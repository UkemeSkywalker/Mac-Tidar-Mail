import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  DEVICE_DB_NAME, DEVICE_STORE_NAME, NoDeviceSessionError, createIndexedDbDeviceStore, resetMailboxKeys, resumeMailbox, setupMailboxKeys, unlockMailbox,
  type DeviceRecord,
} from "../../../../components/mail/crypto";
import { FAST_KDF } from "../helpers";

const ADDRESS = "ada@mactidar.com";
const readRaw = (factory: IDBFactory) => new Promise<DeviceRecord | undefined>((resolve, reject) => {
  const open = factory.open(DEVICE_DB_NAME);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction(DEVICE_STORE_NAME, "readonly").objectStore(DEVICE_STORE_NAME).get(ADDRESS);
    req.onsuccess = () => { open.result.close(); resolve(req.result as DeviceRecord | undefined); };
    req.onerror = () => reject(req.error);
  };
});

describe("reopening the mailbox after a reload", () => {
  it("resumes with the remembered passphrase, which is stored only wrapped", async () => {
    const factory = new IDBFactory();
    const device = createIndexedDbDeviceStore({ indexedDB: factory });
    const { state, session } = await setupMailboxKeys({ address: ADDRESS, password: "Correct-horse-1" }, { kdf: FAST_KDF, device });
    await session.rememberSession(device);

    const raw = await readRaw(factory);
    expect(raw?.session?.data.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(raw!.session!.data)).not.toContain("Correct-horse-1");

    const { session: resumed } = await resumeMailbox(state, device, { kdf: FAST_KDF });
    expect(resumed.primaryFingerprint).toBe(state.primaryFingerprint);
  });

  it("needs the password when nothing is remembered, after sign-out, or after a password change", async () => {
    const device = createIndexedDbDeviceStore({ indexedDB: new IDBFactory() });
    const { state, session } = await setupMailboxKeys({ address: ADDRESS, password: "Old-pass-1" }, { kdf: FAST_KDF, device });
    await expect(resumeMailbox(state, device)).rejects.toBeInstanceOf(NoDeviceSessionError);

    await session.rememberSession(device);
    await device.forgetSession(ADDRESS);
    await expect(resumeMailbox(state, device)).rejects.toBeInstanceOf(NoDeviceSessionError);

    // Remembered under the old password, but the key state moved to a new one elsewhere.
    await session.rememberSession(device);
    const { state: next } = await resetMailboxKeys(state, "New-pass-1", { kdf: FAST_KDF });
    await expect(resumeMailbox(next, device)).rejects.toBeInstanceOf(NoDeviceSessionError);
    expect(await device.loadSession(ADDRESS)).toBeNull();
    await expect(unlockMailbox(next, "New-pass-1", { kdf: FAST_KDF })).resolves.toBeTruthy();
  });
});
