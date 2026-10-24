import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { parseArgs } from "node:util";

export const REGION = process.env.AWS_REGION ?? "af-south-1";
export const TABLE = process.env.MAIL_TABLE ?? "mactidar-mail";
export const BUCKET = process.env.MAIL_BUCKET ?? "mactidar-mail-831981619011";
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
export const s3 = new S3Client({ region: REGION });

/** Parses `--name value` flags; throws if a required one is missing. */
export function args<K extends string>(names: readonly K[], required: readonly K[]): Record<K, string | undefined> {
  const { values } = parseArgs({ options: Object.fromEntries(names.map(n => [n, { type: "string" as const }])), strict: true });
  for (const r of required) if (!values[r]) throw new Error(`--${r} is required`);
  return values as Record<K, string | undefined>;
}
