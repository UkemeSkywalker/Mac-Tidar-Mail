// Admin-only: create a mailbox and bind it to a Mac Tidar Cloud (Cognito) login.
//   npx tsx scripts/provision-mailbox.ts --address ukeme@beta.mactidar.com --owner-email you@example.com --name "Ukeme Eseme"
// Real keys are created in the browser at first sign-in (Phase 4). For beta testing only,
// --test-key-dir generates a key and writes it (locked) to that directory, outside the repo.
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateMailboxKey, lockPrivateKey, normalizeAddress } from "../src/crypto";
import { mailboxPk, META_SK, type MailboxMeta } from "../src/shared/table";
import { args, ddb, REGION, TABLE } from "./_aws";

const POOL = process.env.COGNITO_USER_POOL_ID ?? "af-south-1_378A7d9Bp";
const a = args(["address", "owner-email", "name", "test-key-dir"], ["address", "owner-email"]);

const address = normalizeAddress(a.address!);
const ownerEmail = a["owner-email"]!.trim().toLowerCase();
if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(ownerEmail) || ownerEmail.includes('"')) throw new Error("Invalid owner email");

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const { Users = [] } = await cognito.send(new ListUsersCommand({ UserPoolId: POOL, Filter: `email = "${ownerEmail}"`, Limit: 2 }));
if (Users.length !== 1) throw new Error(`Expected exactly one Cloud account for that email, found ${Users.length}`);
const ownerSub = Users[0]!.Attributes?.find(x => x.Name === "sub")?.Value;
if (!ownerSub) throw new Error("Cloud account has no sub");

const meta: MailboxMeta = { pk: mailboxPk(address), sk: META_SK, address, ownerSub, displayName: a.name ?? address.split("@")[0]!, status: "active", createdAt: new Date().toISOString() };

if (a["test-key-dir"]) {
  const dir = resolve(a["test-key-dir"]);
  if (dir.startsWith(resolve(process.cwd(), "../.."))) throw new Error("Write test keys outside the repository");
  const key = await generateMailboxKey(address, { name: meta.displayName });
  const passphrase = randomBytes(32).toString("hex");
  const locked = await lockPrivateKey(key.privateKey, passphrase);
  meta.keyState = { version: 1, address, primaryFingerprint: key.fingerprint, keys: [{ fingerprint: key.fingerprint, publicKey: key.publicKey, privateKey: locked, status: "active", createdAt: meta.createdAt }], recovery: null };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${address}.test-key.json`);
  writeFileSync(file, JSON.stringify({ address, fingerprint: key.fingerprint, privateKey: locked, passphrase }), { mode: 0o600 });
  console.log(`Test key written to ${file} (beta only; delete after testing)`);
}

await ddb.send(new PutCommand({ TableName: TABLE, Item: meta, ConditionExpression: "attribute_not_exists(pk)" }));
console.log(`Provisioned ${address} for Cloud account ${ownerSub}${meta.keyState ? " with a test key" : " (keys are created at first sign-in)"}`);
