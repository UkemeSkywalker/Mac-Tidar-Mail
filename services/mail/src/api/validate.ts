// Validation for everything the browser uploads. The server can't read mail, but it must
// never accept malformed or *unlocked* key material, which would silently weaken a mailbox.
import { inspectPrivateKey, normalizeAddress, readPublicKey } from "../crypto/keys";
import type { MailboxKeyState } from "../crypto/keyring-types";
import type { Folder } from "../shared/table";

export class BadRequest extends Error {}

const FINGERPRINT = /^[0-9a-f]{40}$/;
const ARMORED_MESSAGE = /^-----BEGIN PGP MESSAGE-----[\s\S]+-----END PGP MESSAGE-----\s*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function need(cond: unknown, msg: string): asserts cond { if (!cond) throw new BadRequest(msg); }

async function checkPublic(armored: unknown, fingerprint: string, what: string) {
  need(typeof armored === "string" && armored.length < 20_000, `${what}: public key missing`);
  const key = await readPublicKey(armored).catch(() => null);
  need(key && !key.isPrivate() && key.getFingerprint() === fingerprint, `${what}: public key does not match its fingerprint`);
}

async function checkLockedPrivate(armored: unknown, fingerprint: string, what: string) {
  need(typeof armored === "string" && armored.length < 20_000, `${what}: private key missing`);
  const info = await inspectPrivateKey(armored).catch(() => null);
  need(info && info.fingerprint === fingerprint, `${what}: private key does not match its fingerprint`);
  need(info.locked, `${what}: private key must be encrypted before upload`);
}

export async function validateKeyState(input: unknown, address: string): Promise<MailboxKeyState> {
  need(isObj(input), "keyState must be an object");
  need(input.version === 1, "Unsupported keyState version");
  need(input.address === normalizeAddress(address), "keyState is for a different mailbox");
  need(Array.isArray(input.keys) && input.keys.length >= 1 && input.keys.length <= 20, "keyState.keys must hold 1–20 keys");
  const seen = new Set<string>();
  for (const k of input.keys as unknown[]) {
    need(isObj(k) && typeof k.fingerprint === "string" && FINGERPRINT.test(k.fingerprint), "Invalid key fingerprint");
    need(!seen.has(k.fingerprint), "Duplicate key");
    seen.add(k.fingerprint);
    need(k.status === "active" || k.status === "locked", "Invalid key status");
    need(typeof k.createdAt === "string" && !Number.isNaN(Date.parse(k.createdAt)), "Invalid key createdAt");
    await checkPublic(k.publicKey, k.fingerprint, "key");
    await checkLockedPrivate(k.privateKey, k.fingerprint, "key");
  }
  const primary = (input.keys as { fingerprint: string; status: string }[]).find(k => k.fingerprint === input.primaryFingerprint);
  need(primary && primary.status === "active", "primaryFingerprint must name an active key");

  if (input.recovery !== null) {
    const r = input.recovery;
    need(isObj(r) && typeof r.fingerprint === "string" && FINGERPRINT.test(r.fingerprint), "Invalid recovery key");
    await checkPublic(r.publicKey, r.fingerprint, "recovery");
    await checkLockedPrivate(r.privateKey, r.fingerprint, "recovery");
    need(isObj(r.copies), "recovery.copies must be an object");
    for (const [fp, msg] of Object.entries(r.copies)) {
      need(seen.has(fp), "recovery copy for an unknown key");
      need(typeof msg === "string" && msg.length < 40_000 && ARMORED_MESSAGE.test(msg), "recovery copies must be encrypted messages");
    }
  }
  return input as unknown as MailboxKeyState;
}

export const FOLDERS: readonly Folder[] = ["inbox", "sent", "archive", "spam", "trash"];
const LABEL_ID = /^[A-Za-z0-9_-]{1,40}$/;

export interface MessagePatch { read?: boolean; starred?: boolean; folder?: Folder; labels?: string[]; snoozedUntil?: string | null }

export function validatePatch(input: unknown): { sks: string[]; set: MessagePatch } {
  need(isObj(input), "Body must be an object");
  const { sks, set } = input;
  need(Array.isArray(sks) && sks.length >= 1 && sks.length <= 100 && sks.every(s => typeof s === "string" && /^MSG#[^#]{1,40}#[A-Za-z0-9._-]{1,100}$/.test(s)), "sks must be 1–100 message keys");
  need(isObj(set) && Object.keys(set).length > 0, "set must name at least one field");
  const out: MessagePatch = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === "read" || k === "starred") { need(typeof v === "boolean", `${k} must be boolean`); out[k] = v; }
    else if (k === "folder") { need(FOLDERS.includes(v as Folder), "Unknown folder"); out.folder = v as Folder; }
    else if (k === "labels") { need(Array.isArray(v) && v.length <= 20 && v.every(l => typeof l === "string" && LABEL_ID.test(l)), "labels must be up to 20 opaque label ids"); out.labels = [...new Set(v as string[])]; }
    else if (k === "snoozedUntil") { need(v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v))), "snoozedUntil must be a date or null"); out.snoozedUntil = v as string | null; }
    else throw new BadRequest(`Unknown field ${k}`);
  }
  return { sks: [...new Set(sks as string[])], set: out };
}

export function validateSks(input: unknown): string[] {
  need(isObj(input) && Array.isArray(input.sks) && input.sks.length >= 1 && input.sks.length <= 100, "sks must be 1–100 message keys");
  need((input.sks as unknown[]).every(s => typeof s === "string" && s.startsWith("MSG#") && s.length < 200), "Invalid message key");
  return [...new Set(input.sks as string[])];
}

export function validateSettings(input: unknown): { blob: string; expectedVersion: number } {
  need(isObj(input) && typeof input.blob === "string" && input.blob.length < 200_000 && ARMORED_MESSAGE.test(input.blob), "Settings must be an encrypted message");
  need(Number.isInteger(input.expectedVersion) && (input.expectedVersion as number) >= 0, "expectedVersion required");
  return { blob: input.blob, expectedVersion: input.expectedVersion as number };
}
