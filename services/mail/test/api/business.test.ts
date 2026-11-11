// Business sign-up: accounts on the company's own domain, competing claims decided by each
// claim's ownership record, company logos, and the 15-minute check with its reminders.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DeleteEmailIdentityCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type UserAdmin } from "../../src/api/handler";
import { createHandler as createAuth } from "../../src/auth/handler";
import { sentEmail } from "../helpers";
import { NO_CLAIM_CHECKS, type ClaimItem, type DomainItem, type PersonItem, type Resolver } from "../../src/shared/domains";

const MX = "inbound-smtp.af-south-1.amazonaws.com";
const TOKENS = ["aaa", "bbb", "ccc"];
const ddb = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESv2Client);
const s3 = mockClient(S3Client);

let removed: string[];
const users: UserAdmin = { invite: async () => {}, resendInvite: async () => {}, remove: async a => { removed.push(a); } };
const accounts: Record<string, { sub: string; email: string }> = {
  "ceo@zetca.pro": { sub: "sub-ceo", email: "ceo.backup@gmail.com" },
  "squat@zetca.pro": { sub: "sub-squat", email: "squat@gmail.com" },
  "ada@mactidar.com": { sub: "sub-ada", email: "ada@gmail.com" },
};

/** A DNS zone in memory; anything not listed doesn't exist. */
let zone: { mx?: Record<string, { exchange: string; priority: number }[]>; txt?: Record<string, string[][]> };
const dns: Resolver = {
  resolveMx: async n => { const r = zone.mx?.[n]; if (!r) throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); return r; },
  resolveTxt: async n => { const r = zone.txt?.[n]; if (!r) throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); return r; },
};
const verifiedZone = (token: string) => ({ mx: { "zetca.pro": [{ exchange: MX, priority: 10 }] }, txt: { "_mactidar.zetca.pro": [[`mactidar-verify=${token}`]], "zetca.pro": [["v=spf1 include:amazonses.com ~all"]] } });

beforeEach(() => {
  ddb.reset(); ses.reset(); s3.reset(); removed = []; zone = {};
  ses.on(SendEmailCommand).resolves({}); ses.on(DeleteEmailIdentityCommand).resolves({});
});

