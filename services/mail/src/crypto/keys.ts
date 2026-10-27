import * as openpgp from "openpgp";
import type { PrivateKey, PublicKey } from "openpgp";
import { DEFAULT_KDF, keyLockConfig, readConfig, type KdfParams } from "./config";
import { WrongPassphraseError } from "./errors";

export interface GeneratedMailboxKey {
  /** Unlocked. Keep in memory only; persist via `lockPrivateKey`. */
  privateKey: PrivateKey;
  /** Armored public key, safe to publish. */
  publicKey: string;
  fingerprint: string;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * New mailbox keypair: v4 Ed25519 primary (sign/certify) + X25519 subkey (encrypt).
 * Legacy Curve25519 encoding is used on purpose: it is what GnuPG, Proton and
 * Thunderbird understand today, so external PGP users can write to us (WKD, later).
 */
export async function generateMailboxKey(
  address: string,
  options: { name?: string } = {},
): Promise<GeneratedMailboxKey> {
  const email = normalizeAddress(address);
  const userID = options.name ? { name: options.name, email } : { email };
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "ed25519Legacy",
    userIDs: [userID],
    format: "object",
  });
  return { privateKey, publicKey: publicKey.armor(), fingerprint: privateKey.getFingerprint() };
}

/** Encrypt an unlocked private key with Argon2id S2K + AEAD. Returns armored; never mutates `key`. */
export async function lockPrivateKey(
  key: PrivateKey,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<string> {
  if (!key.isDecrypted()) throw new Error("lockPrivateKey expects an unlocked key");
  if (!passphrase) throw new Error("A passphrase is required");
  const config = keyLockConfig(kdf);
  const copy = await openpgp.readPrivateKey({ binaryKey: key.write() });
  const locked = await openpgp.encryptKey({ privateKey: copy, passphrase, config });
  return locked.armor();
}

/** Decrypt an armored, passphrase-protected private key. Throws `WrongPassphraseError`. */
export async function unlockPrivateKey(armored: string, passphrase: string): Promise<PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armored, config: readConfig });
  try {
    return await openpgp.decryptKey({ privateKey, passphrase, config: readConfig });
  } catch {
    throw new WrongPassphraseError();
  }
}

export async function readPublicKey(armored: string): Promise<PublicKey> {
  const key = await openpgp.readKey({ armoredKey: armored });
  if (key.isPrivate()) throw new Error("Expected a public key, got a private key");
  return key as PublicKey;
}

/** Accepts armored text or an already-parsed key; rejects private keys so they are never sent around by mistake. */
export async function toPublicKey(key: string | PublicKey | PrivateKey): Promise<PublicKey> {
  if (typeof key === "string") return readPublicKey(key);
  if (key.isPrivate()) throw new Error("Expected a public key, got a private key");
  return key as PublicKey;
}

/**
 * Turn the account password into the private-key passphrase.
 * Domain-separated so the string protecting the key is never the login password
 * itself and differs per mailbox. Argon2 inside the S2K does the expensive stretching.
 */
export async function deriveKeyPassphrase(password: string, address: string): Promise<string> {
  const input = new TextEncoder().encode(`mactidar-mail/key-passphrase/v1\0${normalizeAddress(address)}\0${password}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Binary form of an unlocked key, for wrapping under a device key or recovery key. Handle as a secret. */
export function serializeUnlockedKey(key: PrivateKey): Uint8Array {
  if (!key.isDecrypted()) throw new Error("serializeUnlockedKey expects an unlocked key");
  return key.write();
}

export async function parseUnlockedKey(bytes: Uint8Array): Promise<PrivateKey> {
  const key = await openpgp.readPrivateKey({ binaryKey: bytes, config: readConfig });
  if (!key.isDecrypted()) throw new Error("Expected an unlocked private key");
  return key;
}
