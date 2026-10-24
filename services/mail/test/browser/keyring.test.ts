import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { encryptInboundMessage, readPublicKey } from "../../src/crypto";
import {
  SessionLockedError,
  WrongPasswordError,
  createIndexedDbDeviceStore,
  lockedKeyCount,
  resetMailboxKeys,
  setupMailboxKeys,
  unlockMailbox,
  type MailboxKeyState,
} from "../../../../components/mail/crypto";
import { FAST_KDF } from "../helpers";

const ADDRESS = "ukeme@mactidar.com";
const opts = { kdf: FAST_KDF };
const newDevice = () => createIndexedDbDeviceStore({ indexedDB: new IDBFactory() });

async function inbound(state: MailboxKeyState, subject: string) {
  const primary = state.keys.find((k) => k.fingerprint === state.primaryFingerprint)!;
  return encryptInboundMessage({ subject, text: `${subject} body`, from: { name: "Gmail friend" } }, primary.publicKey);
}

async function readSubject(session: Awaited<ReturnType<typeof unlockMailbox>>["session"], msg: { header: string }) {
  return (await session.decryptHeader(msg.header)).header.subject;
}

describe("first sign-in key setup", () => {
  it("creates an active primary key, a recovery key and a recovery file", async () => {
    const { state, session, recovery } = await setupMailboxKeys({ address: "Ukeme@MacTidar.com", password: "pw-1" }, opts);
    expect(state.version).toBe(1);
    expect(state.address).toBe(ADDRESS);
    expect(state.keys).toHaveLength(1);
    expect(state.keys[0]!.status).toBe("active");
    expect(state.keys[0]!.fingerprint).toBe(state.primaryFingerprint);
    expect(state.recovery?.fingerprint).toBe(recovery.fingerprint);
    expect(Object.keys(state.recovery!.copies)).toEqual([state.primaryFingerprint]);
    expect(recovery.file).toContain(recovery.code);
    expect(session.locked).toBe(false);
    expect(session.primaryFingerprint).toBe(state.primaryFingerprint);
  });

  it("stores a device copy and pins the recovery key when a device store is given", async () => {
    const device = newDevice();
    const { state } = await setupMailboxKeys({ address: ADDRESS, password: "pw-1" }, { ...opts, device });
    expect((await device.loadKeys(ADDRESS)).map((k) => k.getFingerprint())).toEqual([state.primaryFingerprint]);
    expect(await device.getRecoveryFingerprint(ADDRESS)).toBe(state.recovery!.fingerprint);
  });
});

