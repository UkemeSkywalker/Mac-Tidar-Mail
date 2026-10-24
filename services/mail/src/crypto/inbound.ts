import type { PrivateKey, PublicKey } from "openpgp";
import { toPublicKey } from "./keys";
import { encryptAttachment, encryptMessageParts, type AttachmentMeta } from "./messages";

/** The subset of a mailparser `ParsedMail` the inbound Lambda hands us (map `from.value[0]` into `from`). */
export interface InboundParsedMessage {
  subject?: string;
  from?: { name?: string; address?: string };
  text?: string;
  html?: string;
  attachments?: {
    filename?: string;
    contentType?: string;
    content: Uint8Array;
    contentId?: string;
    inline?: boolean;
  }[];
}

/**
 * Ciphertext only. Attachment names, types and sizes live inside `header`;
 * `attachments[i]` is the encrypted bytes of `header.attachments[i]`.
 */
export interface EncryptedInboundMessage {
  header: string;
  body: Uint8Array;
  attachments: Uint8Array[];
}

const PREVIEW_LENGTH = 160;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

export function buildPreview(text: string | undefined, html: string | undefined): string {
  const source = text?.trim() ? text : html ? htmlToText(html) : "";
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_LENGTH ? flat : `${flat.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/**
 * Used by the inbound Lambda: encrypt a freshly parsed external message to the
 * mailbox owner's public key. The caller must drop every plaintext reference
 * (and the raw S3 object) right after this resolves.
 */
export async function encryptInboundMessage(
  parsed: InboundParsedMessage,
  recipientPublicKey: string | PublicKey | PrivateKey,
): Promise<EncryptedInboundMessage> {
  const key = await toPublicKey(recipientPublicKey);
  const opts = { encryptionKeys: [key] };
  const files = parsed.attachments ?? [];
  const meta: AttachmentMeta[] = files.map((a) => ({
    filename: a.filename ?? "attachment",
    contentType: a.contentType ?? "application/octet-stream",
    size: a.content.byteLength,
    ...(a.contentId ? { contentId: a.contentId } : {}),
    ...(a.inline ? { inline: true } : {}),
  }));

  const [message, ...attachments] = await Promise.all([
    encryptMessageParts(
      {
        header: {
          subject: parsed.subject ?? "",
          preview: buildPreview(parsed.text, parsed.html),
          fromName: parsed.from?.name ?? "",
          attachments: meta,
        },
        body: { text: parsed.text ?? "", ...(parsed.html ? { html: parsed.html } : {}) },
      },
      opts,
    ),
    ...files.map((a) => encryptAttachment(a.content, opts)),
  ]);
  return { header: message.header, body: message.body, attachments };
}
