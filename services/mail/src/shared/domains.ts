// Customer domains ("bring your own domain"). Any Mac Tidar Mail user can connect a domain they
// control. Control is proven by DNS: SES only marks the domain verified once its three DKIM
// CNAMEs resolve, and mail only arrives once its MX points at us. Domains are data, not
// Terraform: each one gets its own SES identity, created by the API.
import { domainToASCII } from "node:url";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BadRequest } from "../api/validate";

/** Free-tier limits. */
export const MAX_DOMAINS_PER_ACCOUNT = 2;
export const MAX_PEOPLE_PER_DOMAIN = 25;
export const DOMAIN_DAILY_RECIPIENT_LIMIT = 500;
/** A domain that hasn't passed its checks by then is released, so nobody can sit on a name. */
export const PENDING_DOMAIN_DAYS = 3;
/** People setting up the same domain at once; only the one whose ownership record appears wins. */
export const MAX_CLAIMS_PER_DOMAIN = 25;
/** Reminders to a pending claim's owner, by its age. */
export const REMIND_AFTER_MS = 86400_000;
export const WARN_AFTER_MS = 2 * 86400_000;

export type DomainStatus = "pending" | "active" | "suspended";
export interface DomainChecks {
  /** Amazon SES has verified the DKIM keys (it re-checks DNS on its own schedule). */
  dkim: boolean; mx: boolean; spf: boolean; dmarc: boolean;
  /** All three DKIM CNAMEs are in DNS, whether or not SES has confirmed them yet. */
  dkimRecords?: boolean;
  /** Optional: mail.<domain> points at our CloudFront routing endpoint (the company's own web address). */
  web?: boolean;
}
/** A pending claim also needs its own ownership record, which says *who* controls the DNS. */
export interface ClaimChecks extends DomainChecks { ownership: boolean }

/** `DOMAIN#<name>/META`. Listed per owner through gsi1 (`DOMAINS#<sub>`). */
export interface DomainItem {
  pk: string; sk: "META"; type: "domain";
  domain: string;
  ownerSub: string;
  /** The owner's Mac Tidar address, for alerts and display. */
  ownerAddress: string;
  displayName: string;
  status: DomainStatus;
  dkimTokens: string[];
  checks: DomainChecks;
  createdAt: string;
  checkedAt?: string;
  verifiedAt?: string;
  /** Why it was suspended. DNS suspensions lift by themselves once the records are back; abuse ones don't. */
  suspendedFor?: "dns" | "abuse";
  /** The company logo in the brand bucket (`logos/…`), shown to everyone on the domain. */
  logoKey?: string;
  /** mail.<domain>: Mac Tidar Mail on the company's own web address, once its owner sets it up. */
  webHost?: import("./webhost").WebHost;
  /** The owner turned the web address off: don't set it up again while its CNAME is still there. */
  webOff?: boolean;
  gsi1pk: string; gsi1sk: string;
  /** Every domain shares one gsi2 partition so the daily check can list them all. */
  gsi2pk: typeof ALL_DOMAINS; gsi2sk: string;
}

/**
 * Someone setting up a domain that isn't verified yet: `DOMAIN#<name>/CLAIM#<sub>`. Several people
 * may claim the same name; DKIM and MX are shared (one SES identity), so what decides is each
 * claim's own ownership TXT record. The first claim whose record appears becomes the domain.
 */
export interface ClaimItem {
  pk: string; sk: string; type: "claim";
  domain: string; ownerSub: string; ownerAddress: string; displayName: string;
  /** Goes in `_mactidar.<domain>` as `mactidar-verify=<token>`. */
  token: string;
  dkimTokens: string[];
  checks: ClaimChecks;
  createdAt: string; checkedAt?: string;
  /** An uploaded logo waiting for verification (`uploads/…`, never served publicly). */
  pendingLogoKey?: string;
  remindedAt?: string; warnedAt?: string;
  gsi1pk: string; gsi1sk: string;
  gsi2pk: typeof ALL_CLAIMS; gsi2sk: string;
}

/** A business sign-up's address on a domain that isn't verified yet, so the winner can remove the others'. */
export interface SignupItem { pk: string; sk: string; type: "signup"; address: string; createdAt: string; expiresAt: number }

