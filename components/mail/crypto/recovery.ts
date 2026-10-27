/** Crockford base32: no I, L, O, U, so codes survive being read aloud or handwritten. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BYTES = 32;
const CODE_CHARS = Math.ceil((CODE_BYTES * 8) / 5); // 52
const BEGIN = "-----BEGIN MAC TIDAR MAIL RECOVERY-----";
const END = "-----END MAC TIDAR MAIL RECOVERY-----";

export class InvalidRecoveryCodeError extends Error {
  constructor(message = "That is not a valid recovery code or recovery file") {
    super(message);
    this.name = "InvalidRecoveryCodeError";
  }
}

export interface RecoveryInput {
  code: string;
  address?: string;
  fingerprint?: string;
}

function group(chars: string): string {
  return chars.match(/.{1,4}/g)!.join("-");
}

/** 256 random bits, shown as 13 groups of 4 characters. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return group(out);
}

/** Canonical form of a typed code (any case, spaces or dashes, O/I/L look-alikes). */
export function normalizeRecoveryCode(input: string): string {
  const chars = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (chars.length !== CODE_CHARS || [...chars].some((c) => !ALPHABET.includes(c))) {
    throw new InvalidRecoveryCodeError();
  }
  return group(chars);
}

export function buildRecoveryFile(input: { address: string; code: string; fingerprint: string }): string {
  const payload = JSON.stringify({
    type: "mactidar-mail-recovery",
    version: 1,
    address: input.address,
    fingerprint: input.fingerprint,
    code: input.code,
  });
  return [
    "Mac Tidar Mail recovery file",
    "",
    `Mailbox: ${input.address}`,
    `Recovery code: ${input.code}`,
    "",
    "Keep this file somewhere safe and private (a password manager or printed copy).",
    "If you reset your password, it unlocks the mail encrypted before the reset.",
    "Anyone holding this file AND access to your account can read your mail.",
    "Mac Tidar does not keep a copy and cannot recover your mail without it.",
    "",
    BEGIN,
    payload,
    END,
    "",
  ].join("\n");
}

/** Accepts either the full recovery file contents or just the code. */
export function parseRecoveryInput(input: string): RecoveryInput {
  const start = input.indexOf(BEGIN);
  if (start === -1) return { code: normalizeRecoveryCode(input) };
  const end = input.indexOf(END, start);
  if (end === -1) throw new InvalidRecoveryCodeError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.slice(start + BEGIN.length, end));
  } catch {
    throw new InvalidRecoveryCodeError();
  }
  const p = parsed as Record<string, unknown>;
  if (
    p?.type !== "mactidar-mail-recovery" ||
    p.version !== 1 ||
    typeof p.code !== "string" ||
    typeof p.address !== "string" ||
    typeof p.fingerprint !== "string"
  ) {
    throw new InvalidRecoveryCodeError();
  }
  return { code: normalizeRecoveryCode(p.code), address: p.address, fingerprint: p.fingerprint };
}
