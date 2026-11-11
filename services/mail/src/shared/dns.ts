// DNS lookups for customer-domain checks, asked of the domain's own (authoritative) nameservers.
//
// Shared resolvers cache answers, including "not found" ones (for zetca.pro, 30 minutes). A
// domain's records were usually missing the first time we looked, so going through a pool of
// caching resolvers made checks flip between found and not found for up to that long, depending
// on which resolver answered. Authoritative servers don't cache: their answer is the truth.
import { promises as dns } from "node:dns";
import type { Resolver } from "./domains";

/** A lookup that couldn't get an answer (timeout, server failure). Not the same as "the record doesn't exist". */
export class DnsUnavailable extends Error {
  constructor(readonly domain: string) { super(`Couldn't reach the DNS servers for ${domain}`); this.name = "DnsUnavailable"; }
}

/** Answers that mean "there's no such record". Anything else is a failed lookup, not an answer. */
export const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "NXDOMAIN"]);

/**
 * The nameservers that answer for `domain`'s zone: its own NS records, or its parent's for a
 * subdomain without its own zone (mail.example.com → example.com).
 */
async function nameserverIps(domain: string, base: typeof dns): Promise<string[]> {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join(".");
    const ns = await base.resolveNs(zone).catch(() => [] as string[]);
    if (!ns.length) continue;
    const ips = (await Promise.all(ns.slice(0, 4).map(h => base.resolve4(h).catch(() => [] as string[])))).flat();
    if (ips.length) return [...new Set(ips)].slice(0, 6);
  }
  return [];
}

/**
 * A resolver for checking `domain`'s records: its authoritative nameservers when they can be found,
 * otherwise the system resolver. Failed lookups throw DnsUnavailable rather than looking like
 * "record missing", so a slow nameserver can never untick a record or suspend a working domain.
 */
export async function authoritativeResolver(domain: string, base: typeof dns = dns): Promise<Resolver> {
  const ips = await nameserverIps(domain, base);
  let target: Pick<typeof dns, "resolveMx" | "resolveTxt" | "resolveCname"> = base;
  if (ips.length) { const r = new base.Resolver({ timeout: 3000, tries: 2 }); r.setServers(ips); target = r; }
  const wrap = <T>(p: Promise<T>): Promise<T> => p.catch(e => {
    if (NOT_FOUND.has((e as { code?: string }).code ?? "")) throw e;
    throw new DnsUnavailable(domain);
  });
  return {
    resolveMx: n => wrap(target.resolveMx(n)),
    resolveTxt: n => wrap(target.resolveTxt(n)),
    resolveCname: n => wrap(target.resolveCname(n)),
  };
}
