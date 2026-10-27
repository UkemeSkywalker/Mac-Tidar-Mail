import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler } from "../../src/push/handler";

const ddb = mockClient(DynamoDBDocumentClient);
const ADDR = "ukeme@beta.mactidar.com";
const handler = () => createHandler({ ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: "t", verifySub: async t => { if (t !== "good-token") throw new Error("bad"); return "sub-owner"; } });
const ev = (routeKey: string, q?: Record<string, string>) => ({ requestContext: { connectionId: "c1", routeKey }, queryStringParameters: q }) as never;

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand, { Key: { pk: `MAILBOX#${ADDR}`, sk: "META" } }).resolves({ Item: { address: ADDR, ownerSub: "sub-owner", status: "active" } });
  ddb.on(PutCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
});

describe("push connections", () => {
  it("accepts the mailbox owner and records the connection", async () => {
    expect(await handler()(ev("$connect", { token: "good-token", mailbox: ADDR }))).toEqual({ statusCode: 200 });
    expect(ddb.commandCalls(PutCommand).map(c => c.args[0].input.Item!.pk)).toEqual([`MAILBOX#${ADDR}`, "CONNID#c1"]);
  });
  it("rejects bad tokens and other people's mailboxes", async () => {
    expect(await handler()(ev("$connect", { token: "forged", mailbox: ADDR }))).toEqual({ statusCode: 401 });
    expect(await handler()(ev("$connect", { token: "good-token", mailbox: "victim@beta.mactidar.com" }))).toEqual({ statusCode: 401 });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
  it("forgets the connection on disconnect", async () => {
    ddb.on(GetCommand, { Key: { pk: "CONNID#c1", sk: "CONN" } }).resolves({ Item: { mailbox: ADDR } });
    await handler()(ev("$disconnect"));
    expect(ddb.commandCalls(DeleteCommand).map(c => c.args[0].input.Key)).toEqual([{ pk: `MAILBOX#${ADDR}`, sk: "CONN#c1" }, { pk: "CONNID#c1", sk: "CONN" }]);
  });
});
