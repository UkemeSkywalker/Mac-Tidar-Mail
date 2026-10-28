import { CognitoIdentityProviderClient, AdminDeleteUserCommand, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type AccountInfo } from "../../src/api/handler";
import { createHandler as createAuth } from "../../src/auth/handler";
import { ageOn, parseAddress, validateProfile } from "../../src/shared/accounts";

const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const DOMAINS = ["beta.mactidar.com", "mactidar.com"];
let acct: AccountInfo | null;
const api = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), account: async () => acct,
  config: { table: "t", bucket: "b", configurationSet: "c", localDomains: DOMAINS, region: "af-south-1", signupDomain: "mactidar.com" } });
const call = async (routeKey: string, opts: { sub?: string | null; username?: string } = {}) => {
  const claims = { sub: opts.sub ?? "sub-new", username: opts.username ?? "ada@mactidar.com" };
  const r = await api()({ routeKey, isBase64Encoded: false,
    requestContext: { authorizer: opts.sub === null ? undefined : { jwt: { claims, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};
const cancelled = (codes: string[]) => new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: codes.map(Code => ({ Code })) });
const PROFILE = { email: "ada@gmail.com", given_name: "Ada", family_name: "Obi", birthdate: "1995-04-12", phone_number: "+2348012345678", gender: "female", "custom:country": "NG" };
const inYears = (n: number) => Math.floor(Date.now() / 1000) + n * 365 * 86400;

beforeEach(() => {
  ddb.reset(); cognito.reset();
  acct = { sub: "sub-new", email: "ada@gmail.com", emailVerified: true, givenName: "Ada", familyName: "Obi" };
});

describe("addresses", () => {
  it("accepts ordinary addresses and flags reserved ones", () => {
    expect(parseAddress("ada.obi@mactidar.com", "mactidar.com")).toEqual({ address: "ada.obi@mactidar.com", reserved: false });
    for (const u of ["admin@mactidar.com", "post.master@mactidar.com", "mactidar-help@mactidar.com", "admin2@mactidar.com", "no_reply@mactidar.com", "ukeme@mactidar.com"]) {
      expect(parseAddress(u, "mactidar.com").reserved, u).toBe(true);
    }
  });
  it("rejects bad shapes and other domains", () => {
    for (const u of ["ab@mactidar.com", "a..b@mactidar.com", ".ada@mactidar.com", "ada.@mactidar.com", "ada b@mactidar.com", `${"x".repeat(31)}@mactidar.com`, "ada@gmail.com", "ada", "ada@beta.mactidar.com"]) {
      expect(() => parseAddress(u, "mactidar.com"), u).toThrow();
    }
  });
});

describe("sign-up profile", () => {
  const today = new Date("2026-10-28T12:00:00Z");
  it("accepts a complete profile, with an optional middle name", () => {
    expect(validateProfile(PROFILE, DOMAINS, today)).toMatchObject({ email: "ada@gmail.com", givenName: "Ada", familyName: "Obi", country: "NG", gender: "female" });
    expect(validateProfile({ ...PROFILE, middle_name: "Chi-Chi" }, DOMAINS, today).middleName).toBe("Chi-Chi");
  });
  it("rejects missing or bad fields", () => {
    const bad: Record<string, string>[] = [
      { email: "ada@mactidar.com" }, { email: "ada@beta.mactidar.com" }, { email: "not-an-email" },
      { given_name: "" }, { family_name: "<b>" }, { given_name: "Mac", family_name: "Tidar" }, { middle_name: "1337" },
      { birthdate: "1995-02-30" }, { birthdate: "12/04/1995" }, { birthdate: "2020-01-01" }, { birthdate: "1800-01-01" },
      { phone_number: "08012345678" }, { phone_number: "+0123" }, { gender: "other" }, { "custom:country": "XX" }, { name: "Mac Tidar" },
    ];
    for (const b of bad) expect(() => validateProfile({ ...PROFILE, ...b }, DOMAINS, today), JSON.stringify(b)).toThrow();
  });
  it("counts age from the birthday", () => {
    expect(ageOn("2013-10-28", today)).toBe(13);
    expect(ageOn("2013-10-29", today)).toBe(12);
  });
});

describe("pre-sign-up trigger", () => {
  const auth = () => createAuth({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}), config: { table: "t", signupDomain: "mactidar.com", localDomains: DOMAINS } });
  const ev = (userName: string, attrs: Record<string, string> = PROFILE) => ({ triggerSource: "PreSignUp_SignUp", userName, request: { userAttributes: attrs }, response: {} }) as unknown as PreSignUpTriggerEvent;
  it("lets a free, ordinary address through", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(auth()(ev("ada@mactidar.com"))).resolves.toMatchObject({ userName: "ada@mactidar.com" });
  });
  it("refuses taken, reserved, uppercase and malformed sign-ups", async () => {
    ddb.on(GetCommand, { Key: { pk: "MAILBOX#ada@mactidar.com", sk: "META" } }).resolves({ Item: { ownerSub: "x" } });
    ddb.on(GetCommand, { Key: { pk: "RESERVED#ada@mactidar.com", sk: "RESERVATION" } }).resolves({});
    await expect(auth()(ev("ada@mactidar.com"))).rejects.toThrow(/taken/);
    ddb.on(GetCommand).resolves({});
    await expect(auth()(ev("admin@mactidar.com"))).rejects.toThrow(/reserved/);
    await expect(auth()(ev("Ada@mactidar.com"))).rejects.toThrow(/lowercase/);
    await expect(auth()(ev("ada@gmail.com"))).rejects.toThrow();
    await expect(auth()(ev("ada@mactidar.com", { ...PROFILE, gender: "x" }))).rejects.toThrow(/gender/);
  });
  it("allows a reserved or existing address only for the backup email it was reserved for", async () => {
    ddb.on(GetCommand, { Key: { pk: "MAILBOX#ukeme@mactidar.com", sk: "META" } }).resolves({ Item: { ownerSub: "old" } });
    ddb.on(GetCommand, { Key: { pk: "RESERVED#ukeme@mactidar.com", sk: "RESERVATION" } }).resolves({ Item: { backupEmail: "ada@gmail.com", expiresAt: inYears(1) } });
    await expect(auth()(ev("ukeme@mactidar.com"))).resolves.toBeTruthy();
    await expect(auth()(ev("ukeme@mactidar.com", { ...PROFILE, email: "eve@gmail.com" }))).rejects.toThrow(/taken/);
    ddb.on(GetCommand, { Key: { pk: "RESERVED#ukeme@mactidar.com", sk: "RESERVATION" } }).resolves({ Item: { backupEmail: "ada@gmail.com", expiresAt: inYears(-1) } });
    await expect(auth()(ev("ukeme@mactidar.com"))).rejects.toThrow(/taken/);
  });
  it("deletes only accounts left unconfirmed for over a day", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [
      { Username: "old@mactidar.com", UserCreateDate: new Date(Date.now() - 2 * 86400_000) },
      { Username: "new@mactidar.com", UserCreateDate: new Date(Date.now() - 3600_000) },
    ] });
    cognito.on(AdminDeleteUserCommand).resolves({});
    await expect(auth()({ task: "cleanup-unconfirmed", userPoolId: "pool" })).resolves.toEqual({ deleted: 1 });
    expect(cognito.commandCalls(AdminDeleteUserCommand)[0]!.args[0].input.Username).toBe("old@mactidar.com");
  });
});