const api = () => createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), users, dns,
  account: async u => accounts[u] ? { ...accounts[u]!, emailVerified: true, givenName: "Chi", familyName: "Eze" } : null,
  presign: async () => "https://signed.example/preview",
  presignPost: async (_c, p) => ({ url: `https://${p.bucket}.s3.af-south-1.amazonaws.com/`, fields: { key: p.key, "Content-Type": p.contentType } }),
  config: { table: "t", bucket: "b", configurationSet: "c", localDomains: ["mactidar.com"], region: "af-south-1", signupDomain: "mactidar.com", brandBucket: "brand", brandUrl: "https://cdn.example" },
});
const call = async (routeKey: string, o: { username?: string; body?: unknown; params?: Record<string, string> } = {}) => {
  const username = o.username ?? "ceo@zetca.pro";
  const r = await api()({ routeKey, pathParameters: o.params, body: o.body === undefined ? undefined : JSON.stringify(o.body), isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: accounts[username]!.sub, username }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};

const claim = (over: Partial<ClaimItem> = {}): ClaimItem => ({ pk: "DOMAIN#zetca.pro", sk: "CLAIM#sub-ceo", type: "claim", domain: "zetca.pro", ownerSub: "sub-ceo", ownerAddress: "ceo@zetca.pro",
  displayName: "Zetca", token: "t-ceo", dkimTokens: TOKENS, checks: NO_CLAIM_CHECKS, createdAt: new Date().toISOString(), gsi1pk: "DOMAINS#sub-ceo", gsi1sk: "zetca.pro", gsi2pk: "CLAIMS", gsi2sk: "zetca.pro#sub-ceo", ...over });
const squatter = claim({ sk: "CLAIM#sub-squat", ownerSub: "sub-squat", ownerAddress: "squat@zetca.pro", token: "t-squat", gsi1pk: "DOMAINS#sub-squat" });

/** Table contents by "pk|sk"; queries on the domain's partition filter by sort-key prefix. */
function table(items: Record<string, unknown>) {
  ddb.on(GetCommand).callsFake(i => ({ Item: items[`${i.Key.pk}|${i.Key.sk}`] }));
  ddb.on(QueryCommand).callsFake(i => {
    const v = i.ExpressionAttributeValues ?? {};
    if (v[":c"] === "CLAIMS") return { Items: Object.values(items).filter(x => (x as ClaimItem).type === "claim") };
    const prefix = v[":c"] ?? v[":s"];
    if (v[":p"] && prefix) return { Items: Object.entries(items).filter(([k]) => k.startsWith(`${v[":p"]}|${prefix}`)).map(([, x]) => x) };
    return { Items: [], Count: 0 };
  });
}

describe("Business accounts connect their own domain", () => {
  it("only the domain their address is on, and only one", async () => {
    table({});
    expect((await call("POST /v1/domains", { body: { domain: "other.com" } })).body.error).toMatch(/only connect zetca\.pro/);
    ddb.on(QueryCommand).resolves({ Count: 1 });
    expect((await call("POST /v1/domains", { body: { domain: "zetca.pro" } })).status).toBe(409);
  });
  it("lists the claim with its ownership record and says which domain the account is for", async () => {
    ddb.on(QueryCommand).resolves({ Items: [claim()] });
    const r = await call("GET /v1/domains");
    expect(r.body).toMatchObject({ limit: 1, businessDomain: "zetca.pro", domains: [{ domain: "zetca.pro", status: "pending", ownAddress: "ceo@zetca.pro", checks: { ownership: false } }] });
    expect(r.body.domains[0].records[0]).toMatchObject({ purpose: "Ownership", value: "mactidar-verify=t-ceo" });
  });
});

describe("Verify now on a claim", () => {
  it("stays pending without the ownership record, even when DKIM and MX pass", async () => {
    table({ "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim() });
    ddb.on(PutCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    zone = { ...verifiedZone("someone-else") };
    const r = await call("POST /v1/domains/{domain}/check", { params: { domain: "zetca.pro" } });
    expect(r.body).toMatchObject({ status: "pending", checks: { ownership: false, dkim: true, mx: true } });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("wins with the ownership record: becomes the domain, adds the owner's own address, removes the other claims and sign-ups", async () => {
    table({
      "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim({ pendingLogoKey: "uploads/zetca.pro/sub-ceo/abc.png" }),
      "DOMAIN#zetca.pro|CLAIM#sub-squat": squatter,
      "DOMAIN#zetca.pro|SIGNUP#ceo@zetca.pro": { pk: "DOMAIN#zetca.pro", sk: "SIGNUP#ceo@zetca.pro", type: "signup", address: "ceo@zetca.pro" },
      "DOMAIN#zetca.pro|SIGNUP#squat@zetca.pro": { pk: "DOMAIN#zetca.pro", sk: "SIGNUP#squat@zetca.pro", type: "signup", address: "squat@zetca.pro" },
    });
    ddb.on(TransactWriteCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    s3.on(CopyObjectCommand).resolves({}); s3.on(DeleteObjectCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    zone = verifiedZone("t-ceo");
    const r = await call("POST /v1/domains/{domain}/check", { params: { domain: "zetca.pro" } });
    expect(r.body).toMatchObject({ status: "active", checks: { ownership: true }, ownAddress: "ceo@zetca.pro", logoUrl: expect.stringMatching(/^https:\/\/cdn\.example\/logos\/zetca\.pro\/[0-9a-f]{24}\.png$/) });

    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx[0]!.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { sk: "META", type: "domain", status: "active", ownerSub: "sub-ceo", gsi2pk: "DOMAINS" } });
    expect(tx[1]!.Delete!.Key).toEqual({ pk: "DOMAIN#zetca.pro", sk: "CLAIM#sub-ceo" });
    expect((tx[2]!.Put!.Item as PersonItem)).toMatchObject({ sk: "PERSON#ceo@zetca.pro", address: "ceo@zetca.pro", backupEmail: "ceo.backup@gmail.com", status: "invited" });
    expect(s3.commandCalls(CopyObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: "brand", CopySource: "brand/uploads%2Fzetca.pro%2Fsub-ceo%2Fabc.png", ContentType: "image/png" });

    // The squatter's claim and account go; the winner's account stays.
    expect(ddb.commandCalls(DeleteCommand).map(c => c.args[0].input.Key)).toEqual(expect.arrayContaining([{ pk: "DOMAIN#zetca.pro", sk: "CLAIM#sub-squat" }, { pk: "DOMAIN#zetca.pro", sk: "SIGNUP#squat@zetca.pro" }, { pk: "DOMAIN#zetca.pro", sk: "SIGNUP#ceo@zetca.pro" }]));
    expect(removed).toContain("squat@zetca.pro");
    expect(removed).not.toContain("ceo@zetca.pro");
    // The SES identity is now the domain's: never deleted while it's verified.
    expect(ses.commandCalls(DeleteEmailIdentityCommand)).toHaveLength(0);
    const sent = await Promise.all(ses.commandCalls(SendEmailCommand).map(async c => [c.args[0].input.Destination?.ToAddresses?.[0], (await sentEmail(c.args[0].input)).subject]));
    expect(sent).toEqual(expect.arrayContaining([["squat@gmail.com", "zetca.pro was verified by someone else"], ["ceo.backup@gmail.com", "zetca.pro is live on Mac Tidar Mail"]]));
  });

  it("loses when someone else's claim became the domain first", async () => {
    table({ "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim() });
    ddb.on(TransactWriteCommand).rejects(Object.assign(new (await import("@aws-sdk/client-dynamodb")).TransactionCanceledException({ message: "x", $metadata: {} }), { CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }));
    ddb.on(DeleteCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "SUCCESS" } });
    zone = verifiedZone("t-ceo");
    expect((await call("POST /v1/domains/{domain}/check", { params: { domain: "zetca.pro" } })).status).toBe(404);
    expect(removed).toEqual(["ceo@zetca.pro"]);
  });
});

describe("the 15-minute check", () => {
  it("releases expired claims (and their Business account), reminds after a day, warns after two", async () => {
    const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
    table({
      "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim({ createdAt: ago(3.1) }),
      "DOMAIN#late.com|CLAIM#sub-ada": claim({ pk: "DOMAIN#late.com", sk: "CLAIM#sub-ada", domain: "late.com", ownerSub: "sub-ada", ownerAddress: "ada@mactidar.com", createdAt: ago(1.2) }),
      "DOMAIN#later.com|CLAIM#sub-ada": claim({ pk: "DOMAIN#later.com", sk: "CLAIM#sub-ada", domain: "later.com", ownerSub: "sub-ada", ownerAddress: "ada@mactidar.com", createdAt: ago(2.2), remindedAt: ago(1) }),
    });
    ddb.on(DeleteCommand).resolves({}); ddb.on(PutCommand).resolves({}); ddb.on(UpdateCommand).resolves({});
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: { Status: "PENDING" } });
    expect(await api().checkAllClaims()).toEqual({ checked: 2, verified: 0, released: 1, reminded: 2, failed: 0 });
    expect(removed).toEqual(["ceo@zetca.pro"]);
    const mails = await Promise.all(ses.commandCalls(SendEmailCommand).map(c => sentEmail(c.args[0].input)));
    const subjects = mails.map(m => m.subject);
    expect(subjects).toEqual(["zetca.pro was released", "late.com is waiting for its DNS records", "later.com will be released tomorrow"]);
    for (const m of mails) { expect(m.text).not.toMatch(/https?:\/\//); expect(m.html).not.toMatch(/href=/); }
  });
});

describe("company logos", () => {
  it("hands out an upload form for raster images only", async () => {
    table({ "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim() });
    expect((await call("POST /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { contentType: "image/svg+xml" } })).status).toBe(400);
    const r = await call("POST /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { contentType: "image/png" } });
    expect(r.body).toMatchObject({ url: "https://brand.s3.af-south-1.amazonaws.com/", key: expect.stringMatching(/^uploads\/zetca\.pro\/sub-ceo\/[0-9a-f]{24}\.png$/), maxBytes: 1048576 });
  });
  it("keeps a pending domain's logo private, and refuses uploads that aren't what they claim", async () => {
    table({ "DOMAIN#zetca.pro|CLAIM#sub-ceo": claim() });
    ddb.on(UpdateCommand).resolves({}); s3.on(DeleteObjectCommand).resolves({});
    const key = "uploads/zetca.pro/sub-ceo/0123456789abcdef01234567.png";
    s3.on(HeadObjectCommand).resolves({ ContentLength: 2000, ContentType: "image/png" });
    const r = await call("PUT /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { key } });
    expect(r.body.logoUrl).toBe("https://signed.example/preview");
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({ UpdateExpression: "SET pendingLogoKey = :k", ExpressionAttributeValues: { ":k": key } });
    expect(s3.commandCalls(CopyObjectCommand)).toHaveLength(0);

    s3.on(HeadObjectCommand).resolves({ ContentLength: 2000, ContentType: "text/html" });
    expect((await call("PUT /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { key } })).status).toBe(400);
    expect((await call("PUT /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { key: "uploads/zetca.pro/sub-other/0123456789abcdef01234567.png" } })).status).toBe(400);
  });
  it("publishes a verified domain's logo and shows it with the owner's mailboxes", async () => {
    const d: DomainItem = { pk: "DOMAIN#zetca.pro", sk: "META", type: "domain", domain: "zetca.pro", ownerSub: "sub-ceo", ownerAddress: "ceo@zetca.pro", displayName: "Zetca", status: "active",
      dkimTokens: TOKENS, checks: { dkim: true, mx: true, spf: true, dmarc: true }, createdAt: "x", logoKey: "logos/zetca.pro/old.png", gsi1pk: "DOMAINS#sub-ceo", gsi1sk: "zetca.pro", gsi2pk: "DOMAINS", gsi2sk: "zetca.pro" };
    table({ "DOMAIN#zetca.pro|META": d });
    ddb.on(UpdateCommand).resolves({}); s3.on(CopyObjectCommand).resolves({}); s3.on(DeleteObjectCommand).resolves({});
    s3.on(HeadObjectCommand).resolves({ ContentLength: 2000, ContentType: "image/webp" });
    const r = await call("PUT /v1/domains/{domain}/logo", { params: { domain: "zetca.pro" }, body: { key: "uploads/zetca.pro/sub-ceo/0123456789abcdef01234567.webp" } });
    expect(r.body.logoUrl).toMatch(/^https:\/\/cdn\.example\/logos\/zetca\.pro\/[0-9a-f]{24}\.webp$/);
    expect(s3.commandCalls(DeleteObjectCommand).map(c => c.args[0].input.Key)).toEqual(["uploads/zetca.pro/sub-ceo/0123456789abcdef01234567.webp", "logos/zetca.pro/old.png"]);

    ddb.on(QueryCommand).resolves({ Items: [{ pk: "MAILBOX#ceo@zetca.pro", sk: "META", address: "ceo@zetca.pro", ownerSub: "sub-ceo", displayName: "Chi Eze", status: "active" }] });
    expect((await call("GET /v1/mailboxes")).body.mailboxes[0].brand).toEqual({ name: "Zetca", logoUrl: "https://cdn.example/logos/zetca.pro/old.png" });
  });
});

describe("the owner's own address on their domain", () => {
  const d: DomainItem = { pk: "DOMAIN#zetca.pro", sk: "META", type: "domain", domain: "zetca.pro", ownerSub: "sub-ceo", ownerAddress: "ceo@zetca.pro", displayName: "Zetca", status: "active",
    dkimTokens: TOKENS, checks: { dkim: true, mx: true, spf: true, dmarc: true }, createdAt: "x", gsi1pk: "DOMAINS#sub-ceo", gsi1sk: "zetca.pro", gsi2pk: "DOMAINS", gsi2sk: "zetca.pro" };
  const me: PersonItem = { pk: "DOMAIN#zetca.pro", sk: "PERSON#ceo@zetca.pro", type: "person", address: "ceo@zetca.pro", domain: "zetca.pro", givenName: "Chi", familyName: "Eze", backupEmail: "c@gmail.com", status: "active", createdAt: "x" };
  it("can't be removed, and the domain can't be disconnected under it", async () => {
    table({ "DOMAIN#zetca.pro|META": d, "DOMAIN#zetca.pro|PERSON#ceo@zetca.pro": me });
    expect((await call("DELETE /v1/domains/{domain}/people/{address}", { params: { domain: "zetca.pro", address: "ceo@zetca.pro" } })).status).toBe(409);
    expect((await call("DELETE /v1/domains/{domain}", { params: { domain: "zetca.pro" } })).status).toBe(409);
    expect(removed).toEqual([]);
    const list = await call("GET /v1/domains/{domain}/people", { params: { domain: "zetca.pro" } });
    expect(list.body.people[0]).toMatchObject({ address: "ceo@zetca.pro", owner: true });
  });
});

describe("Business sign-up check (pre-sign-up trigger)", () => {
  const auth = () => createAuth({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}), config: { table: "t", signupDomain: "mactidar.com", localDomains: ["mactidar.com"] } });
  const pre = (userName: string, attrs: Record<string, string> = { email: "chi@gmail.com", given_name: "Chi", family_name: "Eze" }) =>
    ({ triggerSource: "PreSignUp_SignUp", userName, request: { userAttributes: attrs }, response: {} }) as unknown as PreSignUpTriggerEvent;

  it("accepts an address on an unverified company domain and records the sign-up", async () => {
    table({}); ddb.on(PutCommand).resolves({});
    await expect(auth()(pre("ceo@zetca.pro"))).resolves.toBeTruthy();
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ pk: "DOMAIN#zetca.pro", sk: "SIGNUP#ceo@zetca.pro", type: "signup", expiresAt: expect.any(Number) });
  });
  it("refuses providers, malformed addresses, a backup email on the same domain and extra fields", async () => {
    table({}); ddb.on(PutCommand).resolves({});
    await expect(auth()(pre("ceo@gmail.com"))).rejects.toThrow("company's domain");
    await expect(auth()(pre("c@zetca.pro"))).rejects.toThrow("company's domain");
    await expect(auth()(pre("ceo@zetca.pro", { email: "me@zetca.pro", given_name: "Chi", family_name: "Eze" }))).rejects.toThrow("somewhere else");
    await expect(auth()(pre("ceo@zetca.pro", { email: "chi@gmail.com", given_name: "Chi", family_name: "Eze", birthdate: "2000-01-01" }))).rejects.toThrow("Unexpected");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
  it("refuses an address that's taken and a domain with too many sign-ups in progress", async () => {
    table({ "MAILBOX#ceo@zetca.pro|META": { status: "active" } });
    await expect(auth()(pre("ceo@zetca.pro"))).rejects.toThrow("taken");
    table({}); ddb.on(QueryCommand).resolves({ Count: 25 });
    await expect(auth()(pre("ceo@zetca.pro"))).rejects.toThrow("Too many");
  });
});

describe("public brand lookup (sign-in screen)", () => {
  const d: DomainItem = { pk: "DOMAIN#zetca.pro", sk: "META", type: "domain", domain: "zetca.pro", ownerSub: "sub-ceo", ownerAddress: "ceo@zetca.pro", displayName: "Zetca", status: "active",
    dkimTokens: TOKENS, checks: { dkim: true, mx: true, spf: true, dmarc: true }, createdAt: "x", logoKey: "logos/zetca.pro/0123456789abcdef01234567.png", gsi1pk: "DOMAINS#sub-ceo", gsi1sk: "zetca.pro", gsi2pk: "DOMAINS", gsi2sk: "zetca.pro" };
  const lookup = async (domain: string) => {
    const r = await api()({ routeKey: "GET /v1/brand", queryStringParameters: { domain }, requestContext: {} } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
    return { status: r.statusCode!, body: JSON.parse(r.body as string) };
  };
  it("answers without sign-in for verified domains only, with nothing private", async () => {
    table({ "DOMAIN#zetca.pro|META": d });
    expect(await lookup("Zetca.pro")).toEqual({ status: 200, body: { domain: "zetca.pro", name: "Zetca", logoUrl: "https://cdn.example/logos/zetca.pro/0123456789abcdef01234567.png" } });
    table({ "DOMAIN#zetca.pro|META": { ...d, status: "pending" } });
    expect((await lookup("zetca.pro")).status).toBe(404);
    table({});
    expect((await lookup("nobody.com")).status).toBe(404);
    expect((await lookup("not a domain")).status).toBe(404);
  });
});

describe("invite email", () => {
  it("shows the company's logo from our CDN, and nothing else", async () => {
    const d = { domain: "zetca.pro", displayName: "Zetca & Co", status: "active", logoKey: "logos/zetca.pro/0123456789abcdef01234567.png" };
    const auth = (brandUrl?: string) => createAuth({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}), config: { table: "t", signupDomain: "mactidar.com", localDomains: ["mactidar.com"], brandUrl } });
    const ev = () => ({ triggerSource: "CustomMessage_AdminCreateUser", userName: "ana@zetca.pro", request: { codeParameter: "{####}", usernameParameter: "{username}" }, response: {} }) as never;
    table({ "DOMAIN#zetca.pro|META": d });
    const out = await auth("https://cdn.example")(ev()) as { response: { emailMessage: string } };
    expect(out.response.emailMessage).toContain('<img src="https://cdn.example/logos/zetca.pro/0123456789abcdef01234567.png"');
    expect(out.response.emailMessage).toContain("Zetca &amp; Co");
    table({ "DOMAIN#zetca.pro|META": { ...d, logoKey: "logos/zetca.pro/x.svg\" onerror=\"alert(1)" } });
    expect(((await auth("https://cdn.example")(ev())) as { response: { emailMessage: string } }).response.emailMessage).not.toContain("onerror");
  });
});
