"use client";

import { ReactNode, useState } from "react";
import { saveSkin, useSkin } from "../skin-store";
import { accounts } from "./data";
import { MAIL_SKINS } from "./skins";
import { useMail } from "./store";
import { Avatar, Icon, IconButton } from "./ui";

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
const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
    className={`w-10 h-6 rounded-full p-0.5 transition-colors shrink-0 ${checked ? "bg-m-brand" : "bg-m-high"}`}>
    <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
  </button>
);
const Btn = ({ children, onClick, tone = "plain" }: { children: ReactNode; onClick: () => void; tone?: "plain" | "brand" | "danger" }) => (
  <button type="button" onClick={onClick} className={`px-3 py-1.5 rounded-m-lg t-headline-sm whitespace-nowrap transition-colors ${tone === "brand" ? "bg-m-brand text-m-on-brand hover:bg-m-brand-hover" : tone === "danger" ? "bg-m-error-soft text-m-on-error-soft hover:brightness-95" : "bg-m-low text-m-text hover:bg-m-mid"}`}>{children}</button>
);

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

const TABS = ["General", "Appearance", "Accounts", "Signatures", "Notifications", "Keyboard shortcuts", "Storage", "About"];

function SettingsDialog({ initial }: { initial?: string }) {
  const { setDialog, box, account, updateSettings, resetAccount, switchAccount, emptyTrash, toast, live } = useMail();
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
            {!live && <Row title="Reset demo workspace" text="Restore the original demo mail, labels and settings for this account."><Btn tone="danger" onClick={() => { if (confirm("Reset this demo account? Your local changes will be lost.")) { resetAccount(); close(); } }}>Reset demo</Btn></Row>}
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
          {tab === "Accounts" && live && <>
            <Row title={live.displayName} text={`${live.address} · zero-access encrypted`}><Btn onClick={() => { close(); void live.signOut(); }}>Sign out</Btn></Row>
            <Row title="Recover older mail" text={live.lockedKeys ? `${live.lockedKeys} older key${live.lockedKeys > 1 ? "s are" : " is"} locked after a password reset.` : "All of your keys are unlocked."}>{live.lockedKeys > 0 && <Btn tone="brand" onClick={() => { close(); live.openRecovery(); }}>Recover</Btn>}</Row>
            <p className="t-body-sm text-m-muted pt-3">Your mail is encrypted with a key only you hold. Mac Tidar cannot read it or reset it for you — keep your recovery file safe.</p>
          </>}
          {tab === "Accounts" && !live && <>
            {accounts.map(a => (
              <div key={a.email} className="flex items-center justify-between gap-3 py-3 border-b border-m-line last:border-0">
                <span className="flex items-center gap-3 min-w-0"><Avatar person={a} /><span className="min-w-0"><b className="block t-headline-sm text-m-text truncate">{a.name}</b><span className="t-body-sm text-m-muted">{a.email}</span></span></span>
                {a.email === account.email ? <span className="t-label-sm text-m-primary font-semibold">Signed in</span> : <Btn onClick={() => { switchAccount(a.email); close(); }}>Switch</Btn>}
              </div>
            ))}
            <p className="t-body-sm text-m-muted pt-3">Authentication is simulated locally. No real credentials or emails are used.</p>
          </>}
          {tab === "Signatures" && <label className="block">
            <b className="block t-headline-sm text-m-text">Default signature</b><span className="t-body-sm text-m-muted">Added to new messages and replies.</span>
            <textarea value={s.signature} onChange={e => updateSettings({ signature: e.target.value })} rows={5} className="mt-3 w-full p-3 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
          </label>}
          {tab === "Notifications" && <Row title="Desktop notifications" text="Show demo alerts for mail activity in this browser."><Toggle label="Desktop notifications" checked={s.notifications} onChange={v => updateSettings({ notifications: v })} /></Row>}
          {tab === "Keyboard shortcuts" && <Shortcuts />}
          {tab === "Storage" && <>
            <Row title="4.2 GB of 15 GB used" text="Storage figures are representative demo data."><Btn onClick={() => { emptyTrash(); close(); }}>Empty Trash{trash ? ` (${trash})` : ""}</Btn></Row>
            <div className="w-full h-2 bg-m-high rounded-full overflow-hidden mt-2"><div className="h-full w-[28%] bg-m-brand rounded-full" /></div>
          </>}
          {tab === "About" && <div className="space-y-2">
            <b className="t-headline-md text-m-text">Mac Tidar Mail</b>
            <p className="t-body-md text-m-muted">An interactive prototype for the Mac Tidar Suite. Mail, drafts and settings are stored only in this browser — nothing is delivered externally.</p>
            <Btn onClick={() => { toast("Mac Tidar Mail v2.14.0 · demo build"); }}>Check for updates</Btn>
          </div>}
        </div>
      </div>
    </Modal>
  );
}

function AuthDialog({ mode }: { mode: "signin" | "signup" }) {
  const { setDialog, switchAccount, account } = useMail();
  const finish = (email: string) => {
    if (email !== account.email) switchAccount(email);
    setDialog(null);
    history.replaceState({}, "", location.pathname);
  };
  return (
    <Modal title="Mac Tidar Account" onClose={() => finish(account.email)} width="max-w-md">
      <div className="p-space-lg">
        <span className="w-11 h-11 rounded-m-xl bg-m-brand text-m-on-brand flex items-center justify-center mb-4"><Icon name="mail" className="text-[22px]" /></span>
        <h2 className="t-headline-lg text-m-text">{mode === "signup" ? "Create your demo account" : "Welcome back"}</h2>
        <p className="t-body-md text-m-muted mt-1">{mode === "signup" ? "Choose one of the local demo accounts to begin exploring Mac Tidar Mail." : "Select a local demo account to continue. No password is collected or stored."}</p>
        <div className="grid gap-2 mt-5">
          {accounts.slice(0, 3).map(a => (
            <button key={a.email} type="button" onClick={() => finish(a.email)} className="flex items-center gap-3 p-3 rounded-m-xl border border-m-line hover:bg-m-low hover:border-m-brand/40 text-left transition-colors">
              <Avatar person={a} /><span className="flex-1 min-w-0"><b className="block t-headline-sm text-m-text">{a.name}</b><span className="t-body-sm text-m-muted">{a.email}</span></span><Icon name="arrow_forward" className="text-[18px] text-m-muted" />
            </button>
          ))}
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
  if (dialog.kind === "auth") return <AuthDialog mode={dialog.mode} />;
  return <LabelDialog />;
}
