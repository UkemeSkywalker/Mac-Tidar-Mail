// Beta verification: decrypt the newest messages in a mailbox with a test key.
//   npx tsx scripts/read-latest.ts --address ukeme@beta.mactidar.com --key-file /path/ukeme@beta.mactidar.com.test-key.json
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import { decryptMessageBody, decryptMessageHeader, normalizeAddress, unlockPrivateKey } from "../src/crypto";
import { mailboxPk, type MessageItem } from "../src/shared/table";
import { args, BUCKET, ddb, s3, TABLE } from "./_aws";

const a = args(["address", "key-file", "limit"], ["address", "key-file"]);
const keyFile = JSON.parse(readFileSync(a["key-file"]!, "utf8")) as { privateKey: string; passphrase: string };
const key = await unlockPrivateKey(keyFile.privateKey, keyFile.passphrase);

const { Items = [] } = await ddb.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: "pk = :pk AND begins_with(sk, :msg)",
  ExpressionAttributeValues: { ":pk": mailboxPk(normalizeAddress(a.address!)), ":msg": "MSG#" }, ScanIndexForward: false, Limit: Number(a.limit ?? 5),
}));
if (!Items.length) console.log("No messages yet.");
for (const item of Items as MessageItem[]) {
  const { header } = await decryptMessageHeader(item.header, { decryptionKeys: [key] });
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: item.bodyKey }));
  const { body } = await decryptMessageBody(await obj.Body!.transformToByteArray(), { decryptionKeys: [key] });
  console.log(`\n[${item.folder}/${item.category}] ${item.receivedAt}  from ${header.fromName || ""} <${item.fromAddress}>`);
  console.log(`Subject: ${header.subject}`);
  console.log(`Verdicts: ${JSON.stringify(item.verdicts)}  attachments: ${header.attachments?.map(x => x.filename).join(", ") || "none"}`);
  console.log(body.text.slice(0, 400));
}
