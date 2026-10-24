import { createCipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { SESEvent } from "aws-lambda";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptAttachment, decryptMessageBody, decryptMessageHeader, generateMailboxKey, type PrivateKey } from "../../src/crypto";
import { createHandler } from "../../src/inbound/handler";
import { UnsupportedEnvelopeError } from "../../src/inbound/raw-decrypt";
import { containsPlaintext } from "../helpers";

/** The handler only calls transformToByteArray() on the S3 body. */
const streamOf = (bytes: Uint8Array) => ({ transformToByteArray: async () => new Uint8Array(bytes) }) as never;

const RAW_KEY_ARN = "arn:aws:kms:af-south-1:111111111111:key/raw";
const MAILBOX = "ukeme@beta.mactidar.com";
const SUBJECT = "Q3 roadmap sign-off";
const BODY = "Latency is under 38ms and the board approved the plan.";
const ATTACHMENT = "confidential,numbers\n1,2\n";

const s3 = mockClient(S3Client), kms = mockClient(KMSClient), ddbBase = mockClient(DynamoDBDocumentClient);
const dataKey = randomBytes(32);
let privateKey: PrivateKey, fingerprint: string, publicKey: string;
let puts: { key: string; body: Uint8Array }[], items: Record<string, unknown>[], logs: Record<string, unknown>[];

function rfc822(from = "elena@gmail.com", extraHeaders = "") {
  const boundary = "b1";
  return [
    `From: Elena Rostova <${from}>`, `To: ${MAILBOX}`, `Subject: ${SUBJECT}`, "Message-ID: <m1@gmail.com>", "MIME-Version: 1.0", ...(extraHeaders ? [extraHeaders] : []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", BODY, `--${boundary}`,
    'Content-Type: text/csv; name="numbers.csv"', 'Content-Disposition: attachment; filename="numbers.csv"', "Content-Transfer-Encoding: base64", "",
    Buffer.from(ATTACHMENT).toString("base64"), `--${boundary}--`, "",
  ].join("\r\n");
}

/** Encrypt like SES's S3 action does (S3 Encryption Client v2, kms+context). */
function sesEnvelope(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, iv);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const context = { "aws:x-amz-cek-alg": "AES/GCM/NoPadding", "aws:ses:message-id": "ses-1", "aws:ses:rule-name": "inbound", "aws:ses:source-account": "111111111111" };
  return {
    body,
    metadata: { "x-amz-key-v2": Buffer.from("wrapped").toString("base64"), "x-amz-iv": iv.toString("base64"), "x-amz-cek-alg": "AES/GCM/NoPadding", "x-amz-wrap-alg": "kms+context", "x-amz-tag-len": "128", "x-amz-matdesc": JSON.stringify(context) },
  };
}

function event(verdicts: Partial<Record<"spam" | "virus" | "dmarc", string>> = {}, recipients = [MAILBOX]): SESEvent {
  const v = (s = "PASS") => ({ status: s });
  return { Records: [{ eventSource: "aws:ses", eventVersion: "1.0", ses: {
    mail: { messageId: "ses-1", timestamp: "2026-10-24T10:00:00.000Z", source: "elena@gmail.com", destination: recipients } as never,
    receipt: { timestamp: "2026-10-24T10:00:01.000Z", recipients, spamVerdict: v(verdicts.spam), virusVerdict: v(verdicts.virus), spfVerdict: v(), dkimVerdict: v(), dmarcVerdict: v(verdicts.dmarc) } as never,
  } }] };
}

function stubRaw(plain = rfc822()) {
  const { body, metadata } = sesEnvelope(plain);
  s3.on(GetObjectCommand).resolves({ Body: streamOf(body), Metadata: metadata, VersionId: "v-raw" });
}

function stubMailbox(withKeys = true) {
  ddbBase.on(GetCommand).resolves({ Item: { pk: `MAILBOX#${MAILBOX}`, sk: "META", address: MAILBOX, ownerSub: "sub-1", displayName: "Ukeme", status: "active", createdAt: "x",
    ...(withKeys ? { keyState: { version: 1, address: MAILBOX, primaryFingerprint: fingerprint, keys: [{ fingerprint, publicKey, privateKey: "locked", status: "active", createdAt: "x" }], recovery: null } } : {}) } });
}

const handler = () => createHandler({
  s3: new S3Client({}), kms: new KMSClient({}), ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  config: { bucket: "mail", table: "mactidar-mail", rawPrefix: "raw/", rawKeyArn: RAW_KEY_ARN, receivingDomains: ["beta.mactidar.com"], localDomains: ["mactidar.com"] },
  log: e => logs.push(e),
});

beforeAll(async () => {
  const k = await generateMailboxKey(MAILBOX);
  privateKey = k.privateKey; fingerprint = k.fingerprint; publicKey = k.publicKey;
});

