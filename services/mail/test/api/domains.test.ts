import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
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
function fakeDns(zone: { mx?: Record<string, { exchange: string; priority: number }[]>; txt?: Record<string, string[][]> }): Resolver {
  const missing = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return {
    resolveMx: async n => { const r = zone.mx?.[n]; if (!r) throw missing(); return r; },
    resolveTxt: async n => { const r = zone.txt?.[n]; if (!r) throw missing(); return r; },
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
  dns: { resolveMx: n => fakeDns(zone).resolveMx(n), resolveTxt: n => fakeDns(zone).resolveTxt(n) },
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
    ddb.on(QueryCommand).resolves({ Items: [stored({ domain: "stale.com", pk: "DOMAIN#stale.com", createdAt: old }), stored({ status: "active", verifiedAt: old })] });
    ddb.on(DeleteCommand).resolves({}); ddb.on(PutCommand).resolves({});
    ses.on(DeleteEmailIdentityCommand).resolves({}); ses.on(SendEmailCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    zone = { ...goodZone, mx: {} };
    expect(await api().checkAllDomains()).toEqual({ checked: 1, released: 1, suspended: 1, restored: 0, failed: 0 });
    expect(ses.commandCalls(DeleteEmailIdentityCommand)[0]!.args[0].input.EmailIdentity).toBe("stale.com");
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ domain: "zetca.pro", status: "suspended", suspendedFor: "dns" });
    const mail = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(mail.Destination?.ToAddresses).toEqual(["ada.backup@gmail.com"]);
    expect(mail.Content?.Simple?.Body?.Text?.Data).not.toMatch(/https?:\/\//);
  });
});
