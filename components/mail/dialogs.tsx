"use client";

import { ReactNode, useEffect, useState } from "react";
import { mailApi, type DomainView, type PersonView } from "./live/api";
import { saveSkin, useSkin } from "../skin-store";
import { MAIL_SKINS } from "./skins";
import { useMail } from "./store";
import { Icon, IconButton } from "./ui";

function Modal({ title, onClose, children, width = "max-w-lg" }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className={`w-full ${width} max-h-[90dvh] flex flex-col bg-m-card rounded-m-xl shadow-2xl border border-m-line overflow-hidden`} role="dialog" aria-modal="true">
        <div className="h-12 px-space-md flex items-center justify-between bg-m-low shrink-0">
          <b className="t-headline-sm text-m-text">{title}</b>
          <IconButton icon="close" title="Close" size="text-[18px]" onClick={onClose} />
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

const Row = ({ title, text, children }: { title: string; text: string; children?: ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-3 border-b border-m-line last:border-0">
    <div><b className="block t-headline-sm text-m-text">{title}</b><p className="t-body-sm text-m-muted mt-0.5">{text}</p></div>{children}
  </div>
);
const Btn = ({ children, onClick, tone = "plain" }: { children: ReactNode; onClick: () => void; tone?: "plain" | "brand" | "danger" }) => (
  <button type="button" onClick={onClick} className={`px-3 py-1.5 rounded-m-lg t-headline-sm whitespace-nowrap transition-colors ${tone === "brand" ? "bg-m-brand text-m-on-brand hover:bg-m-brand-hover" : tone === "danger" ? "bg-m-error-soft text-m-on-error-soft hover:brightness-95" : "bg-m-low text-m-text hover:bg-m-mid"}`}>{children}</button>
);

const STATUS: Record<DomainView["status"], [string, string]> = {
  pending: ["Waiting for DNS records", "bg-m-low text-m-muted"],
  active: ["Working", "bg-m-success/15 text-m-success"],
  suspended: ["Not working", "bg-m-error-soft text-m-on-error-soft"],
};
const PURPOSE: Record<string, string> = { DKIM: "Proves you own the domain and signs your mail", MX: "Delivers mail for the domain to Mac Tidar Mail", SPF: "Lets receivers trust mail we send for you", DMARC: "Tells receivers what to do with forged mail" };

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title="Copy" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}
      className="group inline-flex items-start gap-1 text-left t-code text-m-text break-all hover:text-m-brand">
      <span>{text}</span><Icon name={done ? "check" : "content_copy"} className="text-[14px] shrink-0 mt-0.5 text-m-muted group-hover:text-m-brand" />
    </button>
  );
}

