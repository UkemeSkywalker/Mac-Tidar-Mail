import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { generateMailboxKey, serializeUnlockedKey } from "../../src/crypto";
import {
  DEVICE_DB_NAME,
  DEVICE_STORE_NAME,
  createIndexedDbDeviceStore,
  type DeviceRecord,
} from "../../../../components/mail/crypto";

function rawTx<T>(factory: IDBFactory, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = factory.open(DEVICE_DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(DEVICE_STORE_NAME, mode).objectStore(DEVICE_STORE_NAME));
      req.onsuccess = () => {
        open.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    };
  });
}
const readRaw = (f: IDBFactory, address: string) => rawTx<DeviceRecord | undefined>(f, "readonly", (s) => s.get(address));
const writeRaw = (f: IDBFactory, rec: DeviceRecord) => rawTx(f, "readwrite", (s) => s.put(rec));

function freshStore() {
  return createIndexedDbDeviceStore({ indexedDB: new IDBFactory() });
}

describe("IndexedDB device key store", () => {
  it("wraps keys under a non-extractable AES-GCM key and unwraps them again", async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbDeviceStore({ indexedDB: factory });
    const k = await generateMailboxKey("a@mactidar.com");
    await store.saveKeys("A@mactidar.com", [k.privateKey]);

    const raw = await readRaw(factory, "a@mactidar.com");
    expect(raw).toBeDefined();
    expect(raw!.wrappingKey.extractable).toBe(false);
    expect(raw!.wrappingKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", raw!.wrappingKey)).rejects.toThrow();
    const keyBytes = Buffer.from(serializeUnlockedKey(k.privateKey));
    for (const entry of Object.values(raw!.keys)) {
      expect(Buffer.from(entry.data).includes(keyBytes.subarray(0, 64))).toBe(false);
    }

    // A second store instance on the same database (e.g. after a reload) can read them.
    const reopened = createIndexedDbDeviceStore({ indexedDB: factory });
    const loaded = await reopened.loadKeys("a@mactidar.com");
    expect(loaded.map((x) => x.getFingerprint())).toEqual([k.fingerprint]);
    expect(loaded[0]!.isDecrypted()).toBe(true);
  });

  it("accumulates keys across saves and keeps them per mailbox", async () => {
    const store = freshStore();
    const [k1, k2, other] = await Promise.all([
      generateMailboxKey("a@mactidar.com"),
      generateMailboxKey("a@mactidar.com"),
      generateMailboxKey("b@mactidar.com"),
    ]);
    await store.saveKeys("a@mactidar.com", [k1.privateKey]);
    await store.saveKeys("a@mactidar.com", [k2.privateKey]);
    await store.saveKeys("b@mactidar.com", [other.privateKey]);
    const a = (await store.loadKeys("a@mactidar.com")).map((x) => x.getFingerprint()).sort();
    expect(a).toEqual([k1.fingerprint, k2.fingerprint].sort());
    expect((await store.loadKeys("b@mactidar.com")).map((x) => x.getFingerprint())).toEqual([other.fingerprint]);
  });

  it("refuses to store locked keys", async () => {
    const store = freshStore();
    const k = await generateMailboxKey("a@mactidar.com");
    const { lockPrivateKey } = await import("../../src/crypto");
    const openpgp = await import("openpgp");
    const locked = await openpgp.readPrivateKey({ armoredKey: await lockPrivateKey(k.privateKey, "pw", { passes: 1, parallelism: 1, memoryExponent: 10 }) });
    await expect(store.saveKeys("a@mactidar.com", [locked])).rejects.toThrow(/unlocked/);
  });

  it("skips entries whose ciphertext was swapped between fingerprints", async () => {
    const factory = new IDBFactory();
    const store = createIndexedDbDeviceStore({ indexedDB: factory });
    const [k1, k2] = await Promise.all([generateMailboxKey("a@mactidar.com"), generateMailboxKey("a@mactidar.com")]);
    await store.saveKeys("a@mactidar.com", [k1.privateKey, k2.privateKey]);
    const rec = (await readRaw(factory, "a@mactidar.com"))!;
    const e1 = rec.keys[k1.fingerprint]!;
    rec.keys[k1.fingerprint] = rec.keys[k2.fingerprint]!;
    rec.keys[k2.fingerprint] = e1;
    await writeRaw(factory, rec);
    expect(await store.loadKeys("a@mactidar.com")).toEqual([]);
  });

  it("pins the recovery key fingerprint and forgets everything on request", async () => {
    const store = freshStore();
    const k = await generateMailboxKey("a@mactidar.com");
    await store.saveKeys("a@mactidar.com", [k.privateKey]);
    await store.pinRecoveryFingerprint("a@mactidar.com", "AB".repeat(20));
    expect(await store.getRecoveryFingerprint("a@mactidar.com")).toBe("ab".repeat(20));
    await store.forget("a@mactidar.com");
    expect(await store.loadKeys("a@mactidar.com")).toEqual([]);
    expect(await store.getRecoveryFingerprint("a@mactidar.com")).toBeNull();
  });
});
