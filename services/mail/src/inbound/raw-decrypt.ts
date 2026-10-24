// SES's S3 action encrypts each inbound message client-side (S3 Encryption Client v2
// format, KMS "kms+context" key wrapping) before it ever reaches S3. This reverses that,
// in memory only.
import { createDecipheriv } from "node:crypto";
import { DecryptCommand, type KMSClient } from "@aws-sdk/client-kms";

export class UnsupportedEnvelopeError extends Error {
  constructor(detail: string) {
    super(`Unsupported S3 encryption envelope: ${detail}`);
    this.name = "UnsupportedEnvelopeError";
  }
}

const TAG_BYTES = 16;

/** `metadata` is S3 GetObject's user metadata (keys without the `x-amz-meta-` prefix). */
export async function decryptSesObject(kms: KMSClient, body: Uint8Array, metadata: Record<string, string | undefined>, expectedKeyArn: string): Promise<Buffer> {
  const wrappedKey = metadata["x-amz-key-v2"];
  const iv = metadata["x-amz-iv"];
  const cekAlg = metadata["x-amz-cek-alg"];
  const wrapAlg = metadata["x-amz-wrap-alg"];
  const matdesc = metadata["x-amz-matdesc"];
  const tagLen = metadata["x-amz-tag-len"] ?? "128";
  if (!wrappedKey || !iv || !matdesc) throw new UnsupportedEnvelopeError("missing v2 envelope metadata");
  if (cekAlg !== "AES/GCM/NoPadding") throw new UnsupportedEnvelopeError(`content algorithm ${cekAlg}`);
  if (wrapAlg !== "kms+context") throw new UnsupportedEnvelopeError(`wrap algorithm ${wrapAlg}`);
  if (tagLen !== "128") throw new UnsupportedEnvelopeError(`tag length ${tagLen}`);

  const context = JSON.parse(matdesc) as Record<string, string>;
  if (context["aws:x-amz-cek-alg"] !== cekAlg) throw new UnsupportedEnvelopeError("context/algorithm mismatch");

  const { Plaintext } = await kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(wrappedKey, "base64"),
    EncryptionContext: context,
    KeyId: expectedKeyArn,
  }));
  if (!Plaintext || Plaintext.byteLength !== 32) throw new UnsupportedEnvelopeError("data key is not AES-256");

  const data = Buffer.from(body);
  if (data.byteLength < TAG_BYTES) throw new UnsupportedEnvelopeError("object too short");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(Plaintext), Buffer.from(iv, "base64"));
  decipher.setAuthTag(data.subarray(data.byteLength - TAG_BYTES));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.byteLength - TAG_BYTES)), decipher.final()]);
  Buffer.from(Plaintext).fill(0);
  return plain;
}
