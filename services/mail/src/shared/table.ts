// Key layout for the `mactidar-mail` table (see infra/modules/table/main.tf).
import { normalizeAddress } from "../crypto/keys";

export type Folder = "inbox" | "sent" | "archive" | "spam" | "trash";
export type Category = "primary" | "updates" | "newsletters";

export const mailboxPk = (address: string) => `MAILBOX#${normalizeAddress(address)}`;
export const META_SK = "META";
export const messageSk = (receivedAt: string, id: string) => `MSG#${receivedAt}#${id}`;
export const folderGsi1 = (address: string, folder: Folder) => `MAILBOX#${normalizeAddress(address)}#FOLDER#${folder}`;
export const threadGsi2 = (threadId: string) => `THREAD#${threadId}`;
/** Lets the API list the mailboxes a Cloud account owns (gsi1 on META items). */
export const ownerGsi1 = (ownerSub: string) => `OWNER#${ownerSub}`;
export const SETTINGS_SK = "SETTINGS";

/** `MAILBOX#addr/META`. `keyState` is the crypto core's `MailboxKeyState` (public keys + locked private keys only). */
export interface MailboxMeta {
  pk: string;
  sk: typeof META_SK;
  address: string;
  ownerSub: string;
  displayName: string;
  status: "active" | "suspended";
  createdAt: string;
  gsi1pk: string;
  gsi1sk: string;
  keyState?: import("../crypto/keyring-types").MailboxKeyState;
  /** Bumped on every key change, for optimistic concurrency between devices. */
  keyVersion?: number;
  /** "self" when claimed through sign-up; absent for admin-provisioned mailboxes. */
  createdBy?: "self";
  /** Overrides the default daily recipient cap (new sign-ups start lower). */
  dailyRecipientLimit?: number;
}

/** `MAILBOX#addr/SETTINGS`: labels, signature and preferences, encrypted in the browser. */
export interface SettingsItem { pk: string; sk: typeof SETTINGS_SK; blob: string; version: number; updatedAt: string }

/** One stored message. Everything human-readable is inside the OpenPGP ciphertexts. */
export interface MessageItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  type: "message";
  id: string;
  mailbox: string;
  folder: Folder;
  kind: "message";
  category: Category;
  receivedAt: string;
  threadId: string;
  rfcMessageId?: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  size: number;
  read: boolean;
  starred: boolean;
  labels: string[];
  encVersion: 1;
  /** Fingerprint of the mailbox key the ciphertexts are encrypted to (mailboxes can hold several after a reset). */
  keyFingerprint: string;
  /** Armored OpenPGP message: {subject, preview, fromName, attachments}. */
  header: string;
  bodyKey: string;
  attachmentKeys: string[];
  verdicts: { spam: string; virus: string; spf: string; dkim: string; dmarc: string };
  snoozedUntil?: string | null;
  /** Message-IDs this message replies to, oldest first (for threading replies). */
  references?: string[];
  /** Sent copies only. */
  bccAddresses?: string[];
  sesMessageId?: string;
  deliveryStatus?: "sent" | "delivered" | "bounced" | "complained" | "delayed" | "rejected";
  /** Delivered Mac Tidar → Mac Tidar: encrypted and signed in the sender's browser. */
  e2e?: boolean;
}

export const draftSk = (id: string) => `DRAFT#${id}`;
/** `MAILBOX#addr/DRAFT#id`: a draft, encrypted in the browser. */
export interface DraftItem { pk: string; sk: string; type: "draft"; id: string; blob: string; updatedAt: string }

/** `SESMSG#<ses id>/PTR`: maps SES delivery events back to the sender's Sent copy. */
export const sesPointerPk = (sesId: string) => `SESMSG#${sesId}`;
