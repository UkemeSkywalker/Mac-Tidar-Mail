import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { deriveKeyPassphrase, encryptInboundMessage, readPublicKey, serializeUnlockedKey } from "../../src/crypto";
import {
  DEVICE_DB_NAME,
  DEVICE_STORE_NAME,
  createIndexedDbDeviceStore,
  resetMailboxKeys,
  setupMailboxKeys,
} from "../../../../components/mail/crypto";
import { FAST_KDF, containsPlaintext } from "../helpers";

function dumpIdb(factory: IDBFactory): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DEVICE_DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction(DEVICE_STORE_NAME).objectStore(DEVICE_STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v instanceof CryptoKey ? "[CryptoKey]" : v,
  );
}

describe("serialized output never contains plaintext or secrets", () => {
  it("covers server state, ciphertexts, device storage and the recovery file", async () => {
    const PASSWORD = "Tr0ub4dor&3-old";
    const NEW_PASSWORD = "Correct-Horse-new";
    const SUBJECT = "Merger talks with Initech";
    const BODY = "Do not forward: the offer is 4.2 million.";
    const factory = new IDBFactory();
    const device = createIndexedDbDeviceStore({ indexedDB: factory });

    const setup = await setupMailboxKeys({ address: "ceo@mactidar.com", password: PASSWORD }, { kdf: FAST_KDF, device });
    const peer = await setupMailboxKeys({ address: "cfo@mactidar.com", password: "x" }, { kdf: FAST_KDF });
    const internal = await setup.session.encryptMessage(
      { header: { subject: SUBJECT, preview: BODY.slice(0, 20), fromName: "The CEO" }, body: { text: BODY } },
      [await readPublicKey(peer.state.keys[0]!.publicKey)],
    );
    const external = await encryptInboundMessage(
      { subject: SUBJECT, text: BODY, from: { name: "Initech Board" } },
      setup.state.keys[0]!.publicKey,
    );
    const reset = await resetMailboxKeys(setup.state, NEW_PASSWORD, { kdf: FAST_KDF, device });

    const unlockedKeyBytes = (await device.loadKeys("ceo@mactidar.com")).map((k) =>
      Buffer.from(serializeUnlockedKey(k)).toString("base64").slice(40, 120),
    );
    const outputs: Record<string, string | Uint8Array> = {
      setupState: serialize(setup.state),
      resetState: serialize(reset.state),
      internalHeader: internal.header,
      internalBody: internal.body,
      externalHeader: external.header,
      externalBody: external.body,
      deviceDb: serialize(await dumpIdb(factory)),
    };
    const secrets = [
      PASSWORD,
      NEW_PASSWORD,
      await deriveKeyPassphrase(PASSWORD, "ceo@mactidar.com"),
      await deriveKeyPassphrase(NEW_PASSWORD, "ceo@mactidar.com"),
      setup.recovery.code,
      setup.recovery.code.replace(/-/g, ""),
      SUBJECT,
      "Initech",
      "4.2 million",
      "The CEO",
      ...unlockedKeyBytes,
    ];
    for (const [name, out] of Object.entries(outputs)) {
      for (const secret of secrets) {
        expect(containsPlaintext(out, secret), `${name} leaks ${secret.slice(0, 12)}…`).toBe(false);
      }
    }
    // The recovery file holds the code by design, but never the password or any mail.
    for (const secret of [PASSWORD, NEW_PASSWORD, SUBJECT, ...unlockedKeyBytes]) {
      expect(containsPlaintext(setup.recovery.file, secret)).toBe(false);
    }
  });
});
