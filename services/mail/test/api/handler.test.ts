import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateMailboxKey, lockPrivateKey } from "../../src/crypto";
import { createHandler } from "../../src/api/handler";
import { FAST_KDF } from "../helpers";

const OWNER = "sub-owner", OTHER = "sub-other", ADDR = "ukeme@beta.mactidar.com";
const ddb = mockClient(DynamoDBDocumentClient), s3 = mockClient(S3Client);
const meta = { pk: `MAILBOX#${ADDR}`, sk: "META", gsi1pk: `OWNER#${OWNER}`, gsi1sk: `MAILBOX#${ADDR}`, address: ADDR, ownerSub: OWNER, displayName: "Ukeme", status: "active", createdAt: "2026-10-27T00:00:00Z" };
const msg = (folder: string, sk = "MSG#2026-10-27T17:29:27.538Z#abc") => ({ pk: meta.pk, sk, type: "message", id: "abc", mailbox: ADDR, folder, category: "primary", receivedAt: "2026-10-27T17:29:27.538Z", threadId: "t1", fromAddress: "a@gmail.com", toAddresses: [ADDR], ccAddresses: [], size: 10, read: false, starred: false, labels: [], encVersion: 1, keyFingerprint: "f", header: "-----BEGIN PGP MESSAGE-----x", bodyKey: `msg/${ADDR}/abc.pgp`, attachmentKeys: [`att/${ADDR}/abc/0.pgp`], gsi1pk: `MAILBOX#${ADDR}#FOLDER#${folder}`, gsi1sk: "x", gsi2pk: "THREAD#t1", gsi2sk: "x", verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" } });

const api = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), config: { table: "mactidar-mail", bucket: "mail", configurationSet: "mactidar-mail", localDomains: ["beta.mactidar.com"], region: "af-south-1", signupDomain: "beta.mactidar.com" }, presign: async (_c, cmd) => `https://signed/${cmd.input.Key}` });

