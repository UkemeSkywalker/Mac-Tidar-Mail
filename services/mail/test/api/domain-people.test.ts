import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, CustomMessageTriggerEvent, PreSignUpTriggerEvent, SNSEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type UserAdmin } from "../../src/api/handler";
import { createHandler as createAuth } from "../../src/auth/handler";
import { createHandler as createEvents } from "../../src/ses-events/handler";
import { NO_CHECKS, type DomainItem, type PersonItem } from "../../src/shared/domains";

const ddb = mockClient(DynamoDBDocumentClient);
const DOMAIN: DomainItem = { pk: "DOMAIN#zetca.pro", sk: "META", type: "domain", domain: "zetca.pro", ownerSub: "owner", ownerAddress: "ada@mactidar.com", displayName: "Zetca & Co",
  status: "active", dkimTokens: ["a", "b", "c"], checks: NO_CHECKS, createdAt: "x", gsi1pk: "DOMAINS#owner", gsi1sk: "zetca.pro", gsi2pk: "DOMAINS", gsi2sk: "zetca.pro" };
const PERSON: PersonItem = { pk: "DOMAIN#zetca.pro", sk: "PERSON#ana@zetca.pro", type: "person", address: "ana@zetca.pro", domain: "zetca.pro", givenName: "Ana", familyName: "Lee", backupEmail: "ana@gmail.com", status: "invited", createdAt: "x" };

let invites: string[], removed: string[], resent: string[];
beforeEach(() => { ddb.reset(); invites = []; removed = []; resent = []; });
const users: UserAdmin = {
  invite: async a => { invites.push(a); },
  resendInvite: async a => { resent.push(a); },
  remove: async a => { removed.push(a); },
};

/** Table reads by key: `items` maps "pk|sk" to an item. */
function table(items: Record<string, unknown>) {
  ddb.on(GetCommand).callsFake(i => ({ Item: items[`${i.Key.pk}|${i.Key.sk}`] }));
}

const api = () => createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), users,
  account: async u => ({ sub: u === "ana@zetca.pro" ? "sub-ana" : "owner", email: "x@gmail.com", emailVerified: true, givenName: "A", familyName: "B" }),
  config: { table: "t", bucket: "b", configurationSet: "c", localDomains: ["mactidar.com"], region: "af-south-1", signupDomain: "mactidar.com" },
});
const call = async (routeKey: string, o: { sub?: string; username?: string; body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}) => {
  const r = await api()({ routeKey, pathParameters: o.params, queryStringParameters: o.query, body: o.body === undefined ? undefined : JSON.stringify(o.body), isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: o.sub ?? "owner", username: o.username ?? "ada@mactidar.com" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};
const person = { localPart: "Ana", givenName: "Ana", familyName: "Lee", backupEmail: "ana@gmail.com" };

describe("adding people", () => {
  it("adds a person to an active domain and invites them", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN });
    ddb.on(QueryCommand).resolves({ Count: 3 }); ddb.on(PutCommand).resolves({});
    const r = await call("POST /v1/domains/{domain}/people", { params: { domain: "zetca.pro" }, body: person });
    expect(r).toMatchObject({ status: 201, body: { address: "ana@zetca.pro", status: "invited" } });
    expect(invites).toEqual(["ana@zetca.pro"]);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { sk: "PERSON#ana@zetca.pro", backupEmail: "ana@gmail.com" } });
  });
  it("refuses when the domain isn't active, it's full, the address is taken, or the backup email is on the domain", async () => {
    table({ "DOMAIN#zetca.pro|META": { ...DOMAIN, status: "pending" } });
    expect((await call("POST /v1/domains/{domain}/people", { params: { domain: "zetca.pro" }, body: person })).status).toBe(409);
    table({ "DOMAIN#zetca.pro|META": DOMAIN });
    ddb.on(QueryCommand).resolves({ Count: 25 });
    expect((await call("POST /v1/domains/{domain}/people", { params: { domain: "zetca.pro" }, body: person })).status).toBe(409);
    ddb.on(QueryCommand).resolves({ Count: 0 });
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "MAILBOX#ana@zetca.pro|META": { status: "active" } });
    expect((await call("POST /v1/domains/{domain}/people", { params: { domain: "zetca.pro" }, body: person })).body.error).toBe("That address is taken.");
    for (const backupEmail of ["ana@zetca.pro", "x@mail.zetca.pro", "ana@mactidar.com", "nope"])
      expect((await call("POST /v1/domains/{domain}/people", { params: { domain: "zetca.pro" }, body: { ...person, backupEmail } })).status, backupEmail).toBe(400);
    expect(invites).toEqual([]);
  });
  it("only lets the owner manage people", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    expect((await call("POST /v1/domains/{domain}/people", { sub: "someone-else", params: { domain: "zetca.pro" }, body: person })).status).toBe(404);
    expect((await call("DELETE /v1/domains/{domain}/people/{address}", { sub: "someone-else", params: { domain: "zetca.pro", address: "ana@zetca.pro" } })).status).toBe(404);
    expect(removed).toEqual([]);
  });
  it("resends an invite until they sign in", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    expect((await call("POST /v1/domains/{domain}/people/{address}/invite", { params: { domain: "zetca.pro", address: "ana@zetca.pro" } })).status).toBe(200);
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": { ...PERSON, status: "active" } });
    expect((await call("POST /v1/domains/{domain}/people/{address}/invite", { params: { domain: "zetca.pro", address: "ana@zetca.pro" } })).status).toBe(409);
    expect(resent).toEqual(["ana@zetca.pro"]);
  });
  it("removing someone ends their sign-in and queues their mailbox for deletion", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": { ...PERSON, status: "active" }, "MAILBOX#ana@zetca.pro|META": { pk: "MAILBOX#ana@zetca.pro", ownerSub: "sub-ana", status: "active" } });
    ddb.on(PutCommand).resolves({}); ddb.on(UpdateCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    expect((await call("DELETE /v1/domains/{domain}/people/{address}", { params: { domain: "zetca.pro", address: "ana@zetca.pro" } })).body).toEqual({ deleted: true });
    expect(removed).toEqual(["ana@zetca.pro"]);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ pk: "PURGE#ana@zetca.pro", ownerSub: "sub-ana", gsi2pk: "PURGES" });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ":d": "deleted" });
  });
});

