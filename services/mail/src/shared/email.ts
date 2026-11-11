// Branded emails: one layout for everything Mac Tidar Mail sends (domain setup notices, codes,
// invites). Each email is HTML with a plain-text twin. There are never links in our emails, and
// nothing in them is clickable: domain names and DNS values are wrapped so mail apps don't turn
// them into links either, while still copying cleanly.

/** Whose name and logo head the email. `logo` is a URL (a published logo) or "cid:logo" (attached). */
export interface EmailBrand { name: string; logo?: string; /** Shown under the name, e.g. "on Mac Tidar Mail". */ tagline?: string }
export interface EmailRecord { type: string; host: string; value: string; priority?: number; label?: string }
export interface EmailContent {
  /** Shown as the inbox preview line. */
  preview: string;
  title: string;
  /** Paragraphs. `**bold**` and `` `code` `` are supported; everything else is escaped. */
  body: string[];
  /** DNS records, shown as a table. */
  records?: EmailRecord[];
  /** A one-time code, shown large. */
  code?: string;
  /** Short facts shown as label/value rows (address, domain). */
  facts?: [string, string][];
  /** Shown after the records, in muted text. */
  after?: string[];
}

const C = { canvas: "#f4f3ec", card: "#ffffff", line: "#e3e1d6", text: "#14211b", muted: "#5f6b64", brand: "#216b4d", mint: "#e8f6ee", code: "#f1f0e8" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Text that mail apps must not turn into a link (a domain, a DNS value). An anchor with no href
 * isn't clickable, and apps don't auto-link inside one; copying gives exactly the text.
 */
const plain = (s: string, style = "") => `<a style="color:inherit;text-decoration:none;cursor:text;${style}">${escapeHtml(s)}</a>`;

/** `**bold**` and `` `code` `` in an escaped paragraph; any domain-looking text is kept unlinked. */
function inline(s: string): string {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map(part => {
    if (part.startsWith("**") && part.endsWith("**")) return `<strong style="color:${C.text}">${linkless(part.slice(2, -2))}</strong>`;
    if (part.startsWith("`") && part.endsWith("`")) return `<code style="font-family:${MONO};font-size:13px;background:${C.code};padding:1px 5px;border-radius:4px">${plain(part.slice(1, -1))}</code>`;
    return linkless(part);
  }).join("");
}
const DOMAINISH = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s]*)?\b|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const linkless = (s: string) => {
  let out = "", last = 0;
  for (const m of s.matchAll(DOMAINISH)) { out += escapeHtml(s.slice(last, m.index)) + plain(m[0]); last = m.index! + m[0].length; }
  return out + escapeHtml(s.slice(last));
};
const stripMarks = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

function header(brand: EmailBrand): string {
  const logo = brand.logo
    ? `<img src="${escapeHtml(brand.logo)}" alt="" width="44" height="44" style="display:block;width:44px;height:44px;border-radius:10px;object-fit:contain;background:#fff;border:1px solid ${C.line}">`
    : `<div style="width:44px;height:44px;border-radius:10px;background:${C.brand};color:#fff;font:600 20px/44px ${FONT};text-align:center">${escapeHtml(brand.name.slice(0, 1).toUpperCase())}</div>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding-right:12px;vertical-align:middle">${logo}</td>
    <td style="vertical-align:middle;font-family:${FONT}"><div style="font-size:16px;font-weight:700;color:${C.text}">${linkless(brand.name)}</div>
      ${brand.tagline ? `<div style="font-size:12px;color:${C.muted};margin-top:2px">${linkless(brand.tagline)}</div>` : ""}</td>
  </tr></table>`;
}

function recordsTable(records: EmailRecord[]): string {
  // One stacked block per record (type, then name, then value): readable on a phone and on desktop.
  const label = (t: string) => `<div style="font-size:11px;letter-spacing:.3px;text-transform:uppercase;color:${C.muted};margin-top:8px">${t}</div>`;
  const value = (v: string) => `<div style="font:13px/1.45 ${MONO};color:${C.text};background:${C.code};border-radius:6px;padding:6px 8px;margin-top:3px;word-break:break-all">${plain(v)}</div>`;
  const rows = records.map((r, i) => `<tr><td style="padding:12px 14px;${i ? `border-top:1px solid ${C.line};` : ""}">
      <div style="font:600 13px ${FONT};color:${C.text}"><span style="font-family:${MONO};color:${C.brand}">${escapeHtml(r.type)}</span>${r.label ? `<span style="color:${C.muted};font-weight:400"> · ${escapeHtml(r.label)}</span>` : ""}${r.priority !== undefined ? `<span style="color:${C.muted};font-weight:400"> · priority ${r.priority}</span>` : ""}</div>
      ${label("Name")}${value(r.host)}${label("Value")}${value(r.value)}
    </td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:10px;border-collapse:separate;font-family:${FONT};margin:4px 0 16px">${rows}</table>`;
}

/** Renders an email as HTML and plain text. */
export function renderEmail(brand: EmailBrand, c: EmailContent): { html: string; text: string } {
  const p = (s: string, muted = false) => `<p style="margin:0 0 14px;font:${muted ? "13px/1.55" : "15px/1.6"} ${FONT};color:${muted ? C.muted : C.text}">${inline(s)}</p>`;
  const facts = c.facts?.length ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;font-family:${FONT}">${c.facts.map(([k, v]) =>
    `<tr><td style="padding:3px 16px 3px 0;font-size:13px;color:${C.muted}">${escapeHtml(k)}</td><td style="padding:3px 0;font:600 14px ${FONT};color:${C.text}">${plain(v)}</td></tr>`).join("")}</table>` : "";
  const code = c.code ? `<div style="margin:4px 0 18px;padding:14px 18px;background:${C.mint};border-radius:10px;font:700 28px ${MONO};letter-spacing:6px;color:${C.brand};text-align:center">${escapeHtml(c.code)}</div>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(c.title)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(c.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.canvas}"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 16px">${header(brand)}</td></tr>
    <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px;padding:28px 24px">
      <h1 style="margin:0 0 16px;font:700 21px/1.3 ${FONT};color:${C.text}">${inline(c.title)}</h1>
      ${c.body.map(s => p(s)).join("")}${code}${facts}${c.records?.length ? recordsTable(c.records) : ""}${(c.after ?? []).map(s => p(s, true)).join("")}
    </td></tr>
    <tr><td style="padding:16px 8px 0;font:12px/1.6 ${FONT};color:${C.muted};text-align:center">
      Sent by Mac Tidar Mail · end-to-end encrypted email.<br>We never put links in our emails: open ${plain("mail.mactidar.com")} yourself.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    brand.name, "", stripMarks(c.title), "",
    ...c.body.flatMap(s => [stripMarks(s), ""]),
    ...(c.code ? [`    ${c.code}`, ""] : []),
    ...(c.facts ?? []).map(([k, v]) => `${k}: ${v}`), ...(c.facts?.length ? [""] : []),
    ...(c.records ?? []).flatMap(r => [`${r.type}${r.label ? ` (${r.label})` : ""}`, `  Name:  ${r.host}`, `  Value: ${r.priority !== undefined ? `${r.priority} ` : ""}${r.value}`, ""]),
    ...(c.after ?? []).flatMap(s => [stripMarks(s), ""]),
    "--", "Mac Tidar Mail · end-to-end encrypted email. We never put links in our emails: open mail.mactidar.com yourself.",
  ].join("\n");
  return { html, text };
}
