import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../../src/api/handler";
import { checkDns, dnsRecords, evaluate, NO_CHECKS, parseDisplayName, parseDomain, type DomainItem, type Resolver } from "../../src/shared/domains";

const OWN = ["mactidar.com", "beta.mactidar.com"];
const REGION = "af-south-1";
const MX = "inbound-smtp.af-south-1.amazonaws.com";
const TOKENS = ["aaa", "bbb", "ccc"];

/** A DNS zone in memory; anything not listed doesn't exist. */
function fakeDns(zone: { mx?: Record<string, { exchange: string; priority: number }[]>; txt?: Record<string, string[][]>; cname?: Record<string, string[]> }): Resolver {
  const missing = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return {
    resolveMx: async n => { const r = zone.mx?.[n]; if (!r) throw missing(); return r; },
    resolveTxt: async n => { const r = zone.txt?.[n]; if (!r) throw missing(); return r; },
    resolveCname: async n => { const r = zone.cname?.[n]; if (!r) throw missing(); return r; },
  };
}
const goodZone = { mx: { "zetca.pro": [{ exchange: `${MX}.`, priority: 10 }] }, txt: { "zetca.pro": [["v=spf1 include:amazonses.com ~all"], ["google-site-verification=x"]], "_dmarc.zetca.pro": [["v=DMARC1; p=none"]] } };

describe("domain names", () => {
  it("normalizes what people type", () => {
    expect(parseDomain("  HTTPS://Zetca.PRO/inbox ", OWN)).toBe("zetca.pro");
    expect(parseDomain("mail.zetca.pro.", OWN)).toBe("mail.zetca.pro");
    expect(parseDomain("bücher.de", OWN)).toBe("xn--bcher-kva.de");
  });
  it("refuses non-domains, our own domains and email providers", () => {
    for (const bad of ["", "localhost", "zetca", "a..b.com", "-zetca.pro", "zetca-.pro", "1.2.3.4", "zetca.p", `${"a".repeat(64)}.com`, 42])
      expect(() => parseDomain(bad, OWN), String(bad)).toThrow("Enter a domain");
    expect(() => parseDomain("mactidar.com", OWN)).toThrow("already part of Mac Tidar Mail");
    expect(() => parseDomain("x.beta.mactidar.com", OWN)).toThrow("already part of Mac Tidar Mail");
    expect(() => parseDomain("gmail.com", OWN)).toThrow("email or cloud provider");
    expect(() => parseDomain("evil.amazonaws.com", OWN)).toThrow("email or cloud provider");
  });
  it("defaults and checks the display name", () => {
    expect(parseDisplayName("", "zetca.pro")).toBe("Zetca");
    expect(parseDisplayName("  Zetca   Studio ", "zetca.pro")).toBe("Zetca Studio");
    expect(() => parseDisplayName("Mac Tidar Support", "zetca.pro")).toThrow("Mac Tidar");
    expect(() => parseDisplayName("<script>", "zetca.pro")).toThrow();
  });
});

