// Builds an outgoing message in the browser. Mac Tidar recipients get a copy encrypted to
// their key and signed by ours (end to end). Only when there are outside recipients does a
// readable copy go to the server, because Gmail/Yahoo/etc. must be able to read it.
import { encryptAttachment, readPublicKey } from "../crypto/core";
import type { MailboxSession } from "../crypto";
import type { Message } from "../data";
import { mailApi, type CipherPayload, type SendPayload } from "./api";

export interface OutgoingDraft {
  id: string;
  to: string[]; cc: string[];
  subject: string; text: string;
  attachments: { name: string; type: string; data: Uint8Array }[];
  replyTo?: Pick<Message, "rfcMessageId" | "references">;
}

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function buildSend(session: MailboxSession, address: string, displayName: string, d: OutgoingDraft): Promise<SendPayload> {
  const total = d.attachments.reduce((n, a) => n + a.data.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) throw new Error("Attachments are limited to 2 MB per message for now");

  const recipients = [...new Set([...d.to, ...d.cc].map(a => a.trim().toLowerCase()))];
  const keys = await Promise.all(recipients.map(async a => [a, await mailApi.publicKey(a)] as const));
  const internal = keys.filter(([, k]) => k) as [string, { fingerprint: string; publicKey: string }][];
  const hasExternal = keys.some(([, k]) => !k);

  const header = {
    subject: d.subject, preview: d.text.replace(/\s+/g, " ").trim().slice(0, 160), fromName: displayName,
    attachments: d.attachments.map(a => ({ filename: a.name, contentType: a.type || "application/octet-stream", size: a.data.byteLength })),
  };
  const body = { text: d.text };

  const encryptFor = async (recipient: Awaited<ReturnType<typeof readPublicKey>> | null, fingerprint: string): Promise<CipherPayload> => {
    const recipientsKeys = recipient ? [recipient] : [];
    const m = await session.encryptMessage({ header, body }, recipientsKeys);
    const attachKeys = { encryptionKeys: [...recipientsKeys, session.primaryPublicKey()], signingKey: session.signingKey() };
    const attachments = await Promise.all(d.attachments.map(async a => b64(await encryptAttachment(a.data, attachKeys))));
    return { header: m.header, body: b64(m.body), attachments, keyFingerprint: fingerprint };
  };

  const refs = d.replyTo?.rfcMessageId ? [...(d.replyTo.references ?? []), d.replyTo.rfcMessageId].slice(-50) : undefined;
  return {
    clientId: d.id,
    to: d.to, cc: d.cc, bcc: [],
    subject: d.subject,
    ...(d.replyTo?.rfcMessageId ? { inReplyTo: d.replyTo.rfcMessageId, references: refs } : {}),
    ...(hasExternal ? { external: { text: d.text, attachments: d.attachments.map(a => ({ filename: a.name, contentType: a.type || "application/octet-stream", content: b64(a.data) })) } } : {}),
    internal: await Promise.all(internal.map(async ([addr, k]) => ({ address: addr, ...await encryptFor(await readPublicKey(k.publicKey), k.fingerprint) }))),
    sentCopy: await encryptFor(null, session.primaryFingerprint),
  };
}