function req(routeKey: string, opts: { sub?: string | null; address?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const [, path] = routeKey.split(" ");
  return {
    routeKey, rawPath: path, pathParameters: opts.address === undefined ? (path!.includes("{address}") ? { address: encodeURIComponent(ADDR) } : undefined) : { address: opts.address },
    queryStringParameters: opts.query, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
    requestContext: { authorizer: opts.sub === null ? undefined : { jwt: { claims: { sub: opts.sub ?? OWNER }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const call = async (...a: Parameters<typeof req>) => { const r = await api()(req(...a)); return { status: r.statusCode!, body: JSON.parse(r.body as string) }; };

let validState: Record<string, unknown>;
let unlockedArmored: string;

beforeAll(async () => {
  const k = await generateMailboxKey(ADDR);
  const locked = await lockPrivateKey(k.privateKey, "pass", FAST_KDF);
  validState = { version: 1, address: ADDR, primaryFingerprint: k.fingerprint, keys: [{ fingerprint: k.fingerprint, publicKey: k.publicKey, privateKey: locked, status: "active", createdAt: "2026-10-27T00:00:00Z" }], recovery: null };
  unlockedArmored = k.privateKey.armor();
});

beforeEach(() => {
  ddb.reset(); s3.reset();
  ddb.on(GetCommand, { Key: { pk: meta.pk, sk: "META" } }).resolves({ Item: meta });
});

describe("authentication and ownership", () => {
  it("rejects requests without a signed-in user", async () => expect((await call("GET /v1/mailboxes", { sub: null })).status).toBe(401));

  it("answers 404 for every mailbox route when the caller is not the owner", async () => {
    for (const route of ["GET /v1/mailboxes/{address}/messages", "GET /v1/mailboxes/{address}/settings", "GET /v1/mailboxes/{address}/content"]) {
      expect((await call(route, { sub: OTHER, query: { sk: "MSG#x#y" } })).status).toBe(404);
    }
    expect((await call("PUT /v1/mailboxes/{address}/keys", { sub: OTHER, body: { keyState: validState, expectedVersion: 0 } })).status).toBe(404);
    expect((await call("PATCH /v1/mailboxes/{address}/messages", { sub: OTHER, body: { sks: ["MSG#2026#abc"], set: { read: true } } })).status).toBe(404);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("answers 404 for mailboxes that don't exist", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await call("GET /v1/mailboxes/{address}/messages", { address: "nobody%40beta.mactidar.com" })).status).toBe(404);
  });

  it("lists only the caller's mailboxes", async () => {
    ddb.on(QueryCommand).resolves({ Items: [meta, { ...meta, address: "x@y.com", ownerSub: OTHER }] });
    const r = await call("GET /v1/mailboxes");
    expect(r.body.mailboxes).toEqual([{ address: ADDR, displayName: "Ukeme", keyState: null, keyVersion: 0 }]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ":o": `OWNER#${OWNER}` });
  });
});

describe("keys", () => {
  it("stores a valid locked keyState with optimistic versioning", async () => {
    ddb.on(UpdateCommand).resolves({});
    const r = await call("PUT /v1/mailboxes/{address}/keys", { body: { keyState: validState, expectedVersion: 0 } });
    expect(r).toEqual({ status: 200, body: { keyVersion: 1 } });
  });

  it("refuses an unlocked private key", async () => {
    const bad = { ...validState, keys: [{ ...(validState.keys as object[])[0], privateKey: unlockedArmored }] };
    const r = await call("PUT /v1/mailboxes/{address}/keys", { body: { keyState: bad, expectedVersion: 0 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/encrypted before upload/);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("refuses keys for another address or with a mismatched fingerprint", async () => {
    expect((await call("PUT /v1/mailboxes/{address}/keys", { body: { keyState: { ...validState, address: "x@beta.mactidar.com" }, expectedVersion: 0 } })).status).toBe(400);
    const wrongFp = { ...validState, primaryFingerprint: "0".repeat(40), keys: [{ ...(validState.keys as object[])[0], fingerprint: "0".repeat(40) }] };
    expect((await call("PUT /v1/mailboxes/{address}/keys", { body: { keyState: wrongFp, expectedVersion: 0 } })).status).toBe(400);
  });

  it("reports a conflict when another device changed the keys first", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    expect((await call("PUT /v1/mailboxes/{address}/keys", { body: { keyState: validState, expectedVersion: 3 } })).status).toBe(409);
  });
});

describe("messages", () => {
  it("lists a folder without exposing storage keys", async () => {
    ddb.on(QueryCommand).resolves({ Items: [msg("inbox")], LastEvaluatedKey: { gsi1pk: `MAILBOX#${ADDR}#FOLDER#inbox`, gsi1sk: "x", pk: meta.pk, sk: "s" } });
    const r = await call("GET /v1/mailboxes/{address}/messages", { query: { folder: "inbox" } });
    expect(r.body.messages[0]).toMatchObject({ sk: msg("inbox").sk, folder: "inbox", attachmentCount: 1, header: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toMatch(/bodyKey|attachmentKeys|msg\/|att\//);
    expect(r.body.cursor).toEqual(expect.any(String));
  });

  it("rejects a cursor for another mailbox's folder", async () => {
    const cursor = Buffer.from(JSON.stringify({ gsi1pk: "MAILBOX#victim@beta.mactidar.com#FOLDER#inbox" })).toString("base64url");
    expect((await call("GET /v1/mailboxes/{address}/messages", { query: { folder: "inbox", cursor } })).status).toBe(400);
  });

  it("signs a short-lived download for the body and attachments", async () => {
    ddb.on(GetCommand, { Key: { pk: meta.pk, sk: msg("inbox").sk } }).resolves({ Item: msg("inbox") });
    expect((await call("GET /v1/mailboxes/{address}/content", { query: { sk: msg("inbox").sk, part: "body" } })).body.url).toBe(`https://signed/msg/${ADDR}/abc.pgp`);
    expect((await call("GET /v1/mailboxes/{address}/content", { query: { sk: msg("inbox").sk, part: "attachment", index: "0" } })).body.url).toBe(`https://signed/att/${ADDR}/abc/0.pgp`);
    expect((await call("GET /v1/mailboxes/{address}/content", { query: { sk: msg("inbox").sk, part: "attachment", index: "9" } })).status).toBe(404);
  });

  it("moves messages between folders and keeps the folder index in step", async () => {
    ddb.on(UpdateCommand).resolves({});
    const r = await call("PATCH /v1/mailboxes/{address}/messages", { body: { sks: [msg("inbox").sk], set: { folder: "archive", read: true } } });
    expect(r.body).toEqual({ updated: 1 });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: meta.pk, sk: msg("inbox").sk });
    expect(input.ExpressionAttributeValues).toMatchObject({ ":folder": "archive", ":read": true, ":g": `MAILBOX#${ADDR}#FOLDER#archive` });
  });

  it("rejects unknown fields and readable label names", async () => {
    expect((await call("PATCH /v1/mailboxes/{address}/messages", { body: { sks: [msg("inbox").sk], set: { header: "x" } } })).status).toBe(400);
    expect((await call("PATCH /v1/mailboxes/{address}/messages", { body: { sks: [msg("inbox").sk], set: { labels: ["Board meeting notes"] } } })).status).toBe(400);
  });

  it("only deletes forever from Trash or Spam, removing every stored version", async () => {
    ddb.on(GetCommand, { Key: { pk: meta.pk, sk: msg("inbox").sk } }).resolves({ Item: msg("inbox") });
    expect((await call("POST /v1/mailboxes/{address}/messages/delete", { body: { sks: [msg("inbox").sk] } })).status).toBe(400);

    ddb.on(GetCommand, { Key: { pk: meta.pk, sk: msg("inbox").sk } }).resolves({ Item: msg("trash") });
    s3.on(ListObjectVersionsCommand).callsFake(i => ({ Versions: [{ Key: i.Prefix, VersionId: "v1" }, { Key: i.Prefix, VersionId: "v2" }] }));
    s3.on(DeleteObjectsCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    expect((await call("POST /v1/mailboxes/{address}/messages/delete", { body: { sks: [msg("inbox").sk] } })).body).toEqual({ deleted: 1 });
    const deleted = s3.commandCalls(DeleteObjectsCommand).flatMap(c => c.args[0].input.Delete!.Objects!);
    expect(deleted).toHaveLength(4);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});

describe("settings", () => {
  it("accepts only encrypted settings blobs", async () => {
    expect((await call("PUT /v1/mailboxes/{address}/settings", { body: { blob: '{"labels":["Board"]}', expectedVersion: 0 } })).status).toBe(400);
    ddb.on(PutCommand).resolves({});
    expect((await call("PUT /v1/mailboxes/{address}/settings", { body: { blob: "-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----", expectedVersion: 0 } })).body).toEqual({ version: 1 });
  });
});
