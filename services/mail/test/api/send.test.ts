import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptAttachment, encryptMessageParts, generateMailboxKey, type PublicKey } from "../../src/crypto";
import { readPublicKey } from "../../src/crypto/keys";
import { createHandler } from "../../src/api/handler";
import { containsPlaintext } from "../helpers";

const OWNER = "sub-owner", ME = "ukeme@beta.mactidar.com", FRIEND = "john@beta.mactidar.com";
const SECRET = "Quarterly numbers: 4.2M ARR";
const ddb = mockClient(DynamoDBDocumentClient), s3 = mockClient(S3Client), ses = mockClient(SESv2Client);
let myFp = "", friendFp = "", myPub: PublicKey, friendPub: PublicKey;
let items: Record<string, unknown>[], objects: { key: string; body: Uint8Array }[], sentMime = "";

const api = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), s3: new S3Client({}), ses: new SESv2Client({}), config: { table: "t", bucket: "b", configurationSet: "mactidar-mail", localDomains: ["beta.mactidar.com"], region: "af-south-1", signupDomain: "beta.mactidar.com" } });
const meta = (address: string, fp: string, owner = OWNER) => ({ pk: `MAILBOX#${address}`, sk: "META", address, ownerSub: owner, displayName: "Ukeme Eseme", status: "active", gsi1pk: "x", gsi1sk: "x", createdAt: "x", keyState: { version: 1, address, primaryFingerprint: fp, keys: [{ fingerprint: fp, publicKey: "p", privateKey: "x", status: "active", createdAt: "x" }], recovery: null } });

