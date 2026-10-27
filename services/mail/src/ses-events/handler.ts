// SES delivery events (SNS) → delivery status on the sender's Sent copy.
// SES's account-level suppression list already stops mail to bounced/complaining addresses.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SNSEvent } from "aws-lambda";
import { sesPointerPk, type MessageItem } from "../shared/table";

type Status = NonNullable<MessageItem["deliveryStatus"]>;
interface SesEvent { eventType?: string; notificationType?: string; mail?: { messageId?: string }; bounce?: { bounceType?: string } }

/** Later states win: a delivery after a delay is "delivered"; a complaint after delivery is "complained". */
const RANK: Record<Status, number> = { sent: 0, delayed: 1, delivered: 2, bounced: 3, rejected: 3, complained: 4 };

export function statusFor(e: SesEvent): Status | null {
  switch (e.eventType ?? e.notificationType) {
    case "Delivery": return "delivered";
    case "DeliveryDelay": return "delayed";
    case "Bounce": return e.bounce?.bounceType === "Transient" ? "delayed" : "bounced";
    case "Complaint": return "complained";
    case "Reject": case "RenderingFailure": return "rejected";
    default: return null;
  }
}

export function createHandler(ddb: DynamoDBDocumentClient, table: string) {
  return async (event: SNSEvent) => {
    for (const record of event.Records) {
      let e: SesEvent;
      try { e = JSON.parse(record.Sns.Message) as SesEvent; } catch { continue; }
      const status = statusFor(e), sesId = e.mail?.messageId;
      if (!status || !sesId) continue;
      const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { pk: sesPointerPk(sesId), sk: "PTR" } }));
      if (!Item) continue;
      const allowed = (Object.keys(RANK) as Status[]).filter(s => RANK[s] < RANK[status]);
      try {
        await ddb.send(new UpdateCommand({
          TableName: table, Key: { pk: Item.mailboxPk, sk: Item.msgSk },
          UpdateExpression: "SET deliveryStatus = :s",
          ConditionExpression: `attribute_exists(pk) AND (attribute_not_exists(deliveryStatus) OR deliveryStatus IN (${allowed.map((_, i) => `:a${i}`).join(", ") || ":s"}))`,
          ExpressionAttributeValues: { ":s": status, ...Object.fromEntries(allowed.map((s, i) => [`:a${i}`, s])) },
        }));
      } catch (err) {
        if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
      }
      console.log(JSON.stringify({ event: "delivery-status", status }));
    }
  };
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: SNSEvent) => {
  cached ??= createHandler(DynamoDBDocumentClient.from(new DynamoDBClient({})), process.env.MAIL_TABLE ?? "");
  return cached(event);
};