describe("first sign-in on a customer domain", () => {
  it("creates the mailbox for someone the owner added", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    ddb.on(QueryCommand).resolves({ Items: [] }); ddb.on(TransactWriteCommand).resolves({});
    const r = await call("POST /v1/mailboxes", { sub: "sub-ana", username: "ana@zetca.pro" });
    expect(r).toMatchObject({ status: 201, body: { mailbox: { address: "ana@zetca.pro", displayName: "Ana Lee" } } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[1]!.Put!.Item).toMatchObject({ createdBy: "domain", dailyRecipientLimit: 50, ownerSub: "sub-ana" });
    expect(items[2]!.Update!.Key).toEqual({ pk: "DOMAIN#zetca.pro", sk: "PERSON#ana@zetca.pro" });
  });
  it("refuses an address nobody added, or on a domain that isn't active", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    table({ "DOMAIN#zetca.pro|META": DOMAIN });
    expect((await call("POST /v1/mailboxes", { sub: "sub-ana", username: "ana@zetca.pro" })).status).toBe(409);
    table({ "DOMAIN#zetca.pro|META": { ...DOMAIN, status: "suspended" }, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    expect((await call("POST /v1/mailboxes", { sub: "sub-ana", username: "ana@zetca.pro" })).status).toBe(409);
  });
});

describe("customer domains count as Mac Tidar", () => {
  const META = { pk: "MAILBOX#ana@zetca.pro", address: "ana@zetca.pro", status: "active", keyState: { primaryFingerprint: "f", keys: [{ fingerprint: "f", publicKey: "PUB" }] } };
  it("serves public keys for active customer domains only", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "MAILBOX#ana@zetca.pro|META": META });
    expect((await call("GET /v1/keys", { query: { address: "ana@zetca.pro" } })).body).toMatchObject({ publicKey: "PUB" });
    table({ "DOMAIN#zetca.pro|META": { ...DOMAIN, status: "pending" }, "MAILBOX#ana@zetca.pro|META": META });
    expect((await call("GET /v1/keys", { query: { address: "ana@zetca.pro" } })).status).toBe(404);
  });
  it("blocks sending from a paused domain", async () => {
    table({ "DOMAIN#zetca.pro|META": { ...DOMAIN, status: "suspended", suspendedFor: "abuse" }, "MAILBOX#ana@zetca.pro|META": { ...META, ownerSub: "sub-ana" } });
    const r = await call("POST /v1/mailboxes/{address}/send", { sub: "sub-ana", username: "ana@zetca.pro", params: { address: "ana@zetca.pro" }, body: { clientId: "abcdefgh12", to: ["x@gmail.com"], cc: [], bcc: [], internal: [] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/paused/);
  });
});

