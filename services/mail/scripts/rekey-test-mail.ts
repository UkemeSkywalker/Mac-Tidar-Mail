// Beta only: re-encrypts messages that were encrypted to a temporary test key (from
// provision-mailbox --test-key-dir) so the mailbox owner's real key can read them.
// Decryption happens on this admin machine with the test key; nothing readable is stored.
//   npx tsx scripts/rekey-test-mail.ts --address ukeme@beta.mactidar.com --key-file /path/…test-key.json
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { decryptAttachment, decryptMessageBody, decryptMessageHeader, encryptAttachment, encryptMessageParts, normalizeAddress, readPublicKey, unlockPrivateKey } from "../src/crypto";
import { mailboxPk, META_SK, type MailboxMeta, type MessageItem } from "../src/shared/table";
import { args, BUCKET, ddb, s3, TABLE } from "./_aws";

const a = args(["address", "key-file"], ["address", "key-file"]);
const address = normalizeAddress(a.address!);
const keyFile = JSON.parse(readFileSync(a["key-file"]!, "utf8")) as { fingerprint: string; privateKey: string; passphrase: string };
const testKey = await unlockPrivateKey(keyFile.privateKey, keyFile.passphrase);

const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: mailboxPk(address), sk: META_SK } }));
const meta = Item as MailboxMeta | undefined;
const primary = meta?.keyState?.keys.find(k => k.fingerprint === meta.keyState?.primaryFingerprint);
if (!primary) throw new Error("The mailbox has no real key yet — sign in to the app first");
if (primary.fingerprint === keyFile.fingerprint) throw new Error("The mailbox still uses the test key");
const target = await readPublicKey(primary.publicKey);

const { Items = [] } = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk AND begins_with(sk, :m)", ExpressionAttributeValues: { ":pk": mailboxPk(address), ":m": "MSG#" } }));
const fetchBytes = async (key: string) => (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))).Body!.transformToByteArray();
let done = 0;
for (const m of (Items as MessageItem[]).filter(i => i.keyFingerprint === keyFile.fingerprint)) {
  const opts = { decryptionKeys: [testKey] }, enc = { encryptionKeys: [target] };
  const { header } = await decryptMessageHeader(m.header, opts);
  const { body } = await decryptMessageBody(await fetchBytes(m.bodyKey), opts);
  const next = await encryptMessageParts({ header, body }, enc);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: m.bodyKey, Body: next.body, ContentType: "application/pgp-encrypted" }));
  for (const key of m.attachmentKeys) {
    const { data } = await decryptAttachment(await fetchBytes(key), opts);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: await encryptAttachment(data, enc), ContentType: "application/pgp-encrypted" }));
  }
  await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: m.pk, sk: m.sk }, UpdateExpression: "SET header = :h, keyFingerprint = :f", ExpressionAttributeValues: { ":h": next.header, ":f": primary.fingerprint } }));
  done++;
}
console.log(`Re-encrypted ${done} message(s) to ${primary.fingerprint}`);
