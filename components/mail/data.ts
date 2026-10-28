// Shapes the mail UI works with. Real mail is decrypted into these in memory only (see live/mapping.ts).

export type Person = { name: string; email: string; title?: string };
export type Attachment = {
  name: string; size: string; icon: string;
  /** Composer only: the file's bytes, held in memory until sent (never persisted unencrypted). */
  data?: Uint8Array; type?: string;
  /** Inline image referenced from the HTML body as cid:… */
  cid?: string;
};
export type FolderId = "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "scheduled" | "archive" | "spam" | "trash";
export type Category = "primary" | "updates" | "newsletters";
export type LabelTone = "product" | "engineering" | "investors" | "design" | "invoices" | "security" | "custom";
export type Label = { name: string; tone: LabelTone };

export type Message = {
  id: string;
  thread: string;
  kind: "message" | "draft" | "scheduled";
  folder: "inbox" | "sent" | "archive" | "spam" | "trash";
  category: Category;
  from: Person;
  to: Person[];
  cc?: Person[];
  subject: string;
  body: string;
  date: string;
  read: boolean;
  starred: boolean;
  urgent?: boolean;
  snoozedUntil: string | null;
  scheduledAt?: string | null;
  labels: string[];
  attachments: Attachment[];
  /** The server's message key; absent for local-only drafts. */
  ref?: string;
  /** `preview` until the encrypted body has been fetched and decrypted. */
  bodyState?: "preview" | "loading" | "loaded" | "error";
  /** Encrypted to a key this session can't open (e.g. locked after a password reset). */
  locked?: boolean;
  rfcMessageId?: string | null;
  references?: string[];
  /** A display name that impersonated another sender and was replaced by the real address. */
  hiddenName?: string;
  /** Mac Tidar → Mac Tidar mail, encrypted in the sender's browser. */
  e2e?: boolean;
  /** Result of checking the sender's signature on end-to-end mail. */
  signature?: "verified" | "invalid" | "unverified" | "unsigned";
  deliveryStatus?: "sent" | "delivered" | "bounced" | "complained" | "delayed" | "rejected" | null;
  /** Decrypted HTML body (memory only), shown through the sanitizing viewer. */
  html?: string;
  /** cid → blob: URL for decrypted inline images. */
  inlineUrls?: Record<string, string>;
};

export type Settings = { density: "comfortable" | "compact"; signature: string; notifications: boolean };
export type Mailbox = { messages: Message[]; labels: Label[]; settings: Settings };
