// Mail API (API Gateway HTTP API, Cognito JWT authorizer). The server stores and returns
// ciphertext; decryption happens only in the browser. Every route that names a mailbox
// checks the caller owns it, and answers 404 otherwise so addresses can't be probed.
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, type QueryCommandOutput, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { normalizeAddress } from "../crypto/keys";
import { CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { authoritativeResolver, DnsUnavailable } from "../shared/dns";
import { renderEmail, type EmailContent, type EmailRecord } from "../shared/email";
import { MAC_TIDAR_MARK_PNG } from "../shared/assets/mark";
import MailComposer from "nodemailer/lib/mail-composer";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { cloudFrontWebHosts, webHostName, type WebHost, type WebHosts } from "../shared/webhost";
import { randomBytes } from "node:crypto";
import { AdminCreateUserCommand, AdminDeleteUserCommand, AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { draftSk, folderGsi1, mailboxPk, META_SK, ownerGsi1, SETTINGS_SK, type DraftItem, type Folder, type MailboxMeta, type MessageItem, type SettingsItem } from "../shared/table";
import { Conflict as SendConflict, sendMessage } from "./send";
import { validateSend } from "./send-validate";
import { displayNameOf, NEW_MAILBOX_DAILY_LIMIT, parseAddress, parseBackupEmail, parseLocalPart, parseName, reservationKey, type Reservation } from "../shared/accounts";
import { ALL_CLAIMS, ALL_DOMAINS, ALL_PURGES, CLAIM_PREFIX, checkDns, checkOwnership, claimKey, DOMAIN_DAILY_RECIPIENT_LIMIT, dnsRecords, domainDirectory, domainKey, domainsGsi1, evaluate, isReady, LOGO_TYPES, logoPrefix, MAX_CLAIMS_PER_DOMAIN, MAX_DOMAINS_PER_ACCOUNT, MAX_LOGO_BYTES, MAX_PEOPLE_PER_DOMAIN, NO_CLAIM_CHECKS, ownershipRecord, ownsAddressOn, parseDisplayName, parseDomain, pendingExpiry, PERSON_PREFIX, personKey, purgeKey, REMIND_AFTER_MS, SIGNUP_PREFIX, uploadPrefix, WARN_AFTER_MS, type ClaimChecks, type ClaimItem, type DnsRecord, type DomainItem, type PersonItem, type PurgeItem, type Resolver, type SignupItem } from "../shared/domains";
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

export interface ApiConfig {
  table: string; bucket: string; configurationSet: string; localDomains: string[]; region: string; signupDomain: string;
  /** Company logos: uploads land privately here; verified domains' logos are served from `brandUrl` (CloudFront). */
  brandBucket?: string; brandUrl?: string;
}
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
  /** DNS lookups for domain checks. By default each domain's own nameservers are asked; tests pass a fixed resolver. */
  dns?: Resolver;
  /** Accounts for people on customer domains. */
  users?: UserAdmin;
  /** Companies' own web addresses (mail.<domain>) on CloudFront. Absent: the feature is off. */
  webHosts?: WebHosts;
  presign?: (s3: S3Client, cmd: GetObjectCommand) => Promise<string>;
  /** A browser upload form for one logo (S3 presigned POST). */
  presignPost?: (s3: S3Client, p: { bucket: string; key: string; contentType: string }) => Promise<{ url: string; fields: Record<string, string> }>;
}
type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type ScheduledTask = { task: "check-domains" | "check-claims" };
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

export function createHandler({ ddb, s3, ses, config, account, users, webHosts, dns, presign = (c, cmd) => getSignedUrl(c, cmd, { expiresIn: 300 }),
  presignPost = (c, p) => createPresignedPost(c, { Bucket: p.bucket, Key: p.key, Expires: 300, Fields: { "Content-Type": p.contentType },
    Conditions: [["content-length-range", 1, MAX_LOGO_BYTES], ["eq", "$Content-Type", p.contentType]] }) }: ApiDeps) {
  const T = config.table;
  const resolverFor = (domain: string): Promise<Resolver> => dns ? Promise.resolve(dns) : authoritativeResolver(domain);

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
    const checks = await checkDns(d.domain, identity.DkimAttributes?.Status === "SUCCESS", config.region, await resolverFor(d.domain), d.dkimTokens);
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

  /** The company an email is about: its name, and its logo (published, or still private while pending). */
  type BrandSource = { name: string; logoKey?: string };
  const brandOf = (x: DomainItem | ClaimItem): BrandSource => ({ name: x.displayName, logoKey: x.type === "domain" ? x.logoKey : x.pendingLogoKey });

  /** The logo bytes, attached to the email itself (so a pending domain's logo never needs a public URL). */
  async function logoAttachment(key: string | undefined): Promise<{ content: Buffer; contentType: string; ext: string } | null> {
    if (!key || !config.brandBucket) return null;
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: config.brandBucket, Key: key }));
      const ext = key.split(".").pop()!, contentType = Object.entries(LOGO_TYPES).find(([, e]) => e === ext)?.[0];
      if (!r.Body || !contentType) return null;
      return { content: Buffer.from(await r.Body.transformToByteArray()), contentType, ext };
    } catch { return null; }
  }

  /**
   * Emails an account's backup address: a branded HTML email (company logo inline) with a plain-text
   * twin. Never links: people open the app themselves.
   */
  async function notify(ownerAddress: string, subject: string, content: EmailContent, brand?: BrandSource) {
    const acct = await account(ownerAddress).catch(() => null);
    if (!acct?.email || !acct.emailVerified) return;
    const logo = await logoAttachment(brand?.logoKey);
    const { html, text } = renderEmail(brand
      ? { name: brand.name, tagline: "on Mac Tidar Mail", logo: logo ? "cid:logo" : undefined }
      : { name: "Mac Tidar Mail", tagline: "End-to-end encrypted email", logo: "cid:logo" }, content);
    const attachments = brand
      ? (logo ? [{ filename: `logo.${logo.ext}`, content: logo.content, contentType: logo.contentType, cid: "logo", contentDisposition: "inline" as const }] : [])
      : [{ filename: "mactidar.png", content: Buffer.from(MAC_TIDAR_MARK_PNG, "base64"), contentType: "image/png", cid: "logo", contentDisposition: "inline" as const }];
    const from = `Mac Tidar Mail <no-reply@${config.signupDomain}>`;
    try {
      const raw = await new MailComposer({ from, to: acct.email, subject, text, html, attachments }).compile().build();
      await ses.send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [acct.email] }, Content: { Raw: { Data: raw } } }));
    } catch (e) { console.error(JSON.stringify({ event: "notice-failed", name: (e as Error).name })); }
  }
  const openYourself = `Open **mail.${config.signupDomain}** yourself and sign in`;
  const setupPage = `**mail.${config.signupDomain}/business**`;

  /** Tells a domain's owner (at their backup email) that it stopped or started working. */
  async function noticeOwner(d: DomainItem, subject: string, title: string, line: string) {
    await notify(d.ownerAddress, subject, { preview: line, title, body: [line], facts: [["Domain", d.domain]], after: [`${openYourself}, then go to ${setupPage} to see which DNS records need fixing.`] }, brandOf(d));
  }

  const PURPOSE_LABEL: Record<string, string> = { Ownership: "Ownership", DKIM: "DKIM", MX: "Mail delivery", SPF: "SPF", DMARC: "DMARC" };
  const emailRecords = (records: DnsRecord[]): EmailRecord[] => records.map(r => ({ type: r.type, host: r.host, value: r.value, priority: r.priority, label: PURPOSE_LABEL[r.purpose] ?? r.purpose }));
  const claimRecords = (c: ClaimItem) => [ownershipRecord(c.domain, c.token), ...dnsRecords(c.domain, c.dkimTokens, config.region)];
  /** Records a claim still needs (SPF and DMARC are optional), for reminders. */
  const missingRecords = (c: ClaimItem) => claimRecords(c).filter(r => !c.checks[r.check] && r.check !== "spf" && r.check !== "dmarc" && !(r.check === "dkim" && c.checks.dkimRecords));
  const until = (iso: string) => new Date(iso).toUTCString().replace(/:\d\d GMT$/, " GMT");

  /** An identity SES may or may not still have; DKIM tokens are the same for everyone claiming it. */
  async function domainIdentity(domain: string): Promise<{ dkimTokens: string[]; dkimVerified: boolean }> {
    try {
      const r = await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: domain, ConfigurationSetName: config.configurationSet, DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" } }));
      return { dkimTokens: r.DkimAttributes?.Tokens ?? [], dkimVerified: false };
    } catch (e) {
      if ((e as Error).name !== "AlreadyExistsException") throw e;
      const r = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      return { dkimTokens: r.DkimAttributes?.Tokens ?? [], dkimVerified: r.DkimAttributes?.Status === "SUCCESS" };
    }
  }

  async function claimsFor(domain: string): Promise<ClaimItem[]> {
    // Consistent: a claim that just won (and was deleted) must not show up as "another" claim.
    const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, ConsistentRead: true, KeyConditionExpression: "pk = :p AND begins_with(sk, :c)", ExpressionAttributeValues: { ":p": domainKey(domain).pk, ":c": CLAIM_PREFIX } }));
    return Items as ClaimItem[];
  }

  async function deleteBrandObject(key: string | undefined) {
    if (key && config.brandBucket) await s3.send(new DeleteObjectCommand({ Bucket: config.brandBucket, Key: key })).catch(e => console.error(JSON.stringify({ event: "logo-delete-failed", name: (e as Error).name })));
  }

  /** Copies an uploaded logo to where verified domains' logos are served from. */
  async function publishLogo(domain: string, uploadKey: string): Promise<string | undefined> {
    if (!config.brandBucket) return undefined;
    const ext = uploadKey.split(".").pop()!;
    const key = `${logoPrefix(domain)}${randomBytes(12).toString("hex")}.${ext}`;
    const type = Object.entries(LOGO_TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    await s3.send(new CopyObjectCommand({ Bucket: config.brandBucket, Key: key, CopySource: `${config.brandBucket}/${encodeURIComponent(uploadKey)}`,
      MetadataDirective: "REPLACE", ContentType: type, CacheControl: "public, max-age=31536000, immutable" }));
    await deleteBrandObject(uploadKey);
    return key;
  }

  /**
   * Ends a claim. "expired" and "lost" also delete a Business sign-up's account (its address is on
   * a domain it never got); "cancelled" is the owner removing it themselves and keeps the account.
   */
  async function releaseClaim(c: ClaimItem, reason: "expired" | "lost" | "cancelled") {
    if (reason === "expired") await notify(c.ownerAddress, `${c.domain} was released`, {
      preview: `${c.domain} wasn't verified within 3 days.`, title: `${c.domain} was released`,
      body: [`**${c.domain}** wasn't verified within 3 days, so it has been released from Mac Tidar Mail.`,
        ownsAddressOn(c.ownerAddress, c.domain) ? `Your sign-up for **${c.ownerAddress}** was removed with it. You're welcome to sign up again whenever the DNS records are ready.` : `You can connect it again whenever the DNS records are ready.`],
    }, brandOf(c));
    if (reason === "lost") await notify(c.ownerAddress, `${c.domain} was verified by someone else`, {
      preview: `Someone else proved they control the DNS for ${c.domain}.`, title: `${c.domain} was verified by someone else`,
      body: [`Someone else proved they control the DNS for **${c.domain}**: their ownership record appeared first, so your setup has been removed.`,
        `If that wasn't someone from your company, check who can change the DNS for ${c.domain}.`],
    }, brandOf(c));
    await ddb.send(new DeleteCommand({ TableName: T, Key: claimKey(c.domain, c.ownerSub) }));
    await deleteBrandObject(c.pendingLogoKey);
    const [{ Item: meta }, others] = await Promise.all([ddb.send(new GetCommand({ TableName: T, Key: domainKey(c.domain), ConsistentRead: true })), claimsFor(c.domain)]);
    if (!meta && others.every(o => o.ownerSub === c.ownerSub)) await removeDomainIdentity(c.domain);
    if (reason !== "cancelled" && users && ownsAddressOn(c.ownerAddress, c.domain)) await users.remove(c.ownerAddress);
    console.log(JSON.stringify({ event: "claim-released", reason }));
  }

  /** The claim proved it controls the domain: it becomes the domain, and every other claim goes. */
  async function winClaim(c: ClaimItem, checks: ClaimChecks): Promise<DomainItem | null> {
    const now = new Date().toISOString();
    const logoKey = c.pendingLogoKey ? await publishLogo(c.domain, c.pendingLogoKey).catch(() => undefined) : undefined;
    const domainChecks = { dkim: checks.dkim, mx: checks.mx, spf: checks.spf, dmarc: checks.dmarc, dkimRecords: checks.dkimRecords };
    const d: DomainItem = { ...domainKey(c.domain), type: "domain", domain: c.domain, ownerSub: c.ownerSub, ownerAddress: c.ownerAddress, displayName: c.displayName,
      status: "active", dkimTokens: c.dkimTokens, checks: domainChecks, createdAt: c.createdAt, checkedAt: now, verifiedAt: now,
      ...(logoKey ? { logoKey } : {}), gsi1pk: domainsGsi1(c.ownerSub), gsi1sk: c.domain, gsi2pk: ALL_DOMAINS, gsi2sk: c.domain };
    const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
      { Put: { TableName: T, Item: d, ConditionExpression: "attribute_not_exists(pk)" } },
      { Delete: { TableName: T, Key: claimKey(c.domain, c.ownerSub), ConditionExpression: "attribute_exists(pk)" } },
    ];
    // A Business sign-up's own address goes on the domain too; its mailbox opens at their next sign-in.
    if (ownsAddressOn(c.ownerAddress, c.domain)) {
      const acct = await account(c.ownerAddress);
      if (acct) {
        const owner: PersonItem = { ...personKey(c.domain, c.ownerAddress), type: "person", address: c.ownerAddress, domain: c.domain, givenName: acct.givenName || c.displayName,
          familyName: acct.familyName, backupEmail: acct.email, status: "invited", createdAt: now };
        items.push({ Put: { TableName: T, Item: owner, ConditionExpression: "attribute_not_exists(pk)" } });
      }
    }
    try { await ddb.send(new TransactWriteCommand({ TransactItems: items })); }
    catch (e) {
      if (!(e instanceof TransactionCanceledException)) throw e;
      await deleteBrandObject(logoKey);
      // Someone else's claim won in the meantime.
      if (e.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") await releaseClaim(c, "lost");
      return null;
    }
    console.log(JSON.stringify({ event: "claim-won" }));
    for (const other of (await claimsFor(c.domain)).filter(o => o.ownerSub !== c.ownerSub)) await releaseClaim(other, "lost").catch(e => console.error(JSON.stringify({ event: "claim-release-failed", name: (e as Error).name })));
    await removeOtherSignups(c.domain, c.ownerAddress);
    await notify(c.ownerAddress, `${c.domain} is live on Mac Tidar Mail`, {
      preview: `Mail for ${c.domain} now arrives in Mac Tidar Mail.`, title: `${c.domain} is live`,
      body: [`Your DNS records are verified. Mail for **${c.domain}** now arrives in Mac Tidar Mail, end-to-end encrypted.`,
        ownsAddressOn(c.ownerAddress, c.domain) ? `${openYourself} with your address to open your mailbox, then go to ${setupPage} to add your team.` : `${openYourself}, then go to ${setupPage} to add your team.`],
      facts: ownsAddressOn(c.ownerAddress, c.domain) ? [["Your address", c.ownerAddress]] : [["Domain", c.domain]],
    }, { name: d.displayName, logoKey: d.logoKey });
    return d;
  }

  /** Business sign-ups on a domain someone else just won: their accounts go (people already added stay). */
  async function removeOtherSignups(domain: string, winner: string) {
    const { Items = [] } = await ddb.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)", ExpressionAttributeValues: { ":p": domainKey(domain).pk, ":s": SIGNUP_PREFIX } }));
    for (const x of Items as SignupItem[]) {
      if (x.address !== winner && users) await users.remove(x.address).catch(e => console.error(JSON.stringify({ event: "signup-remove-failed", name: (e as Error).name })));
      await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: x.pk, sk: x.sk } }));
    }
  }

  /** Re-checks a claim; returns the domain if this check verified it. */
  async function refreshClaim(c: ClaimItem): Promise<{ claim: ClaimItem } | { domain: DomainItem } | { lost: true }> {
    const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: c.domain })).catch(e => { if ((e as Error).name === "NotFoundException") return null; throw e; });
    if (!identity) c = { ...c, dkimTokens: (await domainIdentity(c.domain)).dkimTokens }; // released and recreated; DKIM starts over
    const r = await resolverFor(c.domain);
    const [dnsChecks, ownership] = await Promise.all([checkDns(c.domain, identity?.DkimAttributes?.Status === "SUCCESS", config.region, r, c.dkimTokens), checkOwnership(c.domain, c.token, r)]);
    const checks: ClaimChecks = { ...dnsChecks, ownership };
    if (ownership && isReady(checks)) {
      const d = await winClaim(c, checks);
      return d ? { domain: d } : { lost: true };
    }
    const next: ClaimItem = { ...c, checks, checkedAt: new Date().toISOString() };
    try { await ddb.send(new PutCommand({ TableName: T, Item: next, ConditionExpression: "attribute_exists(pk)" })); }
    catch (e) { if (e instanceof ConditionalCheckFailedException) return { lost: true }; throw e; }
    return { claim: next };
  }

  /** Every 15 minutes: check pending claims, remind their owners, release the ones never verified. */
  async function checkAllClaims() {
    const counts = { checked: 0, verified: 0, released: 0, reminded: 0, failed: 0 };
    let start: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi2", KeyConditionExpression: "gsi2pk = :c", ExpressionAttributeValues: { ":c": ALL_CLAIMS }, ExclusiveStartKey: start }));
      for (const c of (page.Items ?? []) as ClaimItem[]) {
        try {
          const age = Date.now() - Date.parse(c.createdAt);
          if (pendingExpiry(c.createdAt).getTime() <= Date.now()) { await releaseClaim(c, "expired"); counts.released++; continue; }
          const r = await refreshClaim(c);
          counts.checked++;
          if ("domain" in r) { counts.verified++; continue; }
          if (!("claim" in r)) continue;
          const now = new Date().toISOString(), missing = emailRecords(missingRecords(r.claim));
          if (age >= WARN_AFTER_MS && !c.warnedAt) {
            await notify(c.ownerAddress, `${c.domain} will be released tomorrow`, {
              preview: `${c.domain} still isn't verified.`, title: `${c.domain} will be released tomorrow`,
              body: [`**${c.domain}** still isn't verified. If it isn't by **${until(pendingExpiry(c.createdAt).toISOString())}**, it's released${ownsAddressOn(c.ownerAddress, c.domain) ? " along with your sign-up" : ""}.`,
                missing.length ? "These records still aren't there:" : "Your records are in place; Amazon is still confirming the DKIM records."],
              records: missing, after: [`${openYourself}, then go to ${setupPage} for the exact records and a Verify now button.`],
            }, brandOf(r.claim));
            await ddb.send(new UpdateCommand({ TableName: T, Key: claimKey(c.domain, c.ownerSub), UpdateExpression: "SET warnedAt = :t, remindedAt = if_not_exists(remindedAt, :t)", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":t": now } }));
            counts.reminded++;
          } else if (age >= REMIND_AFTER_MS && !c.remindedAt) {
            await notify(c.ownerAddress, `${c.domain} is waiting for its DNS records`, {
              preview: `A few DNS records for ${c.domain} aren't there yet.`, title: `${c.domain} is waiting for its DNS records`,
              body: [missing.length ? `We check **${c.domain}** every 15 minutes, and these records aren't there yet:` : `Your records for **${c.domain}** are in place; Amazon is still confirming the DKIM records. We'll email you the moment it's verified.`],
              records: missing, after: [`${openYourself}, then go to ${setupPage} for the exact records and a Verify now button.`],
            }, brandOf(r.claim));
            await ddb.send(new UpdateCommand({ TableName: T, Key: claimKey(c.domain, c.ownerSub), UpdateExpression: "SET remindedAt = :t", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":t": now } }));
            counts.reminded++;
          }
        } catch (e) {
          counts.failed++;
          console.error(JSON.stringify({ event: "claim-check-failed", name: (e as Error).name }));
        }
      }
      start = page.LastEvaluatedKey;
    } while (start);
    console.log(JSON.stringify({ event: "claims-checked", ...counts }));
    return counts;
  }

  /** Daily: release domains never verified, and re-check the rest (DNS can change at any time). */
  /** Re-checks a company's mail.<domain>: its CNAME (on the domain's own nameservers) and CloudFront's side. */
  async function refreshWebHost(d: DomainItem): Promise<DomainItem> {
    if (!d.webHost || !webHosts) return d;
    const want = webHosts.routingEndpoint.toLowerCase();
    const r = await resolverFor(d.domain);
    const cnames = await (r.resolveCname?.(d.webHost.host) ?? Promise.resolve([])).catch(e => { if (e instanceof DnsUnavailable) throw e; return [] as string[]; });
    const dns = cnames.some(c => c.toLowerCase().replace(/\.$/, "") === want);
    const cf = await webHosts.status(d.webHost.tenantId);
    const webHost: WebHost = { ...d.webHost, dns, certificate: cf.certificate, status: cf.active && cf.certificate === "issued" ? "active" : "pending", checkedAt: new Date().toISOString() };
    await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(d.domain), UpdateExpression: "SET webHost = :w", ConditionExpression: "attribute_exists(webHost)", ExpressionAttributeValues: { ":w": webHost } }));
    if (d.webHost.status !== "active" && webHost.status === "active") {
      await notify(d.ownerAddress, `${webHost.host} is ready`, {
        preview: `Your team can now sign in at ${webHost.host}.`, title: `${webHost.host} is ready`,
        body: [`Mac Tidar Mail now opens at **${webHost.host}**, with your logo from the first screen. Everyone on ${d.domain} can sign in there; mail.mactidar.com keeps working too.`],
        facts: [["Web address", webHost.host]],
      }, brandOf(d));
    }
    return { ...d, webHost };
  }

  /** Stops serving a company's mail.<domain>; the CloudFront tenant is deleted later, once that's deployed. */
  async function retireWebHost(d: DomainItem) {
    if (!d.webHost || !webHosts) return;
    await webHosts.disable(d.webHost.tenantId);
    const purge = { pk: `TENANTPURGE#${d.webHost.tenantId}`, sk: "PURGE", tenantId: d.webHost.tenantId, createdAt: new Date().toISOString(), gsi2pk: "TENANTPURGES", gsi2sk: d.webHost.tenantId };
    await ddb.send(new PutCommand({ TableName: T, Item: purge }));
  }

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
          const refreshed = await refreshDomain(d);
          // The web address is a side feature: its check failing must not stop the domain's own.
          const next = await refreshWebHost(refreshed).catch(e => { console.error(JSON.stringify({ event: "web-host-check-failed", name: (e as Error).name })); return refreshed; });
          counts.checked++;
          if (d.status === "active" && next.status === "suspended") {
            counts.suspended++;
            await noticeOwner(next, "Your domain stopped working with Mac Tidar Mail", `${d.domain} stopped working`, `Mail for ${d.domain} has stopped working because its DNS records for Mac Tidar Mail (DKIM or MX) are missing or changed. Mail sent to it may bounce until they're fixed; it starts working again by itself once they are.`);
          } else if (d.status === "suspended" && next.status === "active") {
            counts.restored++;
            await noticeOwner(next, "Your domain is working again", `${d.domain} is working again`, `The DNS records for ${d.domain} are correct again, so its mail is working with Mac Tidar Mail.`);
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
    // CloudFront tenants for web addresses that were turned off: deleted once disabling has deployed.
    start = undefined;
    do {
      const page: QueryCommandOutput = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi2", KeyConditionExpression: "gsi2pk = :p", ExpressionAttributeValues: { ":p": "TENANTPURGES" }, ExclusiveStartKey: start }));
      for (const x of (page.Items ?? []) as { pk: string; sk: string; tenantId: string }[]) {
        try { if (webHosts && await webHosts.remove(x.tenantId)) await ddb.send(new DeleteCommand({ TableName: T, Key: { pk: x.pk, sk: x.sk } })); }
        catch (e) { counts.failed++; console.error(JSON.stringify({ event: "tenant-purge-failed", name: (e as Error).name })); }
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

  const publicPerson = (x: PersonItem, d?: DomainItem) => ({ address: x.address, givenName: x.givenName, familyName: x.familyName, backupEmail: x.backupEmail, status: x.status, createdAt: x.createdAt, activatedAt: x.activatedAt ?? null, owner: x.address === d?.ownerAddress });

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
    // Read the domain directly: the directory's cache may still say "not verified" for a minute.
    const [{ Item: dItem }, { Item }] = await Promise.all([ddb.send(new GetCommand({ TableName: T, Key: domainKey(domain) })), ddb.send(new GetCommand({ TableName: T, Key: personKey(domain, address) }))]);
    const d = dItem as DomainItem | undefined, person = Item as PersonItem | undefined;
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

  const logoUrl = (key: string | undefined) => key && config.brandUrl ? `${config.brandUrl}/${key}` : null;
  /** What the owner sees: status, checks and the records to add. Never the owner's sub. */
  const publicDomain = (d: DomainItem) => ({
    domain: d.domain, displayName: d.displayName, status: d.status, suspendedFor: d.suspendedFor ?? null, checks: { ...d.checks, ownership: true },
    records: dnsRecords(d.domain, d.dkimTokens, config.region), createdAt: d.createdAt, checkedAt: d.checkedAt ?? null, verifiedAt: d.verifiedAt ?? null,
    expiresAt: d.status === "pending" ? pendingExpiry(d.createdAt).toISOString() : null,
    logoUrl: logoUrl(d.logoKey), ownAddress: ownsAddressOn(d.ownerAddress, d.domain) ? d.ownerAddress : null,
    // mail.<domain>: offered once the domain is verified, when this deployment has web hosts.
    web: webHosts && d.status !== "pending" ? {
      host: d.webHost?.host ?? webHostName(d.domain), enabled: !!d.webHost, status: d.webHost?.status ?? null, dns: d.webHost?.dns ?? false, certificate: d.webHost?.certificate ?? null,
      record: { purpose: "Web address", type: "CNAME", name: d.webHost?.host ?? webHostName(d.domain), host: "mail", value: webHosts.routingEndpoint },
    } : null,
  });
  /** A claim looks like a pending domain, plus its own ownership record. Its logo is only previewed (signed URL). */
  const publicClaim = async (c: ClaimItem) => ({
    domain: c.domain, displayName: c.displayName, status: "pending" as const, suspendedFor: null, checks: c.checks,
    records: claimRecords(c), createdAt: c.createdAt, checkedAt: c.checkedAt ?? null, verifiedAt: null, expiresAt: pendingExpiry(c.createdAt).toISOString(),
    logoUrl: c.pendingLogoKey && config.brandBucket ? await presign(s3, new GetObjectCommand({ Bucket: config.brandBucket, Key: c.pendingLogoKey, ResponseCacheControl: "no-store" })) : null,
    ownAddress: ownsAddressOn(c.ownerAddress, c.domain) ? c.ownerAddress : null,
  });

  /** The caller's verified domain or their own claim on it; 404 for anyone else's. */
  async function ownedEntry(sub: string, raw: string | undefined): Promise<{ domain: DomainItem } | { claim: ClaimItem }> {
    let domain: string;
    try { domain = parseDomain(decodeURIComponent(raw ?? ""), config.localDomains); } catch { throw new NotFound(); }
    const [{ Item: meta }, { Item: claim }] = await Promise.all([
      ddb.send(new GetCommand({ TableName: T, Key: domainKey(domain) })), ddb.send(new GetCommand({ TableName: T, Key: claimKey(domain, sub) })),
    ]);
    if ((meta as DomainItem | undefined)?.ownerSub === sub) return { domain: meta as DomainItem };
    if (claim) return { claim: claim as ClaimItem };
    throw new NotFound();
  }
  const publicEntry = async (e: { domain: DomainItem } | { claim: ClaimItem }) => "domain" in e ? publicDomain(e.domain) : publicClaim(e.claim);

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
        const mailboxes = await Promise.all((Items as MailboxMeta[]).filter(m => m.status === "active" && m.ownerSub === sub).map(async m => {
          // Addresses on a verified customer domain carry its company name and logo.
          const domain = m.address.split("@")[1]!;
          const d = directory.isOwn(domain) ? undefined : await directory.lookup(domain);
          const brand = d && d.status !== "pending" ? { name: d.displayName, logoUrl: logoUrl(d.logoKey) } : null;
          return { address: m.address, displayName: m.displayName, keyState: m.keyState ?? null, keyVersion: m.keyVersion ?? 0, brand };
        }));
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
      // Connecting a domain starts a claim: DKIM + MX (shared, one SES identity per domain) prove
      // someone controls its DNS, and the claim's own ownership TXT record proves it's this account.
      case "GET /v1/domains": {
        const { Items } = await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": domainsGsi1(sub) } }));
        const entries = (Items ?? []) as (DomainItem | ClaimItem)[];
        const domains = await Promise.all(entries.map(x => x.type === "claim" ? publicClaim(x) : publicDomain(x)));
        const username = usernameOf(event), business = normalizeAddress(username).split("@")[1] !== config.signupDomain;
        return json(200, { domains, limit: business ? 1 : MAX_DOMAINS_PER_ACCOUNT, businessDomain: business ? normalizeAddress(username).split("@")[1] : null });
      }

      case "POST /v1/domains": {
        const ownerAddress = normalizeAddress(usernameOf(event));
        const body = (parseBody(event, 500) ?? {}) as { domain?: unknown; displayName?: unknown };
        const domain = parseDomain(body.domain, config.localDomains);
        const displayName = parseDisplayName(body.displayName, domain);
        // A Business account connects exactly the domain its own address is on.
        const business = ownerAddress.split("@")[1] !== config.signupDomain;
        if (business && !ownsAddressOn(ownerAddress, domain)) throw new BadRequest(`This account can only connect ${ownerAddress.split("@")[1]}`);
        const count = (await ddb.send(new QueryCommand({ TableName: T, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :o", ExpressionAttributeValues: { ":o": domainsGsi1(sub) }, Select: "COUNT" }))).Count ?? 0;
        if (count >= (business ? 1 : MAX_DOMAINS_PER_ACCOUNT)) throw new Conflict(business ? "This account is already setting up its domain." : `You can connect up to ${MAX_DOMAINS_PER_ACCOUNT} domains for now.`);
        const [{ Item: meta }, claims] = await Promise.all([ddb.send(new GetCommand({ TableName: T, Key: domainKey(domain) })), claimsFor(domain)]);
        if (meta) throw new Conflict("That domain already uses Mac Tidar Mail. Ask whoever manages it for an address.");
        if (claims.some(c => c.ownerSub === sub)) throw new Conflict("You're already setting up that domain.");
        if (claims.length >= MAX_CLAIMS_PER_DOMAIN) throw new Conflict("Too many people are setting up that domain right now. Try again in a few days.");
        const { dkimTokens } = await domainIdentity(domain);
        if (dkimTokens.length !== 3) throw new Error("SES returned no DKIM tokens");
        const now = new Date().toISOString();
        const claim: ClaimItem = { ...claimKey(domain, sub), type: "claim", domain, ownerSub: sub, ownerAddress, displayName, token: randomBytes(16).toString("hex"), dkimTokens,
          checks: NO_CLAIM_CHECKS, createdAt: now, gsi1pk: domainsGsi1(sub), gsi1sk: domain, gsi2pk: ALL_CLAIMS, gsi2sk: `${domain}#${sub}` };
        try { await ddb.send(new PutCommand({ TableName: T, Item: claim, ConditionExpression: "attribute_not_exists(pk)" })); }
        catch (e) { if (e instanceof ConditionalCheckFailedException) throw new Conflict("You're already setting up that domain."); throw e; }
        console.log(JSON.stringify({ event: "domain-claimed", business }));
        await notify(ownerAddress, `Finish connecting ${domain} to Mac Tidar Mail`, {
          preview: `Add these DNS records to finish connecting ${domain}.`, title: `Finish connecting ${domain}`,
          body: [`Add these records where you manage the DNS for **${domain}** (your domain registrar or DNS host). Keep any records you already have.`],
          records: emailRecords(claimRecords(claim)),
          after: [`"@" means ${domain} itself; some providers want that box left empty. SPF and DMARC are recommended; if ${domain} already has a record starting \`v=spf1\`, add \`include:amazonses.com\` to it instead of adding a second one.`,
            `We check every 15 minutes and email you here as soon as it's verified. You have until **${until(pendingExpiry(now).toISOString())}**.`,
            `${openYourself}, then go to ${setupPage} to copy the records or choose Verify now.`],
        }, { name: displayName });
        return json(201, await publicClaim(claim));
      }

      case "GET /v1/domains/{domain}":
        return json(200, await publicEntry(await ownedEntry(sub, p.domain)));

      case "POST /v1/domains/{domain}/check": {
        const e = await ownedEntry(sub, p.domain);
        const checkedAt = "domain" in e ? e.domain.checkedAt : e.claim.checkedAt;
        // DNS and SES lookups cost money and time; one check every 10 seconds is plenty.
        if (checkedAt && Date.now() - Date.parse(checkedAt) < 10_000) return json(200, await publicEntry(e));
        try {
          if ("domain" in e) return json(200, publicDomain(await refreshWebHost(await refreshDomain(e.domain))));
          const r = await refreshClaim(e.claim);
          if ("lost" in r) throw new NotFound();
          return json(200, "domain" in r ? publicDomain(r.domain) : await publicClaim(r.claim));
        } catch (err) {
          // Nothing was saved: the last answers stand rather than being replaced by "not found".
          if (err instanceof DnsUnavailable) throw new Conflict(`Couldn’t reach the DNS servers for ${err.domain} just now, so nothing changed. Try again in a minute.`);
          throw err;
        }
      }

      case "PATCH /v1/domains/{domain}": {
        const e = await ownedEntry(sub, p.domain);
        const body = (parseBody(event, 500) ?? {}) as { displayName?: unknown };
        const name = "domain" in e ? e.domain.domain : e.claim.domain;
        const displayName = parseDisplayName(body.displayName, name);
        const key = "domain" in e ? domainKey(name) : claimKey(name, sub);
        await ddb.send(new UpdateCommand({ TableName: T, Key: key, UpdateExpression: "SET displayName = :n", ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":n": displayName, ":s": sub } }));
        return json(200, await publicEntry("domain" in e ? { domain: { ...e.domain, displayName } } : { claim: { ...e.claim, displayName } }));
      }

      // ── Company logo: the browser uploads straight to the brand bucket, then confirms ─────
      case "POST /v1/domains/{domain}/logo": {
        if (!config.brandBucket) throw new NotFound();
        const e = await ownedEntry(sub, p.domain);
        const name = "domain" in e ? e.domain.domain : e.claim.domain;
        const { contentType } = (parseBody(event, 200) ?? {}) as { contentType?: unknown };
        const ext = typeof contentType === "string" ? LOGO_TYPES[contentType] : undefined;
        if (!ext) throw new BadRequest("Use a PNG, JPEG or WebP image");
        const key = `${uploadPrefix(name, sub)}${randomBytes(12).toString("hex")}.${ext}`;
        const form = await presignPost(s3, { bucket: config.brandBucket, key, contentType: contentType as string });
        return json(200, { ...form, key, maxBytes: MAX_LOGO_BYTES });
      }

      case "PUT /v1/domains/{domain}/logo": {
        if (!config.brandBucket) throw new NotFound();
        const e = await ownedEntry(sub, p.domain);
        const name = "domain" in e ? e.domain.domain : e.claim.domain;
        const { key } = (parseBody(event, 400) ?? {}) as { key?: unknown };
        const prefix = uploadPrefix(name, sub);
        if (typeof key !== "string" || !key.startsWith(prefix) || !/^[0-9a-f]{24}\.(png|jpg|webp)$/.test(key.slice(prefix.length))) throw new BadRequest("Upload the logo first");
        const head = await s3.send(new HeadObjectCommand({ Bucket: config.brandBucket, Key: key })).catch(err => { if ((err as Error).name === "NotFound") return null; throw err; });
        if (!head || !head.ContentLength || head.ContentLength > MAX_LOGO_BYTES || LOGO_TYPES[head.ContentType ?? ""] !== key.split(".").pop()) {
          await deleteBrandObject(key);
          throw new BadRequest("Use a PNG, JPEG or WebP image up to 1 MB");
        }
        if ("domain" in e) {
          // Verified domains show their logo to everyone on them straight away.
          const logoKey = await publishLogo(name, key);
          await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(name), UpdateExpression: "SET logoKey = :k", ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":k": logoKey, ":s": sub } }));
          await deleteBrandObject(e.domain.logoKey);
          return json(200, publicDomain({ ...e.domain, logoKey }));
        }
        // Until the domain is verified the logo stays private: nobody can publish a logo for a domain they don't control.
        await ddb.send(new UpdateCommand({ TableName: T, Key: claimKey(name, sub), UpdateExpression: "SET pendingLogoKey = :k", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":k": key } }));
        if (e.claim.pendingLogoKey !== key) await deleteBrandObject(e.claim.pendingLogoKey);
        return json(200, await publicClaim({ ...e.claim, pendingLogoKey: key }));
      }

      case "DELETE /v1/domains/{domain}/logo": {
        const e = await ownedEntry(sub, p.domain);
        if ("domain" in e) {
          await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(e.domain.domain), UpdateExpression: "REMOVE logoKey", ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":s": sub } }));
          await deleteBrandObject(e.domain.logoKey);
          return json(200, publicDomain({ ...e.domain, logoKey: undefined }));
        }
        await ddb.send(new UpdateCommand({ TableName: T, Key: claimKey(e.claim.domain, sub), UpdateExpression: "REMOVE pendingLogoKey", ConditionExpression: "attribute_exists(pk)" }));
        await deleteBrandObject(e.claim.pendingLogoKey);
        return json(200, await publicClaim({ ...e.claim, pendingLogoKey: undefined }));
      }

      // ── People on your domain ─────────────────────────────────────────────────────────
      // The owner adds people; Cognito emails each an invite with a temporary password. Their
      // mailbox key comes from the password *they* choose, so the owner can never read their mail.
      case "GET /v1/domains/{domain}/people": {
        const d = await ownedDomain(sub, p.domain);
        const people = await listPeople(d.domain);
        return json(200, { people: people.map(x => publicPerson(x, d)), limit: MAX_PEOPLE_PER_DOMAIN });
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
        if (person.address === d.ownerAddress) throw new Conflict("That’s your own address.");
        if (person.status !== "invited") throw new Conflict("They’ve already signed in.");
        try { await users.resendInvite(person.address, person.backupEmail); }
        catch (e) { if ((e as Error).name === "UnsupportedUserStateException") throw new Conflict("They’ve already signed in."); throw e; }
        return json(200, { sent: true });
      }

      case "DELETE /v1/domains/{domain}/people/{address}": {
        if (!users) throw new NotFound();
        const d = await ownedDomain(sub, p.domain);
        const person = await domainPerson(d, p.address);
        if (person.address === d.ownerAddress) throw new Conflict("You can’t remove your own address.");
        await removePerson(person);
        console.log(JSON.stringify({ event: "person-removed" }));
        return json(200, { deleted: true });
      }

      // ── mail.<domain>: Mac Tidar Mail on the company's own web address ────────────────────
      case "POST /v1/domains/{domain}/web": {
        if (!webHosts) throw new NotFound();
        const e = await ownedEntry(sub, p.domain);
        if (!("domain" in e) || e.domain.status === "pending") throw new Conflict("Finish connecting this domain first.");
        const d = e.domain;
        if (d.webHost) return json(200, publicDomain(d));
        const host = webHostName(d.domain);
        const { tenantId } = await webHosts.create(host, d.domain).catch(err => {
          if ((err as Error).name === "CNAMEAlreadyExists" || (err as Error).name === "EntityAlreadyExists") throw new Conflict(`${host} is already in use on another CloudFront distribution. If it points somewhere else today, remove that first.`);
          throw err;
        });
        const webHost: WebHost = { host, tenantId, status: "pending", dns: false, certificate: null, createdAt: new Date().toISOString() };
        try { await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(d.domain), UpdateExpression: "SET webHost = :w", ConditionExpression: "attribute_not_exists(webHost) AND ownerSub = :s", ExpressionAttributeValues: { ":w": webHost, ":s": sub } })); }
        catch (err) { await webHosts.disable(tenantId).catch(() => {}); throw err; }
        console.log(JSON.stringify({ event: "web-host-created" }));
        return json(201, publicDomain({ ...d, webHost }));
      }

      case "DELETE /v1/domains/{domain}/web": {
        if (!webHosts) throw new NotFound();
        const e = await ownedEntry(sub, p.domain);
        if (!("domain" in e) || !e.domain.webHost) throw new NotFound();
        await retireWebHost(e.domain);
        await ddb.send(new UpdateCommand({ TableName: T, Key: domainKey(e.domain.domain), UpdateExpression: "REMOVE webHost", ConditionExpression: "ownerSub = :s", ExpressionAttributeValues: { ":s": sub } }));
        const rest: DomainItem = { ...e.domain };
        delete rest.webHost;
        return json(200, publicDomain(rest));
      }

      case "DELETE /v1/domains/{domain}": {
        const e = await ownedEntry(sub, p.domain);
        if ("claim" in e) { await releaseClaim(e.claim, "cancelled"); return json(200, { deleted: true }); }
        const d = e.domain;
        if (ownsAddressOn(d.ownerAddress, d.domain)) throw new Conflict(`Your own address, ${d.ownerAddress}, is on this domain, so it can't be disconnected from here.`);
        if ((await listPeople(d.domain)).length > 0) throw new Conflict("Remove everyone on this domain first.");
        await retireWebHost(d);
        await removeDomainIdentity(d.domain);
        await deleteBrandObject(d.logoKey);
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

  /**
   * Public: a verified company domain's name and logo, so the sign-in screen can show it as
   * someone types their address. Only for verified domains (whose MX already points at us),
   * and the same 404 for "not a customer" and "not verified", so it reveals nothing more.
   */
  async function publicBrand(event: Event): Promise<Result> {
    let domain: string;
    try { domain = parseDomain(event.queryStringParameters?.domain ?? "", config.localDomains); } catch { return json(404, { error: "Not found" }); }
    const d = await directory.lookup(domain);
    if (!d || d.status === "pending") return json(404, { error: "Not found" });
    return { ...json(200, { domain: d.domain, name: d.displayName, logoUrl: logoUrl(d.logoKey) }), headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } };
  }

  const api = async (event: Event): Promise<Result> => {
    if (event.routeKey === "GET /v1/brand") return publicBrand(event).catch(() => json(500, { error: "Something went wrong" }));
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
  return Object.assign(api, { checkAllDomains, checkAllClaims });
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
    webHosts: process.env.WEB_DISTRIBUTION_ID ? cloudFrontWebHosts(new CloudFrontClient({ region: "us-east-1" }), {
      distributionId: env("WEB_DISTRIBUTION_ID"), connectionGroupId: env("WEB_CONNECTION_GROUP_ID"), routingEndpoint: env("WEB_ROUTING_ENDPOINT").replace(/\.$/, ""),
    }) : undefined,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    s3: new S3Client({}),
    ses: new SESv2Client({}),
    config: {
      table: env("MAIL_TABLE"), bucket: env("MAIL_BUCKET"), configurationSet: env("SES_CONFIGURATION_SET"), region: env("AWS_REGION"),
      localDomains: env("LOCAL_MAIL_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
      signupDomain: env("SIGNUP_DOMAIN").trim().toLowerCase(),
      brandBucket: process.env.BRAND_BUCKET || undefined, brandUrl: process.env.BRAND_URL?.replace(/\/$/, "") || undefined,
    },
  }))(new CognitoIdentityProviderClient({}));
  // The daily schedule invokes this function directly; API Gateway events always carry routeKey.
  if (!("routeKey" in event)) {
    if (event.task === "check-domains") return cached.checkAllDomains();
    if (event.task === "check-claims") return cached.checkAllClaims();
    throw new Error("Unknown task");
  }
  return cached(event);
};
