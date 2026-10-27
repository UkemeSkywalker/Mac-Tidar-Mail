// WebSocket API for push: $connect (verify the Cognito token and mailbox ownership),
// $disconnect (forget the connection) and $default (keep-alive pings).
// The access token arrives as a query parameter because browsers can't set WebSocket headers;
// it's never logged.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { normalizeAddress } from "../crypto/keys";
import { connectionIdPk, connectionSk } from "../shared/notify";
import { mailboxPk, META_SK, type MailboxMeta } from "../shared/table";

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string | undefined> };
export interface PushDeps { ddb: DynamoDBDocumentClient; table: string; verifySub: (token: string) => Promise<string> }

const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200 });
const deny = (): APIGatewayProxyResultV2 => ({ statusCode: 401 });
const ttl = () => Math.floor(Date.now() / 1000) + 3 * 3600;

export function createHandler({ ddb, table, verifySub }: PushDeps) {
  return async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
    const id = event.requestContext.connectionId;
    switch (event.requestContext.routeKey) {
      case "$connect": {
        const q = event.queryStringParameters ?? {};
        let sub: string, address: string;
        try {
          sub = await verifySub(q.token ?? "");
          address = normalizeAddress(q.mailbox ?? "");
        } catch { return deny(); }
        const res = await ddb.send(new GetCommand({ TableName: table, Key: { pk: mailboxPk(address), sk: META_SK } }));
        const meta = res?.Item as MailboxMeta | undefined;
        if (!meta || meta.ownerSub !== sub || meta.status !== "active") return deny();
        await ddb.send(new PutCommand({ TableName: table, Item: { pk: mailboxPk(address), sk: connectionSk(id), connectionId: id, expiresAt: ttl() } }));
        await ddb.send(new PutCommand({ TableName: table, Item: { pk: connectionIdPk(id), sk: "CONN", mailbox: address, expiresAt: ttl() } }));
        return ok();
      }
      case "$disconnect": {
        const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: { pk: connectionIdPk(id), sk: "CONN" } }));
        if (Item?.mailbox) await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: mailboxPk(String(Item.mailbox)), sk: connectionSk(id) } }));
        await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: connectionIdPk(id), sk: "CONN" } }));
        return ok();
      }
      default:
        return ok(); // keep-alive ping
    }
  };
}

let cached: ReturnType<typeof createHandler> | undefined;
export const handler = (event: ConnectEvent) => {
  if (!cached) {
    const verifier = CognitoJwtVerifier.create({ userPoolId: process.env.COGNITO_USER_POOL_ID!, clientId: process.env.COGNITO_CLIENT_ID!, tokenUse: "access" });
    cached = createHandler({
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      table: process.env.MAIL_TABLE!,
      verifySub: async token => (await verifier.verify(token)).sub,
    });
  }
  return cached(event);
};