describe("DNS records and checks", () => {
  it("lists the records to add, with names relative to the domain", () => {
    const r = dnsRecords("zetca.pro", TOKENS, REGION);
    expect(r.map(x => [x.type, x.host, x.value])).toEqual([
      ["CNAME", "aaa._domainkey", "aaa.dkim.amazonses.com"], ["CNAME", "bbb._domainkey", "bbb.dkim.amazonses.com"], ["CNAME", "ccc._domainkey", "ccc.dkim.amazonses.com"],
      ["MX", "@", MX], ["TXT", "@", "v=spf1 include:amazonses.com ~all"], ["TXT", "_dmarc", "v=DMARC1; p=none"],
    ]);
    expect(r.find(x => x.type === "MX")!.priority).toBe(10);
  });
  it("passes a correct zone", async () => {
    expect(await checkDns("zetca.pro", true, REGION, fakeDns(goodZone))).toEqual({ dkim: true, mx: true, spf: true, dmarc: true });
  });
  it("fails an MX that still sends some mail elsewhere, two SPF records, and missing records", async () => {
    const z = { ...goodZone, mx: { "zetca.pro": [{ exchange: MX, priority: 10 }, { exchange: "mx.old-host.com", priority: 20 }] }, txt: { ...goodZone.txt, "zetca.pro": [["v=spf1 include:amazonses.com ~all"], ["v=spf1 include:_spf.google.com ~all"]] } };
    expect(await checkDns("zetca.pro", false, REGION, fakeDns(z))).toEqual({ dkim: false, mx: false, spf: false, dmarc: true });
    expect(await checkDns("zetca.pro", false, REGION, fakeDns({}))).toEqual(NO_CHECKS);
  });
  it("activates once DKIM and MX pass, suspends when they go, and never lifts an abuse pause", () => {
    const now = new Date("2026-11-07T10:00:00Z"), ready = { dkim: true, mx: true, spf: false, dmarc: false };
    expect(evaluate({ status: "pending" }, ready, now)).toEqual({ status: "active", verifiedAt: now.toISOString() });
    expect(evaluate({ status: "pending" }, { ...ready, mx: false }, now)).toEqual({ status: "pending" });
    expect(evaluate({ status: "active", verifiedAt: "v" }, { ...ready, dkim: false }, now)).toEqual({ status: "suspended", suspendedFor: "dns", verifiedAt: "v" });
    expect(evaluate({ status: "suspended", suspendedFor: "dns", verifiedAt: "v" }, ready, now)).toEqual({ status: "active", verifiedAt: "v" });
    expect(evaluate({ status: "suspended", suspendedFor: "abuse" }, ready, now)).toEqual({ status: "suspended", suspendedFor: "abuse" });
  });
});

const ddb = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESv2Client);
let zone: Parameters<typeof fakeDns>[0] = goodZone;
beforeEach(() => { ddb.reset(); ses.reset(); zone = goodZone; });

