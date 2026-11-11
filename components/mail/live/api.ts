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
/** A verified company domain's name and logo, shown to everyone with an address on it. */
export interface Brand { name: string; logoUrl: string | null }
export interface ServerMailbox { address: string; displayName: string; keyState: MailboxKeyState | null; keyVersion: number; brand?: Brand | null }
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

export type DomainCheck = "ownership" | "dkim" | "mx" | "spf" | "dmarc" | "web";
/** A connected domain (or one being set up) as its owner sees it (see services/mail/src/shared/domains.ts). */
export interface DomainView {
  domain: string; displayName: string; status: "pending" | "active" | "suspended"; suspendedFor: "dns" | "abuse" | null;
  /** `dkimRecords`: the DKIM records are in DNS, though Amazon may not have confirmed them yet (`dkim`). */
  checks: Record<Exclude<DomainCheck, "web">, boolean> & { dkimRecords?: boolean; web?: boolean };
  records: { purpose: string; type: string; name: string; host: string; value: string; priority?: number; check: DomainCheck }[];
  createdAt: string; checkedAt: string | null; verifiedAt: string | null; expiresAt: string | null;
  logoUrl: string | null;
  /** The owner's own sign-in address when it's on this domain (a Business account). */
  ownAddress: string | null;
  /** mail.<domain>: Mac Tidar Mail on the company's own web address (null until the domain is verified). */
  web: { host: string; enabled: boolean; /** Turned off by the owner (the record may still be there). */ off: boolean; status: "pending" | "active" | null; dns: boolean; certificate: string | null;
    record: { purpose: string; type: string; name: string; host: string; value: string } } | null;
}

/** Someone with an address on a customer domain, as its owner sees them. */
export interface PersonView { address: string; givenName: string; familyName: string; backupEmail: string; status: "invited" | "active"; createdAt: string; activatedAt: string | null; owner?: boolean }

/** A verified company domain's name and logo, for the sign-in screen (no sign-in needed). */
export async function publicBrand(domain: string): Promise<(Brand & { domain: string }) | null> {
  const res = await fetch(`${liveConfig.apiUrl}/v1/brand?domain=${encodeURIComponent(domain)}`).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

export const mailApi = {
  mailboxes: () => call<{ mailboxes: ServerMailbox[] }>("GET", "/v1/mailboxes").then(r => r.mailboxes),
  /** Opens the mailbox for the signed-in account's own address (its username). */
  claim: () => call<{ mailbox: ServerMailbox }>("POST", "/v1/mailboxes", {}).then(r => r.mailbox),
  /** Our server's half of the key that reopens a mailbox after a reload. */
  createSession: (persistent: boolean) => call<{ id: string; clientKey: string }>("POST", "/v1/sessions", { persistent }),
  sessionKey: (id: string) => call<{ clientKey: string }>("GET", `/v1/sessions/${encodeURIComponent(id)}/key`).then(r => r.clientKey),
  endSession: (id: string) => call<{ deleted: boolean }>("DELETE", `/v1/sessions/${encodeURIComponent(id)}`),
  endAllSessions: () => call<{ deleted: number }>("DELETE", "/v1/sessions"),
  /** `businessDomain` is set for Business accounts: the one domain their address is on. */
  domains: () => call<{ domains: DomainView[]; limit: number; businessDomain: string | null }>("GET", "/v1/domains"),
  renameDomain: (domain: string, displayName: string) => call<DomainView>("PATCH", `/v1/domains/${encodeURIComponent(domain)}`, { displayName }),
  /** Uploads a company logo straight to storage, then attaches it to the domain. */
  async uploadLogo(domain: string, file: File): Promise<DomainView> {
    const form = await call<{ url: string; fields: Record<string, string>; key: string; maxBytes: number }>("POST", `/v1/domains/${encodeURIComponent(domain)}/logo`, { contentType: file.type });
    if (file.size > form.maxBytes) throw new ApiError(400, `The logo must be ${Math.round(form.maxBytes / 1024 / 1024)} MB or smaller.`);
    const body = new FormData();
    for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
    body.append("file", file);
    const res = await fetch(form.url, { method: "POST", body });
    if (!res.ok) throw new ApiError(res.status, "The logo couldn’t be uploaded. Use a PNG, JPEG or WebP image up to 1 MB.");
    return call<DomainView>("PUT", `/v1/domains/${encodeURIComponent(domain)}/logo`, { key: form.key });
  },
  removeLogo: (domain: string) => call<DomainView>("DELETE", `/v1/domains/${encodeURIComponent(domain)}/logo`),
  enableWeb: (domain: string) => call<DomainView>("POST", `/v1/domains/${encodeURIComponent(domain)}/web`),
  disableWeb: (domain: string) => call<DomainView>("DELETE", `/v1/domains/${encodeURIComponent(domain)}/web`),
  connectDomain: (domain: string, displayName: string) => call<DomainView>("POST", "/v1/domains", { domain, displayName }),
  checkDomain: (domain: string) => call<DomainView>("POST", `/v1/domains/${encodeURIComponent(domain)}/check`),
  removeDomain: (domain: string) => call<{ deleted: boolean }>("DELETE", `/v1/domains/${encodeURIComponent(domain)}`),
  people: (domain: string) => call<{ people: PersonView[]; limit: number }>("GET", `/v1/domains/${encodeURIComponent(domain)}/people`),
  addPerson: (domain: string, p: { localPart: string; givenName: string; familyName: string; backupEmail: string }) => call<PersonView>("POST", `/v1/domains/${encodeURIComponent(domain)}/people`, p),
  resendInvite: (domain: string, address: string) => call<{ sent: boolean }>("POST", `/v1/domains/${encodeURIComponent(domain)}/people/${encodeURIComponent(address)}/invite`),
  removePerson: (domain: string, address: string) => call<{ deleted: boolean }>("DELETE", `/v1/domains/${encodeURIComponent(domain)}/people/${encodeURIComponent(address)}`),
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
