import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../../src/api/handler";
import { validateClaim } from "../../src/api/signup";

const ddb = mockClient(DynamoDBDocumentClient);
const api = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), config: { table: "t", bucket: "b", configurationSet: "c", localDomains: ["beta.mactidar.com", "mactidar.com"], region: "af-south-1", signupDomain: "mactidar.com" } });
const call = async (routeKey: string, opts: { sub?: string | null; body?: unknown; query?: Record<string, string> } = {}) => {
  const r = await api()({ routeKey, queryStringParameters: opts.query, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
    requestContext: { authorizer: opts.sub === null ? undefined : { jwt: { claims: { sub: opts.sub ?? "sub-new" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};
const cancelled = (codes: string[]) => new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: codes.map(Code => ({ Code })) });

beforeEach(() => ddb.reset());

describe("choosing an address", () => {
  it("accepts ordinary addresses and normalises them", () => {
    expect(validateClaim({ localPart: " Ada.Obi ", displayName: "Ada  Obi" }, "mactidar.com")).toEqual({ address: "ada.obi@mactidar.com", displayName: "Ada Obi" });
  });
  it("rejects bad shapes, reserved names and official-looking names", () => {
    for (const localPart of ["ab", "a..b", ".ada", "ada.", "ada b", "Ad@", "x".repeat(31), "admin", "post.master", "mactidar-help", "admin2", "no_reply", "support1"]) {
      expect(() => validateClaim({ localPart, displayName: "Ada" }, "mactidar.com"), localPart).toThrow();
    }
    for (const displayName of ["", "Mac Tidar Support", "a@b.com", "<script>", "x".repeat(65)]) {
      expect(() => validateClaim({ localPart: "ada", displayName }, "mactidar.com"), displayName).toThrow();
    }
  });
});

describe("POST /v1/mailboxes", () => {
  it("claims a free address for an account without a mailbox, with the lower sending limit", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    const r = await call("POST /v1/mailboxes", { body: { localPart: "ada", displayName: "Ada" } });
    expect(r.status).toBe(201);
    expect(r.body.mailbox).toEqual({ address: "ada@mactidar.com", displayName: "Ada", keyState: null, keyVersion: 0 });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.map(t => t.Put!.Item!);
    expect(items[0]).toMatchObject({ pk: "OWNER#sub-new", sk: "CLAIM" });
    expect(items[1]).toMatchObject({ pk: "MAILBOX#ada@mactidar.com", ownerSub: "sub-new", createdBy: "self", dailyRecipientLimit: 50, status: "active" });
  });
  it("refuses a second mailbox and taken addresses", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "MAILBOX#x@mactidar.com" }] });
    expect((await call("POST /v1/mailboxes", { body: { localPart: "ada", displayName: "Ada" } })).status).toBe(409);
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed"]));
    const taken = await call("POST /v1/mailboxes", { body: { localPart: "ada", displayName: "Ada" } });
    expect(taken).toMatchObject({ status: 409, body: { error: expect.stringMatching(/taken/) } });
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None"]));
    expect((await call("POST /v1/mailboxes", { body: { localPart: "ada2", displayName: "Ada" } })).body.error).toMatch(/already has a mailbox/);
  });
  it("needs a signed-in account", async () => expect((await call("POST /v1/mailboxes", { sub: null, body: { localPart: "ada", displayName: "Ada" } })).status).toBe(401));
});

describe("GET /v1/sign-in-name", () => {
  it("returns only the owning account's opaque username, without sign-in", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "MAILBOX#ada@mactidar.com", ownerSub: "sub-ada", status: "active", displayName: "Ada", keyState: { secret: true } } });
    const r = await call("GET /v1/sign-in-name", { sub: null, query: { address: "Ada@MacTidar.com" } });
    expect(r).toEqual({ status: 200, body: { username: "sub-ada" } });
  });
  it("answers 404 for unknown, suspended or outside addresses", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await call("GET /v1/sign-in-name", { sub: null, query: { address: "nobody@mactidar.com" } })).status).toBe(404);
    ddb.on(GetCommand).resolves({ Item: { ownerSub: "s", status: "suspended" } });
    expect((await call("GET /v1/sign-in-name", { sub: null, query: { address: "ada@mactidar.com" } })).status).toBe(404);
    expect((await call("GET /v1/sign-in-name", { sub: null, query: { address: "ada@gmail.com" } })).status).toBe(404);
  });
});
