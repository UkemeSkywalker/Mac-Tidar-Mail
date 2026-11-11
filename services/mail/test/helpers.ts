import type { KdfParams } from "../src/crypto";

/**
 * Deliberately weak Argon2 parameters so the suite runs in seconds.
 * Production code always defaults to DEFAULT_KDF; one test pins that.
 */
export const FAST_KDF: KdfParams = { passes: 1, parallelism: 1, memoryExponent: 10 };

const decoder = new TextDecoder("utf-8", { fatal: false });

/** True if `needle` appears in `haystack` as UTF-8 text, base64 or raw bytes. */
export function containsPlaintext(haystack: string | Uint8Array, needle: string): boolean {
  const asText = typeof haystack === "string" ? haystack : decoder.decode(haystack);
  if (asText.includes(needle)) return true;
  if (asText.includes(Buffer.from(needle, "utf8").toString("base64").replace(/=+$/, ""))) return true;
  if (typeof haystack !== "string") return Buffer.from(haystack).includes(Buffer.from(needle, "utf8"));
  return false;
}

/** Parses the raw MIME message from an SES SendEmail call (subject, text, html, attachments). */
export async function sentEmail(input: { Content?: { Raw?: { Data?: Uint8Array } } }) {
  const { simpleParser } = await import("mailparser");
  const m = await simpleParser(Buffer.from(input.Content!.Raw!.Data!));
  return { subject: m.subject ?? "", text: m.text ?? "", html: typeof m.html === "string" ? m.html : "", attachments: m.attachments };
}