function DomainCard({ d, onChange, onRemoved }: { d: DomainView; onChange: (d: DomainView) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(d.status !== "active");
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); } };
  const [label, tone] = STATUS[d.status];
  const allGood = Object.values(d.checks).every(Boolean);
  return (
    <div className="rounded-m-lg border border-m-line p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="min-w-0"><b className="t-headline-sm text-m-text">{d.domain}</b> <span className="t-body-sm text-m-muted">· {d.displayName}</span></div>
        <span className={`px-2 py-0.5 rounded-m-pill t-label-sm font-semibold ${tone}`}>{label}</span>
      </div>
      <p className="t-body-sm text-m-muted">
        {d.status === "pending" && <>Add the records below at the company where you manage DNS for {d.domain}, then choose Check now. Changes can take up to a few hours to show.{d.expiresAt && <> If it isn’t finished by {new Date(d.expiresAt).toLocaleDateString()}, the domain is released and you can start again.</>}</>}
        {d.status === "active" && <>Mail for {d.domain} works with Mac Tidar Mail.{!allGood && " Add the remaining records so mail you send is trusted."}</>}
        {d.status === "suspended" && (d.suspendedFor === "abuse" ? "Sending is paused for this domain. Contact us to sort it out." : `Some records Mac Tidar Mail needs are missing or changed, so mail for ${d.domain} isn’t working. It starts again by itself once they’re back.`)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Btn tone="brand" onClick={() => { if (!busy) void act(async () => onChange(await mailApi.checkDomain(d.domain))); }}>{busy ? "Checking…" : "Check now"}</Btn>
        <Btn onClick={() => setOpen(!open)}>{open ? "Hide DNS records" : "Show DNS records"}</Btn>
        <Btn tone="danger" onClick={() => { if (!busy && confirm(`Disconnect ${d.domain} from Mac Tidar Mail?`)) void act(async () => { await mailApi.removeDomain(d.domain); onRemoved(); }); }}>Disconnect</Btn>
      </div>
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
      {d.status === "active" && <People domain={d.domain} />}
      {open && (
        <div className="space-y-2">
          <p className="t-body-sm text-m-muted">Names are shown the way most DNS providers want them (“@” means {d.domain} itself). If yours asks for the full name, add <span className="t-code">.{d.domain}</span>. If {d.domain} already has a record starting <span className="t-code">v=spf1</span>, add <span className="t-code">include:amazonses.com</span> to it instead of adding a second one.</p>
          <div className="overflow-x-auto">
            <table className="w-full t-body-sm">
              <thead><tr className="text-left text-m-muted"><th className="py-1 pr-2 font-medium">Type</th><th className="py-1 pr-2 font-medium">Name</th><th className="py-1 pr-2 font-medium">Value</th><th className="py-1 font-medium sr-only">Status</th></tr></thead>
              <tbody>{d.records.map(r => (
                <tr key={r.name + r.value} className="border-t border-m-line align-top" title={PURPOSE[r.purpose]}>
                  <td className="py-2 pr-2 t-code text-m-muted whitespace-nowrap">{r.type}</td>
                  <td className="py-2 pr-2 min-w-[7rem]"><CopyText text={r.host} /></td>
                  <td className="py-2 pr-2 min-w-[12rem]">{r.priority !== undefined && <span className="t-code text-m-muted">priority {r.priority} · </span>}<CopyText text={r.value} /></td>
                  <td className="py-2"><Icon name={d.checks[r.check] ? "check_circle" : "radio_button_unchecked"} className={`text-[18px] ${d.checks[r.check] ? "text-m-success" : "text-m-muted"}`} /><span className="sr-only">{d.checks[r.check] ? "Found" : "Not found yet"}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {d.checkedAt && <p className="t-label-sm text-m-muted">Last checked {new Date(d.checkedAt).toLocaleString()}</p>}
        </div>
      )}
    </div>
  );
}

// The people on a domain: add (Cognito emails them an invite), resend, remove.
function People({ domain }: { domain: string }) {
  const [list, setList] = useState<{ people: PersonView[]; limit: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ localPart: "", givenName: "", familyName: "", backupEmail: "" });
  useEffect(() => { mailApi.people(domain).then(setList, e => setError(e instanceof Error ? e.message : "Couldn’t load people.")); }, [domain]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); } };
  if (!list) return <p className="t-body-sm text-m-muted">{error || "Loading people…"}</p>;
  const input = "w-full px-3 py-2 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30";
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between"><b className="t-headline-sm text-m-text">People ({list.people.length}/{list.limit})</b>
        {!adding && list.people.length < list.limit && <Btn tone="brand" onClick={() => setAdding(true)}>Add person</Btn>}</div>
      {list.people.length === 0 && !adding && <p className="t-body-sm text-m-muted">Nobody has an address on {domain} yet.</p>}
      {list.people.map(x => (
        <div key={x.address} className="flex flex-wrap items-center justify-between gap-2 py-2 border-t border-m-line">
          <div className="min-w-0"><b className="block t-body-md text-m-text truncate">{x.givenName} {x.familyName}</b><span className="t-body-sm text-m-muted break-all">{x.address}{x.status === "invited" ? ` · invited (${x.backupEmail})` : ""}</span></div>
          <div className="flex gap-2">
            {x.status === "invited" && <Btn onClick={() => { if (!busy) void act(async () => { await mailApi.resendInvite(domain, x.address); alert(`Invite sent again to ${x.backupEmail}.`); }); }}>Resend invite</Btn>}
            <Btn tone="danger" onClick={() => {
              if (!busy && confirm(`Remove ${x.address}?\n\nTheir sign-in stops now, and their mailbox and all its mail are deleted for good. This can’t be undone.`))
                void act(async () => { await mailApi.removePerson(domain, x.address); setList({ ...list, people: list.people.filter(y => y.address !== x.address) }); });
            }}>Remove</Btn>
          </div>
        </div>
      ))}
      {adding && (
        <form className="rounded-m-lg bg-m-low/50 p-3 space-y-3" onSubmit={e => { e.preventDefault(); if (!busy) void act(async () => {
          const p = await mailApi.addPerson(domain, form);
          setList({ ...list, people: [...list.people, p] }); setForm({ localPart: "", givenName: "", familyName: "", backupEmail: "" }); setAdding(false);
        }); }}>
          <div className="grid sm:grid-cols-2 gap-3">
            <label><span className="t-label-sm text-m-muted block mb-1">First name</span><input value={form.givenName} onChange={set("givenName")} required maxLength={40} className={input} /></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Last name</span><input value={form.familyName} onChange={set("familyName")} required maxLength={40} className={input} /></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Address</span>
              <span className="flex items-center gap-1"><input value={form.localPart} onChange={set("localPart")} required placeholder="ana" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={input} /><span className="t-body-md text-m-muted whitespace-nowrap">@{domain}</span></span></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Their backup email</span><input type="email" value={form.backupEmail} onChange={set("backupEmail")} required placeholder="them@gmail.com" className={input} /></label>
          </div>
          <p className="t-body-sm text-m-muted">We’ll email them an invite at their backup email with a temporary password. They choose their own password when they first sign in. You won’t be able to read their mail, and only they can reset their password.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-brand text-m-on-brand hover:bg-m-brand-hover disabled:opacity-60">{busy ? "Adding…" : "Add and send invite"}</button>
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-low text-m-text hover:bg-m-mid">Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
    </div>
  );
}

// Bring your own domain: connect it, add the DNS records shown, and it starts working.
function DomainsSettings() {
  const [list, setList] = useState<{ domains: DomainView[]; limit: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  useEffect(() => { mailApi.domains().then(setList, e => setError(e instanceof Error ? e.message : "Couldn’t load your domains.")); }, []);
  if (!list) return <p className="t-body-md text-m-muted">{error || "Loading…"}</p>;
  const replace = (d: DomainView) => setList({ ...list, domains: list.domains.map(x => x.domain === d.domain ? d : x) });
  const connect = async () => {
    setBusy(true); setError("");
    try { const d = await mailApi.connectDomain(domain, name); setList({ ...list, domains: [...list.domains, d] }); setDomain(""); setName(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };
  const input = "w-full px-3 py-2 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30";
  return (
    <div className="space-y-4">
      <p className="t-body-sm text-m-muted">Use your own domain, like yourcompany.com, with Mac Tidar Mail. Mail stays zero-access encrypted: you’ll manage who has an address, but you can’t read their mail.</p>
      {list.domains.map(d => <DomainCard key={d.domain} d={d} onChange={replace} onRemoved={() => setList({ ...list, domains: list.domains.filter(x => x.domain !== d.domain) })} />)}
      {list.domains.length < list.limit ? (
        <form className="rounded-m-lg border border-dashed border-m-line p-3 space-y-3" onSubmit={e => { e.preventDefault(); if (!busy) void connect(); }}>
          <b className="block t-headline-sm text-m-text">Connect a domain</b>
          <div className="grid sm:grid-cols-2 gap-3">
            <label><span className="t-label-sm text-m-muted block mb-1">Domain</span><input value={domain} onChange={e => setDomain(e.target.value)} placeholder="yourcompany.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} required className={input} /></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Name people see (optional)</span><input value={name} onChange={e => setName(e.target.value)} placeholder="Your Company" maxLength={40} className={input} /></label>
          </div>
          <button type="submit" disabled={busy} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-brand text-m-on-brand hover:bg-m-brand-hover disabled:opacity-60">{busy ? "Connecting…" : "Connect"}</button>
        </form>
      ) : <p className="t-body-sm text-m-muted">You can connect up to {list.limit} domains for now.</p>}
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["C", "Compose a message"], ["/", "Focus search"], ["⌘ K", "Open the command palette"], ["J / K", "Older / newer conversation"], ["Enter", "Open the focused conversation"],
  ["E", "Archive selected or open conversation"], ["#", "Delete selected or open conversation"], ["S", "Star the open conversation"], ["R", "Reply"], ["A", "Reply all"],
  ["U", "Back to the list"], ["G then I", "Go to Inbox"], ["⌘ ↵", "Send"], ["Esc", "Close dialogs and menus"], ["?", "Show this list"],
];

function Shortcuts() {
  return <div className="grid sm:grid-cols-2 gap-x-6">{SHORTCUTS.map(([k, t]) => (
    <div key={k} className="flex items-center justify-between gap-3 py-2 border-b border-m-line/70">
      <span className="t-body-md text-m-text">{t}</span><kbd className="px-1.5 py-0.5 rounded-m bg-m-low text-m-muted t-code whitespace-nowrap">{k}</kbd>
    </div>
  ))}</div>;
}

const TABS = ["General", "Appearance", "Accounts", "Domains", "Signatures", "Keyboard shortcuts", "Storage", "About"];

function SettingsDialog({ initial }: { initial?: string }) {
  const { setDialog, box, updateSettings, emptyTrash, live } = useMail();
  const [tab, setTab] = useState(initial && TABS.includes(initial) ? initial : "General");
  const skin = useSkin();
  const s = box.settings;
  const close = () => setDialog(null);
  const trash = box.messages.filter(m => m.folder === "trash").length;
  return (
    <Modal title="Settings" onClose={close} width="max-w-3xl">
      <div className="flex flex-col sm:flex-row min-h-[420px]">
        <nav className="sm:w-48 shrink-0 p-2 flex sm:flex-col gap-0.5 overflow-x-auto bg-m-low/50 border-b sm:border-b-0 sm:border-r border-m-line">
          {TABS.map(t => <button key={t} type="button" onClick={() => setTab(t)} className={`text-left px-3 py-1.5 rounded-m-lg t-body-md whitespace-nowrap ${tab === t ? "bg-m-high text-m-text font-medium" : "text-m-muted hover:bg-m-mid hover:text-m-text"}`}>{t}</button>)}
        </nav>
        <div className="flex-1 p-space-lg">
          {tab === "General" && <>
            <Row title="Inbox density" text="Comfortable or compact conversation rows.">
              <select value={s.density} onChange={e => updateSettings({ density: e.target.value as typeof s.density })} className="bg-m-low text-m-text rounded-m-lg px-2 py-1.5 t-body-md border border-m-line">
                <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
              </select>
            </Row>
          </>}
          {tab === "Appearance" && <div className="grid sm:grid-cols-2 gap-2">
            {MAIL_SKINS.map(k => (
              <button key={k.key} type="button" onClick={() => saveSkin(k.key)} className={`flex items-center gap-3 p-3 rounded-m-xl border text-left transition-colors ${k.key === skin ? "border-m-brand bg-m-brand-soft" : "border-m-line hover:bg-m-low"}`}>
                <span className="flex -space-x-1.5">{k.swatch.map(c => <i key={c} className="w-5 h-5 rounded-full border-2 border-m-card" style={{ background: c }} />)}</span>
                <span className="flex-1"><b className="block t-headline-sm text-m-text">{k.name}</b><span className="t-label-sm text-m-muted">{k.note}{k.dark ? " · Dark" : ""}</span></span>
                {k.key === skin && <Icon name="check_circle" className="text-[18px] text-m-primary" fill />}
              </button>
            ))}
            <p className="sm:col-span-2 t-body-sm text-m-muted pt-2">Your skin is shared with the Mac Tidar homepage.</p>
          </div>}
          {tab === "Accounts" && <>
            <Row title={live.displayName} text={`${live.address} · zero-access encrypted`}><Btn onClick={() => { close(); void live.signOut(); }}>Sign out</Btn></Row>
            {live.switchMailbox && <Row title="Other mailboxes" text="Open another mailbox on this account. You’ll enter your password to unlock it."><Btn onClick={() => { close(); live.switchMailbox?.(); }}>Switch mailbox</Btn></Row>}
            <Row title="Recover older mail" text={live.lockedKeys ? `${live.lockedKeys} older key${live.lockedKeys > 1 ? "s are" : " is"} locked after a password reset.` : "All of your keys are unlocked."}>{live.lockedKeys > 0 && <Btn tone="brand" onClick={() => { close(); live.openRecovery(); }}>Recover</Btn>}</Row>
            <p className="t-body-sm text-m-muted pt-3">Your mail is encrypted with a key only you hold. Mac Tidar cannot read it or reset it for you — keep your recovery file safe.</p>
          </>}
          {tab === "Domains" && <DomainsSettings />}
          {tab === "Signatures" && <label className="block">
            <b className="block t-headline-sm text-m-text">Default signature</b><span className="t-body-sm text-m-muted">Added to new messages and replies.</span>
            <textarea value={s.signature} onChange={e => updateSettings({ signature: e.target.value })} rows={5} className="mt-3 w-full p-3 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
          </label>}
          {tab === "Keyboard shortcuts" && <Shortcuts />}
          {tab === "Storage" && <>
            <Row title="Trash" text={trash ? `${trash} message${trash > 1 ? "s" : ""} in Trash. Emptying deletes them for good.` : "Trash is empty."}><Btn onClick={() => { if (!trash || confirm("Delete everything in Trash forever? This can’t be undone.")) { emptyTrash(); close(); } }}>Empty Trash{trash ? ` (${trash})` : ""}</Btn></Row>
          </>}
          {tab === "About" && <div className="space-y-2">
            <b className="t-headline-md text-m-text">Mac Tidar Mail</b>
            <p className="t-body-md text-m-muted">Zero-access encrypted email for @mactidar.com. Your mail, drafts, labels and settings are encrypted in this browser with a key only you hold; Mac Tidar can’t read them.</p>
          </div>}
        </div>
      </div>
    </Modal>
  );
}

function LabelDialog() {
  const { setDialog, createLabel } = useMail();
  const [name, setName] = useState("");
  const submit = () => { if (createLabel(name)) setDialog(null); };
  return (
    <Modal title="New label" onClose={() => setDialog(null)} width="max-w-sm">
      <form className="p-space-lg space-y-4" onSubmit={e => { e.preventDefault(); submit(); }}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Label name" aria-label="Label name" maxLength={32}
          className="w-full px-3 py-2 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
        <div className="flex justify-end gap-2"><Btn onClick={() => setDialog(null)}>Cancel</Btn><Btn tone="brand" onClick={submit}>Create</Btn></div>
      </form>
    </Modal>
  );
}

export function Dialogs() {
  const { dialog, setDialog } = useMail();
  if (!dialog) return null;
  if (dialog.kind === "settings") return <SettingsDialog initial={dialog.tab} />;
  if (dialog.kind === "shortcuts") return <Modal title="Keyboard shortcuts" onClose={() => setDialog(null)} width="max-w-2xl"><div className="p-space-lg"><Shortcuts /></div></Modal>;
  return <LabelDialog />;
}
