// Decisions taken on arrival, from SES verdicts and plaintext headers that are visible to
// any mail server anyway. Content is never inspected here.
import type { Category, Folder } from "../shared/table";

export type Verdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "DISABLED" | string;
export interface Verdicts { spam: Verdict; virus: Verdict; spf: Verdict; dkim: Verdict; dmarc: Verdict }

export type Disposition = { action: "store"; folder: Folder } | { action: "drop"; reason: "virus" | "spoofed-local-sender" };

const domainOf = (address: string) => address.split("@").pop()?.toLowerCase() ?? "";

/**
 * - Virus → drop.
 * - Claims to be from one of our own domains but fails DMARC → drop (spoofing).
 * - Spam or DMARC failure → Spam folder.
 * - Anything else → Inbox.
 */
export function decide(verdicts: Verdicts, fromAddress: string, localDomains: string[]): Disposition {
  if (verdicts.virus === "FAIL") return { action: "drop", reason: "virus" };
  const from = domainOf(fromAddress);
  const local = localDomains.some(d => from === d || from.endsWith(`.${d}`));
  if (local && verdicts.dmarc !== "PASS") return { action: "drop", reason: "spoofed-local-sender" };
  if (verdicts.spam === "FAIL" || verdicts.dmarc === "FAIL") return { action: "store", folder: "spam" };
  return { action: "store", folder: "inbox" };
}

/** Inbox tab, from standard list/automation headers only. */
export function categorize(headers: Map<string, unknown>, fromAddress: string): Category {
  if (headers.has("list-unsubscribe") || headers.has("list-id")) return "newsletters";
  const precedence = String(headers.get("precedence") ?? "").toLowerCase();
  const auto = String(headers.get("auto-submitted") ?? "").toLowerCase();
  if (precedence === "bulk" || precedence === "list" || (auto && auto !== "no")) return "updates";
  if (/^(no-?reply|notifications?|alerts?|billing|invoices?|updates?)@/i.test(fromAddress)) return "updates";
  return "primary";
}
