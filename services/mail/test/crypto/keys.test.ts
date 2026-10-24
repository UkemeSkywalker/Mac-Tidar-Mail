import { describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import {
  DEFAULT_KDF,
  WrongPassphraseError,
  deriveKeyPassphrase,
  generateMailboxKey,
  lockPrivateKey,
  parseUnlockedKey,
  readPublicKey,
  serializeUnlockedKey,
  unlockPrivateKey,
} from "../../src/crypto";
import { FAST_KDF } from "../helpers";

describe("mailbox keys", () => {
  it("generates a Curve25519 keypair bound to the address", async () => {
    const key = await generateMailboxKey("Ukeme@MacTidar.com", { name: "Ukeme" });
    expect(key.privateKey.isDecrypted()).toBe(true);
    expect(key.fingerprint).toBe(key.privateKey.getFingerprint());
    const info = key.privateKey.getAlgorithmInfo();
    expect(info.algorithm).toBe("eddsaLegacy");
    expect(info.curve).toBe("ed25519Legacy");
    const enc = await key.privateKey.getEncryptionKey();
    expect(enc.getAlgorithmInfo().curve).toBe("curve25519Legacy");
    expect(key.privateKey.getUserIDs()).toEqual(["Ukeme <ukeme@mactidar.com>"]);
    const pub = await readPublicKey(key.publicKey);
    expect(pub.getFingerprint()).toBe(key.fingerprint);
    expect(pub.isPrivate()).toBe(false);
  });

  it("locks the private key with Argon2 S2K + AEAD and unlocks with the same passphrase", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    const armored = await lockPrivateKey(key.privateKey, "correct horse", FAST_KDF);
    const stored = await openpgp.readPrivateKey({ armoredKey: armored });
    expect(stored.isDecrypted()).toBe(false);
    const s2k = (stored.keyPacket as unknown as { s2k: { type: string } }).s2k;
    expect(s2k.type).toBe("argon2");
    expect((stored.keyPacket as unknown as { s2kUsage: number }).s2kUsage).toBe(253); // AEAD-protected
    const unlocked = await unlockPrivateKey(armored, "correct horse");
    expect(unlocked.isDecrypted()).toBe(true);
    expect(unlocked.getFingerprint()).toBe(key.fingerprint);
  });

  it("does not mutate the caller's unlocked key when locking", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    await lockPrivateKey(key.privateKey, "pw", FAST_KDF);
    expect(key.privateKey.isDecrypted()).toBe(true);
  });

  it("uses RFC 9106 Argon2 parameters by default", async () => {
    expect(DEFAULT_KDF).toEqual({ passes: 3, parallelism: 4, memoryExponent: 16 });
    const key = await generateMailboxKey("a@mactidar.com");
    const armored = await lockPrivateKey(key.privateKey, "pw");
    const stored = await openpgp.readPrivateKey({ armoredKey: armored });
    const s2k = (stored.keyPacket as unknown as { s2k: { encodedM: number; t: number; p: number } }).s2k;
    expect([s2k.t, s2k.p, s2k.encodedM]).toEqual([3, 4, 16]);
  });

  it("rejects a wrong passphrase with WrongPassphraseError", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    const armored = await lockPrivateKey(key.privateKey, "right", FAST_KDF);
    await expect(unlockPrivateKey(armored, "wrong")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("refuses Argon2 memory above the safety cap", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    await expect(
      lockPrivateKey(key.privateKey, "pw", { passes: 1, parallelism: 1, memoryExponent: 30 }),
    ).rejects.toThrow(/memory/i);
  });

  it("derives a domain-separated passphrase that differs per address and never equals the password", async () => {
    const a = await deriveKeyPassphrase("hunter2", "ukeme@mactidar.com");
    const b = await deriveKeyPassphrase("hunter2", "UKEME@mactidar.com ");
    const c = await deriveKeyPassphrase("hunter2", "admin@mactidar.com");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("hunter2");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializes and parses an unlocked key for wrapping", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    const bytes = serializeUnlockedKey(key.privateKey);
    const parsed = await parseUnlockedKey(bytes);
    expect(parsed.getFingerprint()).toBe(key.fingerprint);
    expect(parsed.isDecrypted()).toBe(true);
  });

  it("refuses to serialize a locked key as if it were unlocked", async () => {
    const key = await generateMailboxKey("a@mactidar.com");
    const locked = await openpgp.readPrivateKey({ armoredKey: await lockPrivateKey(key.privateKey, "pw", FAST_KDF) });
    expect(() => serializeUnlockedKey(locked)).toThrow(/unlocked/);
  });
});
