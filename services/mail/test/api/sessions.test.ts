import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../../src/api/handler";

const ddb = mockClient(DynamoDBDocumentClient);
const api = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), account: async () => null,
  config: { table: "t", bucket: "b", configurationSet: "c", localDomains: ["mactidar.com"], region: "af-south-1", signupDomain: "mactidar.com" } });
const call = async (routeKey: string, opts: { sub?: string; body?: unknown; id?: string } = {}) => {
  const r = await api()({ routeKey, pathParameters: opts.id ? { id: opts.id } : undefined, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: opts.sub ?? "sub-a" }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};
const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const future = () => Math.floor(Date.now() / 1000) + 3600;

beforeEach(() => ddb.reset());

describe("sign-in sessions", () => {
  it("creates a session holding only a random key, with the right lifetime", async () => {
    ddb.on(QueryCommand).resolves({ Count: 0 });
    ddb.on(PutCommand).resolves({});
    const r = await call("POST /v1/sessions", { body: { persistent: true } });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(r.body.clientKey, "base64")).toHaveLength(32);
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ pk: `SESSION#${r.body.id}`, gsi1pk: "SESSIONS#sub-a", ownerSub: "sub-a", ttlSeconds: 30 * 86400 });
    await call("POST /v1/sessions", { body: { persistent: false } });
    expect(ddb.commandCalls(PutCommand)[1]!.args[0].input.Item!.ttlSeconds).toBe(12 * 3600);
  });
  it("refuses a bad body and too many sessions", async () => {
    expect((await call("POST /v1/sessions", { body: {} })).status).toBe(400);
    ddb.on(QueryCommand).resolves({ Count: 50 });
    expect((await call("POST /v1/sessions", { body: { persistent: true } })).status).toBe(409);
  });
  it("returns the key only to its owner, before expiry, and slides the expiry", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: `SESSION#${ID}`, ownerSub: "sub-a", clientKey: "k", ttlSeconds: 100, expiresAt: future() } });
    ddb.on(UpdateCommand).resolves({});
    expect(await call("GET /v1/sessions/{id}/key", { id: ID })).toMatchObject({ status: 200, body: { clientKey: "k" } });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    expect((await call("GET /v1/sessions/{id}/key", { id: ID, sub: "sub-b" })).status).toBe(404);
    ddb.on(GetCommand).resolves({ Item: { ownerSub: "sub-a", clientKey: "k", ttlSeconds: 100, expiresAt: 1 } });
    expect((await call("GET /v1/sessions/{id}/key", { id: ID })).status).toBe(404);
    expect((await call("GET /v1/sessions/{id}/key", { id: "../x" })).status).toBe(404);
  });
  it("signs out one session, or all of them", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: `SESSION#${ID}`, ownerSub: "sub-a", clientKey: "k", ttlSeconds: 100, expiresAt: future() } });
    ddb.on(DeleteCommand).resolves({});
    expect((await call("DELETE /v1/sessions/{id}", { id: ID })).status).toBe(200);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "SESSION#1" }, { pk: "SESSION#2" }] });
    expect(await call("DELETE /v1/sessions")).toMatchObject({ status: 200, body: { deleted: 2 } });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ":o": "SESSIONS#sub-a" });
  });
});