export const domainKey = (domain: string) => ({ pk: `DOMAIN#${domain}`, sk: "META" as const });
export const CLAIM_PREFIX = "CLAIM#";
export const claimKey = (domain: string, sub: string) => ({ pk: `DOMAIN#${domain}`, sk: `${CLAIM_PREFIX}${sub}` });
export const ALL_CLAIMS = "CLAIMS";
export const SIGNUP_PREFIX = "SIGNUP#";
export const signupKey = (domain: string, address: string) => ({ pk: `DOMAIN#${domain}`, sk: `${SIGNUP_PREFIX}${address}` });
export const NO_CLAIM_CHECKS: ClaimChecks = { ownership: false, dkim: false, mx: false, spf: false, dmarc: false };
/** True when the account's own sign-in address is on `domain` (it signed up through Business). */
export const ownsAddressOn = (ownerAddress: string, domain: string) => ownerAddress.split("@")[1] === domain;
export const domainsGsi1 = (ownerSub: string) => `DOMAINS#${ownerSub}`;
/** A person the owner added: `DOMAIN#<name>/PERSON#<address>`, listed with the domain's own partition. */
export const PERSON_PREFIX = "PERSON#";
export const personKey = (domain: string, address: string) => ({ pk: `DOMAIN#${domain}`, sk: `${PERSON_PREFIX}${address}` });
export interface PersonItem {
  pk: string; sk: string; type: "person";
  address: string; domain: string; givenName: string; familyName: string;
  /** Where the invite went; the person's own backup email for password resets. */
  backupEmail: string;
  /** "invited" until they first sign in and their mailbox is created. */
  status: "invited" | "active";
  createdAt: string; activatedAt?: string;
}

/** A removed person's mailbox, deleted in the background by the daily task (gsi2 `PURGES`). */
export const ALL_PURGES = "PURGES";
export const purgeKey = (address: string) => ({ pk: `PURGE#${address}`, sk: "PURGE" as const });
export interface PurgeItem { pk: string; sk: "PURGE"; address: string; ownerSub?: string; createdAt: string; gsi2pk: typeof ALL_PURGES; gsi2sk: string }
export const ALL_DOMAINS = "DOMAINS";
export const NO_CHECKS: DomainChecks = { dkim: false, mx: false, spf: false, dmarc: false };

// Public mailbox providers and our own infrastructure: nobody can bring these.
const REFUSED = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "zoho.com", "yandex.com", "mail.com", "fastmail.com", "tutanota.com", "hey.com",
  "amazonaws.com", "amazonses.com", "amplifyapp.com", "cloudfront.net",
]);
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalizes and checks a domain someone wants to connect. International names are stored in
 * their ASCII (punycode) form, which is what DNS and SES use. `ownDomains` are ours (mactidar.com):
 * they and their subdomains can't be brought.
 */
export function parseDomain(raw: unknown, ownDomains: string[]): string {
  if (typeof raw !== "string") throw new BadRequest("Enter a domain, like example.com");
  const typed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  const domain = domainToASCII(typed);
  if (!domain || domain.length > 253) throw new BadRequest("Enter a domain, like example.com");
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every(l => LABEL.test(l)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1)!)) throw new BadRequest("Enter a domain, like example.com");
  if (ownDomains.some(d => domain === d || domain.endsWith(`.${d}`))) throw new BadRequest("That domain is already part of Mac Tidar Mail");
  if (REFUSED.has(domain) || [...REFUSED].some(d => domain.endsWith(`.${d}`))) throw new BadRequest("That domain belongs to an email or cloud provider and can’t be connected");
  return domain;
}

/** The name people see on the domain's web address ("Zetca"). */
export function parseDisplayName(raw: unknown, domain: string): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return domain.split(".")[0]!.replace(/^./, c => c.toUpperCase());
  if (name.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} &'.,-]*$/u.test(name)) throw new BadRequest("Use up to 40 letters, numbers and spaces for the name");
  if (/mac\s*-?\s*tidar/i.test(name)) throw new BadRequest("The name can’t include “Mac Tidar”");
  return name;
}

export type RecordPurpose = "Ownership" | "DKIM" | "MX" | "SPF" | "DMARC" | "Web address";
export interface DnsRecord { purpose: RecordPurpose; type: "CNAME" | "MX" | "TXT"; /** Full name */ name: string; /** Name relative to the domain ("@" for the domain itself) */ host: string; value: string; priority?: number; check: Exclude<keyof ClaimChecks, "dkimRecords"> }
/** Records a domain works without: recommended (SPF, DMARC) or optional (the web address). */
export const OPTIONAL_CHECKS = new Set(["spf", "dmarc", "web"]);

