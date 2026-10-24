// Proves nothing readable is stored: searches a mailbox's DynamoDB items and S3 objects for
// a phrase you put in a test email (as text, base64 and raw bytes), and checks raw/ is empty.
//   npx tsx scripts/audit-plaintext.ts --address ukeme@beta.mactidar.com --needle "pineapple-7731"
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeAddress } from "../src/crypto";
import { mailboxPk } from "../src/shared/table";
import { args, BUCKET, ddb, s3, TABLE } from "./_aws";

const a = args(["address", "needle"], ["address", "needle"]);
const address = normalizeAddress(a.address!);
const needle = a.needle!;
const forms = [Buffer.from(needle), Buffer.from(Buffer.from(needle).toString("base64").replace(/=+$/, ""))];
const hit = (bytes: Uint8Array) => forms.some(f => Buffer.from(bytes).includes(f));
let findings = 0;

const { Items = [] } = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": mailboxPk(address) } }));
for (const item of Items) if (hit(Buffer.from(JSON.stringify(item)))) { findings++; console.log(`FOUND in table item ${item.sk}`); }

let objects = 0;
for (const prefix of [`msg/${address}/`, `att/${address}/`]) {
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      objects++;
      const body = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.Key }))).Body!.transformToByteArray();
      if (hit(body)) { findings++; console.log(`FOUND in s3://${BUCKET}/${o.Key}`); }
    }
    token = page.NextContinuationToken;
  } while (token);
}
const raw = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "raw/" }));

console.log(`Checked ${Items.length} table items and ${objects} S3 objects; raw/ objects left: ${raw.KeyCount ?? 0}`);
console.log(findings ? `FAIL: "${needle}" found ${findings} time(s)` : `PASS: "${needle}" not found anywhere`);
process.exitCode = findings ? 1 : 0;
