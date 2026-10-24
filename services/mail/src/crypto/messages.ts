import * as openpgp from "openpgp";
import type { PrivateKey, PublicKey } from "openpgp";
import { readConfig } from "./config";
import { DecryptionError } from "./errors";

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  inline?: boolean;
}

/** Everything the inbox list needs. Encrypted as one small blob (stored in DynamoDB). */
export interface MessageHeader {
  subject: string;
  preview: string;
  fromName: string;
  attachments?: AttachmentMeta[];
}

/** The full message content. Encrypted as one blob (stored in S3), fetched when opened. */
export interface MessageBody {
  text: string;
  html?: string;
}

export interface EncryptedMessage {
  /** Armored OpenPGP message. */
  header: string;
  /** Binary OpenPGP message. */
  body: Uint8Array;
}

/**
 * - `verified`: signed by one of the given verification keys.
 * - `invalid`: signed, but not by any given key, or the signature does not match.
 * - `unverified`: signed, but no verification keys were supplied.
 * - `unsigned`: no signature (e.g. external mail encrypted on arrival).
 */
export type SignatureStatus = "verified" | "invalid" | "unverified" | "unsigned";

export interface EncryptOptions {
  encryptionKeys: PublicKey[];
  signingKey?: PrivateKey;
}

export interface DecryptOptions {
  decryptionKeys: PrivateKey[];
  verificationKeys?: PublicKey[];
}

type VerificationResult = Awaited<ReturnType<typeof openpgp.decrypt>>["signatures"][number];

const HEADER_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function encryptBytes(data: Uint8Array, opts: EncryptOptions, armor: true): Promise<string>;
async function encryptBytes(data: Uint8Array, opts: EncryptOptions, armor: false): Promise<Uint8Array>;
async function encryptBytes(data: Uint8Array, opts: EncryptOptions, armor: boolean): Promise<string | Uint8Array> {
  if (opts.encryptionKeys.length === 0) throw new Error("At least one recipient key is required");
  const message = await openpgp.createMessage({ binary: data });
  const common = {
    message,
    encryptionKeys: opts.encryptionKeys,
    signingKeys: opts.signingKey ? [opts.signingKey] : undefined,
  };
  return armor
    ? openpgp.encrypt({ ...common, format: "armored" })
    : openpgp.encrypt({ ...common, format: "binary" });
}

async function decryptBytes(
  ciphertext: string | Uint8Array,
  opts: DecryptOptions,
): Promise<{ data: Uint8Array; signature: SignatureStatus }> {
  let data: Uint8Array;
  let signatures: VerificationResult[];
  try {
    const message =
      typeof ciphertext === "string"
        ? await openpgp.readMessage({ armoredMessage: ciphertext, config: readConfig })
        : await openpgp.readMessage({ binaryMessage: ciphertext, config: readConfig });
    const result = await openpgp.decrypt({
      message,
      decryptionKeys: opts.decryptionKeys,
      verificationKeys: opts.verificationKeys ?? [],
      format: "binary",
      config: readConfig,
    });
    data = result.data as Uint8Array;
    signatures = result.signatures;
  } catch {
    throw new DecryptionError();
  }
  return { data, signature: await signatureStatus(signatures, Boolean(opts.verificationKeys?.length)) };
}

async function signatureStatus(signatures: VerificationResult[], haveKeys: boolean): Promise<SignatureStatus> {
  if (signatures.length === 0) return "unsigned";
  if (!haveKeys) return "unverified";
  for (const s of signatures) {
    try {
      await s.verified;
      return "verified";
    } catch {
      // try the next signature
    }
  }
  return "invalid";
}

function parseJson<T>(bytes: Uint8Array, check: (v: Record<string, unknown>) => boolean): T {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new DecryptionError("Decrypted content is not valid JSON");
  }
  if (!value || typeof value !== "object" || !check(value as Record<string, unknown>)) {
    throw new DecryptionError("Decrypted content has an unexpected shape");
  }
  return value as T;
}

/** Encrypt (and optionally sign) a message's header and body to every recipient key. */
export async function encryptMessageParts(
  parts: { header: MessageHeader; body: MessageBody },
  opts: EncryptOptions,
): Promise<EncryptedMessage> {
  const header = { v: HEADER_VERSION, ...parts.header, attachments: parts.header.attachments ?? [] };
  const body = { v: HEADER_VERSION, ...parts.body };
  const [h, b] = await Promise.all([
    encryptBytes(encoder.encode(JSON.stringify(header)), opts, true),
    encryptBytes(encoder.encode(JSON.stringify(body)), opts, false),
  ]);
  return { header: h, body: b };
}

export async function decryptMessageHeader(
  armored: string,
  opts: DecryptOptions,
): Promise<{ header: MessageHeader; signature: SignatureStatus }> {
  const { data, signature } = await decryptBytes(armored, opts);
  const raw = parseJson<MessageHeader>(
    data,
    (v) => typeof v.subject === "string" && typeof v.preview === "string" && typeof v.fromName === "string",
  );
  const header: MessageHeader = {
    subject: raw.subject,
    preview: raw.preview,
    fromName: raw.fromName,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
  };
  return { header, signature };
}

export async function decryptMessageBody(
  ciphertext: Uint8Array,
  opts: DecryptOptions,
): Promise<{ body: MessageBody; signature: SignatureStatus }> {
  const { data, signature } = await decryptBytes(ciphertext, opts);
  const raw = parseJson<MessageBody>(data, (v) => typeof v.text === "string");
  const body: MessageBody = typeof raw.html === "string" ? { text: raw.text, html: raw.html } : { text: raw.text };
  return { body, signature };
}

/** Attachments are encrypted separately so they can be fetched (and size-checked) on demand. */
export function encryptAttachment(data: Uint8Array, opts: EncryptOptions): Promise<Uint8Array> {
  return encryptBytes(data, opts, false);
}

export function decryptAttachment(
  ciphertext: Uint8Array,
  opts: DecryptOptions,
): Promise<{ data: Uint8Array; signature: SignatureStatus }> {
  return decryptBytes(ciphertext, opts);
}

/** Generic binary encryption, for blobs other than mail (labels, drafts, settings, recovery copies). */
export function encryptBlob(data: Uint8Array, opts: EncryptOptions): Promise<string> {
  return encryptBytes(data, opts, true);
}

export function decryptBlob(armored: string, opts: DecryptOptions) {
  return decryptBytes(armored, opts);
}

export async function signDetached(data: string | Uint8Array, signingKey: PrivateKey): Promise<string> {
  const message = await openpgp.createMessage({ binary: typeof data === "string" ? encoder.encode(data) : data });
  return openpgp.sign({ message, signingKeys: signingKey, detached: true, format: "armored" });
}

export async function verifyDetached(
  data: string | Uint8Array,
  armoredSignature: string,
  verificationKeys: PublicKey[],
): Promise<boolean> {
  try {
    const message = await openpgp.createMessage({ binary: typeof data === "string" ? encoder.encode(data) : data });
    const signature = await openpgp.readSignature({ armoredSignature });
    const { signatures } = await openpgp.verify({ message, signature, verificationKeys, format: "binary" });
    return (await signatureStatus(signatures, verificationKeys.length > 0)) === "verified";
  } catch {
    return false;
  }
}