beforeEach(() => {
  s3.reset(); kms.reset(); ddbBase.reset();
  puts = []; items = []; logs = [];
  kms.on(DecryptCommand).callsFake(input => {
    expect(input.KeyId).toBe(RAW_KEY_ARN);
    expect(input.EncryptionContext["aws:ses:message-id"]).toBe("ses-1");
    return { Plaintext: new Uint8Array(dataKey) };
  });
  s3.on(PutObjectCommand).callsFake(input => { puts.push({ key: input.Key, body: input.Body }); return {}; });
  ddbBase.on(PutCommand).callsFake(input => { items.push(input.Item); return {}; });
  stubMailbox();
});

describe("inbound handler", () => {
  it("stores only ciphertext that the mailbox key can decrypt, then deletes the raw version", async () => {
    stubRaw();
    await handler()(event());

    expect(items).toHaveLength(1);
    const item = items[0] as Record<string, unknown> & { header: string; bodyKey: string; attachmentKeys: string[] };
    expect(item).toMatchObject({ folder: "inbox", category: "primary", read: false, keyFingerprint: fingerprint, fromAddress: "elena@gmail.com", gsi1pk: `MAILBOX#${MAILBOX}#FOLDER#inbox` });

    const serialized = JSON.stringify(item);
    for (const secret of [SUBJECT, BODY, "Elena Rostova", "numbers.csv", ATTACHMENT.trim()]) expect(containsPlaintext(serialized, secret)).toBe(false);
    for (const p of puts) for (const secret of [SUBJECT, BODY, ATTACHMENT.trim()]) expect(containsPlaintext(p.body, secret)).toBe(false);

    const { header } = await decryptMessageHeader(item.header, { decryptionKeys: [privateKey] });
    expect(header).toMatchObject({ subject: SUBJECT, fromName: "Elena Rostova", attachments: [{ filename: "numbers.csv", contentType: "text/csv" }] });
    const body = puts.find(p => p.key === item.bodyKey)!;
    expect((await decryptMessageBody(body.body, { decryptionKeys: [privateKey] })).body.text.trim()).toBe(BODY);
    const att = puts.find(p => p.key === item.attachmentKeys[0])!;
    expect(Buffer.from((await decryptAttachment(att.body, { decryptionKeys: [privateKey] })).data).toString()).toBe(ATTACHMENT);

    const del = s3.commandCalls(DeleteObjectCommand);
    expect(del).toHaveLength(1);
    expect(del[0]!.args[0].input).toMatchObject({ Key: "raw/ses-1", VersionId: "v-raw" });
    expect(JSON.stringify(logs)).not.toContain(SUBJECT);
  });

  it("files spam and DMARC failures in Spam", async () => {
    stubRaw();
    await handler()(event({ spam: "FAIL" }));
    expect(items[0]).toMatchObject({ folder: "spam", gsi1pk: `MAILBOX#${MAILBOX}#FOLDER#spam` });
  });

  it("drops viruses without storing anything", async () => {
    stubRaw();
    await handler()(event({ virus: "FAIL" }));
    expect(items).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(logs).toContainEqual({ event: "dropped", sesId: "ses-1", reason: "virus" });
  });

  it("drops outside mail spoofing an @mactidar.com sender", async () => {
    stubRaw(rfc822("ceo@mactidar.com"));
    await handler()(event({ dmarc: "FAIL" }));
    expect(items).toHaveLength(0);
    expect(logs[0]).toMatchObject({ event: "dropped", reason: "spoofed-local-sender" });
  });

  it("ignores unknown recipients and recipients outside the receiving domains", async () => {
    stubRaw();
    ddbBase.on(GetCommand).resolves({});
    await handler()(event({}, [MAILBOX, "x@other.com"]));
    expect(items).toHaveLength(0);
    expect(ddbBase.commandCalls(GetCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("keeps the encrypted raw object while the mailbox has no keys yet", async () => {
    stubRaw();
    stubMailbox(false);
    await handler()(event());
    expect(items).toHaveLength(0);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: "processed", pending: 1, stored: 0 }));
  });

  it("is idempotent when SES retries an invocation that already stored the message", async () => {
    stubRaw();
    ddbBase.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    await expect(handler()(event())).resolves.toBeUndefined();
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it("refuses envelopes it does not recognise rather than guessing", async () => {
    const { body, metadata } = sesEnvelope(rfc822());
    s3.on(GetObjectCommand).resolves({ Body: streamOf(body), Metadata: { ...metadata, "x-amz-cek-alg": "AES/CBC/PKCS5Padding" } });
    await expect(handler()(event())).rejects.toBeInstanceOf(UnsupportedEnvelopeError);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("rejects tampered ciphertext", async () => {
    const { body, metadata } = sesEnvelope(rfc822());
    body[5] = body[5]! ^ 0xff;
    s3.on(GetObjectCommand).resolves({ Body: streamOf(body), Metadata: metadata });
    await expect(handler()(event())).rejects.toThrow();
    expect(items).toHaveLength(0);
  });
});
