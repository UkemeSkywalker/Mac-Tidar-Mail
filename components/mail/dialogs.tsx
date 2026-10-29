"use client";

import { ReactNode, useEffect, useState } from "react";
import { getCurrentUser, setUpTOTP, verifyTOTPSetup } from "./live/auth";
import { mailApi } from "./live/api";
import { cleanCode } from "./live/mfa";
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

type Mfa = { totp: boolean; email: boolean };
const failText = (e: unknown) => {
  const name = e instanceof Error ? e.name : "";
  if (name === "CodeMismatchException" || name === "EnableSoftwareTokenMFAException") return "That code isn’t right. Check your authenticator app and try again.";
  return e instanceof Error ? e.message : "Something went wrong.";
};

// Two-step verification is optional. The authenticator secret goes browser ↔ Cognito only; our
// API just switches methods on and off, so every change emails the backup address.
function SecuritySettings({ onSignOutEverywhere }: { onSignOutEverywhere: () => void }) {
  const [mfa, setMfa] = useState<Mfa | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => { mailApi.mfa().then(setMfa, e => setError(failText(e))); }, []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(failText(e)); } finally { setBusy(false); }
  };
  const change = (next: Partial<Mfa>) => act(async () => setMfa(await mailApi.setMfa(next)));
  const startSetup = () => act(async () => {
    const [details, { username }, QR] = await Promise.all([setUpTOTP(), getCurrentUser(), import("qrcode")]);
    const uri = details.getSetupUri("Mac Tidar Mail", username).toString();
    setSetup({ qr: await QR.toDataURL(uri, { margin: 1, width: 192 }), secret: details.sharedSecret });
    setCode("");
  });
  const finishSetup = () => act(async () => {
    await verifyTOTPSetup({ code: cleanCode(code) });
    setMfa(await mailApi.setMfa({ totp: true }));
    setSetup(null);
  });
  const turnOff = (method: keyof Mfa, label: string) => {
    if (!mfa) return;
    const left = method === "totp" ? mfa.email : mfa.totp;
    if (confirm(`Turn off ${label}?${left ? "" : " Signing in will only need your password."}`)) void change({ [method]: false });
  };

  if (!mfa) return <p className="t-body-md text-m-muted">{error || "Loading…"}</p>;
  if (setup) return (
    <div className="space-y-4">
      <b className="block t-headline-sm text-m-text">Set up an authenticator app</b>
      <ol className="t-body-md text-m-muted list-decimal pl-5 space-y-1">
        <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>Scan this code, or enter the setup key by hand.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col sm:flex-row gap-4 items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn in this browser */}
        <img src={setup.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-m-lg border border-m-line bg-white" />
        <div className="space-y-2 min-w-0">
          <span className="t-label-sm text-m-muted block">Setup key</span>
          <code className="block t-code text-m-text break-all select-all bg-m-low rounded-m p-2">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          <p className="t-body-sm text-m-muted">Keep this private: anyone with it can make your codes.</p>
        </div>
      </div>
      <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); void finishSetup(); }}>
        <label className="flex-1"><span className="t-label-sm text-m-muted block mb-1">Code from the app</span>
          <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required className="w-full px-3 py-2 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
        </label>
        <button type="submit" disabled={busy} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-brand text-m-on-brand hover:bg-m-brand-hover disabled:opacity-60">Turn on</button>
        <button type="button" onClick={() => setSetup(null)} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-low text-m-text hover:bg-m-mid">Cancel</button>
      </form>
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
    </div>
  );
  return (
    <>
      <p className="t-body-sm text-m-muted pb-2">Two-step verification is optional. When it’s on, signing in needs your password and a code.</p>
      <Row title={`Authenticator app${mfa.totp ? " · on" : ""}`} text="Recommended. A code from an app on your phone each time you sign in.">
        {mfa.totp ? <Btn onClick={() => turnOff("totp", "the authenticator app")}>Turn off</Btn> : <Btn tone="brand" onClick={() => { if (!busy) void startSetup(); }}>Set up</Btn>}
      </Row>
      <Row title={`Email codes${mfa.email ? " · on" : ""}`} text="A code sent to your backup email. Handy if you lose your phone, but weaker than the app: the same inbox can also reset your password.">
        {mfa.email ? <Btn onClick={() => turnOff("email", "email codes")}>Turn off</Btn> : <Btn onClick={() => { if (!busy) void change({ email: true }); }}>Turn on</Btn>}
      </Row>
      <Row title="Security alerts" text="We email your backup address when two-step verification changes, your password is reset, or you sign out of all devices." />
      <Row title="Signed-in devices" text="Ends every sign-in, on every device, including this one.">
        <Btn tone="danger" onClick={() => { if (confirm("Sign out of Mac Tidar Mail on every device, including this one?")) onSignOutEverywhere(); }}>Sign out of all devices</Btn>
      </Row>
      {error && <p className="t-body-sm text-m-error pt-2" role="alert">{error}</p>}
    </>
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

const TABS = ["General", "Appearance", "Accounts", "Security", "Signatures", "Keyboard shortcuts", "Storage", "About"];

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
          {tab === "Security" && <SecuritySettings onSignOutEverywhere={() => { close(); void live.signOutEverywhere(); }} />}
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