async function cipherFor(keys: PublicKey[], fp: string, attachments: Uint8Array[] = []) {
  const m = await encryptMessageParts({ header: { subject: SECRET, preview: SECRET, fromName: "Ukeme", attachments: attachments.map((a, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", size: a.byteLength })) }, body: { text: SECRET } }, { encryptionKeys: keys });
  return { header: m.header, body: Buffer.from(m.body).toString("base64"), attachments: await Promise.all(attachments.map(async a => Buffer.from(await encryptAttachment(a, { encryptionKeys: keys })).toString("base64"))), keyFingerprint: fp };
}

const send = async (body: unknown) => {
  const r = await api()({ routeKey: "POST /v1/mailboxes/{address}/send", pathParameters: { address: encodeURIComponent(ME) }, body: JSON.stringify(body), isBase64Encoded: false, requestContext: { authorizer: { jwt: { claims: { sub: OWNER }, scopes: [] } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
  return { status: r.statusCode!, body: JSON.parse(r.body as string) };
};

beforeAll(async () => {
  const a = await generateMailboxKey(ME), b = await generateMailboxKey(FRIEND);
  myFp = a.fingerprint; friendFp = b.fingerprint; myPub = await readPublicKey(a.publicKey); friendPub = await readPublicKey(b.publicKey);
});

beforeEach(() => {
  ddb.reset(); s3.reset(); ses.reset(); items = []; objects = [];
  ddb.on(GetCommand, { Key: { pk: `MAILBOX#${ME}`, sk: "META" } }).resolves({ Item: meta(ME, myFp) });
  ddb.on(GetCommand, { Key: { pk: `MAILBOX#${FRIEND}`, sk: "META" } }).resolves({ Item: meta(FRIEND, friendFp, "sub-friend") });
  ddb.on(PutCommand).callsFake(i => { items.push(i.Item); return {}; });
  ddb.on(UpdateCommand).resolves({});
  s3.on(PutObjectCommand).callsFake(i => { objects.push({ key: i.Key, body: i.Body }); return {}; });
  // Copy the MIME: the handler wipes its buffer as soon as SES has it.
  ses.on(SendEmailCommand).callsFake(i => { sentMime = Buffer.from(i.Content.Raw.Data).toString(); return { MessageId: "ses-123" }; });
});

describe("sending", () => {
  it("sends to outside recipients through SES and stores only an encrypted Sent copy", async () => {
    const r = await send({ clientId: "draft-0001", to: ["elena@gmail.com"], cc: [], bcc: ["boss@yahoo.com"], references: ["<a@gmail.com>"], inReplyTo: "<a@gmail.com>",
      external: { subject: "Hello", text: SECRET, attachments: [{ filename: "notes.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") }] },
      internal: [], sentCopy: await cipherFor([myPub], myFp, [Buffer.from("hi")]) });
    expect(r.status).toBe(200);
    const call = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(call.FromEmailAddress).toBe(ME);
    expect(call.Destination).toEqual({ ToAddresses: ["elena@gmail.com"], CcAddresses: [], BccAddresses: ["boss@yahoo.com"] });
    const mime = sentMime;
    expect(Buffer.from(call.Content!.Raw!.Data!).every(b => b === 0)).toBe(true);
    expect(mime).toMatch(/In-Reply-To: <a@gmail.com>/);
    expect(mime).toMatch(/^Subject: Hello/m);
    expect(mime).not.toMatch(/^Bcc:/m);
    const sent = items.find(i => (i as { folder?: string }).folder === "sent") as Record<string, unknown>;
    expect(sent).toMatchObject({ folder: "sent", sesMessageId: "ses-123", deliveryStatus: "sent", fromAddress: ME, bccAddresses: ["boss@yahoo.com"] });
    expect(items).toContainEqual(expect.objectContaining({ pk: "SESMSG#ses-123" }));
    for (const it of items) expect(containsPlaintext(JSON.stringify(it), SECRET)).toBe(false);
    for (const o of objects) expect(containsPlaintext(o.body, SECRET)).toBe(false);
    // SES rewrites Message-ID; the Sent copy records the one recipients see so their replies thread.
    expect(r.body.message).toMatchObject({ folder: "sent", rfcMessageId: "<ses-123@af-south-1.amazonses.com>" });
    expect(mime).toMatch(/Message-ID: <[^>]+@beta\.mactidar\.com>/);
  });

  it("delivers Mac Tidar mail end to end without SES and without any readable content", async () => {
    const r = await send({ clientId: "draft-0002", to: [FRIEND], cc: [], bcc: [], internal: [{ address: FRIEND, ...await cipherFor([friendPub, myPub], friendFp) }], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(200);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    const inbox = items.find(i => (i as { pk: string }).pk === `MAILBOX#${FRIEND}`);
    expect(inbox).toMatchObject({ folder: "inbox", e2e: true, keyFingerprint: friendFp, fromAddress: ME, read: false });
    // Encrypted content can't be scanned; the stored verdicts say so instead of claiming a pass.
    expect(inbox).toMatchObject({ verdicts: { spam: "NOT_SCANNED", virus: "NOT_SCANNED", dmarc: "INTERNAL" } });
    expect(r.body.message).toMatchObject({ e2e: true, deliveryStatus: "delivered" });
  });

  it("refuses readable content when every recipient is on Mac Tidar", async () => {
    const r = await send({ clientId: "draft-0003", to: [FRIEND], external: { subject: "x", text: "leak", attachments: [] }, internal: [{ address: FRIEND, ...await cipherFor([friendPub], friendFp) }], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(400);
  });

  it("refuses a readable subject when every recipient is on Mac Tidar", async () => {
    const r = await send({ clientId: "draft-0008", to: [FRIEND], subject: "Private", internal: [{ address: FRIEND, ...await cipherFor([friendPub], friendFp) }], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(400);
    expect(items.filter(i => (i as { folder?: string }).folder)).toHaveLength(0);
  });

  it("refuses ciphertext made for a recipient's old key", async () => {
    const r = await send({ clientId: "draft-0004", to: [FRIEND], internal: [{ address: FRIEND, ...await cipherFor([friendPub], "0".repeat(40)) }], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(400);
    expect(items.filter(i => (i as { folder?: string }).folder)).toHaveLength(0);
  });

  it("never sends the same message twice", async () => {
    ddb.on(PutCommand, { Item: { sk: "SEND#draft-0005" } as never }).rejects(new ConditionalCheckFailedException({ message: "dup", $metadata: {} }));
    const r = await send({ clientId: "draft-0005", to: ["a@gmail.com"], external: { subject: "x", text: "x", attachments: [] }, internal: [], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(409);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("enforces the daily recipient limit and frees the request for a retry", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "limit", $metadata: {} }));
    ddb.on(DeleteCommand).resolves({});
    const r = await send({ clientId: "draft-0006", to: ["a@gmail.com"], external: { subject: "x", text: "x", attachments: [] }, internal: [], sentCopy: await cipherFor([myPub], myFp) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Daily sending limit/);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("blocks header injection, bad addresses, blocked file types and Sent copies for someone else's key", async () => {
    const base = { clientId: "draft-0007", to: ["a@gmail.com"], external: { subject: "x", text: "x", attachments: [] }, internal: [], sentCopy: await cipherFor([myPub], myFp) };
    expect((await send({ ...base, external: { subject: "Hi\r\nBcc: victim@x.com", text: "x", attachments: [] } })).status).toBe(400);
    expect((await send({ ...base, to: ["a@gmail.com>, evil@x.com"] })).status).toBe(400);
    expect((await send({ ...base, external: { subject: "x", text: "x", attachments: [{ filename: "invoice.exe", contentType: "application/octet-stream", content: "AA==" }] }, sentCopy: await cipherFor([myPub], myFp, [Buffer.from("x")]) })).status).toBe(400);
    expect((await send({ ...base, sentCopy: await cipherFor([friendPub], friendFp) })).status).toBe(400);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
