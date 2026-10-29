import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, PostConfirmationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type AccountInfo, type MfaState } from "../../src/api/handler";
import { createHandler as createAuth } from "../../src/auth/handler";
import { alertEmail, deviceName, type AlertContext, type SecurityEvent } from "../../src/shared/alerts";

const ddb = mockClient(DynamoDBDocumentClient);
const ACCOUNT: AccountInfo = { sub: "sub-a", email: "backup@gmail.com", emailVerified: true, givenName: "Ada", familyName: "Obi" };

let state: MfaState, sent: { to: string; event: SecurityEvent; ctx: AlertContext }[], failSet: string | null, acct: AccountInfo | null;
beforeEach(() => { ddb.reset(); state = { totp: false, email: false }; sent = []; failSet = null; acct = ACCOUNT; });

const api = () => createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}),
  account: async () => acct,
  mfa: { get: async () => ({ ...state }), set: async (_u, next) => { if (failSet) throw Object.assign(new Error("x"), { name: failSet }); state = { ...next }; } },
  alert: async (to, event, ctx) => { sent.push({ to, event, ctx }); },
  config: { table: "t", bucket: "b", configurationSet: "c", localDomains: ["mactidar.com"], region: "af-south-1", signupDomain: "mactidar.com" },
});
const call = async (routeKey: string, body?: unknown, claims: Record<string, string> = { sub: "sub-a", username: "ada@mactidar.com" }) => {
  const r = await api()({ routeKey, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
    requestContext: { http: { sourceIp: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36" }, authorizer: { jwt: { claims, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};

describe("two-step verification settings", () => {
  it("reports which methods are on", async () => {
    state = { totp: true, email: false };
    expect(await call("GET /v1/account/mfa")).toEqual({ status: 200, body: { totp: true, email: false } });
  });
  it("turns methods on and off and emails the backup address once per change", async () => {
    const r = await call("PUT /v1/account/mfa", { totp: true, email: true });
    expect(r).toEqual({ status: 200, body: { totp: true, email: true } });
    expect(sent.map(s => s.event)).toEqual(["totp-on", "email-mfa-on"]);
    expect(sent[0]).toMatchObject({ to: "backup@gmail.com", ctx: { address: "ada@mactidar.com", ip: "203.0.113.7", device: "Chrome on macOS" } });
    sent = [];
    await call("PUT /v1/account/mfa", { email: false });
    expect(state).toEqual({ totp: true, email: false });
    expect(sent.map(s => s.event)).toEqual(["email-mfa-off"]);
  });
  it("sends no alert when nothing changes, or when the backup email isn't verified", async () => {
    await call("PUT /v1/account/mfa", { totp: false });
    expect(sent).toEqual([]);
    acct = { ...ACCOUNT, emailVerified: false };
    await call("PUT /v1/account/mfa", { email: true });
    expect(sent).toEqual([]);
  });
  it("refuses bad bodies and an app that wasn't set up", async () => {
    for (const b of [{}, { totp: "yes" }, { sms: true }, { totp: true, extra: 1 }]) expect((await call("PUT /v1/account/mfa", b)).status).toBe(400);
    failSet = "InvalidParameterException";
    const r = await call("PUT /v1/account/mfa", { totp: true });
    expect(r).toEqual({ status: 400, body: { error: "Finish setting up your authenticator app first" } });
    expect(sent).toEqual([]);
  });
  it("needs a Mac Tidar username", async () => {
    expect((await call("GET /v1/account/mfa", undefined, { sub: "sub-a" })).status).toBe(400);
  });
});

describe("sign out of all devices", () => {
  it("emails the backup address after revoking, and still revokes without a username", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "SESSION#x", sk: "KEY" }] });
    ddb.on(DeleteCommand).resolves({});
    expect((await call("DELETE /v1/sessions")).body).toEqual({ deleted: 1 });
    expect(sent.map(s => s.event)).toEqual(["signed-out-everywhere"]);
    sent = [];
    expect((await call("DELETE /v1/sessions", undefined, { sub: "sub-a" })).status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("alert emails", () => {
  it("say what changed, when and from where, with no links", () => {
    const { subject, text } = alertEmail("totp-off", { address: "ada@mactidar.com", at: new Date("2026-10-29T12:00:00Z"), ip: "203.0.113.7", device: "Safari on iOS" });
    expect(subject).toBe("Security alert: Authenticator app turned off");
    expect(text).toContain("Account: ada@mactidar.com");
    expect(text).toContain("When: Thu, 29 Oct 2026 12:00:00 UTC");
    expect(text).toContain("From: Safari on iOS, IP address 203.0.113.7");
    expect(text).not.toMatch(/https?:\/\//);
  });
  it("names common browsers", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1")).toBe("Safari on iOS");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(deviceName(undefined)).toBeUndefined();
  });
});

describe("password reset alert", () => {
  const auth = () => createAuth({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), cognito: new CognitoIdentityProviderClient({}),
    config: { table: "t", signupDomain: "mactidar.com", localDomains: ["mactidar.com"] }, alert: async (to, event, ctx) => { sent.push({ to, event, ctx }); } });
  const confirm = (triggerSource: string, email_verified = "true") => ({ triggerSource, userName: "ada@mactidar.com", request: { userAttributes: { email: "backup@gmail.com", email_verified } }, response: {} }) as unknown as PostConfirmationTriggerEvent;
  it("emails after a completed reset, not after sign-up", async () => {
    const e = confirm("PostConfirmation_ConfirmForgotPassword");
    expect(await auth()(e)).toBe(e);
    expect(sent).toMatchObject([{ to: "backup@gmail.com", event: "password-reset", ctx: { address: "ada@mactidar.com" } }]);
    sent = [];
    await auth()(confirm("PostConfirmation_ConfirmSignUp"));
    await auth()(confirm("PostConfirmation_ConfirmForgotPassword", "false"));
    expect(sent).toEqual([]);
  });
});
