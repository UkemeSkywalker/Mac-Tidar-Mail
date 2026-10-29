// Mail API (API Gateway HTTP API, Cognito JWT authorizer). The server stores and returns
// ciphertext; decryption happens only in the browser. Every route that names a mailbox
// checks the caller owns it, and answers 404 otherwise so addresses can't be probed.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { normalizeAddress } from "../crypto/keys";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { randomBytes } from "node:crypto";
import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { draftSk, folderGsi1, mailboxPk, META_SK, ownerGsi1, SETTINGS_SK, type DraftItem, type Folder, type MailboxMeta, type MessageItem, type SettingsItem } from "../shared/table";
import { Conflict as SendConflict, sendMessage } from "./send";
import { validateSend } from "./send-validate";
import { displayNameOf, NEW_MAILBOX_DAILY_LIMIT, parseAddress, reservationKey, type Reservation } from "../shared/accounts";
import { BadRequest, FOLDERS, validateKeyState, validatePatch, validateSettings, validateSks } from "./validate";

/** Sessions per account; each signed-in browser holds one. */
const MAX_SESSIONS = 50;
/** "Keep me signed in": ends after 30 days without use. */
const PERSISTENT_SESSION_S = 30 * 86400;
/** Tab-only sign-in: the browser drops its ID when the tab closes; ours goes after 12 hours unused. */
const TAB_SESSION_S = 12 * 3600;
const SESSION_SK = "KEY";
const sessionPk = (id: string) => `SESSION#${id}`;
const sessionsGsi1 = (sub: string) => `SESSIONS#${sub}`;
interface SessionItem { pk: string; sk: string; gsi1pk: string; gsi1sk: string; ownerSub: string; clientKey: string; persistent: boolean; ttlSeconds: number; createdAt: string; expiresAt: number }

export interface ApiConfig { table: string; bucket: string; configurationSet: string; localDomains: string[]; region: string; signupDomain: string }
/** The parts of a Mail account the API needs (read from the user pool). */
export interface AccountInfo { sub: string; email: string; emailVerified: boolean; givenName: string; familyName: string }
export interface ApiDeps {
  ddb: DynamoDBDocumentClient; s3: S3Client; ses: SESv2Client; config: ApiConfig;
  account: (username: string) => Promise<AccountInfo | null>;
  presign?: (s3: S3Client, cmd: GetObjectCommand) => Promise<string>;
}
type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

class NotFound extends Error {}
class Conflict extends Error {}

const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** Fields the browser needs for a message row; never includes S3 keys or index keys. */
const publicMessage = (m: MessageItem) => ({
  id: m.id, sk: m.sk, folder: m.folder, category: m.category, receivedAt: m.receivedAt, threadId: m.threadId,
  fromAddress: m.fromAddress, toAddresses: m.toAddresses, ccAddresses: m.ccAddresses, size: m.size, read: m.read,
  starred: m.starred, labels: m.labels, snoozedUntil: m.snoozedUntil ?? null, keyFingerprint: m.keyFingerprint,
  header: m.header, attachmentCount: m.attachmentKeys.length, spam: m.verdicts?.spam === "FAIL",
  rfcMessageId: m.rfcMessageId ?? null, references: m.references ?? [], bccAddresses: m.bccAddresses ?? [],
  deliveryStatus: m.deliveryStatus ?? null, e2e: !!m.e2e,
});

const encodeCursor = (key?: Record<string, unknown>) => key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;
function decodeCursor(cursor: string | undefined, expectedGsi1pk: string) {
  if (!cursor) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
    if (key.gsi1pk !== expectedGsi1pk) throw new Error();
    return key;
  } catch { throw new BadRequest("Invalid cursor"); }
}

function parseBody(event: Event, maxChars = 600_000): unknown {
  if (!event.body) throw new BadRequest("Body required");
  if (event.body.length > maxChars) throw new BadRequest("Body too large");
  try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body); }
  catch { throw new BadRequest("Body must be JSON"); }
}