describe("unlock", () => {
  it("unlocks with the right password and decrypts mail", async () => {
    const { state } = await setupMailboxKeys({ address: ADDRESS, password: "pw-1" }, opts);
    const msg = await inbound(state, "Hello from Gmail");
    const { session } = await unlockMailbox(state, "pw-1", opts);
    expect(await readSubject(session, msg)).toBe("Hello from Gmail");
  });

  it("rejects the wrong password", async () => {
    const { state } = await setupMailboxKeys({ address: ADDRESS, password: "pw-1" }, opts);
    await expect(unlockMailbox(state, "pw-2", opts)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("keeps keys only in memory and forgets them on lock", async () => {
    const { state } = await setupMailboxKeys({ address: ADDRESS, password: "pw-1" }, opts);
    const msg = await inbound(state, "secret");
    const { session } = await unlockMailbox(state, "pw-1", opts);
    session.lock();
    expect(session.locked).toBe(true);
    await expect(session.decryptHeader(msg.header)).rejects.toBeInstanceOf(SessionLockedError);
    expect(() => session.decryptionKeys()).toThrow(SessionLockedError);
  });
});

describe("Mac Tidar to Mac Tidar end-to-end", () => {
  it("encrypts to the recipient and the sender's own copy, signed by the sender", async () => {
    const alice = await setupMailboxKeys({ address: "alice@mactidar.com", password: "a" }, opts);
    const bob = await setupMailboxKeys({ address: "bob@mactidar.com", password: "b" }, opts);
    const bobPub = await readPublicKey(bob.state.keys[0]!.publicKey);
    const alicePub = await readPublicKey(alice.state.keys[0]!.publicKey);

    const enc = await alice.session.encryptMessage(
      { header: { subject: "Lunch?", preview: "Friday", fromName: "Alice" }, body: { text: "Friday at 1" } },
      [bobPub],
    );
    const atBob = await bob.session.decryptHeader(enc.header, { verificationKeys: [alicePub] });
    expect(atBob.header.subject).toBe("Lunch?");
    expect(atBob.signature).toBe("verified");
    const sentCopy = await alice.session.decryptBody(enc.body);
    expect(sentCopy.body.text).toBe("Friday at 1");
  });
});

describe("password reset (never fatal)", () => {
  it("makes new mail readable immediately and marks old keys locked", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    expect(reset.state.primaryFingerprint).not.toBe(setup.state.primaryFingerprint);
    expect(lockedKeyCount(reset.state)).toBe(1);
    expect(reset.state.keys.find((k) => k.fingerprint === setup.state.primaryFingerprint)!.status).toBe("locked");

    const fresh = await inbound(reset.state, "after reset");
    expect(await readSubject(reset.session, fresh)).toBe("after reset");

    // And after a full sign-out / sign-in with the new password.
    const { session } = await unlockMailbox(reset.state, "new-pw", opts);
    expect(await readSubject(session, fresh)).toBe("after reset");
    await expect(unlockMailbox(reset.state, "old-pw", opts)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("old mail stays locked until a recovery method is used", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const old = await inbound(setup.state, "before reset");
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    await expect(reset.session.decryptHeader(old.header)).rejects.toThrow();
  });

  it("device recovery: a still-signed-in device re-unlocks old mail automatically on reset", async () => {
    const device = newDevice();
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, { ...opts, device });
    const old = await inbound(setup.state, "before reset");

    const reset = await resetMailboxKeys(setup.state, "new-pw", { ...opts, device });
    expect(reset.restored).toEqual([setup.state.primaryFingerprint]);
    expect(lockedKeyCount(reset.state)).toBe(0);
    expect(reset.recoveryCovered).toBe(true);
    expect(await readSubject(reset.session, old)).toBe("before reset");

    // The old key is now stored under the NEW password.
    const { session } = await unlockMailbox(reset.state, "new-pw", opts);
    expect(await readSubject(session, old)).toBe("before reset");
  });

  it("device recovery: another signed-in device heals the state at its next unlock", async () => {
    const laptop = newDevice();
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, { ...opts, device: laptop });
    const old = await inbound(setup.state, "before reset");
    // Reset happens on a phone that never had the keys.
    const reset = await resetMailboxKeys(setup.state, "new-pw", { ...opts, device: newDevice() });
    expect(lockedKeyCount(reset.state)).toBe(1);
    expect(reset.recoveryCovered).toBe(false);

    const onLaptop = await unlockMailbox(reset.state, "new-pw", { ...opts, device: laptop });
    expect(onLaptop.restored).toEqual([setup.state.primaryFingerprint]);
    expect(lockedKeyCount(onLaptop.state)).toBe(0);
    expect(await readSubject(onLaptop.session, old)).toBe("before reset");
  });

  it("recovery file restores old mail after a reset with no device", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const old = await inbound(setup.state, "before reset");
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    expect(reset.recoveryCovered).toBe(false);

    const restored = await reset.session.restoreWithRecovery(reset.state, setup.recovery.file);
    expect(restored.restored).toEqual([setup.state.primaryFingerprint]);
    expect(lockedKeyCount(restored.state)).toBe(0);
    expect(await readSubject(reset.session, old)).toBe("before reset");
    // The new key is now covered by the same recovery file too.
    expect(Object.keys(restored.state.recovery!.copies).sort()).toEqual(
      [setup.state.primaryFingerprint, reset.state.primaryFingerprint].sort(),
    );

    const again = await unlockMailbox(restored.state, "new-pw", opts);
    expect(await readSubject(again.session, old)).toBe("before reset");
  });

  it("recovery phrase (typed by hand) works the same as the file", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const old = await inbound(setup.state, "before reset");
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    const typed = setup.recovery.code.toLowerCase().replace(/-/g, " ");
    await reset.session.restoreWithRecovery(reset.state, typed);
    expect(await readSubject(reset.session, old)).toBe("before reset");
  });

  it("one recovery file survives two resets", async () => {
    const device = newDevice();
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "pw-1" }, { ...opts, device });
    const m1 = await inbound(setup.state, "era one");
    const r1 = await resetMailboxKeys(setup.state, "pw-2", { ...opts, device });
    const m2 = await inbound(r1.state, "era two");
    // Lose the device, forget the password again.
    const r2 = await resetMailboxKeys(r1.state, "pw-3", { ...opts, device: newDevice() });
    expect(lockedKeyCount(r2.state)).toBe(2);
    await r2.session.restoreWithRecovery(r2.state, setup.recovery.file);
    expect(await readSubject(r2.session, m1)).toBe("era one");
    expect(await readSubject(r2.session, m2)).toBe("era two");
  });

  it("rejects a wrong recovery code or a file for another mailbox", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const other = await setupMailboxKeys({ address: "admin@mactidar.com", password: "x" }, opts);
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    await expect(reset.session.restoreWithRecovery(reset.state, other.recovery.code)).rejects.toThrow(/recovery code/i);
    await expect(reset.session.restoreWithRecovery(reset.state, other.recovery.file)).rejects.toThrow(/another mailbox/i);
    expect(lockedKeyCount(reset.state)).toBe(1);
  });

  it("refuses a recovery file whose key fingerprint does not match the server's recovery key", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);
    const forged = setup.recovery.file.replace(setup.recovery.fingerprint, "0".repeat(40));
    await expect(reset.session.restoreWithRecovery(reset.state, forged)).rejects.toThrow(/does not match/);
  });

  it("remembering the old password later unlocks old mail", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "old-pw" }, opts);
    const old = await inbound(setup.state, "before reset");
    const reset = await resetMailboxKeys(setup.state, "new-pw", opts);

    await expect(reset.session.unlockWithOldPassword(reset.state, "not-it")).rejects.toBeInstanceOf(WrongPasswordError);
    const res = await reset.session.unlockWithOldPassword(reset.state, "old-pw");
    expect(res.restored).toEqual([setup.state.primaryFingerprint]);
    expect(lockedKeyCount(res.state)).toBe(0);
    expect(await readSubject(reset.session, old)).toBe("before reset");

    const again = await unlockMailbox(res.state, "new-pw", opts);
    expect(await readSubject(again.session, old)).toBe("before reset");
  });

  it("never keeps a company escrow copy: no stored blob opens without a user secret", async () => {
    const setup = await setupMailboxKeys({ address: ADDRESS, password: "pw" }, opts);
    for (const k of setup.state.keys) {
      expect((await openpgp.readPrivateKey({ armoredKey: k.privateKey })).isDecrypted()).toBe(false);
    }
    expect((await openpgp.readPrivateKey({ armoredKey: setup.state.recovery!.privateKey })).isDecrypted()).toBe(false);
    // Recovery copies are encrypted only to the recovery key.
    for (const copy of Object.values(setup.state.recovery!.copies)) {
      const msg = await openpgp.readMessage({ armoredMessage: copy });
      const ids = msg.getEncryptionKeyIDs().map((id) => id.toHex());
      const recoveryKey = await readPublicKey(setup.state.recovery!.publicKey);
      const recoverySubkeys = recoveryKey.getKeys().map((k) => k.getKeyID().toHex());
      expect(ids.every((id) => recoverySubkeys.includes(id))).toBe(true);
    }
  });
});
