// Domain checks ask the domain's own nameservers, and never mistake a failed lookup for a missing record.
import { describe, expect, it } from "vitest";
import { authoritativeResolver, DnsUnavailable } from "../../src/shared/dns";

const err = (code: string) => Object.assign(new Error(code), { code });

/** A stand-in for node:dns/promises: `zone` answers through whichever servers were set. */
function fakeBase(opts: { ns?: Record<string, string[]>; a?: Record<string, string[]>; answer: (server: string[] | null, kind: string, name: string) => unknown }) {
  class Resolver {
    servers: string[] = [];
    constructor(public o: unknown) {}
    setServers(s: string[]) { this.servers = s; }
    async resolveMx(n: string) { return opts.answer(this.servers, "MX", n); }
    async resolveTxt(n: string) { return opts.answer(this.servers, "TXT", n); }
    async resolveCname(n: string) { return opts.answer(this.servers, "CNAME", n); }
  }
  return {
    Resolver,
    resolveNs: async (z: string) => { const r = opts.ns?.[z]; if (!r) throw err("ENODATA"); return r; },
    resolve4: async (h: string) => { const r = opts.a?.[h]; if (!r) throw err("ENOTFOUND"); return r; },
    resolveMx: async (n: string) => opts.answer(null, "MX", n),
    resolveTxt: async (n: string) => opts.answer(null, "TXT", n),
    resolveCname: async (n: string) => opts.answer(null, "CNAME", n),
  } as never;
}

describe("authoritative DNS checks", () => {
  it("asks the zone's own nameservers, walking up from a subdomain", async () => {
    let asked: string[] | null = null;
    const base = fakeBase({ ns: { "zetca.pro": ["ns1.porkbun.com"] }, a: { "ns1.porkbun.com": ["192.0.2.1"] }, answer: (s, kind) => { asked = s; return kind === "MX" ? [{ exchange: "mx", priority: 10 }] : []; } });
    expect(await (await authoritativeResolver("mail.zetca.pro", base)).resolveMx("mail.zetca.pro")).toEqual([{ exchange: "mx", priority: 10 }]);
    expect(asked).toEqual(["192.0.2.1"]);
  });
  it("passes real 'no such record' answers through, and turns failures into DnsUnavailable", async () => {
    const base = fakeBase({ ns: { "zetca.pro": ["ns1"] }, a: { ns1: ["192.0.2.1"] }, answer: (_s, kind) => { throw err(kind === "MX" ? "ENODATA" : "ETIMEOUT"); } });
    const r = await authoritativeResolver("zetca.pro", base);
    await expect(r.resolveMx("zetca.pro")).rejects.toMatchObject({ code: "ENODATA" });
    await expect(r.resolveTxt("_mactidar.zetca.pro")).rejects.toBeInstanceOf(DnsUnavailable);
  });
  it("falls back to the system resolver when no nameservers can be found", async () => {
    let asked: string[] | null | undefined;
    const base = fakeBase({ answer: (s) => { asked = s; return [["v=spf1"]]; } });
    await (await authoritativeResolver("zetca.pro", base)).resolveTxt("zetca.pro");
    expect(asked).toBeNull();
  });
});
