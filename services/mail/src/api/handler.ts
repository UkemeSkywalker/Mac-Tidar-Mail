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
import { draftSk, folderGsi1, mailboxPk, META_SK, ownerGsi1, SETTINGS_SK, type DraftItem, type Folder, type MailboxMeta, type MessageItem, type SettingsItem } from "../shared/table";
import { Conflict as SendConflict, sendMessage } from "./send";
import { validateSend } from "./send-validate";
import { NEW_MAILBOX_DAILY_LIMIT, validateClaim } from "./signup";
import { BadRequest, FOLDERS, validateKeyState, validatePatch, validateSettings, validateSks } from "./validate";

export interface ApiConfig { table: string; bucket: string; configurationSet: string; localDomains: string[]; region: string; signupDomain: string }
export interface ApiDeps { ddb: DynamoDBDocumentClient; s3: S3Client; ses: SESv2Client; config: ApiConfig; presign?: (s3: S3Client, cmd: GetObjectCommand) => Promise<string> }
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

export function createHandler({ ddb, s3, ses, config, presign = (c, cmd) => getSignedUrl(c, cmd, { expiresIn: 300 }) }: ApiDeps) {
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
        // One self-claimed address per account. The OWNER#…/CLAIM marker makes that atomic.
        const { address, displayName } = validateClaim(parseBody(event, 2_000), config.signupDomain);
        const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": ownerGsi1(sub) }, Limit: 1 }));
        if (Items.length) throw new Conflict("This account already has a mailbox");
        const now = new Date().toISOString();
        const meta: MailboxMeta = { pk: mailboxPk(address), sk: META_SK, gsi1pk: ownerGsi1(sub), gsi1sk: mailboxPk(address), address, ownerSub: sub, displayName, status: "active", createdAt: now, createdBy: "self", dailyRecipientLimit: NEW_MAILBOX_DAILY_LIMIT };
        try {
          await ddb.send(new TransactWriteCommand({ TransactItems: [
            { Put: { TableName: T, Item: { pk: `OWNER#${sub}`, sk: "CLAIM", address, createdAt: now }, ConditionExpression: "attribute_not_exists(pk)" } },
            { Put: { TableName: T, Item: meta, ConditionExpression: "attribute_not_exists(pk)" } },
          ] }));
        } catch (e) {
          if (e instanceof TransactionCanceledException) {
            const [claim, box] = e.CancellationReasons ?? [];
            if (claim?.Code === "ConditionalCheckFailed") throw new Conflict("This account already has a mailbox");
            if (box?.Code === "ConditionalCheckFailed") throw new Conflict("That address is taken. Please choose another.");
          }
          throw e;
        }
        console.log(JSON.stringify({ event: "mailbox-claimed" }));
        return json(201, { mailbox: { address, displayName, keyState: null, keyVersion: 0 } });
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

      default:
        throw new NotFound();
    }
  }

  /**
   * Public (no sign-in): lets people sign in with their @mactidar.com address. Returns the
   * opaque Cognito username of the account that owns it; the account's email is never revealed.
   */
  async function signInName(event: Event): Promise<Result> {
    let address: string;
    try { address = normalizeAddress(event.queryStringParameters?.address ?? ""); } catch { throw new NotFound(); }
    if (!config.localDomains.includes(address.split("@")[1] ?? "")) throw new NotFound();
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } }));
    const meta = Item as MailboxMeta | undefined;
    if (!meta || meta.status !== "active") throw new NotFound();
    return json(200, { username: meta.ownerSub });
  }

  return async (event: Event): Promise<Result> => {
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
    const isPublic = event.routeKey === "GET /v1/sign-in-name";
    if (!isPublic && (typeof sub !== "string" || !sub)) return json(401, { error: "Unauthorized" });
    try {
      return isPublic ? await signInName(event) : await route(event, sub as string);
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

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: Event) => {
  cached ??= createHandler({
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
