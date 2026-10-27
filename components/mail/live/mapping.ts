// Turns server ciphertext into the UI's Message shape (in memory only) and back for settings.
// Nothing decrypted here is ever written to localStorage or sent to the server.
import { decryptBlob, encryptBlob } from "../crypto/core";
import type { MailboxSession } from "../crypto";
import type { Label, LabelTone, Message, Person, Settings } from "../data";
import type { ServerMessage } from "./api";

export interface LiveLabel { id: string; name: string; tone: LabelTone }
export interface LiveSettings { v: 1; labels: LiveLabel[]; signature: string; density: Settings["density"]; notifications: boolean }

const newLabelId = () => `l${crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 14)}`;

export function defaultSettings(displayName: string): LiveSettings {
  const tones: [string, LabelTone][] = [["Engineering", "engineering"], ["Product", "product"], ["Investors", "investors"], ["Design", "design"], ["Invoices", "invoices"], ["Security", "security"]];
  return { v: 1, labels: tones.map(([name, tone]) => ({ id: newLabelId(), name, tone })), signature: `${displayName}\nMac Tidar Technologies`, density: "comfortable", notifications: true };
}

export const createLabel = (name: string): LiveLabel => ({ id: newLabelId(), name, tone: "custom" });

const enc = new TextEncoder(), dec = new TextDecoder();

export async function encryptSettings(settings: LiveSettings, session: MailboxSession): Promise<string> {
  return encryptBlob(enc.encode(JSON.stringify(settings)), { encryptionKeys: [session.primaryPublicKey()], signingKey: session.signingKey() });
}

export async function decryptSettings(blob: string, session: MailboxSession): Promise<LiveSettings | null> {
  try {
    const { data } = await decryptBlob(blob, { decryptionKeys: session.decryptionKeys() });
    const parsed = JSON.parse(dec.decode(data)) as LiveSettings;
    return parsed?.v === 1 && Array.isArray(parsed.labels) ? parsed : null;
  } catch {
    return null;
  }
}

const fmtSize = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const iconFor = (type: string, name: string) =>
  type.includes("pdf") ? "picture_as_pdf" : type.startsWith("image/") ? "image" : /csv|sheet|excel/.test(type) || /\.(csv|xlsx?)$/i.test(name) ? "table_chart" : type.includes("json") ? "data_object" : "description";

export async function toMessage(item: ServerMessage, session: MailboxSession, labelNames: Map<string, string>): Promise<Message> {
  let header: Awaited<ReturnType<MailboxSession["decryptHeader"]>>["header"] | null = null;
  try { header = (await session.decryptHeader(item.header)).header; } catch { header = null; }
  const person = (email: string) => ({ name: email.split("@")[0] ?? email, email });
  return {
    id: item.sk,
    ref: item.sk,
    thread: item.threadId,
    kind: "message",
    folder: item.folder,
    category: item.category,
    from: { name: header?.fromName || item.fromAddress, email: item.fromAddress },
    to: item.toAddresses.map(person),
    cc: item.ccAddresses.map(person),
    subject: header ? header.subject || "(no subject)" : "Locked message",
    body: header ? header.preview : "This message is encrypted to an older key. Recover your old keys to read it.",
    date: item.receivedAt,
    read: item.read,
    starred: item.starred,
    snoozedUntil: item.snoozedUntil,
    labels: item.labels.map(id => labelNames.get(id)).filter((n): n is string => !!n),
    attachments: header?.attachments?.map(a => ({ name: a.filename, size: fmtSize(a.size), icon: iconFor(a.contentType, a.filename) })) ?? [],
    bodyState: "preview",
    locked: !header,
    rfcMessageId: item.rfcMessageId,
    references: item.references,
    e2e: item.e2e,
    deliveryStatus: item.deliveryStatus,
  };
}

/** Drafts are encrypted to the mailbox's own key before they leave the browser. */
export interface DraftBlob { v: 1; to: Person[]; cc: Person[]; subject: string; body: string; thread?: string }

export async function encryptDraft(d: DraftBlob, session: MailboxSession): Promise<string> {
  return encryptBlob(enc.encode(JSON.stringify(d)), { encryptionKeys: [session.primaryPublicKey()], signingKey: session.signingKey() });
}

export async function decryptDraft(blob: string, session: MailboxSession): Promise<DraftBlob | null> {
  try {
    const parsed = JSON.parse(dec.decode((await decryptBlob(blob, { decryptionKeys: session.decryptionKeys() })).data)) as DraftBlob;
    return parsed?.v === 1 && Array.isArray(parsed.to) ? parsed : null;
  } catch { return null; }
}

/** Plain text for display. HTML bodies are reduced to text until sanitised rendering lands (Phase 6). */
export function bodyText(body: { text: string; html?: string }): string {
  if (body.text.trim()) return body.text;
  if (!body.html) return "";
  const doc = new DOMParser().parseFromString(body.html, "text/html");
  doc.querySelectorAll("script,style,head").forEach(n => n.remove());
  return (doc.body.innerText || doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

export const uiLabels = (labels: LiveLabel[]): Label[] => labels.map(({ name, tone }) => ({ name, tone }));
