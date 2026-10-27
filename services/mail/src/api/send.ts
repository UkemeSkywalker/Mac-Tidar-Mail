// Sending. External recipients: MIME is built in memory and handed to SES, never stored.
// Mac Tidar recipients: browser-encrypted ciphertext is delivered straight into their mailbox.
// The sender's Sent copy is ciphertext the browser encrypted to the sender's own key.
import { randomUUID } from "node:crypto";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import MailComposer from "nodemailer/lib/mail-composer";
import { threadId, threadRoot } from "../inbound/thread";
import { folderGsi1, mailboxPk, META_SK, messageSk, sesPointerPk, threadGsi2, type MailboxMeta, type MessageItem } from "../shared/table";
import { notifyMailboxes } from "../shared/notify";
import type { Cipher, SendRequest } from "./send-validate";
import { BadRequest } from "./validate";

export const DAILY_RECIPIENT_LIMIT = 300;

export interface SendDeps { ddb: DynamoDBDocumentClient; s3: S3Client; ses: SESv2Client; table: string; bucket: string; configurationSet: string; region: string }
export class Conflict extends Error {}

const domainOf = (a: string) => a.split("@")[1] ?? "";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (d: number) => Math.floor(Date.now() / 1000) + d * 86_400;

export async function sendMessage(deps: SendDeps, sender: MailboxMeta, req: SendRequest) {
  const { ddb, s3, table, bucket } = deps;
  const senderKeys = sender.keyState?.keys.map(k => k.fingerprint) ?? [];
  if (!senderKeys.includes(req.sentCopy.keyFingerprint)) throw new BadRequest("The Sent copy must be encrypted to your own key");

  // 1. Idempotency: a retried request must never send twice.
  try {
    await ddb.send(new PutCommand({ TableName: table, Item: { pk: sender.pk, sk: `SEND#${req.clientId}`, expiresAt: inDays(2) }, ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) throw new Conflict("This message was already sent");
    throw e;
  }
  const releaseIdempotency = async () => {
    try { await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: sender.pk, sk: `SEND#${req.clientId}` } })); } catch { /* the marker expires on its own */ }
  };
  // Once anything has left (SES accepted it or a recipient copy was written), a retry would duplicate it.
  let delivered = false;

  try {
    // 2. Daily per-mailbox recipient cap (abuse protection for the shared sending reputation).
    const recipients = new Set([...req.to, ...req.cc, ...req.bcc]).size;
    try {
      await ddb.send(new UpdateCommand({
        TableName: table, Key: { pk: sender.pk, sk: `QUOTA#${today()}` },
        UpdateExpression: "ADD recipients :n SET expiresAt = :exp",
        ConditionExpression: "attribute_not_exists(recipients) OR recipients <= :max",
        ExpressionAttributeValues: { ":n": recipients, ":max": DAILY_RECIPIENT_LIMIT - recipients, ":exp": inDays(3) },
      }));
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) throw new BadRequest(`Daily sending limit reached (${DAILY_RECIPIENT_LIMIT} recipients per day)`);
      throw e;
    }

    // 3. Every Mac Tidar recipient must be a real mailbox, and the ciphertext must be for its current key.
    const internalMetas = await Promise.all(req.internal.map(async d => {
      const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { pk: mailboxPk(d.address), sk: META_SK } }));
      const meta = Item as MailboxMeta | undefined;
      if (!meta || meta.status !== "active" || meta.keyState?.primaryFingerprint !== d.keyFingerprint) throw new BadRequest(`${d.address} can't receive encrypted mail right now; reload and try again`);
      return meta;
    }));

    const now = new Date();
    const rfcMessageId = `<${randomUUID()}@${domainOf(sender.address)}>`;
    const references = [...new Set([...req.references, ...(req.inReplyTo ? [req.inReplyTo] : [])])].slice(-50);
    const root = threadRoot(rfcMessageId, req.inReplyTo, references);
    const internalSet = new Set(req.internal.map(d => d.address));
    const externalTo = req.to.filter(a => !internalSet.has(a)), externalCc = req.cc.filter(a => !internalSet.has(a)), externalBcc = req.bcc.filter(a => !internalSet.has(a));

    // 4. External recipients via SES. The readable MIME exists only in this function's memory.
    let sesMessageId: string | undefined;
    if (externalTo.length + externalCc.length + externalBcc.length) {
      if (!req.external) throw new BadRequest("Message content is required for recipients outside Mac Tidar");
      const mime = await new MailComposer({
        from: { name: sender.displayName.replace(/[\r\n"]/g, ""), address: sender.address },
        to: req.to, cc: req.cc.length ? req.cc : undefined,
        subject: req.subject, text: req.external.text, html: req.external.html,
        messageId: rfcMessageId, date: now,
        inReplyTo: req.inReplyTo, references: references.length ? references : undefined,
        attachments: req.external.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
        disableFileAccess: true, disableUrlAccess: true,
      }).compile().build();
      const res = await deps.ses.send(new SendEmailCommand({
        FromEmailAddress: sender.address,
        Destination: { ToAddresses: externalTo, CcAddresses: externalCc, BccAddresses: externalBcc },
        Content: { Raw: { Data: mime } },
        ConfigurationSetName: deps.configurationSet,
      }));
      mime.fill(0);
      sesMessageId = res.MessageId;
      delivered = true;
    }

    // 5. Store ciphertext: one item per Mac Tidar recipient, plus the sender's Sent copy.
    const store = async (mailbox: string, folder: "inbox" | "sent", c: Cipher, extra: Partial<MessageItem>) => {
      const id = `${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
      const at = now.toISOString(), base = `${mailbox}/${id}`;
      const bodyKey = `msg/${base}.pgp`, attachmentKeys = c.attachments.map((_, i) => `att/${base}/${i}.pgp`);
      await Promise.all([
        s3.send(new PutObjectCommand({ Bucket: bucket, Key: bodyKey, Body: c.body, ContentType: "application/pgp-encrypted" })),
        ...c.attachments.map((bytes, i) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: attachmentKeys[i], Body: bytes, ContentType: "application/pgp-encrypted" }))),
      ]);
      const tid = threadId(mailbox, root, id);
      const item: MessageItem = {
        pk: mailboxPk(mailbox), sk: messageSk(at, id), gsi1pk: folderGsi1(mailbox, folder), gsi1sk: `${at}#${id}`, gsi2pk: threadGsi2(tid), gsi2sk: `${at}#${id}`,
        type: "message", id, mailbox, folder, kind: "message", category: "primary", receivedAt: at, threadId: tid,
        rfcMessageId, references, fromAddress: sender.address, toAddresses: req.to, ccAddresses: req.cc,
        size: c.body.byteLength + c.attachments.reduce((n, a) => n + a.byteLength, 0),
        read: folder === "sent", starred: false, labels: [], encVersion: 1, keyFingerprint: c.keyFingerprint,
        header: c.header, bodyKey, attachmentKeys,
        verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" }, ...extra,
      };
      await ddb.send(new PutCommand({ TableName: table, Item: item }));
      return item;
    };

    delivered ||= req.internal.length > 0;
    await Promise.all(req.internal.map((d, i) => store(internalMetas[i]!.address, "inbox", d, { e2e: true })));
    // SES replaces Message-ID with "<ses id>@<region>.amazonses.com"; that's what outside replies will reference.
    const sesRfcId = sesMessageId ? `<${sesMessageId}@${deps.region}.amazonses.com>` : undefined;
    const sent = await store(sender.address, "sent", req.sentCopy, {
      bccAddresses: req.bcc, sesMessageId, deliveryStatus: sesMessageId ? "sent" : "delivered", e2e: !sesMessageId,
      ...(sesRfcId ? { rfcMessageId: sesRfcId, references: [...references, rfcMessageId].slice(-50) } : {}),
    });
    if (sesMessageId) {
      await ddb.send(new PutCommand({ TableName: table, Item: { pk: sesPointerPk(sesMessageId), sk: "PTR", mailboxPk: sent.pk, msgSk: sent.sk, expiresAt: inDays(30) } }));
    }
    console.log(JSON.stringify({ event: "sent", external: externalTo.length + externalCc.length + externalBcc.length, internal: req.internal.length }));
    await notifyMailboxes(ddb, table, internalMetas.map(m => m.address));
    return sent;
  } catch (e) {
    if (!delivered) await releaseIdempotency();
    else console.error(JSON.stringify({ event: "send-partial-failure", name: (e as Error).name }));
    throw e;
  }
}