export const ownershipName = (domain: string) => `_mactidar.${domain}`;
export const ownershipValue = (token: string) => `mactidar-verify=${token}`;
/** The record that proves this claim, not just someone, controls the domain's DNS. */
export const ownershipRecord = (domain: string, token: string): DnsRecord =>
  ({ purpose: "Ownership", type: "TXT", name: ownershipName(domain), host: "_mactidar", value: ownershipValue(token), check: "ownership" });

/** True when the domain's `_mactidar` TXT records include this claim's token. */
export async function checkOwnership(domain: string, token: string, dns: Resolver): Promise<boolean> {
  const txt = await orEmpty(dns.resolveTxt(ownershipName(domain)));
  return txt.some(r => r.join("").trim() === ownershipValue(token));
}

export const inboundMx = (region: string) => `inbound-smtp.${region}.amazonaws.com`;

// Easy DKIM keys live under dkim.amazonses.com in SES's original regions, but under a regional name
// (dkim.<region>.amazonses.com) in regions launched since. Pointing a CNAME at the wrong one leaves
// SES with nothing to find ("HOST_NOT_FOUND"), so the domain never verifies.
const GLOBAL_DKIM_REGIONS = new Set(["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-southeast-1", "ap-southeast-2", "sa-east-1", "us-gov-west-1"]);
/** Where a DKIM token's CNAME must point in `region`. */
export const dkimTarget = (token: string, region: string) => GLOBAL_DKIM_REGIONS.has(region) ? `${token}.dkim.amazonses.com` : `${token}.dkim.${region}.amazonses.com`;

/**
 * The records the owner adds at their DNS provider. `webTarget` (our CloudFront routing endpoint)
 * adds the optional mail.<domain> CNAME for the company's own web address.
 */
export function dnsRecords(domain: string, dkimTokens: string[], region: string, webTarget?: string): DnsRecord[] {
  const rel = (name: string) => name === domain ? "@" : name.slice(0, -(domain.length + 1));
  const rec = (r: Omit<DnsRecord, "host">): DnsRecord => ({ ...r, host: rel(r.name) });
  return [
    ...dkimTokens.map(t => rec({ purpose: "DKIM", type: "CNAME", name: `${t}._domainkey.${domain}`, value: dkimTarget(t, region), check: "dkim" })),
    rec({ purpose: "MX", type: "MX", name: domain, value: inboundMx(region), priority: 10, check: "mx" }),
    rec({ purpose: "SPF", type: "TXT", name: domain, value: "v=spf1 include:amazonses.com ~all", check: "spf" }),
    rec({ purpose: "DMARC", type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none", check: "dmarc" }),
    ...(webTarget ? [rec({ purpose: "Web address", type: "CNAME", name: `mail.${domain}`, value: webTarget, check: "web" })] : []),
  ];
}

/** The DNS lookups the checks need; `node:dns/promises` in Lambda, a fake in tests. */
export interface Resolver {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname?(name: string): Promise<string[]>;
}

// Only real "no such record" answers count as missing. A timeout or server failure is thrown, so a
// flaky lookup can't untick a record or suspend a working domain.
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "NXDOMAIN"]);
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try { return await p; } catch (e) { if (NO_RECORD.has((e as { code?: string }).code ?? "")) return []; throw e; }
}

/** True when every DKIM CNAME is in DNS and points at its SES key. */
export async function checkDkimRecords(domain: string, tokens: string[], region: string, dns: Resolver): Promise<boolean> {
  if (!dns.resolveCname || tokens.length === 0) return false;
  const found = await Promise.all(tokens.map(t => orEmpty(dns.resolveCname!(`${t}._domainkey.${domain}`))
    .then(rs => rs.some(v => v.toLowerCase().replace(/\.$/, "") === dkimTarget(t, region)))));
  return found.every(Boolean);
}

