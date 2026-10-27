// Inbound mail: SES → (KMS-encrypted) S3 raw/ → this Lambda → OpenPGP ciphertext in S3 + DynamoDB.
// Plaintext exists only in this function's memory, for the few seconds it takes to encrypt.
// Never log message content, subjects, names or addresses.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { KMSClient } from "@aws-sdk/client-kms";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { SESEvent, SESEventRecord } from "aws-lambda";
import { simpleParser, type AddressObject } from "mailparser";
import { encryptInboundMessage } from "../crypto/inbound";
import { normalizeAddress } from "../crypto/keys";
import { folderGsi1, mailboxPk, META_SK, messageSk, threadGsi2, type MailboxMeta, type MessageItem } from "../shared/table";
import { categorize, decide, type Verdicts } from "./policy";
import { decryptSesObject } from "./raw-decrypt";
import { threadId, threadRoot } from "./thread";

export interface InboundConfig {
  bucket: string;
  table: string;
  rawPrefix: string;
  rawKeyArn: string;
  receivingDomains: string[];
  localDomains: string[];
}

export interface InboundDeps { s3: S3Client; kms: KMSClient; ddb: DynamoDBDocumentClient; config: InboundConfig; log?: (entry: Record<string, unknown>) => void }

const addresses = (field?: AddressObject | AddressObject[]) =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap(a => a.value).map(v => v.address).filter((a): a is string => !!a).map(normalizeAddress);

const domainOf = (address: string) => address.split("@").pop() ?? "";

export function createHandler({ s3, kms, ddb, config, log = e => console.log(JSON.stringify(e)) }: InboundDeps) {
  async function processRecord(record: SESEventRecord) {
    const { mail, receipt } = record.ses;
    const sesId = mail.messageId;
    const rawKey = `${config.rawPrefix}${sesId}`;

    const raw = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: rawKey }));
    const envelope = await raw.Body!.transformToByteArray();
    const plain = await decryptSesObject(kms, envelope, raw.Metadata ?? {}, config.rawKeyArn);
    const deleteRaw = () => s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: rawKey, VersionId: raw.VersionId }));

    try {
      const parsed = await simpleParser(plain, { skipTextToHtml: true, skipImageLinks: true });
      const fromAddress = normalizeAddress(parsed.from?.value[0]?.address ?? mail.source ?? "");
      const verdicts: Verdicts = {
        spam: receipt.spamVerdict?.status ?? "DISABLED",
        virus: receipt.virusVerdict?.status ?? "DISABLED",
        spf: receipt.spfVerdict?.status ?? "DISABLED",
        dkim: receipt.dkimVerdict?.status ?? "DISABLED",
        dmarc: receipt.dmarcVerdict?.status ?? "DISABLED",
      };
      const disposition = decide(verdicts, fromAddress, config.localDomains);
      if (disposition.action === "drop") {
        await deleteRaw();
        log({ event: "dropped", sesId, reason: disposition.reason });
        return;
      }

      const recipients = [...new Set(receipt.recipients.map(normalizeAddress))].filter(r => config.receivingDomains.includes(domainOf(r)));
      const receivedAt = new Date(receipt.timestamp ?? mail.timestamp).toISOString();
      const root = threadRoot(parsed.messageId, parsed.inReplyTo, parsed.references);
      const category = categorize(parsed.headers, fromAddress);
      const to = addresses(parsed.to), cc = addresses(parsed.cc);
      let pending = 0, stored = 0;

      for (const mailbox of recipients) {
        const { Item } = await ddb.send(new GetCommand({ TableName: config.table, Key: { pk: mailboxPk(mailbox), sk: META_SK } }));
        const meta = Item as MailboxMeta | undefined;
        if (!meta || meta.status !== "active") { log({ event: "unknown-recipient", sesId }); continue; }
        const key = meta.keyState?.keys.find(k => k.fingerprint === meta.keyState?.primaryFingerprint);
        if (!key) { pending++; log({ event: "mailbox-without-keys", sesId }); continue; }

        const enc = await encryptInboundMessage({
          subject: parsed.subject,
          from: { name: parsed.from?.value[0]?.name, address: fromAddress },
          text: parsed.text,
          html: typeof parsed.html === "string" ? parsed.html : undefined,
          attachments: parsed.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, content: a.content, contentId: a.cid, inline: a.contentDisposition === "inline" })),
        }, key.publicKey);

        const base = `${normalizeAddress(mailbox)}/${sesId}`;
        const bodyKey = `msg/${base}.pgp`;
        const attachmentKeys = enc.attachments.map((_, i) => `att/${base}/${i}.pgp`);
        await Promise.all([
          s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: bodyKey, Body: enc.body, ContentType: "application/pgp-encrypted" })),
          ...enc.attachments.map((bytes, i) => s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: attachmentKeys[i], Body: bytes, ContentType: "application/pgp-encrypted" }))),
        ]);

        const tid = threadId(mailbox, root, sesId);
        const item: MessageItem = {
          pk: mailboxPk(mailbox), sk: messageSk(receivedAt, sesId),
          gsi1pk: folderGsi1(mailbox, disposition.folder), gsi1sk: `${receivedAt}#${sesId}`,
          gsi2pk: threadGsi2(tid), gsi2sk: `${receivedAt}#${sesId}`,
          type: "message", id: sesId, mailbox: normalizeAddress(mailbox), folder: disposition.folder, kind: "message", category,
          receivedAt, threadId: tid, rfcMessageId: parsed.messageId, fromAddress, toAddresses: to, ccAddresses: cc,
          size: plain.byteLength, read: false, starred: false, labels: [], encVersion: 1, keyFingerprint: key.fingerprint,
          header: enc.header, bodyKey, attachmentKeys, verdicts,
        };
        try {
          await ddb.send(new PutCommand({ TableName: config.table, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
        } catch (err) {
          // A retry of an invocation that already stored this message: nothing to do.
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }
        stored++;
      }

      // Keep the (still KMS-encrypted) raw object only while a mailbox is waiting for its keys;
      // the bucket lifecycle removes it after 3 days regardless.
      if (pending === 0) await deleteRaw();
      log({ event: "processed", sesId, stored, pending, folder: disposition.folder });
    } finally {
      plain.fill(0);
    }
  }

  return async (event: SESEvent) => {
    for (const record of event.Records) await processRecord(record);
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: SESEvent) => {
  cached ??= createHandler({
    s3: new S3Client({}),
    kms: new KMSClient({}),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
    config: {
      bucket: env("MAIL_BUCKET"),
      table: env("MAIL_TABLE"),
      rawPrefix: env("RAW_PREFIX"),
      rawKeyArn: env("RAW_KMS_KEY_ARN"),
      receivingDomains: env("RECEIVING_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
      localDomains: env("LOCAL_DOMAINS").split(",").map(d => d.trim().toLowerCase()),
    },
  });
  return cached(event);
};
