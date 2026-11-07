// Mail API (API Gateway HTTP API, Cognito JWT authorizer). The server stores and returns
// ciphertext; decryption happens only in the browser. Every route that names a mailbox
// checks the caller owns it, and answers 404 otherwise so addresses can't be probed.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, type QueryCommandOutput, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { normalizeAddress } from "../crypto/keys";
import { CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { promises as nodeDns } from "node:dns";
import { randomBytes } from "node:crypto";
import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { draftSk, folderGsi1, mailboxPk, META_SK, ownerGsi1, SETTINGS_SK, type DraftItem, type Folder, type MailboxMeta, type MessageItem, type SettingsItem } from "../shared/table";
import { Conflict as SendConflict, sendMessage } from "./send";
import { validateSend } from "./send-validate";
import { displayNameOf, NEW_MAILBOX_DAILY_LIMIT, parseAddress, parseBackupEmail, parseLocalPart, parseName, reservationKey, type Reservation } from "../shared/accounts";
import { ALL_DOMAINS, ALL_PURGES, DOMAIN_DAILY_RECIPIENT_LIMIT, checkDns, dnsRecords, domainDirectory, domainKey, domainsGsi1, evaluate, MAX_DOMAINS_PER_ACCOUNT, MAX_PEOPLE_PER_DOMAIN, NO_CHECKS, parseDisplayName, parseDomain, pendingExpiry, PERSON_PREFIX, personKey, purgeKey, type DomainItem, type PersonItem, type PurgeItem, type Resolver } from "../shared/domains";
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
/** Creating and removing accounts for people on customer domains (Cognito admin API). */
export interface UserAdmin {
  /** Creates the account and has Cognito email an invite with a temporary password. */
  invite(address: string, p: { email: string; givenName: string; familyName: string }): Promise<void>;
  /** Sends the invite again; only works until they first sign in. */
  resendInvite(address: string, email: string): Promise<void>;
  remove(address: string): Promise<void>;
}
export interface ApiDeps {
  ddb: DynamoDBDocumentClient; s3: S3Client; ses: SESv2Client; config: ApiConfig;
  account: (username: string) => Promise<AccountInfo | null>;
  /** DNS lookups for domain checks (node:dns by default). */
  dns?: Resolver;
  /** Accounts for people on customer domains. */
  users?: UserAdmin;
  presign?: (s3: S3Client, cmd: GetObjectCommand) => Promise<string>;
}
type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type ScheduledTask = { task: "check-domains" };
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

export function createHandler({ ddb, s3, ses, config, account, users, dns = nodeDns, presign = (c, cmd) => getSignedUrl(c, cmd, { expiresIn: 300 }) }: ApiDeps) {
  const T = config.table;

  const directory = domainDirectory(ddb, T, config.localDomains);

  /** The caller's address: their username in the Mail user pool. */
  function usernameOf(event: Event): string {
    const u = event.requestContext.authorizer?.jwt?.claims?.username;
    if (typeof u !== "string" || !u) throw new BadRequest("This account has no Mac Tidar address");
    return u;
  }

  async function ownedDomain(sub: string, raw: string | undefined): Promise<DomainItem> {
    let domain: string;
    try { domain = parseDomain(decodeURIComponent(raw ?? ""), config.localDomains); } catch { throw new NotFound(); }
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: domainKey(domain) }));
    const d = Item as DomainItem | undefined;
    if (!d || d.ownerSub !== sub) throw new NotFound();
    return d;
  }

  /** Re-checks a domain's DNS and SES status and saves the result. */
  async function refreshDomain(d: DomainItem): Promise<DomainItem> {
    const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: d.domain }));
    const checks = await checkDns(d.domain, identity.DkimAttributes?.Status === "SUCCESS", config.region, dns);
    const now = new Date();
    const next: DomainItem = { ...d, ...evaluate(d, checks, now), checks, checkedAt: now.toISOString() };
    if (next.status !== "suspended") delete next.suspendedFor;
    await ddb.send(new PutCommand({ TableName: T, Item: next, ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":s": d.ownerSub } }));
    if (next.status !== d.status) console.log(JSON.stringify({ event: "domain-status", from: d.status, to: next.status }));
    return next;
  }

  async function removeDomainIdentity(domain: string) {
    await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain })).catch(e => { if ((e as Error).name !== "NotFoundException") throw e; });
  }

  /** Tells a domain's owner (at their backup email) that it stopped or started working. */
  async function noticeOwner(d: DomainItem, subject: string, line: string) {
    const acct = await account(d.ownerAddress).catch(() => null);
    if (!acct?.email || !acct.emailVerified) return;
    const text = [`Hello,`, ``, line, ``, `Domain: ${d.domain}`, ``, `Open Mac Tidar Mail at mail.${config.signupDomain} yourself (don't use links in emails), then Settings, Domains, to see which DNS records need fixing.`, ``, `Mac Tidar Mail`].join("\n");
    await ses.send(new SendEmailCommand({ FromEmailAddress: `Mac Tidar Mail <no-reply@${config.signupDomain}>`, Destination: { ToAddresses: [acct.email] },
      Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } } } }))
      .catch(e => console.error(JSON.stringify({ event: "domain-notice-failed", name: (e as Error).name })));
  }

  /** Daily: release domains never verified, and re-check the rest (DNS can change at any time). */
  async function checkAllDomains() {
    let start: Record<string, unknown> | undefined;
    const counts = { checked: 0, released: 0, suspended: 0, restored: 0, failed: 0 };
    do {
      const page = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi2", KeyConditionExpression: "gsi2pk = :d", ExpressionAttributeValues: { ":d": ALL_DOMAINS }, ExclusiveStartKey: start }));
      for (const d of (page.Items ?? []) as DomainItem[]) {
        try {
          if (d.status === "pending" && pendingExpiry(d.createdAt).getTime() <= Date.now()) {
            await removeDomainIdentity(d.domain);
            await ddb.send(new DeleteCommand({ TableName: T, Key: domainKey(d.domain), ConditionExpression: "#s = :p", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":p": "pending" } }));
            counts.released++;
            continue;
          }
          const next = await refreshDomain(d);
          counts.checked++;
          if (d.status === "active" && next.status === "suspended") {
            counts.suspended++;
            await noticeOwner(next, "Your domain stopped working with Mac Tidar Mail", `Mail for ${d.domain} has stopped working because its DNS records for Mac Tidar Mail (DKIM or MX) are missing or changed. Mail sent to it may bounce until they're fixed; it starts working again by itself once they are.`);
          } else if (d.status === "suspended" && next.status === "active") {
            counts.restored++;
            await noticeOwner(next, "Your domain is working again", `The DNS records for ${d.domain} are correct again, so its mail is working with Mac Tidar Mail.`);
          }
        } catch (e) {
          counts.failed++;
          console.error(JSON.stringify({ event: "domain-check-failed", name: (e as Error).name }));
        }
      }
      start = page.LastEvaluatedKey;
    } while (start);
    let purged = 0;
    start = undefined;
    do {
      const page: QueryCommandOutput = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi2", KeyConditionExpression: "gsi2pk = :p", ExpressionAttributeValues: { ":p": ALL_PURGES }, ExclusiveStartKey: start }));
      for (const x of (page.Items ?? []) as PurgeItem[]) {
        try { await purgeMailbox(x); purged++; }
        catch (e) { counts.failed++; console.error(JSON.stringify({ event: "purge-failed", name: (e as Error).name })); }
      }
      start = page.LastEvaluatedKey;
    } while (start);
    console.log(JSON.stringify({ event: "domains-checked", ...counts, purged }));
    return { ...counts, purged };
  }

  async function listPeople(domain: string): Promise<PersonItem[]> {
    const out: PersonItem[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": domainKey(domain).pk, ":s": PERSON_PREFIX }, ExclusiveStartKey: start }));
      out.push(...(page.Items ?? []) as PersonItem[]);
      start = page.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async function domainPerson(d: DomainItem, raw: string | undefined): Promise<PersonItem> {
    let address: string;
    try { address = normalizeAddress(decodeURIComponent(raw ?? "")); } catch { throw new NotFound(); }
    if (address.split("@")[1] !== d.domain) throw new NotFound();
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: personKey(d.domain, address) }));
    if (!Item) throw new NotFound();
    return Item as PersonItem;
  }

  const publicPerson = (x: PersonItem) => ({ address: x.address, givenName: x.givenName, familyName: x.familyName, backupEmail: x.backupEmail, status: x.status, createdAt: x.createdAt, activatedAt: x.activatedAt ?? null });

  /**
   * Removes a person: their sign-in goes now and their mailbox stops working now; the stored
   * (still encrypted) mail is deleted by the daily task, so a big mailbox can't time this out.
   */
  async function removePerson(person: PersonItem) {
    const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(person.address), sk: META_SK } }));
    const meta = Item as MailboxMeta | undefined;
    if (meta) {
      const purge: PurgeItem = { ...purgeKey(person.address), address: person.address, ownerSub: meta.ownerSub, createdAt: new Date().toISOString(), gsi2pk: ALL_PURGES, gsi2sk: person.address };
      await ddb.send(new PutCommand({ TableName: T, Item: purge }));
      await ddb.send(new UpdateCommand({ TableName: T, Key: { pk: meta.pk, sk: META_SK }, UpdateExpression: "SET #s = :d", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":d": "deleted" } }));
    }
    await users!.remove(person.address);
    await ddb.send(new DeleteCommand({ TableName: T, Key: personKey(person.domain, person.address) }));
  }

  /** Our own domains plus any active customer domains among this message's recipients. */
  async function localDomainsFor(body: unknown): Promise<string[]> {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const raw = ["to", "cc", "bcc"].flatMap(k => Array.isArray(b[k]) ? (b[k] as unknown[]).slice(0, 60) : []).filter((a): a is string => typeof a === "string");
    const domains = [...new Set(raw.map(a => a.trim().toLowerCase().split("@")[1] ?? "").filter(d => d && !directory.isOwn(d)))].slice(0, 60);
    const active = await Promise.all(domains.map(async d => (await directory.isLocal(d)) ? d : null));
    return [...config.localDomains, ...active.filter((d): d is string => !!d)];
  }

  /** Per-domain daily recipient cap, on top of each mailbox's own cap. */
  async function chargeDomainQuota(domain: string, recipients: number) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: T, Key: { pk: domainKey(domain).pk, sk: `QUOTA#${new Date().toISOString().slice(0, 10)}` },
        UpdateExpression: "ADD recipients :n SET expiresAt = :exp",
        ConditionExpression: "attribute_not_exists(recipients) OR recipients <= :max",
        ExpressionAttributeValues: { ":n": recipients, ":max": DOMAIN_DAILY_RECIPIENT_LIMIT - recipients, ":exp": Math.floor(Date.now() / 1000) + 3 * 86400 },
      }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new BadRequest(`@${domain} has reached its daily sending limit (${DOMAIN_DAILY_RECIPIENT_LIMIT} recipients per day)`);
      throw e;
    }
  }

  /** First sign-in of someone a domain owner added: creates their mailbox and marks them active. */
  async function claimDomainMailbox(address: string, sub: string) {
    const domain = address.split("@")[1]!;
    const [d, { Item }] = await Promise.all([directory.lookup(domain), ddb.send(new GetCommand({ TableName: T, Key: personKey(domain, address) }))]);
    const person = Item as PersonItem | undefined;
    if (!person || d?.status !== "active") throw new Conflict("This address isn’t available right now. Ask whoever manages it.");
    const now = new Date().toISOString();
    const mailbox: MailboxMeta = { pk: mailboxPk(address), sk: META_SK, gsi1pk: ownerGsi1(sub), gsi1sk: mailboxPk(address), address, ownerSub: sub,
      displayName: displayNameOf(person), status: "active", createdAt: now, createdBy: "domain", dailyRecipientLimit: NEW_MAILBOX_DAILY_LIMIT };
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: T, Item: { pk: `OWNER#${sub}`, sk: "CLAIM", address, createdAt: now }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: T, Item: mailbox, ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: { TableName: T, Key: personKey(domain, address), UpdateExpression: "SET #s = :a, activatedAt = :t", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":a": "active", ":t": now } } },
      ] }));
    } catch (e) {
      if (e instanceof TransactionCanceledException) throw new Conflict("This account already has a mailbox");
      throw e;
    }
    console.log(JSON.stringify({ event: "mailbox-claimed", domain: "custom" }));
    return { mailbox: { address, displayName: mailbox.displayName, keyState: null, keyVersion: 0 } };
  }

  /** Deletes a removed person's mailbox: every table item and every S3 object version. */
  async function purgeMailbox(x: PurgeItem) {
    const pk = mailboxPk(x.address);
    let start: Record<string, unknown> | undefined;
    do {
      const page: QueryCommandOutput = await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ProjectionExpression: "pk, sk", ExclusiveStartKey: start }));
      const keys = (page.Items ?? []) as { pk: string; sk: string }[];
      for (let i = 0; i < keys.length; i += 25) {
        let pending = keys.slice(i, i + 25).map(k => ({ DeleteRequest: { Key: k } }));
        for (let tries = 0; pending.length && tries < 5; tries++) {
          const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [T]: pending } }));
          pending = (r.UnprocessedItems?.[T] ?? []) as typeof pending;
        }
        if (pending.length) throw new Error("Couldn't delete every mailbox item");
      }
      start = page.LastEvaluatedKey;
    } while (start);
    for (const prefix of [`msg/${x.address}/`, `att/${x.address}/`]) {
      let keyMarker: string | undefined, versionMarker: string | undefined;
      do {
        const r = await s3.send(new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
        const objects = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map(v => ({ Key: v.Key!, VersionId: v.VersionId }));
        if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objects, Quiet: true } }));
        keyMarker = r.IsTruncated ? r.NextKeyMarker : undefined; versionMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
      } while (keyMarker);
    }
    if (x.ownerSub) await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: `OWNER#${x.ownerSub}`, sk: "CLAIM" } }));
    await ddb.send(new DeleteCommand({ TableName: T, Key: purgeKey(x.address) }));
  }

  /** What the owner sees: status, checks and the records to add. Never the owner's sub. */
  const publicDomain = (d: DomainItem) => ({
    domain: d.domain, displayName: d.displayName, status: d.status, suspendedFor: d.suspendedFor ?? null, checks: d.checks,
    records: dnsRecords(d.domain, d.dkimTokens, config.region), createdAt: d.createdAt, checkedAt: d.checkedAt ?? null, verifiedAt: d.verifiedAt ?? null,
    expiresAt: d.status === "pending" ? pendingExpiry(d.createdAt).toISOString() : null,
  });

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
        const username = usernameOf(event);
        const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": ownerGsi1(sub) }, Limit: 1 }));
        if (Items.length) throw new Conflict("This account already has a mailbox");
        const acct = await account(username);
        if (!acct || acct.sub !== sub || !acct.emailVerified) throw new Conflict("Verify your backup email first");
        if (normalizeAddress(username).split("@")[1] !== config.signupDomain) return json(201, await claimDomainMailbox(normalizeAddress(username), sub));
        const { address, reserved } = parseAddress(username, config.signupDomain);

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
        if (!(await directory.isLocal(address.split("@")[1] ?? ""))) throw new NotFound();
        const { Item } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } }));
        const meta = Item as MailboxMeta | undefined;
        const key = meta?.status === "active" ? meta.keyState?.keys.find(k => k.fingerprint === meta.keyState?.primaryFingerprint) : undefined;
        if (!meta || !key) throw new NotFound();
        return json(200, { address, fingerprint: key.fingerprint, publicKey: key.publicKey });
      }

      case "POST /v1/mailboxes/{address}/send": {
        const meta = await ownedMailbox(sub, p.address);
        const senderDomain = meta.address.split("@")[1]!;
        const customDomain = !directory.isOwn(senderDomain);
        if (customDomain && !(await directory.canSendFrom(senderDomain))) throw new Conflict(`Sending from @${senderDomain} is paused. Whoever manages the domain can see why in Settings, Domains.`);
        const body = parseBody(event, 6_000_000);
        const req = validateSend(body, await localDomainsFor(body));
        if (customDomain) await chargeDomainQuota(senderDomain, new Set([...req.to, ...req.cc, ...req.bcc]).size);
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

      // ── Your own domains ──────────────────────────────────────────────────────────────
      // Connecting a domain creates its SES identity; DNS (DKIM CNAMEs + MX) proves control.
      case "GET /v1/domains": {
        const { Items } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": domainsGsi1(sub) } }));
        return json(200, { domains: ((Items ?? []) as DomainItem[]).map(publicDomain), limit: MAX_DOMAINS_PER_ACCOUNT });
      }

      case "POST /v1/domains": {
        const ownerAddress = usernameOf(event);
        const body = (parseBody(event, 500) ?? {}) as { domain?: unknown; displayName?: unknown };
        const domain = parseDomain(body.domain, config.localDomains);
        const displayName = parseDisplayName(body.displayName, domain);
        const count = (await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": domainsGsi1(sub) }, Select: "COUNT" }))).Count ?? 0;
        if (count >= MAX_DOMAINS_PER_ACCOUNT) throw new Conflict(`You can connect up to ${MAX_DOMAINS_PER_ACCOUNT} domains for now.`);
        const now = new Date().toISOString();
        const item: DomainItem = { ...domainKey(domain), type: "domain", domain, ownerSub: sub, ownerAddress, displayName, status: "pending", dkimTokens: [], checks: NO_CHECKS, createdAt: now, gsi1pk: domainsGsi1(sub), gsi1sk: domain, gsi2pk: ALL_DOMAINS, gsi2sk: domain };
        // Claim the name first, so two people can't both start connecting it.
        try { await ddb.send(new PutCommand({ TableName: T, Item: item, ConditionExpression: "attribute_not_exists(pk)" })); }
        catch (e) { if (e instanceof ConditionalCheckFailedException) throw new Conflict("That domain is already connected, or someone is connecting it."); throw e; }
        try {
          const r = await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: domain, ConfigurationSetName: config.configurationSet, DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" } }));
          item.dkimTokens = r.DkimAttributes?.Tokens ?? [];
        } catch (e) {
          await ddb.send(new DeleteCommand({ TableName: T, Key: domainKey(domain) }));
          if ((e as Error).name === "AlreadyExistsException") throw new Conflict("That domain is already connected.");
          throw e;
        }
        if (item.dkimTokens.length !== 3) throw new Error("SES returned no DKIM tokens");
        await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(domain), UpdateExpression: "SET dkimTokens = :t", ExpressionAttributeValues: { ":t": item.dkimTokens } }));
        console.log(JSON.stringify({ event: "domain-connected" }));
        return json(201, publicDomain(item));
      }

      case "GET /v1/domains/{domain}":
        return json(200, publicDomain(await ownedDomain(sub, p.domain)));

      case "POST /v1/domains/{domain}/check": {
        const d = await ownedDomain(sub, p.domain);
        // DNS and SES lookups cost money and time; one check every 10 seconds is plenty.
        if (d.checkedAt && Date.now() - Date.parse(d.checkedAt) < 10_000) return json(200, publicDomain(d));
        return json(200, publicDomain(await refreshDomain(d)));
      }

      // ── People on your domain ─────────────────────────────────────────────────────────
      // The owner adds people; Cognito emails each an invite with a temporary password. Their
      // mailbox key comes from the password *they* choose, so the owner can never read their mail.
      case "GET /v1/domains/{domain}/people": {
        const d = await ownedDomain(sub, p.domain);
        const people = await listPeople(d.domain);
        return json(200, { people: people.map(publicPerson), limit: MAX_PEOPLE_PER_DOMAIN });
      }

      case "POST /v1/domains/{domain}/people": {
        if (!users) throw new NotFound();
        const d = await ownedDomain(sub, p.domain);
        if (d.status !== "active") throw new Conflict("Finish connecting this domain first.");
        const body = (parseBody(event, 1000) ?? {}) as Record<string, unknown>;
        const address = `${parseLocalPart(body.localPart)}@${d.domain}`;
        const person: PersonItem = {
          ...personKey(d.domain, address), type: "person", address, domain: d.domain, status: "invited", createdAt: new Date().toISOString(),
          givenName: parseName(body.givenName, "first"), familyName: parseName(body.familyName, "last"),
          backupEmail: parseBackupEmail(body.backupEmail, [d.domain, ...config.localDomains]),
        };
        const count = (await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": d.pk, ":s": PERSON_PREFIX }, Select: "COUNT" }))).Count ?? 0;
        if (count >= MAX_PEOPLE_PER_DOMAIN) throw new Conflict(`A domain can have up to ${MAX_PEOPLE_PER_DOMAIN} people for now.`);
        const { Item: existing } = await ddb.send(new GetCommand({ TableName: T, Key: { pk: mailboxPk(address), sk: META_SK } }));
        if (existing) throw new Conflict((existing as MailboxMeta).status === "deleted" ? "That address was just removed. Try again tomorrow." : "That address is taken.");
        // The person record goes first: the sign-up trigger only lets an invite through when it exists.
        try { await ddb.send(new PutCommand({ TableName: T, Item: person, ConditionExpression: "attribute_not_exists(pk)" })); }
        catch (e) { if (e instanceof ConditionalCheckFailedException) throw new Conflict("That address is taken."); throw e; }
        try {
          await users.invite(address, { email: person.backupEmail, givenName: person.givenName, familyName: person.familyName });
        } catch (e) {
          await ddb.send(new DeleteCommand({ TableName: T, Key: personKey(d.domain, address) }));
          if ((e as Error).name === "UsernameExistsException") throw new Conflict("That address is taken.");
          throw e;
        }
        console.log(JSON.stringify({ event: "person-invited" }));
        return json(201, publicPerson(person));
      }

      case "POST /v1/domains/{domain}/people/{address}/invite": {
        if (!users) throw new NotFound();
        const d = await ownedDomain(sub, p.domain);
        const person = await domainPerson(d, p.address);
        if (person.status !== "invited") throw new Conflict("They’ve already signed in.");
        try { await users.resendInvite(person.address, person.backupEmail); }
        catch (e) { if ((e as Error).name === "UnsupportedUserStateException") throw new Conflict("They’ve already signed in."); throw e; }
        return json(200, { sent: true });
      }

      case "DELETE /v1/domains/{domain}/people/{address}": {
        if (!users) throw new NotFound();
        const d = await ownedDomain(sub, p.domain);
        const person = await domainPerson(d, p.address);
        await removePerson(person);
        console.log(JSON.stringify({ event: "person-removed" }));
        return json(200, { deleted: true });
      }

      case "DELETE /v1/domains/{domain}": {
        const d = await ownedDomain(sub, p.domain);
        if ((await listPeople(d.domain)).length > 0) throw new Conflict("Remove everyone on this domain first.");
        await removeDomainIdentity(d.domain);
        await ddb.send(new DeleteCommand({ TableName: T, Key: domainKey(d.domain), ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":s": sub } }));
        console.log(JSON.stringify({ event: "domain-removed" }));
        return json(200, { deleted: true });
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

  const api = async (event: Event): Promise<Result> => {
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
  return Object.assign(api, { checkAllDomains });
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

/** Customer-domain accounts. The username is the address; the email attribute is their backup email. */
function poolUsers(cognito: CognitoIdentityProviderClient, poolId: string): UserAdmin {
  return {
    async invite(address, p) {
      // email_verified: only someone who receives the invite (at that email) can finish signing in.
      await cognito.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: address, DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [{ Name: "email", Value: p.email }, { Name: "email_verified", Value: "true" }, { Name: "given_name", Value: p.givenName }, { Name: "family_name", Value: p.familyName }] }));
    },
    async resendInvite(address) {
      await cognito.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: address, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] }));
    },
    async remove(address) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: address })).catch(e => { if ((e as Error).name !== "UserNotFoundException") throw e; });
    },
  };
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: Event | ScheduledTask) => {
  cached ??= ((cognito: CognitoIdentityProviderClient) => createHandler({
    account: username => poolAccount(cognito, env("MAIL_USER_POOL_ID"), username),
    users: poolUsers(cognito, env("MAIL_USER_POOL_ID")),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client({}),
    ses: new SESv2Client({}),
    config: {
      table: env("MAIL_TABLE"), bucket: env("MAIL_BUCKET"), configurationSet: env("SES_CONFIGURATION_SET"), region: env("AWS_REGION"),
      localDomains: env("LOCAL_MAIL_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
      signupDomain: env("SIGNUP_DOMAIN").trim().toLowerCase(),
    },
  }))(new CognitoIdentityProviderClient({}));
  // The daily schedule invokes this function directly; API Gateway events always carry routeKey.
  if (!("routeKey" in event)) {
    if (event.task === "check-domains") return cached.checkAllDomains();
    throw new Error("Unknown task");
  }
  return cached(event);
};