describe("invite trigger", () => {
  const auth = () => createAuth({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}), config: { table: "t", signupDomain: "mactidar.com", localDomains: ["mactidar.com"] } });
  const pre = (userName: string, triggerSource = "PreSignUp_AdminCreateUser") => ({ triggerSource, userName, request: { userAttributes: { email: "ana@gmail.com" } }, response: {} }) as unknown as PreSignUpTriggerEvent;
  it("lets an invite through only for someone added to an active domain", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    await expect(auth()(pre("ana@zetca.pro"))).resolves.toBeTruthy();
    await expect(auth()(pre("sam@zetca.pro"))).rejects.toThrow("can't be created");
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON, "MAILBOX#ana@zetca.pro|META": {} });
    await expect(auth()(pre("ana@zetca.pro"))).rejects.toThrow("can't be created");
    table({ "DOMAIN#zetca.pro|META": { ...DOMAIN, status: "pending" }, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    await expect(auth()(pre("ana@zetca.pro"))).rejects.toThrow("can't be created");
  });
  it("still refuses self sign-up on a customer domain", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN, "DOMAIN#zetca.pro|PERSON#ana@zetca.pro": PERSON });
    await expect(auth()(pre("ana@zetca.pro", "PreSignUp_SignUp"))).rejects.toThrow("@mactidar.com");
  });
  it("writes the invite with the domain's name, escaped, keeping Cognito's placeholders", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN });
    const e = { triggerSource: "CustomMessage_AdminCreateUser", userName: "ana@zetca.pro", request: { codeParameter: "{####}", usernameParameter: "{username}", userAttributes: {} }, response: {} } as unknown as CustomMessageTriggerEvent;
    const r = await auth()(e) as CustomMessageTriggerEvent;
    expect(r.response.emailSubject).toBe("You’ve been added to Zetca & Co’s email");
    expect(r.response.emailMessage).toContain("Zetca &amp; Co has given you");
    expect(r.response.emailMessage).toContain("{####}");
    expect(r.response.emailMessage).toContain("{username}");
    const other = { ...e, triggerSource: "CustomMessage_ForgotPassword", response: {} } as unknown as CustomMessageTriggerEvent;
    expect((await auth()(other) as CustomMessageTriggerEvent).response.emailMessage).toBeUndefined();
  });
});

describe("pausing a domain that draws complaints", () => {
  const sns = (source: string, eventType = "Complaint") => ({ Records: [{ Sns: { Message: JSON.stringify({ eventType, mail: { messageId: "m1", source } }) } }] }) as unknown as SNSEvent;
  it("pauses a customer domain at 3 complaints in a day, and leaves Mac Tidar's own domains to SES", async () => {
    table({ "DOMAIN#zetca.pro|META": DOMAIN });
    ddb.on(UpdateCommand).resolves({ Attributes: { complaints: 3 } });
    await createEvents(DynamoDBDocumentClient.from(new DynamoDBClient({})), "t")(sns("Ana Lee <ana@zetca.pro>"));
    const pause = ddb.commandCalls(UpdateCommand).find(c => c.args[0].input.Key!.sk === "META")!;
    expect(pause.args[0].input.ExpressionAttributeValues).toMatchObject({ ":s": "suspended", ":a": "abuse" });
    ddb.reset(); table({});
    await createEvents(DynamoDBDocumentClient.from(new DynamoDBClient({})), "t")(sns("ada@mactidar.com"));
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
