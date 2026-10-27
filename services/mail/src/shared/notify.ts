// "You have new mail" pushes to a mailbox's open browser tabs. The message carries no content
// (the browser fetches and decrypts mail itself). Best effort: delivery never fails because of it.
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mailboxPk } from "./table";

export const connectionSk = (id: string) => `CONN#${id}`;
export const connectionIdPk = (id: string) => `CONNID#${id}`;
const SIGNAL = new TextEncoder().encode(JSON.stringify({ type: "new-mail" }));

let client: ApiGatewayManagementApiClient | undefined;

export async function notifyMailboxes(ddb: DynamoDBDocumentClient, table: string, mailboxes: string[], endpoint = process.env.WS_ENDPOINT) {
  if (!endpoint || !mailboxes.length) return;
  client ??= new ApiGatewayManagementApiClient({ endpoint });
  await Promise.all(mailboxes.map(async mailbox => {
    try {
      const { Items = [] } = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :c)", ExpressionAttributeValues: { ":pk": mailboxPk(mailbox), ":c": "CONN#" } }));
      await Promise.all(Items.map(async item => {
        const id = String(item.connectionId);
        try {
          await client!.send(new PostToConnectionCommand({ ConnectionId: id, Data: SIGNAL }));
        } catch (e) {
          if (e instanceof GoneException) {
            await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: mailboxPk(mailbox), sk: connectionSk(id) } })).catch(() => {});
            await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: connectionIdPk(id), sk: "CONN" } })).catch(() => {});
          }
        }
      }));
    } catch (e) {
      console.error(JSON.stringify({ event: "notify-failed", name: (e as Error).name }));
    }
  }));
}