/** Checks DNS for the records we need. DKIM is confirmed by SES, which looks it up itself. */
export async function checkDns(domain: string, dkimVerified: boolean, region: string, dns: Resolver, dkimTokens: string[] = [], webTarget?: string): Promise<DomainChecks> {
  const [mx, txt, dmarc, dkimRecords, web] = await Promise.all([orEmpty(dns.resolveMx(domain)), orEmpty(dns.resolveTxt(domain)), orEmpty(dns.resolveTxt(`_dmarc.${domain}`)), checkDkimRecords(domain, dkimTokens, region, dns),
    webTarget && dns.resolveCname ? orEmpty(dns.resolveCname(`mail.${domain}`)).then(rs => rs.some(v => v.toLowerCase().replace(/\.$/, "") === webTarget.toLowerCase())) : Promise.resolve(undefined)]);
  const want = inboundMx(region);
  const joined = (rs: string[][]) => rs.map(r => r.join("").trim());
  const spf = joined(txt).filter(t => /^v=spf1\b/i.test(t));
  return {
    dkim: dkimVerified,
    // Every MX must be ours: senders may use any of them, and mail sent elsewhere never reaches us.
    mx: mx.length > 0 && mx.every(r => r.exchange.toLowerCase().replace(/\.$/, "") === want),
    // Exactly one SPF record is allowed; two make SPF fail everywhere.
    spf: spf.length === 1 && /\binclude:amazonses\.com\b/i.test(spf[0]!),
    dmarc: joined(dmarc).some(t => /^v=DMARC1\b/i.test(t)),
    dkimRecords: dkimVerified || dkimRecords,
    ...(web !== undefined ? { web } : {}),
  };
}

/** Mail arrives and sends correctly once DKIM and MX pass; SPF and DMARC are strongly recommended. */
export const isReady = (c: DomainChecks) => c.dkim && c.mx;

/** What a fresh check means for a domain's status. Shared by "Check now" and the daily check. */
export function evaluate(item: Pick<DomainItem, "status" | "suspendedFor" | "verifiedAt">, checks: DomainChecks, now: Date): Pick<DomainItem, "status" | "suspendedFor" | "verifiedAt"> {
  const ready = isReady(checks);
  if (item.status === "suspended" && item.suspendedFor === "abuse") return item;
  if (ready) return { status: "active", verifiedAt: item.verifiedAt ?? now.toISOString() };
  if (item.status === "pending") return { status: "pending" };
  return { status: "suspended", suspendedFor: "dns", verifiedAt: item.verifiedAt };
}

/** Company logos: small raster images only. SVG can carry scripts, so it's refused. */
export const MAX_LOGO_BYTES = 1024 * 1024;
export const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** Where a logo is uploaded (private) and where a verified domain's logo is served from (public). */
export const uploadPrefix = (domain: string, sub: string) => `uploads/${domain}/${sub}/`;
export const logoPrefix = (domain: string) => `logos/${domain}/`;

/** When an unverified domain is released. */
export const pendingExpiry = (createdAt: string) => new Date(Date.parse(createdAt) + PENDING_DOMAIN_DAYS * 86400_000);

/**
 * Which domains are "ours": Mac Tidar's own, plus every active customer domain. Mail between
 * addresses on these is delivered directly and end-to-end encrypted. Customer domains are looked up
 * in the table and cached briefly, so a Lambda doesn't read the same domain for every message.
 */
export function domainDirectory(ddb: DynamoDBDocumentClient, table: string, own: string[], ttlMs = 60_000) {
  const cache = new Map<string, { item: DomainItem | undefined; at: number }>();
  async function lookup(domain: string): Promise<DomainItem | undefined> {
    const hit = cache.get(domain);
    if (hit && Date.now() - hit.at < ttlMs) return hit.item;
    const Item = (await ddb.send(new GetCommand({ TableName: table, Key: domainKey(domain) })))?.Item;
    const item = Item?.type === "domain" ? Item as DomainItem : undefined;
    cache.set(domain, { item, at: Date.now() });
    return item;
  }
  const isOwn = (domain: string) => own.some(d => domain === d);
  return {
    isOwn,
    /** The customer domain, if `domain` is one (any status). */
    lookup,
    /** True for Mac Tidar's own domains and active customer domains. */
    async isLocal(domain: string) { return isOwn(domain) || (await lookup(domain))?.status === "active"; },
    /** Sending from a customer domain needs it active (DNS correct, not paused for abuse). */
    async canSendFrom(domain: string) { return isOwn(domain) || (await lookup(domain))?.status === "active"; },
  };
}
export type DomainDirectory = ReturnType<typeof domainDirectory>;