export function createHandler({ ddb, s3, ses, config, account, presign = (c, cmd) => getSignedUrl(c, cmd, { expiresIn: 300 }) }: ApiDeps) {
  const T = config.table;

  async function ownedMailbox(sub: string, raw: string | undefined): Promise<MailboxMeta> {
    let address: string;
    try { address = normalizeAddress(decodeURIComponent(raw ?? "")); } catch { throw new NotFound(); }
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new NotFound();
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } }));
    const meta = Item as MailboxMeta | undefined;
    if (!meta || meta.ownerSub !== sub || meta.status !== "active") throw new NotFound();
    return meta;
  }

  async function messagesBySk(meta: MailboxMeta, sks: string[]) {
    const items = await Promise.all(sks.map(sk => ddb.send(new GetCommand({ TableName: T, Key: { pk: meta.pk, sk } })).then(r => r.Item as MessageItem | undefined)));
    if (items.some(i => !i || i.type !== "message")) throw new NotFound();
    return items as MessageItem[];
  }

  async function route(event: Event, sub: string): Promise<Result> {
    const p = event.pathParameters ?? {};
    const q = event.queryStringParameters ?? {};

    switch (event.routeKey) {
      case "GET /v1/mailboxes": {
        const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": ownerGsi1(sub) } }));
        const mailboxes = (Items as MailboxMeta[]).filter(m => m.status === "active" && m.ownerSub === sub)
          .map(m => ({ address: m.address, displayName: m.displayName, keyState: m.keyState ?? null, keyVersion: m.keyVersion ?? 0 }));
        return json(200, { mailboxes });
      }

      case "POST /v1/mailboxes": {
        // Opens the mailbox for the signed-in account's own address (its username). One per
        // account; the OWNER#…/CLAIM marker makes that atomic. A reserved address (for example an
        // existing mailbox moving to its own login) needs a reservation for this backup email.
        const username = event.requestContext.authorizer?.jwt?.claims?.username;
        if (typeof username !== "string") throw new BadRequest("This account has no Mac Tidar address");
        const { address, reserved } = parseAddress(username, config.signupDomain);
        const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": ownerGsi1(sub) }, Limit: 1 }));
        if (Items.length) throw new Conflict("This account already has a mailbox");
        const acct = await account(username);
        if (!acct || acct.sub !== sub || !acct.emailVerified) throw new Conflict("Verify your backup email first");

        const [{ Item: res }, { Item: existing }] = await Promise.all([
          ddb.send(new GetCommand({ TableName: T, Key: reservationKey(address) })),
          ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } })),
        ]);
        const reservation = res as Reservation | undefined;
        const now = new Date().toISOString();
        const claim = { Put: { TableName: T, Item: { pk: `OWNER#${sub}`, sk: "CLAIM", address, createdAt: now }, ConditionExpression: "attribute_not_exists(pk)" } };
        const meta = existing as MailboxMeta | undefined;
        let mailbox: MailboxMeta, items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>;

        if (reservation && reservation.backupEmail === acct.email && reservation.expiresAt * 1000 > Date.now()) {
          const useIt = { Delete: { TableName: T, Key: reservationKey(address), ConditionExpression: "backupEmail = :e", ExpressionAttributeValues: { ":e": acct.email } } };
          if (meta) {
            // Move the existing mailbox (mail and keys unchanged) to this account.
            mailbox = { ...meta, ownerSub: sub, gsi1pk: ownerGsi1(sub) };
            items = [claim, useIt, { Update: { TableName: T, Key: { pk: meta.pk, sk: META_SK }, UpdateExpression: "SET ownerSub = :s, gsi1pk = :g",
              ConditionExpression: "ownerSub = :old", ExpressionAttributeValues: { ":s": sub, ":g": ownerGsi1(sub), ":old": meta.ownerSub } } }];
          } else {
            mailbox = { pk: mailboxPk(address), sk: META_SK, gsi1pk: ownerGsi1(sub), gsi1sk: mailboxPk(address), address, ownerSub: sub, displayName: displayNameOf(acct), status: "active", createdAt: now, createdBy: "admin" };
            items = [claim, useIt, { Put: { TableName: T, Item: mailbox, ConditionExpression: "attribute_not_exists(pk)" } }];
          }
        } else {
          if (reserved || reservation) throw new Conflict("That address is reserved");
          mailbox = { pk: mailboxPk(address), sk: META_SK, gsi1pk: ownerGsi1(sub), gsi1sk: mailboxPk(address), address, ownerSub: sub, displayName: displayNameOf(acct), status: "active", createdAt: now, createdBy: "self", dailyRecipientLimit: NEW_MAILBOX_DAILY_LIMIT };
          items = [claim, { Put: { TableName: T, Item: mailbox, ConditionExpression: "attribute_not_exists(pk)" } }];
        }
        try {
          await ddb.send(new TransactWriteCommand({ TransactItems: items }));
        } catch (e) {
          if (e instanceof TransactionCanceledException) {
            const [first, ...rest] = e.CancellationReasons ?? [];
            if (first?.Code === "ConditionalCheckFailed") throw new Conflict("This account already has a mailbox");
            if (rest.some(r => r?.Code === "ConditionalCheckFailed")) throw new Conflict("That address is taken");
          }
          throw e;
        }
        console.log(JSON.stringify({ event: "mailbox-claimed", moved: !!(reservation && meta) }));
        return json(201, { mailbox: { address, displayName: mailbox.displayName, keyState: mailbox.keyState ?? null, keyVersion: mailbox.keyVersion ?? 0 } });
      }

      case "PUT /v1/mailboxes/{address}/keys": {
        const meta = await ownedMailbox(sub, p.address);
        const body = parseBody(event) as { keyState?: unknown; expectedVersion?: unknown };
        if (!Number.isInteger(body.expectedVersion)) throw new BadRequest("expectedVersion required");
        const keyState = await validateKeyState(body.keyState, meta.address);
        const expected = body.expectedVersion as number;
        try {
          await ddb.send(new UpdateCommand({
            TableName: T, Key: { pk: meta.pk, sk: META_SK },
            UpdateExpression: "SET keyState = :k, keyVersion = :next, keysUpdatedAt = :now",
            ConditionExpression: expected === 0 ? "attribute_not_exists(keyVersion) OR keyVersion = :zero" : "keyVersion = :expected",
            ExpressionAttributeValues: { ":k": keyState, ":next": expected + 1, ":now": new Date().toISOString(), ...(expected === 0 ? { ":zero": 0 } : { ":expected": expected }) },
          }));
        } catch (e) {
          if (e instanceof ConditionalCheckFailedException) throw new Conflict("Keys were changed on another device; reload and try again");
          throw e;
        }
        console.log(JSON.stringify({ event: "keys-updated", keyVersion: expected + 1 }));
        return json(200, { keyVersion: expected + 1 });
      }

      case "GET /v1/mailboxes/{address}/messages": {
        const meta = await ownedMailbox(sub, p.address);
        const folder = (q.folder ?? "inbox") as Folder;
        if (!FOLDERS.includes(folder)) throw new BadRequest("Unknown folder");
        const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 200);
        const gsi1pk = folderGsi1(meta.address, folder);
        const res = await ddb.send(new QueryCommand({
          TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :f", ExpressionAttributeValues: { ":f": gsi1pk },
          ScanIndexForward: false, Limit: limit, ExclusiveStartKey: decodeCursor(q.cursor, gsi1pk),
        }));
        const messages = (res.Items as MessageItem[] ?? []).filter(m => m.pk === meta.pk).map(publicMessage);
        return json(200, { messages, cursor: encodeCursor(res.LastEvaluatedKey) });
      }

      case "GET /v1/mailboxes/{address}/content": {
        const meta = await ownedMailbox(sub, p.address);
        if (!q.sk) throw new BadRequest("sk required");
        const m = (await messagesBySk(meta, [q.sk]))[0]!;
        const part = q.part ?? "body";
        let key: string | undefined;
        if (part === "body") key = m.bodyKey;
        else if (part === "attachment") key = m.attachmentKeys[Number(q.index)];
        if (!key) throw new NotFound();
        const url = await presign(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key, ResponseContentType: "application/octet-stream", ResponseCacheControl: "no-store" }));
        return json(200, { url, expiresIn: 300 });
      }

      case "PATCH /v1/mailboxes/{address}/messages": {
        const meta = await ownedMailbox(sub, p.address);
        const { sks, set } = validatePatch(parseBody(event));
        const names: Record<string, string> = {}, values: Record<string, unknown> = {}, parts: string[] = [];
        for (const [k, v] of Object.entries(set)) { names[`#${k}`] = k; values[`:${k}`] = v; parts.push(`#${k} = :${k}`); }
        if (set.folder) { names["#g"] = "gsi1pk"; values[":g"] = folderGsi1(meta.address, set.folder); parts.push("#g = :g"); }
        let updated = 0;
        for (const sk of sks) {
          try {
            await ddb.send(new UpdateCommand({
              TableName: T, Key: { pk: meta.pk, sk }, UpdateExpression: `SET ${parts.join(", ")}`,
              ConditionExpression: "attribute_exists(pk) AND #type = :msg",
              ExpressionAttributeNames: { ...names, "#type": "type" }, ExpressionAttributeValues: { ...values, ":msg": "message" },
            }));
            updated++;
          } catch (e) { if (!(e instanceof ConditionalCheckFailedException)) throw e; }
        }
        return json(200, { updated });
      }

      case "POST /v1/mailboxes/{address}/messages/delete": {
        const meta = await ownedMailbox(sub, p.address);
        const items = await messagesBySk(meta, validateSks(parseBody(event)));
        if (items.some(m => m.folder !== "trash" && m.folder !== "spam")) throw new BadRequest("Only messages in Trash or Spam can be deleted forever");
        for (const m of items) {
          // Remove every stored version of the ciphertext, then the index item.
          for (const prefix of [m.bodyKey, ...m.attachmentKeys]) {
            const { Versions = [], DeleteMarkers = [] } = await s3.send(new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: prefix }));
            const objects = [...Versions, ...DeleteMarkers].filter(v => v.Key === prefix).map(v => ({ Key: v.Key!, VersionId: v.VersionId }));
            if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objects, Quiet: true } }));
          }
          await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: meta.pk, sk: m.sk } }));
        }
        return json(200, { deleted: items.length });
      }

      case "GET /v1/mailboxes/{address}/settings": {
        const meta = await ownedMailbox(sub, p.address);
        const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: meta.pk, sk: SETTINGS_SK } }));
        const s = Item as SettingsItem | undefined;
        return json(200, { blob: s?.blob ?? null, version: s?.version ?? 0 });
      }

      case "PUT /v1/mailboxes/{address}/settings": {
        const meta = await ownedMailbox(sub, p.address);
        const { blob, expectedVersion } = validateSettings(parseBody(event));
        const item: SettingsItem = { pk: meta.pk, sk: SETTINGS_SK, blob, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
        try {
          await ddb.send(new PutCommand({
            TableName: T, Item: item,
            ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(pk)" : "version = :v", ...(expectedVersion === 0 ? {} : { ExpressionAttributeValues: { ":v": expectedVersion } }),
          }));
        } catch (e) {
          if (e instanceof ConditionalCheckFailedException) throw new Conflict("Settings changed on another device; reload and try again");
          throw e;
        }
        return json(200, { version: item.version });
      }

      case "GET /v1/keys": {
        // Public key lookup for Mac Tidar recipients, so the browser can encrypt end to end.
        let address: string;
        try { address = normalizeAddress(q.address ?? ""); } catch { throw new NotFound(); }
        if (!config.localDomains.includes(address.split("@")[1] ?? "")) throw new NotFound();
        const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } }));
        const meta = Item as MailboxMeta | undefined;
        const key = meta?.status === "active" ? meta.keyState?.keys.find(k => k.fingerprint === meta.keyState?.primaryFingerprint) : undefined;
        if (!meta || !key) throw new NotFound();
        return json(200, { address, fingerprint: key.fingerprint, publicKey: key.publicKey });
      }

      case "POST /v1/mailboxes/{address}/send": {
        const meta = await ownedMailbox(sub, p.address);
        const req = validateSend(parseBody(event, 6_000_000), config.localDomains);
        const sent = await sendMessage({ ddb, s3, ses, table: T, bucket: config.bucket, configurationSet: config.configurationSet, region: config.region }, meta, req);
        return json(200, { message: publicMessage(sent) });
      }

      case "GET /v1/mailboxes/{address}/drafts": {
        const meta = await ownedMailbox(sub, p.address);
        const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :pk AND begins_with(sk, :d)", ExpressionAttributeValues: { ":pk": meta.pk, ":d": "DRAFT#" } }));
        return json(200, { drafts: (Items as DraftItem[]).map(d => ({ id: d.id, blob: d.blob, updatedAt: d.updatedAt })) });
      }

      case "PUT /v1/mailboxes/{address}/drafts/{id}": {
        const meta = await ownedMailbox(sub, p.address);
        const id = p.id ?? "";
        if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new BadRequest("Invalid draft id");
        const body = parseBody(event, 1_600_000) as { blob?: unknown };
        if (typeof body.blob !== "string" || body.blob.length > 1_500_000 || !/^-----BEGIN PGP MESSAGE-----[\s\S]+-----END PGP MESSAGE-----\s*$/.test(body.blob)) throw new BadRequest("Drafts must be encrypted messages");
        const item: DraftItem = { pk: meta.pk, sk: draftSk(id), type: "draft", id, blob: body.blob, updatedAt: new Date().toISOString() };
        await ddb.send(new PutCommand({ TableName: T, Item: item }));
        return json(200, { id, updatedAt: item.updatedAt });
      }

      case "DELETE /v1/mailboxes/{address}/drafts/{id}": {
        const meta = await ownedMailbox(sub, p.address);
        if (!/^[A-Za-z0-9_-]{4,64}$/.test(p.id ?? "")) throw new BadRequest("Invalid draft id");
        await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: meta.pk, sk: draftSk(p.id!) } }));
        return json(200, { deleted: true });
      }

      // ── Sign-in sessions: our half of the key that reopens a mailbox after a reload ─────
      // The browser keeps the mailbox passphrase sealed under `clientKey`; we keep only
      // `clientKey`. Neither half opens mail alone, and deleting ours ends that session.
      case "POST /v1/sessions": {
        const { persistent } = (parseBody(event, 200) ?? {}) as { persistent?: unknown };
        if (typeof persistent !== "boolean") throw new BadRequest("persistent must be true or false");
        const count = (await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": sessionsGsi1(sub) }, Select: "COUNT" }))).Count ?? 0;
        if (count >= MAX_SESSIONS) throw new Conflict("Too many signed-in devices. Sign out of all devices, then sign in again.");
        const id = randomBytes(16).toString("base64url"), clientKey = randomBytes(32).toString("base64");
        const now = Math.floor(Date.now() / 1000), ttl = persistent ? PERSISTENT_SESSION_S : TAB_SESSION_S;
        const item: SessionItem = { pk: sessionPk(id), sk: SESSION_SK, gsi1pk: sessionsGsi1(sub), gsi1sk: id, ownerSub: sub, clientKey, persistent, ttlSeconds: ttl, createdAt: new Date().toISOString(), expiresAt: now + ttl };
        await ddb.send(new PutCommand({ TableName: T, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
        return json(201, { id, clientKey, expiresAt: item.expiresAt });
      }

      case "GET /v1/sessions/{id}/key": {
        // Each use slides the expiry forward: sessions end after a stretch of no use.
        const s = await ownedSession(sub, p.id);
        const expiresAt = Math.floor(Date.now() / 1000) + s.ttlSeconds;
        await ddb.send(new UpdateCommand({ TableName: T, Key: { pk: s.pk, sk: SESSION_SK }, UpdateExpression: "SET expiresAt = :e", ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":e": expiresAt, ":s": sub } }));
        return json(200, { clientKey: s.clientKey, expiresAt });
      }

      case "DELETE /v1/sessions/{id}": {
        const s = await ownedSession(sub, p.id).catch(e => { if (e instanceof NotFound) return null; throw e; });
        if (s) await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: s.pk, sk: SESSION_SK }, ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":s": sub } }));
        return json(200, { deleted: true });
      }

      case "DELETE /v1/sessions": {
        // Sign out of all devices: every sealed copy anywhere stops opening the mailbox.
        let deleted = 0, start: Record<string, unknown> | undefined;
        do {
          const page = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": sessionsGsi1(sub) }, ExclusiveStartKey: start }));
          for (const it of (page.Items ?? []) as SessionItem[]) {
            await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: it.pk, sk: SESSION_SK } }));
            deleted++;
          }
          start = page.LastEvaluatedKey;
        } while (start);
        console.log(JSON.stringify({ event: "sessions-revoked", deleted }));
        return json(200, { deleted });
      }

      default:
        throw new NotFound();
    }
  }

  async function ownedSession(sub: string, id: string | undefined): Promise<SessionItem> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id ?? "")) throw new NotFound();
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: sessionPk(id!), sk: SESSION_SK } }));
    const s = Item as SessionItem | undefined;
    // TTL deletion can lag by days, so check the expiry here too.
    if (!s || s.ownerSub !== sub || s.expiresAt * 1000 <= Date.now()) throw new NotFound();
    return s;
  }

  return async (event: Event): Promise<Result> => {
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof sub !== "string" || !sub) return json(401, { error: "Unauthorized" });
    try {
      return await route(event, sub);
    } catch (e) {
      if (e instanceof BadRequest) return json(400, { error: e.message });
      if (e instanceof NotFound) return json(404, { error: "Not found" });
      if (e instanceof Conflict || e instanceof SendConflict) return json(409, { error: e.message });
      console.error(JSON.stringify({ event: "api-error", route: event.routeKey, name: (e as Error).name }));
      return json(500, { error: "Something went wrong" });
    }
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

async function poolAccount(cognito: CognitoIdentityProviderClient, poolId: string, username: string): Promise<AccountInfo | null> {
  try {
    const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
    const attr = (n: string) => u.UserAttributes?.find(a => a.Name === n)?.Value ?? "";
    return { sub: attr("sub"), email: attr("email").toLowerCase(), emailVerified: attr("email_verified") === "true", givenName: attr("given_name"), familyName: attr("family_name") };
  } catch (e) {
    if ((e as Error).name === "UserNotFoundException") return null;
    throw e;
  }
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: Event) => {
  cached ??= createHandler({
    account: (cognito => (username: string) => poolAccount(cognito, env("MAIL_USER_POOL_ID"), username))(new CognitoIdentityProviderClient({})),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client({}),
    ses: new SESv2Client({}),
    config: {
      table: env("MAIL_TABLE"), bucket: env("MAIL_BUCKET"), configurationSet: env("SES_CONFIGURATION_SET"), region: env("AWS_REGION"),
      localDomains: env("LOCAL_MAIL_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
      signupDomain: env("SIGNUP_DOMAIN").trim().toLowerCase(),
    },
  });
  return cached(event);
};
