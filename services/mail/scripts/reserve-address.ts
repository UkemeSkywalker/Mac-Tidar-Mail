// Admin-only: reserve an @mactidar.com address for whoever signs up with a given backup email.
// Works for new reserved names (support@…) and for existing mailboxes moving to their own login;
// an existing mailbox keeps its mail and keys. The reservation expires after --days (default 14).
//   npx tsx scripts/reserve-address.ts --address ukeme@mactidar.com --backup-email you@gmail.com
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeAddress } from "../src/crypto";
import { reservationKey, type Reservation } from "../src/shared/accounts";
import { args, ddb, TABLE } from "./_aws";

const a = args(["address", "backup-email", "days"], ["address", "backup-email"]);
const address = normalizeAddress(a.address!);
const backupEmail = a["backup-email"]!.trim().toLowerCase();
if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(backupEmail)) throw new Error("Invalid backup email");
if (/@(?:.+\.)?mactidar\.com$/.test(backupEmail)) throw new Error("The backup email must be outside Mac Tidar");
const days = Number(a.days ?? 14);
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be 1–90");

const item: Reservation = { ...reservationKey(address), address, backupEmail, createdAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + days * 86400 };
await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
console.log(`Reserved ${address} for sign-up with its backup email, for ${days} days`);
