// Self sign-up: a verified Mac Tidar account (whose email is the backup address for password
// resets) claims one @mactidar.com address. Admin-provisioned mailboxes don't go through here.
import { BadRequest } from "./validate";

/** Recipients a new self sign-up mailbox may send to per day, until an admin raises it. */
export const NEW_MAILBOX_DAILY_LIMIT = 50;

// Role and staff names nobody can claim (checked with dots, dashes and underscores removed).
const RESERVED = new Set([
  "abuse", "account", "accounts", "admin", "administrator", "all", "api", "billing", "bounce", "bounces", "ceo", "cloud",
  "contact", "daemon", "dmarc", "donotreply", "email", "everyone", "ftp", "help", "hello", "hostmaster", "imap", "info",
  "john", "legal", "mail", "mailerdaemon", "marketing", "noreply", "null", "official", "payments", "pop", "postmaster",
  "press", "privacy", "root", "sales", "security", "smtp", "staff", "status", "support", "system", "team", "test",
  "ukeme", "undefined", "webmaster", "www",
]);
// Stems that make an address look official wherever they appear ("mactidar-help", "admin2").
const RESERVED_STEMS = ["mactidar", "admin", "support", "security", "postmaster", "abuse", "noreply", "billing", "official"];

// 3–30 characters: lowercase letters and digits, with single . - _ between them.
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9])){2,29}$/;

export function validateClaim(input: unknown, domain: string): { address: string; displayName: string } {
  if (typeof input !== "object" || input === null) throw new BadRequest("Body must be an object");
  const { localPart, displayName } = input as Record<string, unknown>;
  if (typeof localPart !== "string") throw new BadRequest("Choose an address");
  const local = localPart.trim().toLowerCase();
  if (!LOCAL_PART.test(local)) throw new BadRequest("Addresses are 3–30 letters or numbers, with single dots, dashes or underscores between them");
  const bare = local.replace(/[._-]/g, "");
  if (RESERVED.has(bare) || RESERVED_STEMS.some(s => bare.includes(s))) throw new BadRequest("That address is reserved. Please choose another.");

  if (typeof displayName !== "string") throw new BadRequest("Enter your name");
  const name = displayName.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 64 || /[\0-\x1f\x7f<>"@]/.test(name)) throw new BadRequest("Names are up to 64 characters, without @ < > or quotes");
  if (/mac\s*-?\s*tidar/i.test(name)) throw new BadRequest("Names can’t include “Mac Tidar”");
  return { address: `${local}@${domain}`, displayName: name };
}
