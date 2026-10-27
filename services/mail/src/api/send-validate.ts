// Validation for outgoing mail. Plaintext is accepted only for recipients outside Mac Tidar
// (it has to leave readable); Mac Tidar recipients get ciphertext encrypted in the browser.
import { normalizeAddress } from "../crypto/keys";
import { BadRequest } from "./validate";

export interface ExternalPart { subject: string; text: string; html?: string; attachments: { filename: string; contentType: string; content: Buffer }[] }
export interface Cipher { header: string; body: Buffer; attachments: Buffer[]; keyFingerprint: string }
export interface InternalDelivery extends Cipher { address: string }
export interface SendRequest {
  clientId: string;
  to: string[]; cc: string[]; bcc: string[];
  inReplyTo?: string;
  references: string[];
  external?: ExternalPart;
  internal: InternalDelivery[];
  sentCopy: Cipher;
}

export const MAX_RECIPIENTS = 50;
// Lambda requests are capped at 6 MB and a send carries plaintext + ciphertext (base64), so keep this at 2 MB.
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const BLOCKED_EXTENSIONS = /\.(exe|com|bat|cmd|scr|pif|vbs|vbe|js|jse|wsf|wsh|msi|msp|jar|ps1|psm1|hta|cpl|lnk|reg|dll)$/i;
// Deliberately strict: no quotes, angle brackets, commas or spaces, so nothing can be smuggled into headers.
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}$/;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}@[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;
const ARMORED_MESSAGE = /^-----BEGIN PGP MESSAGE-----[\s\S]+-----END PGP MESSAGE-----\s*$/;
const FINGERPRINT = /^[0-9a-f]{40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function need(cond: unknown, msg: string): asserts cond { if (!cond) throw new BadRequest(msg); }
const noBreaks = (s: string) => !/[\r\n\0]/.test(s);

function addresses(v: unknown, field: string): string[] {
  need(v === undefined || Array.isArray(v), `${field} must be a list`);
  const list = (v as unknown[] | undefined) ?? [];
  for (const a of list) need(typeof a === "string" && a.length <= 254 && EMAIL.test(a), `${field} contains an invalid address`);
  return [...new Set((list as string[]).map(normalizeAddress))];
}

function base64(v: unknown, field: string, maxBytes: number): Buffer {
  need(typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v), `${field} must be base64`);
  const buf = Buffer.from(v, "base64");
  need(buf.byteLength <= maxBytes, `${field} is too large`);
  return buf;
}

/** OpenPGP binary messages start with a packet header byte that has the top bit set. */
function cipherBytes(v: unknown, field: string, maxBytes: number): Buffer {
  const buf = base64(v, field, maxBytes);
  need(buf.byteLength > 0 && (buf[0]! & 0x80) !== 0, `${field} must be OpenPGP ciphertext`);
  return buf;
}

function cipher(v: unknown, field: string, attachmentCount: number): Cipher {
  need(isObj(v), `${field} required`);
  need(typeof v.header === "string" && v.header.length < 100_000 && ARMORED_MESSAGE.test(v.header), `${field}.header must be an encrypted message`);
  need(typeof v.keyFingerprint === "string" && FINGERPRINT.test(v.keyFingerprint), `${field}.keyFingerprint invalid`);
  need(Array.isArray(v.attachments) && v.attachments.length === attachmentCount, `${field}.attachments must match the message`);
  return {
    header: v.header,
    body: cipherBytes(v.body, `${field}.body`, 3 * 1024 * 1024),
    attachments: (v.attachments as unknown[]).map((a, i) => cipherBytes(a, `${field}.attachments[${i}]`, MAX_ATTACHMENT_BYTES + 64 * 1024)),
    keyFingerprint: v.keyFingerprint,
  };
}

export function validateSend(input: unknown, localDomains: string[]): SendRequest {
  need(isObj(input), "Body must be an object");
  need(typeof input.clientId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(input.clientId), "clientId required");
  const to = addresses(input.to, "to"), cc = addresses(input.cc, "cc"), bcc = addresses(input.bcc, "bcc");
  const all = [...new Set([...to, ...cc, ...bcc])];
  need(all.length >= 1, "Add at least one recipient");
  need(all.length <= MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients per message`);
  // The subject travels only inside `external`: mail between Mac Tidar users has it in the ciphertext header alone.
  need(input.subject === undefined, "The subject belongs in the readable part for outside recipients only");
  need(input.inReplyTo === undefined || (typeof input.inReplyTo === "string" && MESSAGE_ID.test(input.inReplyTo)), "Invalid In-Reply-To");
  need(input.references === undefined || (Array.isArray(input.references) && input.references.length <= 50 && input.references.every(r => typeof r === "string" && MESSAGE_ID.test(r))), "Invalid References");

  const isLocal = (a: string) => localDomains.includes(a.split("@")[1] ?? "");
  need(Array.isArray(input.internal), "internal must be a list");
  const internalAddrs = new Set<string>();
  const attachmentCount = isObj(input.sentCopy) && Array.isArray(input.sentCopy.attachments) ? input.sentCopy.attachments.length : 0;
  need(attachmentCount <= 20, "At most 20 attachments");
  const internal = (input.internal as unknown[]).map((d, i) => {
    need(isObj(d) && typeof d.address === "string", `internal[${i}] invalid`);
    const address = normalizeAddress(d.address);
    need(all.includes(address) && isLocal(address), `internal[${i}] is not a Mac Tidar recipient of this message`);
    need(!internalAddrs.has(address), "Duplicate internal recipient");
    internalAddrs.add(address);
    return { address, ...cipher(d, `internal[${i}]`, attachmentCount) };
  });
  const externals = all.filter(a => !internalAddrs.has(a));

  let external: ExternalPart | undefined;
  if (externals.length) {
    const e = input.external;
    need(isObj(e), "Message content is required for recipients outside Mac Tidar");
    need(typeof e.subject === "string" && e.subject.length <= 998 && noBreaks(e.subject), "Invalid subject");
    need(typeof e.text === "string" && e.text.length <= 1_000_000, "Invalid text body");
    need(e.html === undefined || (typeof e.html === "string" && e.html.length <= 2_000_000), "Invalid HTML body");
    need(Array.isArray(e.attachments) && e.attachments.length === attachmentCount, "Attachments must match the message");
    let total = 0;
    const attachments = (e.attachments as unknown[]).map((a, i) => {
      need(isObj(a), `attachment ${i} invalid`);
      need(typeof a.filename === "string" && a.filename.length >= 1 && a.filename.length <= 200 && noBreaks(a.filename) && !/[\\/"]/.test(a.filename), `attachment ${i} has an invalid name`);
      need(!BLOCKED_EXTENSIONS.test(a.filename), `“${a.filename}” is a blocked file type`);
      need(typeof a.contentType === "string" && /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(a.contentType), `attachment ${i} has an invalid type`);
      const content = base64(a.content, `attachment ${i}`, MAX_ATTACHMENT_BYTES);
      total += content.byteLength;
      return { filename: a.filename, contentType: a.contentType, content };
    });
    need(total <= MAX_ATTACHMENT_BYTES, "Attachments are limited to 2 MB per message for now");
    external = { subject: e.subject, text: e.text, html: e.html as string | undefined, attachments };
  } else {
    need(input.external === undefined, "Mail between Mac Tidar users must not include readable content");
  }

  return {
    clientId: input.clientId, to, cc, bcc,
    inReplyTo: input.inReplyTo as string | undefined, references: (input.references as string[] | undefined) ?? [],
    external, internal, sentCopy: cipher(input.sentCopy, "sentCopy", attachmentCount),
  };
}
