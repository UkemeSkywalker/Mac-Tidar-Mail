// Account rules shared by the sign-up check (Cognito pre-sign-up trigger) and the API.
// A Mac Tidar Mail account's username IS its @mactidar.com address, and the only way to sign in.
// Its email attribute is the backup address: Cognito sends sign-up and reset codes there, and it
// is never a sign-in name (the pool has no email alias).
import { COUNTRY_CODES } from "../../../../components/mail/live/countries";
import { BadRequest } from "../api/validate";

/** Recipients a new self sign-up mailbox may send to per day, until an admin raises it. */
export const NEW_MAILBOX_DAILY_LIMIT = 50;

// Role and staff names nobody can claim (checked with dots, dashes and underscores removed),
// except through an admin reservation for a specific backup email.
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

export const reservationKey = (address: string) => ({ pk: `RESERVED#${address}`, sk: "RESERVATION" });
export interface Reservation { pk: string; sk: string; address: string; backupEmail: string; createdAt: string; expiresAt: number }

/** Checks a username is an address we hand out. Usernames are stored lowercase. */
export function parseAddress(username: string, domain: string): { address: string; reserved: boolean } {
  const at = username.lastIndexOf("@");
  const local = username.slice(0, at);
  if (at < 0 || username.slice(at + 1) !== domain) throw new BadRequest(`Choose an address ending in @${domain}`);
  if (!LOCAL_PART.test(local)) throw new BadRequest("Addresses are 3–30 lowercase letters or numbers, with single dots, dashes or underscores between them");
  const bare = local.replace(/[._-]/g, "");
  return { address: username, reserved: RESERVED.has(bare) || RESERVED_STEMS.some(s => bare.includes(s)) };
}

const NAME = /^[\p{L}\p{M}](?:[\p{L}\p{M}' .-]{0,38}[\p{L}\p{M}.])?$/u;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
export const GENDERS = ["male", "female", "rather_not_say"] as const;
const ALLOWED = new Set(["email", "given_name", "middle_name", "family_name", "birthdate", "phone_number", "gender", "custom:country"]);
/** Youngest age that may create an account. */
export const MIN_AGE = 13;

export interface Profile { email: string; givenName: string; middleName?: string; familyName: string; birthdate: string; phone: string; gender: string; country: string }

/** Age in whole years on `today` for a YYYY-MM-DD date, or null if it isn't a real date. */
export function ageOn(birthdate: string, today: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d)) age--;
  return age;
}

/** Validates the attributes a sign-up sends. `localDomains` can't be used as a backup email. */
export function validateProfile(attrs: Record<string, string | undefined>, localDomains: string[], today = new Date()): Profile {
  for (const k of Object.keys(attrs)) if (!ALLOWED.has(k)) throw new BadRequest("Unexpected sign-up field");
  const get = (k: string) => (attrs[k] ?? "").trim();

  const email = get("email").toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new BadRequest("Enter a valid backup email");
  const host = email.split("@")[1]!;
  if (localDomains.some(d => host === d || host.endsWith(`.${d}`))) throw new BadRequest("Your backup email must be outside Mac Tidar (Gmail, Outlook…)");

  const givenName = get("given_name"), familyName = get("family_name"), middleName = get("middle_name");
  if (!NAME.test(givenName)) throw new BadRequest("Enter your first name (letters, spaces, hyphens and apostrophes only)");
  if (!NAME.test(familyName)) throw new BadRequest("Enter your last name (letters, spaces, hyphens and apostrophes only)");
  if (middleName && !NAME.test(middleName)) throw new BadRequest("Middle names use letters, spaces, hyphens and apostrophes only");
  if (/mac\s*-?\s*tidar/i.test(`${givenName} ${middleName} ${familyName}`)) throw new BadRequest("Names can’t include “Mac Tidar”");

  const birthdate = get("birthdate"), age = ageOn(birthdate, today);
  if (age === null || age > 120 || age < 0) throw new BadRequest("Enter a valid date of birth");
  if (age < MIN_AGE) throw new BadRequest(`You must be at least ${MIN_AGE} to create an account`);

  const phone = get("phone_number");
  if (!PHONE.test(phone)) throw new BadRequest("Enter your phone number with its country code");
  const gender = get("gender");
  if (!(GENDERS as readonly string[]).includes(gender)) throw new BadRequest("Choose a gender option");
  const country = get("custom:country");
  if (!COUNTRY_CODES.has(country)) throw new BadRequest("Choose your country");

  return { email, givenName, familyName, birthdate, phone, gender, country, ...(middleName ? { middleName } : {}) };
}

/** The name people see on mail from a new mailbox. */
export const displayNameOf = (p: { givenName: string; familyName: string }) => `${p.givenName} ${p.familyName}`.slice(0, 64);