describe("POST /v1/mailboxes", () => {
  it("opens the account's own address with the lower sending limit", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const r = await call("POST /v1/mailboxes");
    expect(r.status).toBe(201);
    expect(r.body.mailbox).toEqual({ address: "ada@mactidar.com", displayName: "Ada Obi", keyState: null, keyVersion: 0 });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.map(t => t.Put!.Item!);
    expect(items[0]).toMatchObject({ pk: "OWNER#sub-new", sk: "CLAIM" });
    expect(items[1]).toMatchObject({ pk: "MAILBOX#ada@mactidar.com", ownerSub: "sub-new", createdBy: "self", dailyRecipientLimit: 50, status: "active" });
  });
  it("refuses unverified accounts, second mailboxes, reserved and taken addresses", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({});
    acct = { ...acct!, emailVerified: false };
    expect((await call("POST /v1/mailboxes")).status).toBe(409);
    acct = { ...acct, emailVerified: true, sub: "someone-else" };
    expect((await call("POST /v1/mailboxes")).status).toBe(409);
    acct = { ...acct, sub: "sub-new" };
    expect((await call("POST /v1/mailboxes", { username: "admin@mactidar.com" })).body.error).toMatch(/reserved/);
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed"]));
    expect((await call("POST /v1/mailboxes")).body.error).toMatch(/taken/);
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None"]));
    expect((await call("POST /v1/mailboxes")).body.error).toMatch(/already has a mailbox/);
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "MAILBOX#x@mactidar.com" }] });
    expect((await call("POST /v1/mailboxes")).status).toBe(409);
  });
  it("moves a reserved existing mailbox to the new account, keeping its keys", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand, { Key: { pk: "RESERVED#ukeme@mactidar.com", sk: "RESERVATION" } }).resolves({ Item: { backupEmail: "ada@gmail.com", expiresAt: inYears(1) } });
    ddb.on(GetCommand, { Key: { pk: "MAILBOX#ukeme@mactidar.com", sk: "META" } }).resolves({ Item: {
      pk: "MAILBOX#ukeme@mactidar.com", sk: "META", ownerSub: "gmail-sub", address: "ukeme@mactidar.com", displayName: "Ukeme Eseme", status: "active", keyState: { k: 1 }, keyVersion: 3 } });
    ddb.on(TransactWriteCommand).resolves({});
    const r = await call("POST /v1/mailboxes", { username: "ukeme@mactidar.com" });
    expect(r).toEqual({ status: 201, body: { mailbox: { address: "ukeme@mactidar.com", displayName: "Ukeme Eseme", keyState: { k: 1 }, keyVersion: 3 } } });
    const tx = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx[1]!.Delete!.Key).toEqual({ pk: "RESERVED#ukeme@mactidar.com", sk: "RESERVATION" });
    expect(tx[2]!.Update).toMatchObject({ ConditionExpression: "ownerSub = :old", ExpressionAttributeValues: { ":s": "sub-new", ":old": "gmail-sub" } });
  });
  it("won't use a reservation made for a different backup email", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand, { Key: { pk: "RESERVED#ukeme@mactidar.com", sk: "RESERVATION" } }).resolves({ Item: { backupEmail: "owner@gmail.com", expiresAt: inYears(1) } });
    ddb.on(GetCommand, { Key: { pk: "MAILBOX#ukeme@mactidar.com", sk: "META" } }).resolves({ Item: { ownerSub: "gmail-sub" } });
    expect((await call("POST /v1/mailboxes", { username: "ukeme@mactidar.com" })).status).toBe(409);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
  it("needs a signed-in account", async () => expect((await call("POST /v1/mailboxes", { sub: null })).status).toBe(401));
});
