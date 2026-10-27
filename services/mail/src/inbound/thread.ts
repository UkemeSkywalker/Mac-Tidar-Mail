import { createHash } from "node:crypto";
import { normalizeAddress } from "../crypto/keys";

const clean = (id: string) => id.trim().replace(/^<|>$/g, "").toLowerCase();

/** The conversation root: first References entry, else In-Reply-To, else the message's own Message-ID. */
export function threadRoot(messageId?: string, inReplyTo?: string, references?: string | string[]): string | undefined {
  const refs = (Array.isArray(references) ? references : references ? references.split(/\s+/) : []).filter(Boolean);
  const root = refs[0] ?? inReplyTo ?? messageId;
  return root ? clean(root) : undefined;
}

/**
 * Opaque, per-mailbox thread id. Derived from the mailbox and the root Message-ID so the
 * browser can compute the same id when replying, without the server storing a readable link.
 */
export function threadId(mailbox: string, root: string | undefined, fallback: string): string {
  return createHash("sha256").update(`mactidar-mail/thread/v1\0${normalizeAddress(mailbox)}\0${root ?? `local:${fallback}`}`).digest("hex").slice(0, 32);
}
