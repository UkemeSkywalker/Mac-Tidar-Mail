// Replays inbound mail that failed processing (after a fix is deployed). Each dead-letter
// message holds the original SES event; the raw mail is still in S3 (KMS-encrypted) for 3 days.
//   npx tsx scripts/redrive-inbound.ts            # replay everything in the queue
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { REGION } from "./_aws";

const FUNCTION = process.env.INBOUND_FUNCTION ?? "mactidar-mail-inbound";
const sqs = new SQSClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: `${FUNCTION}-dlq` }));

let ok = 0, failed = 0;
for (;;) {
  const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 300 }));
  if (!Messages.length) break;
  for (const m of Messages) {
    const payload = (JSON.parse(m.Body ?? "{}") as { requestPayload?: unknown }).requestPayload;
    if (!payload) { console.log(`skip ${m.MessageId}: no requestPayload`); failed++; continue; }
    const res = await lambda.send(new InvokeCommand({ FunctionName: FUNCTION, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(payload)) }));
    if (res.FunctionError) {
      failed++;
      console.log(`still failing ${m.MessageId}: ${Buffer.from(res.Payload ?? []).toString().slice(0, 300)}`);
    } else {
      ok++;
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
      console.log(`replayed ${m.MessageId}`);
    }
  }
}
console.log(`Done: ${ok} replayed, ${failed} still failing`);
process.exitCode = failed ? 1 : 0;
