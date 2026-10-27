// Small checks that protect the reader from content the server can't inspect
// (end-to-end mail is never scanned) or that the sender fully controls.

/** Files that run code when opened. Senders can't attach them; received ones need an explicit confirm. */
const RISKY_FILE = /\.(exe|com|bat|cmd|scr|pif|vbs|vbe|js|jse|wsf|wsh|msi|msp|jar|ps1|psm1|hta|cpl|lnk|reg|dll|iso|img|vhd|vhdx|docm|xlsm|pptm|html?|svg)$/i;
export const isRiskyFile = (name: string) => RISKY_FILE.test(name.trim());

const EMAIL_IN_TEXT = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,}/gi;
const isMacTidar = (email: string) => /(^|\.)mactidar\.com$/i.test(email.split("@")[1] ?? "");

/**
 * True when a display name pretends to be someone else: it contains a different email
 * address ("support@bank.com" <x@evil.com>) or claims to be Mac Tidar from outside Mac Tidar.
 */
export function misleadingName(name: string, email: string): boolean {
  const addr = email.toLowerCase();
  if ((name.match(EMAIL_IN_TEXT) ?? []).some(a => a.toLowerCase() !== addr)) return true;
  return !isMacTidar(addr) && /mac\s*-?\s*tidar/i.test(name);
}