const api = () => createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}),
  account: async u => u === "ada@mactidar.com" ? { sub: "sub-a", email: "ada.backup@gmail.com", emailVerified: true, givenName: "Ada", familyName: "Obi" } : null,
  dns: { resolveMx: n => fakeDns(zone).resolveMx(n), resolveTxt: n => fakeDns(zone).resolveTxt(n), resolveCname: n => fakeDns(zone).resolveCname(n) },
  config: { table: "t", bucket: "b", configurationSet: "mactidar-mail", localDomains: OWN, region: REGION, signupDomain: "mactidar.com" },
});
const call = async (routeKey: string, opts: { body?: unknown; domain?: string; sub?: string } = {}) => {
  const r = await api()({ routeKey, pathParameters: opts.domain ? { domain: opts.domain } : undefined, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: opts.sub ?? "sub-a", username: "ada@mactidar.com" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};
const stored = (over: Partial<DomainItem> = {}): DomainItem => ({ pk: "DOMAIN#zetca.pro", sk: "META", type: "domain", domain: "zetca.pro", ownerSub: "sub-a", ownerAddress: "ada@mactidar.com", displayName: "Zetca",
  status: "pending", dkimTokens: TOKENS, checks: NO_CHECKS, createdAt: new Date().toISOString(), gsi1pk: "DOMAINS#sub-a", gsi1sk: "zetca.pro", gsi2pk: "DOMAINS", gsi2sk: "zetca.pro", ...over });

describe("connecting a domain", () => {
  it("claims the name, creates its SES identity and returns the records", async () => {
    ddb.on(QueryCommand).resolves({ Count: 0 });
    ddb.on(PutCommand).resolves({}); ddb.on(UpdateCommand).resolves({});
    ses.on(CreateEmailIdentityCommand).resolves({ DkimAttributes: { Tokens: TOKENS } });
    const r = await call("POST /v1/domains", { body: { domain: "Zetca.pro", displayName: "Zetca" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ domain: "zetca.pro", displayName: "Zetca", status: "pending", records: expect.arrayContaining([expect.objectContaining({ type: "MX", value: MX })]) });
    expect(r.body.ownerSub).toBeUndefined();
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { ownerSub: "sub-a", ownerAddress: "ada@mactidar.com", gsi1pk: "DOMAINS#sub-a" } });
    expect(ses.commandCalls(CreateEmailIdentityCommand)[0]!.args[0].input).toMatchObject({ EmailIdentity: "zetca.pro", ConfigurationSetName: "mactidar-mail" });
  });
  it("enforces the limit and refuses a name someone else has", async () => {
    ddb.on(QueryCommand).resolves({ Count: 2 });
    expect((await call("POST /v1/domains", { body: { domain: "zetca.pro" } })).status).toBe(409);
    ddb.on(QueryCommand).resolves({ Count: 0 });
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect((await call("POST /v1/domains", { body: { domain: "zetca.pro" } })).status).toBe(409);
    expect(ses.commandCalls(CreateEmailIdentityCommand)).toHaveLength(0);
  });
  it("releases its claim when SES already has the identity", async () => {
    ddb.on(QueryCommand).resolves({ Count: 0 }); ddb.on(PutCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    ses.on(CreateEmailIdentityCommand).rejects(Object.assign(new Error("exists"), { name: "AlreadyExistsException" }));
    expect((await call("POST /v1/domains", { body: { domain: "zetca.pro" } })).status).toBe(409);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

describe("checking and removing", () => {
  it("goes active when DKIM and MX pass", async () => {
    ddb.on(GetCommand).resolves({ Item: stored() }); ddb.on(PutCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    const r = await call("POST /v1/domains/{domain}/check", { domain: "zetca.pro" });
    expect(r.body).toMatchObject({ status: "active", checks: { dkim: true, mx: true, spf: true, dmarc: true } });
    expect(r.body.verifiedAt).toBeTruthy();
  });
  it("hides other people's domains", async () => {
    ddb.on(GetCommand).resolves({ Item: stored({ ownerSub: "sub-b" }) });
    expect((await call("GET /v1/domains/{domain}", { domain: "zetca.pro" })).status).toBe(404);
    expect((await call("DELETE /v1/domains/{domain}", { domain: "zetca.pro" })).status).toBe(404);
    expect((await call("GET /v1/domains/{domain}", { domain: "not a domain" })).status).toBe(404);
  });
  it("removes a domain and its SES identity", async () => {
    ddb.on(GetCommand).resolves({ Item: stored() }); ddb.on(QueryCommand).resolves({ Count: 0 }); ddb.on(DeleteCommand).resolves({});
    ses.on(DeleteEmailIdentityCommand).resolves({});
    expect((await call("DELETE /v1/domains/{domain}", { domain: "zetca.pro" })).body).toEqual({ deleted: true });
    expect(ses.commandCalls(DeleteEmailIdentityCommand)[0]!.args[0].input.EmailIdentity).toBe("zetca.pro");
  });
});

describe("daily check", () => {
  it("releases expired pending domains and suspends ones whose records disappeared, telling the owner", async () => {
    const old = new Date(Date.now() - 4 * 86400_000).toISOString();
    const domains = [stored({ domain: "stale.com", pk: "DOMAIN#stale.com", createdAt: old }), stored({ status: "active", verifiedAt: old })];
    ddb.on(QueryCommand).callsFake(i => ({ Items: i.ExpressionAttributeValues[":d"] === "DOMAINS" ? domains : [] }));
    ddb.on(DeleteCommand).resolves({}); ddb.on(PutCommand).resolves({});
    ses.on(DeleteEmailIdentityCommand).resolves({}); ses.on(SendEmailCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    zone = { ...goodZone, mx: {} };
    expect(await api().checkAllDomains()).toEqual({ checked: 1, released: 1, suspended: 1, restored: 0, failed: 0, purged: 0 });
    expect(ses.commandCalls(DeleteEmailIdentityCommand)[0]!.args[0].input.EmailIdentity).toBe("stale.com");
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ domain: "zetca.pro", status: "suspended", suspendedFor: "dns" });
    const mail = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(mail.Destination?.ToAddresses).toEqual(["ada.backup@gmail.com"]);
    expect(mail.Content?.Simple?.Body?.Text?.Data).not.toMatch(/https?:\/\//);
  });
});

describe("removed people's mailboxes", () => {
  it("are deleted by the daily task: every item, every S3 version, the claim marker, then the marker itself", async () => {
    const s3 = mockClient(S3Client);
    ddb.on(QueryCommand).callsFake(i => {
      if (i.ExpressionAttributeValues[":p"] === "PURGES") return { Items: [{ pk: "PURGE#ana@zetca.pro", sk: "PURGE", address: "ana@zetca.pro", ownerSub: "sub-ana", createdAt: "x", gsi2pk: "PURGES", gsi2sk: "ana@zetca.pro" }] };
      if (i.ExpressionAttributeValues[":p"] === "MAILBOX#ana@zetca.pro") return { Items: [{ pk: "MAILBOX#ana@zetca.pro", sk: "META" }, { pk: "MAILBOX#ana@zetca.pro", sk: "MSG#1" }] };
      return { Items: [] };
    });
    ddb.on(BatchWriteCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    s3.on(ListObjectVersionsCommand).resolves({ Versions: [{ Key: "msg/ana@zetca.pro/1.pgp", VersionId: "v1" }] }); s3.on(DeleteObjectsCommand).resolves({});
    expect((await api().checkAllDomains()).purged).toBe(1);
    expect(ddb.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.t).toHaveLength(2);
    expect(s3.commandCalls(ListObjectVersionsCommand).map(c => c.args[0].input.Prefix)).toEqual(["msg/ana@zetca.pro/", "att/ana@zetca.pro/"]);
    expect(ddb.commandCalls(DeleteCommand).map(c => c.args[0].input.Key)).toEqual([{ pk: "OWNER#sub-ana", sk: "CLAIM" }, { pk: "PURGE#ana@zetca.pro", sk: "PURGE" }]);
    s3.restore();
  });
});

describe("mail.<domain> web address", () => {
  const EDGE = "d1abc.cloudfront.net";
  let created: string[], removed: string[], cert: "pending" | "issued" | "failed", removal: "deleted" | "pending";
  beforeEach(() => { created = []; removed = []; cert = "pending"; removal = "deleted"; });
  const withWeb = () => createHandler({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), account: async () => null,
    dns: { resolveMx: n => fakeDns(zone).resolveMx(n), resolveTxt: n => fakeDns(zone).resolveTxt(n), resolveCname: n => fakeDns(zone).resolveCname(n) },
    web: { routingEndpoint: EDGE, create: async h => { created.push(h); return "tenant-1"; }, certificate: async () => cert, remove: async id => { removed.push(id); return removal; } },
    config: { table: "t", bucket: "b", configurationSet: "c", localDomains: OWN, region: REGION, signupDomain: "mactidar.com" },
  });
  const call = async (h: ReturnType<typeof withWeb>, routeKey: string, o: { domain?: string; query?: Record<string, string>; claims?: Record<string, string> } = {}) => {
    const r = await h({ routeKey, pathParameters: o.domain ? { domain: o.domain } : undefined, queryStringParameters: o.query, isBase64Encoded: false,
      requestContext: { authorizer: o.claims ? { jwt: { claims: o.claims, scopes: [] } } : undefined } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
    return { status: r.statusCode!, body: JSON.parse(r.body as string) };
  };
  const owner = { sub: "sub-a", username: "ada@mactidar.com" };

  it("adds the CNAME record and checks it, ignoring case and the trailing dot", async () => {
    expect(dnsRecords("zetca.pro", TOKENS, REGION, EDGE).at(-1)).toMatchObject({ purpose: "WEB", type: "CNAME", host: "mail", value: EDGE, check: "web" });
    expect((await checkDns("zetca.pro", true, REGION, fakeDns({ ...goodZone, cname: { "mail.zetca.pro": ["D1ABC.cloudfront.net."] } }), EDGE)).web).toBe(true);
    expect((await checkDns("zetca.pro", true, REGION, fakeDns(goodZone), EDGE)).web).toBe(false);
  });
  it("creates the tenant once the CNAME points at us, then goes live when the certificate is issued", async () => {
    zone = { ...goodZone, cname: { "mail.zetca.pro": [EDGE] } };
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    ddb.on(PutCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: stored({ status: "active" }) });
    let r = await call(withWeb(), "POST /v1/domains/{domain}/check", { domain: "zetca.pro", claims: owner });
    expect(created).toEqual(["mail.zetca.pro"]);
    expect(r.body.web).toEqual({ host: "mail.zetca.pro", status: "certificate" });
    cert = "issued";
    ddb.on(GetCommand).resolves({ Item: stored({ status: "active", web: { tenantId: "tenant-1", certificate: "pending" } }) });
    r = await call(withWeb(), "POST /v1/domains/{domain}/check", { domain: "zetca.pro", claims: owner });
    expect(created).toHaveLength(1);
    expect(r.body.web.status).toBe("live");
  });
  it("doesn't create a tenant for a domain that isn't active", async () => {
    zone = { cname: { "mail.zetca.pro": [EDGE] } };
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "PENDING" } });
    ddb.on(PutCommand).resolves({}); ddb.on(GetCommand).resolves({ Item: stored() });
    await call(withWeb(), "POST /v1/domains/{domain}/check", { domain: "zetca.pro", claims: owner });
    expect(created).toEqual([]);
  });
  it("tells a customer web address its domain and name, without sign-in, only once it's live", async () => {
    ddb.on(GetCommand).resolves({ Item: stored({ status: "active", displayName: "Zetca", web: { tenantId: "t", certificate: "issued" } }) });
    expect(await call(withWeb(), "GET /v1/public/brand", { query: { host: "mail.zetca.pro" } })).toEqual({ status: 200, body: { domain: "zetca.pro", displayName: "Zetca" } });
    ddb.on(GetCommand).resolves({ Item: stored({ status: "active", web: { tenantId: "t", certificate: "pending" } }) });
    expect((await call(withWeb(), "GET /v1/public/brand", { query: { host: "mail.zetca.pro" } })).status).toBe(404);
    for (const host of ["zetca.pro", "mail.mactidar.com", "mail.", ""]) expect((await call(withWeb(), "GET /v1/public/brand", { query: { host } })).status, host).toBe(404);
  });
  it("removes the tenant with the domain, finishing later if CloudFront is still disabling it", async () => {
    ddb.on(GetCommand).resolves({ Item: stored({ status: "active", web: { tenantId: "tenant-1", certificate: "issued" } }) });
    ddb.on(QueryCommand).resolves({ Items: [] }); ddb.on(PutCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    ses.on(DeleteEmailIdentityCommand).resolves({});
    removal = "pending";
    expect((await call(withWeb(), "DELETE /v1/domains/{domain}", { domain: "zetca.pro", claims: owner })).body).toEqual({ deleted: true });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ pk: "PURGE#mail.zetca.pro", tenantId: "tenant-1", gsi2pk: "PURGES" });
    ddb.reset(); removal = "deleted";
    ddb.on(QueryCommand).callsFake(i => ({ Items: i.ExpressionAttributeValues[":p"] === "PURGES" ? [{ pk: "PURGE#mail.zetca.pro", sk: "PURGE", address: "mail.zetca.pro", tenantId: "tenant-1" }] : [] }));
    ddb.on(DeleteCommand).resolves({});
    await withWeb().checkAllDomains();
    expect(removed).toEqual(["tenant-1", "tenant-1"]);
    expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input.Key).toEqual({ pk: "PURGE#mail.zetca.pro", sk: "PURGE" });
  });
});
