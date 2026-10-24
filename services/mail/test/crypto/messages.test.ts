import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  decryptAttachment,
  decryptMessageBody,
  decryptMessageHeader,
  encryptAttachment,
  encryptMessageParts,
  generateMailboxKey,
  readPublicKey,
  signDetached,
  verifyDetached,
} from "../../src/crypto";
import { containsPlaintext } from "../helpers";

const header = { subject: "Quarterly numbers", preview: "Revenue is up 12%", fromName: "Ada Lovelace" };
const body = { text: "Revenue is up 12% quarter on quarter.", html: "<p>Revenue is up <b>12%</b></p>" };

async function pair(address: string) {
  const k = await generateMailboxKey(address);
  return { ...k, pub: await readPublicKey(k.publicKey) };
}

describe("message parts", () => {
  it("round-trips header and body for a single recipient", async () => {
    const bob = await pair("bob@mactidar.com");
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [bob.pub] });
    expect(typeof enc.header).toBe("string");
    expect(enc.header).toContain("-----BEGIN PGP MESSAGE-----");
    expect(enc.body).toBeInstanceOf(Uint8Array);

    const h = await decryptMessageHeader(enc.header, { decryptionKeys: [bob.privateKey] });
    expect(h.header).toEqual({ ...header, attachments: [] });
    expect(h.signature).toBe("unsigned");
    const b = await decryptMessageBody(enc.body, { decryptionKeys: [bob.privateKey] });
    expect(b.body).toEqual(body);
  });

  it("encrypts to multiple recipients and each can decrypt independently", async () => {
    const [alice, bob, carol] = await Promise.all([
      pair("alice@mactidar.com"),
      pair("bob@mactidar.com"),
      pair("carol@mactidar.com"),
    ]);
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [alice.pub, bob.pub, carol.pub] });
    for (const who of [alice, bob, carol]) {
      const h = await decryptMessageHeader(enc.header, { decryptionKeys: [who.privateKey] });
      expect(h.header.subject).toBe(header.subject);
      const b = await decryptMessageBody(enc.body, { decryptionKeys: [who.privateKey] });
      expect(b.body.text).toBe(body.text);
    }
  });

  it("fails with DecryptionError for a non-recipient key", async () => {
    const [bob, eve] = await Promise.all([pair("bob@mactidar.com"), pair("eve@mactidar.com")]);
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [bob.pub] });
    await expect(decryptMessageHeader(enc.header, { decryptionKeys: [eve.privateKey] })).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptMessageBody(enc.body, { decryptionKeys: [eve.privateKey] })).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("decrypts with any key in a keyring (old + new keys)", async () => {
    const [oldKey, newKey] = await Promise.all([pair("bob@mactidar.com"), pair("bob@mactidar.com")]);
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [oldKey.pub] });
    const h = await decryptMessageHeader(enc.header, { decryptionKeys: [newKey.privateKey, oldKey.privateKey] });
    expect(h.header.subject).toBe(header.subject);
  });

  it("signs and verifies sender identity; flags tampered or wrong signer", async () => {
    const [alice, bob, mallory] = await Promise.all([
      pair("alice@mactidar.com"),
      pair("bob@mactidar.com"),
      pair("mallory@mactidar.com"),
    ]);
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [bob.pub], signingKey: alice.privateKey });

    const ok = await decryptMessageHeader(enc.header, { decryptionKeys: [bob.privateKey], verificationKeys: [alice.pub] });
    expect(ok.signature).toBe("verified");
    const okBody = await decryptMessageBody(enc.body, { decryptionKeys: [bob.privateKey], verificationKeys: [alice.pub] });
    expect(okBody.signature).toBe("verified");

    const wrong = await decryptMessageHeader(enc.header, {
      decryptionKeys: [bob.privateKey],
      verificationKeys: [mallory.pub],
    });
    expect(wrong.signature).toBe("invalid");

    const unknown = await decryptMessageHeader(enc.header, { decryptionKeys: [bob.privateKey] });
    expect(unknown.signature).toBe("unverified");
  });

  it("rejects ciphertext that has been tampered with", async () => {
    const bob = await pair("bob@mactidar.com");
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [bob.pub] });
    const tampered = enc.body.slice();
    const at = tampered.length - 5;
    tampered[at] = tampered[at]! ^ 0xff;
    await expect(decryptMessageBody(tampered, { decryptionKeys: [bob.privateKey] })).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("never leaks plaintext into the ciphertext", async () => {
    const bob = await pair("bob@mactidar.com");
    const enc = await encryptMessageParts({ header, body }, { encryptionKeys: [bob.pub] });
    for (const secret of [header.subject, header.preview, header.fromName, body.text, "Revenue"]) {
      expect(containsPlaintext(enc.header, secret)).toBe(false);
      expect(containsPlaintext(enc.body, secret)).toBe(false);
    }
  });

  it("requires at least one recipient", async () => {
    await expect(encryptMessageParts({ header, body }, { encryptionKeys: [] })).rejects.toThrow(/recipient/);
  });
});

describe("attachments", () => {
  it("round-trips binary data byte for byte", async () => {
    const bob = await pair("bob@mactidar.com");
    const data = new Uint8Array(256 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const ct = await encryptAttachment(data, { encryptionKeys: [bob.pub] });
    expect(Buffer.from(ct).includes(Buffer.from(data.subarray(1000, 1064)))).toBe(false);
    const pt = await decryptAttachment(ct, { decryptionKeys: [bob.privateKey] });
    expect(Buffer.from(pt.data).equals(Buffer.from(data))).toBe(true);
  });

  it("fails for the wrong key", async () => {
    const [bob, eve] = await Promise.all([pair("bob@mactidar.com"), pair("eve@mactidar.com")]);
    const ct = await encryptAttachment(new TextEncoder().encode("secret pdf"), { encryptionKeys: [bob.pub] });
    await expect(decryptAttachment(ct, { decryptionKeys: [eve.privateKey] })).rejects.toBeInstanceOf(DecryptionError);
  });

  it("carries a verifiable signature when signed", async () => {
    const [alice, bob] = await Promise.all([pair("alice@mactidar.com"), pair("bob@mactidar.com")]);
    const ct = await encryptAttachment(new Uint8Array([1, 2, 3]), {
      encryptionKeys: [bob.pub],
      signingKey: alice.privateKey,
    });
    const pt = await decryptAttachment(ct, { decryptionKeys: [bob.privateKey], verificationKeys: [alice.pub] });
    expect(pt.signature).toBe("verified");
  });
});

describe("detached signatures", () => {
  it("verifies for the signer and fails for tampered data or another key", async () => {
    const [alice, mallory] = await Promise.all([pair("alice@mactidar.com"), pair("mallory@mactidar.com")]);
    const sig = await signDetached("hello world", alice.privateKey);
    expect(sig).toContain("-----BEGIN PGP SIGNATURE-----");
    expect(await verifyDetached("hello world", sig, [alice.pub])).toBe(true);
    expect(await verifyDetached("hello w0rld", sig, [alice.pub])).toBe(false);
    expect(await verifyDetached("hello world", sig, [mallory.pub])).toBe(false);
  });

  it("works on binary data", async () => {
    const alice = await pair("alice@mactidar.com");
    const data = new Uint8Array([0, 1, 2, 255]);
    const sig = await signDetached(data, alice.privateKey);
    expect(await verifyDetached(data, sig, [alice.pub])).toBe(true);
    expect(await verifyDetached(new Uint8Array([0, 1, 2, 254]), sig, [alice.pub])).toBe(false);
  });
});
