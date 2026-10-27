// Typed client for the mail API. Everything sent or received here is ciphertext or metadata.
import { fetchAuthSession } from "aws-amplify/auth";
import type { MailboxKeyState } from "../crypto";
import type { Message } from "../data";
import { liveConfig } from "./config";

export type ServerFolder = "inbox" | "sent" | "archive" | "spam" | "trash";
export interface ServerMessage {
  id: string; sk: string; folder: ServerFolder; category: "primary" | "updates" | "newsletters"; receivedAt: string; threadId: string;
  fromAddress: string; toAddresses: string[]; ccAddresses: string[]; size: number; read: boolean; starred: boolean; labels: string[];
  snoozedUntil: string | null; keyFingerprint: string; header: string; attachmentCount: number; spam: boolean;
  rfcMessageId: string | null; references: string[]; bccAddresses: string[]; deliveryStatus: Message["deliveryStatus"]; e2e: boolean;
}
export interface CipherPayload { header: string; body: string; attachments: string[]; keyFingerprint: string }
export interface SendPayload {
  clientId: string; to: string[]; cc: string[]; bcc: string[]; inReplyTo?: string; references?: string[];
  external?: { subject: string; text: string; attachments: { filename: string; contentType: string; content: string }[] };
  internal: (CipherPayload & { address: string })[];
  sentCopy: CipherPayload;
}
export interface ServerMailbox { address: string; displayName: string; keyState: MailboxKeyState | null; keyVersion: number }
export interface MessagePatch { read?: boolean; starred?: boolean; folder?: ServerFolder; labels?: string[]; snoozedUntil?: string | null }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = (await fetchAuthSession()).tokens?.accessToken?.toString();
  if (!token) throw new ApiError(401, "Your session has expired. Please sign in again.");
  const res = await fetch(`${liveConfig.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const mb = (address: string) => `/v1/mailboxes/${encodeURIComponent(address)}`;

export const mailApi = {
  mailboxes: () => call<{ mailboxes: ServerMailbox[] }>("GET", "/v1/mailboxes").then(r => r.mailboxes),
  saveKeys: (address: string, keyState: MailboxKeyState, expectedVersion: number) => call<{ keyVersion: number }>("PUT", `${mb(address)}/keys`, { keyState, expectedVersion }),
  async listFolder(address: string, folder: ServerFolder): Promise<ServerMessage[]> {
    const out: ServerMessage[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `?folder=${folder}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: { messages: ServerMessage[]; cursor: string | null } = await call("GET", `${mb(address)}/messages${q}`);
      out.push(...page.messages);
      cursor = page.cursor;
    } while (cursor && out.length < 5000);
    return out;
  },
  patch: (address: string, sks: string[], set: MessagePatch) => call<{ updated: number }>("PATCH", `${mb(address)}/messages`, { sks, set }),
  deleteForever: (address: string, sks: string[]) => call<{ deleted: number }>("POST", `${mb(address)}/messages/delete`, { sks }),
  async download(address: string, sk: string, part: "body" | "attachment", index = 0): Promise<Uint8Array> {
    const { url } = await call<{ url: string }>("GET", `${mb(address)}/content?sk=${encodeURIComponent(sk)}&part=${part}&index=${index}`);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new ApiError(res.status, "Download failed");
    return new Uint8Array(await res.arrayBuffer());
  },
  settings: (address: string) => call<{ blob: string | null; version: number }>("GET", `${mb(address)}/settings`),
  saveSettings: (address: string, blob: string, expectedVersion: number) => call<{ version: number }>("PUT", `${mb(address)}/settings`, { blob, expectedVersion }),
  /** Public key of a Mac Tidar mailbox, or null if the address isn't one (send it as external mail). */
  async publicKey(address: string): Promise<{ fingerprint: string; publicKey: string } | null> {
    try { return await call("GET", `/v1/keys?address=${encodeURIComponent(address)}`); }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  },
  send: (address: string, payload: SendPayload) => call<{ message: ServerMessage }>("POST", `${mb(address)}/send`, payload).then(r => r.message),
  drafts: (address: string) => call<{ drafts: { id: string; blob: string; updatedAt: string }[] }>("GET", `${mb(address)}/drafts`).then(r => r.drafts),
  saveDraft: (address: string, id: string, blob: string) => call<{ id: string }>("PUT", `${mb(address)}/drafts/${encodeURIComponent(id)}`, { blob }),
  deleteDraft: (address: string, id: string) => call<{ deleted: boolean }>("DELETE", `${mb(address)}/drafts/${encodeURIComponent(id)}`),
};
