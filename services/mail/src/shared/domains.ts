// Customer domains ("bring your own domain"). Any Mac Tidar Mail user can connect a domain they
// control. Control is proven by DNS: SES only marks the domain verified once its three DKIM
// CNAMEs resolve, and mail only arrives once its MX points at us. Domains are data, not
// Terraform: each one gets its own SES identity, created by the API.
import { domainToASCII } from "node:url";
import { BadRequest } from "../api/validate";

/** Free-tier limits. */
export const MAX_DOMAINS_PER_ACCOUNT = 2;
export const MAX_PEOPLE_PER_DOMAIN = 25;
export const DOMAIN_DAILY_RECIPIENT_LIMIT = 500;
/** A domain that hasn't passed its checks by then is released, so nobody can sit on a name. */
export const PENDING_DOMAIN_DAYS = 3;

export type DomainStatus = "pending" | "active" | "suspended";
export interface DomainChecks { dkim: boolean; mx: boolean; spf: boolean; dmarc: boolean }

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
  gsi1pk: string; gsi1sk: string;
  /** Every domain shares one gsi2 partition so the daily check can list them all. */
  gsi2pk: typeof ALL_DOMAINS; gsi2sk: string;
}

export const domainKey = (domain: string) => ({ pk: `DOMAIN#${domain}`, sk: "META" as const });
export const domainsGsi1 = (ownerSub: string) => `DOMAINS#${ownerSub}`;
/** gsi1 partition for the people (mailboxes) on a domain. */
export const domainPeopleGsi1 = (domain: string) => `DOMAINPEOPLE#${domain}`;
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

export type RecordPurpose = "DKIM" | "MX" | "SPF" | "DMARC";
export interface DnsRecord { purpose: RecordPurpose; type: "CNAME" | "MX" | "TXT"; /** Full name */ name: string; /** Name relative to the domain ("@" for the domain itself) */ host: string; value: string; priority?: number; check: keyof DomainChecks }

export const inboundMx = (region: string) => `inbound-smtp.${region}.amazonaws.com`;

/** The records the owner adds at their DNS provider. */
export function dnsRecords(domain: string, dkimTokens: string[], region: string): DnsRecord[] {
  const rel = (name: string) => name === domain ? "@" : name.slice(0, -(domain.length + 1));
  const rec = (r: Omit<DnsRecord, "host">): DnsRecord => ({ ...r, host: rel(r.name) });
  return [
    ...dkimTokens.map(t => rec({ purpose: "DKIM", type: "CNAME", name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`, check: "dkim" })),
    rec({ purpose: "MX", type: "MX", name: domain, value: inboundMx(region), priority: 10, check: "mx" }),
    rec({ purpose: "SPF", type: "TXT", name: domain, value: "v=spf1 include:amazonses.com ~all", check: "spf" }),
    rec({ purpose: "DMARC", type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none", check: "dmarc" }),
  ];
}

/** The DNS lookups the checks need; `node:dns/promises` in Lambda, a fake in tests. */
export interface Resolver {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED"]);
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  try { return await p; } catch (e) { if (NO_RECORD.has((e as { code?: string }).code ?? "")) return []; throw e; }
}

/** Checks DNS for the records we need. DKIM comes from SES, which looks it up itself. */
export async function checkDns(domain: string, dkimVerified: boolean, region: string, dns: Resolver): Promise<DomainChecks> {
  const [mx, txt, dmarc] = await Promise.all([orEmpty(dns.resolveMx(domain)), orEmpty(dns.resolveTxt(domain)), orEmpty(dns.resolveTxt(`_dmarc.${domain}`))]);
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

/** When an unverified domain is released. */
export const pendingExpiry = (createdAt: string) => new Date(Date.parse(createdAt) + PENDING_DOMAIN_DAYS * 86400_000);
