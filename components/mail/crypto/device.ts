import { normalizeAddress, parseUnlockedKey, serializeUnlockedKey, type PrivateKey } from "./core";

export const DEVICE_DB_NAME = "mactidar-mail-device";
export const DEVICE_STORE_NAME = "mailboxes";

/**
 * Per-browser copy of a mailbox's keys, so a password reset on this (or any
 * still-signed-in) device can bring old mail back without the old password.
 * Never leaves the device.
 */
export interface DeviceKeyStore {
  /** Adds (or replaces) wrapped copies of these unlocked keys; keeps any others already stored. */
  saveKeys(address: string, keys: PrivateKey[]): Promise<void>;
  /** Unwraps every stored key. Entries that fail to unwrap are skipped. */
  loadKeys(address: string): Promise<PrivateKey[]>;
  /** Remember which recovery key this device trusts, so new keys can be backed up to it after a reset. */
  pinRecoveryFingerprint(address: string, fingerprint: string): Promise<void>;
  getRecoveryFingerprint(address: string): Promise<string | null>;
  /**
   * Keeps the key passphrase (derived from the password, never the password itself) wrapped
   * the same way as the keys, so a reload can reopen the mailbox without asking again.
   * Gives no more access than the wrapped keys this store already holds.
   */
  saveSession(address: string, passphrase: string): Promise<void>;
  /** The remembered passphrase, or null if there is none (or it can't be unwrapped). */
  loadSession(address: string): Promise<string | null>;
  /** Drops the remembered passphrase (sign out); key copies for recovery stay. */
  forgetSession(address: string): Promise<void>;
  /** Removes everything for this mailbox (use on "sign out and forget this device"). */
  forget(address: string): Promise<void>;
}

export interface WrappedKey {
  iv: Uint8Array;
  data: Uint8Array;
}

export interface DeviceRecord {
  address: string;
  /** Non-extractable AES-GCM-256 key: script on this origin can use it, but nothing can export its bytes. */
  wrappingKey: CryptoKey;
  keys: Record<string, WrappedKey>;
  recoveryFingerprint?: string;
  /** Wrapped key passphrase for reopening after a reload; removed on sign-out. */
  session?: WrappedKey;
}

function aad(address: string, fingerprint: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`mactidar-mail/device-key/v1\0${address}\0${fingerprint}`);
}

function sessionAad(address: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`mactidar-mail/device-session/v1\0${address}`);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createIndexedDbDeviceStore(options: { indexedDB?: IDBFactory; dbName?: string } = {}): DeviceKeyStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const dbName = options.dbName ?? DEVICE_DB_NAME;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new Error("IndexedDB is not available"));
    dbPromise ??= new Promise((resolve, reject) => {
      const open = factory.open(dbName, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(DEVICE_STORE_NAME, { keyPath: "address" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return dbPromise;
  }

  async function get(address: string): Promise<DeviceRecord | undefined> {
    const tx = (await db()).transaction(DEVICE_STORE_NAME, "readonly");
    return request(tx.objectStore(DEVICE_STORE_NAME).get(address) as IDBRequest<DeviceRecord | undefined>);
  }

  async function put(record: DeviceRecord): Promise<void> {
    const tx = (await db()).transaction(DEVICE_STORE_NAME, "readwrite");
    await request(tx.objectStore(DEVICE_STORE_NAME).put(record));
  }

  async function getOrCreate(address: string): Promise<DeviceRecord> {
    const existing = await get(address);
    if (existing) return existing;
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    return { address, wrappingKey, keys: {} };
  }

  return {
    async saveKeys(rawAddress, keys) {
      const address = normalizeAddress(rawAddress);
      if (keys.some((k) => !k.isDecrypted())) throw new Error("Only unlocked keys can be saved to the device");
      const record = await getOrCreate(address);
      for (const key of keys) {
        const fingerprint = key.getFingerprint();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plain = new Uint8Array(serializeUnlockedKey(key));
        const data = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: aad(address, fingerprint) },
            record.wrappingKey,
            plain,
          ),
        );
        plain.fill(0);
        record.keys[fingerprint] = { iv, data };
      }
      await put(record);
    },

    async loadKeys(rawAddress) {
      const address = normalizeAddress(rawAddress);
      const record = await get(address);
      if (!record) return [];
      const out: PrivateKey[] = [];
      for (const [fingerprint, wrapped] of Object.entries(record.keys)) {
        try {
          const plain = new Uint8Array(
            await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: new Uint8Array(wrapped.iv), additionalData: aad(address, fingerprint) },
              record.wrappingKey,
              new Uint8Array(wrapped.data),
            ),
          );
          const key = await parseUnlockedKey(plain); // keeps references into `plain`; do not zero it
          if (key.getFingerprint() === fingerprint) out.push(key);
        } catch {
          // Tampered or corrupt entry: ignore it rather than fail the whole recovery.
        }
      }
      return out;
    },

    async pinRecoveryFingerprint(rawAddress, fingerprint) {
      const record = await getOrCreate(normalizeAddress(rawAddress));
      record.recoveryFingerprint = fingerprint.toLowerCase();
      await put(record);
    },

    async getRecoveryFingerprint(rawAddress) {
      return (await get(normalizeAddress(rawAddress)))?.recoveryFingerprint ?? null;
    },

    async saveSession(rawAddress, passphrase) {
      const address = normalizeAddress(rawAddress);
      const record = await getOrCreate(address);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(passphrase);
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sessionAad(address) }, record.wrappingKey, plain));
      plain.fill(0);
      record.session = { iv, data };
      await put(record);
    },

    async loadSession(rawAddress) {
      const address = normalizeAddress(rawAddress);
      const record = await get(address);
      const wrapped = record?.session;
      if (!record || !wrapped) return null;
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(wrapped.iv), additionalData: sessionAad(address) }, record.wrappingKey, new Uint8Array(wrapped.data));
        return new TextDecoder().decode(plain);
      } catch {
        return null; // tampered or corrupt: fall back to the password
      }
    },

    async forgetSession(rawAddress) {
      const record = await get(normalizeAddress(rawAddress));
      if (!record?.session) return;
      delete record.session;
      await put(record);
    },

    async forget(rawAddress) {
      const tx = (await db()).transaction(DEVICE_STORE_NAME, "readwrite");
      await request(tx.objectStore(DEVICE_STORE_NAME).delete(normalizeAddress(rawAddress)));
    },
  };
}
