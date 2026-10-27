"use client";

import { useEffect, useRef } from "react";
import { saveSkin, useSkin } from "../skin-store";
import { CommandPalette } from "./command-palette";
import { Composer } from "./composer";
import { ConversationView } from "./conversation-view";
import { Dialogs } from "./dialogs";
import { InboxView, ShortcutBar } from "./inbox-view";
import { Sidebar } from "./sidebar";
import { MAIL_SKINS } from "./skins";
import { liveEnabled } from "./live/config";
import { LiveGate, useLiveSession } from "./live/gate";
import { MailProvider, useMail } from "./store";
import { Topbar } from "./topbar";
import { Icon } from "./ui";

const typing = (el: Element | null) => !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || (el as HTMLElement).isContentEditable);

function Toasts() {
  const { toasts, dismissToast } = useMail();
  return (
    <div className="fixed bottom-4 left-4 z-[90] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} role="status" className="pointer-events-auto flex items-center gap-3 pl-4 pr-2 py-2 rounded-m-xl bg-m-text text-m-card shadow-xl t-body-md max-w-[90vw]">
          <span>{t.text}</span>
          {t.undo && <button type="button" onClick={() => { t.undo!(); dismissToast(t.id); }} className="px-2 py-1 rounded-m-lg font-semibold hover:bg-white/10" style={{ color: "var(--m-sb-cta)" }}>Undo</button>}
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="p-1 rounded-m opacity-70 hover:opacity-100"><Icon name="close" className="text-[16px]" /></button>
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const mail = useMail();
  const { view, collapsed, composer, palette, setDialog, compose, openThread } = mail;
  const skin = useSkin();
  const search = useRef<HTMLInputElement>(null);
  const pendingG = useRef(0);
  const state = useRef(mail);
  useEffect(() => { state.current = mail; });

  // Deep links: ?mode=signin|signup from the homepage, ?thread=<id> from "open in new tab".
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const mode = p.get("mode"), thread = p.get("thread");
    if (!mail.live && (mode === "signin" || mode === "signup")) setDialog({ kind: "auth", mode });
    if (thread) openThread(thread);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = state.current, k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); s.setPalette(p => !p); return; }
      if ((e.metaKey || e.ctrlKey) && k === "d") { e.preventDefault(); const light = MAIL_SKINS.find(x => !x.dark)!.key; saveSkin(document.querySelector(".mail-skin-cyber") ? light : "cyber"); return; }
      if (e.key === "Escape") {
        if (s.palette) s.setPalette(false); else if (s.dialog) s.setDialog(null); else if (s.view.kind === "thread") s.closeThread(); else if (s.selected.length) s.setSelected([]);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement) || s.palette || s.dialog) return;
      const openId = s.view.kind === "thread" ? s.view.thread : null;
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[role=row]");
      const rowEls = () => [...document.querySelectorAll<HTMLElement>("[role=row]")];
      const focusedThread = focused ? s.rows[rowEls().indexOf(focused) + s.page * 50]?.thread : undefined;
      const targets = s.selected.length ? s.selected : openId ? [openId] : focusedThread ? [focusedThread] : [];
      if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const go: Record<string, string> = { i: "inbox", s: "starred", t: "sent", d: "drafts", a: "archive" };
        if (go[k]) { e.preventDefault(); s.setFolder(go[k]); return; }
      }
      switch (e.key) {
        case "c": e.preventDefault(); s.compose(); break;
        case "/": e.preventDefault(); search.current?.focus(); break;
        case "?": s.setDialog({ kind: "shortcuts" }); break;
        case "g": pendingG.current = Date.now(); break;
        case "e": if (targets.length) s.move(targets, "archive"); break;
        case "#": if (targets.length) s.move(targets, "trash"); break;
        case "!": if (targets.length) s.move(targets, "spam"); break;
        case "s": if (openId || focusedThread) s.toggleStar((openId ?? focusedThread)!); break;
        case "u": if (openId) s.closeThread(); break;
        case "r": case "a": if (openId) { e.preventDefault(); window.dispatchEvent(new CustomEvent("mail:reply", { detail: e.key === "a" })); } break;
        case "j": case "k": {
          e.preventDefault();
          const dir = e.key === "j" ? 1 : -1;
          if (openId) { const i = s.rows.findIndex(r => r.thread === openId); const next = s.rows[i + dir]; if (next) s.openThread(next.thread); }
          else { const els = rowEls(); const i = focused ? els.indexOf(focused) : -1; els[Math.max(0, Math.min(els.length - 1, i + dir))]?.focus(); }
          break;
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { document.title = view.kind === "thread" ? `${mail.threadMessages(view.thread).at(-1)?.subject ?? "Conversation"} — Mac Tidar Mail` : "Inbox — Mac Tidar Mail"; }, [view, mail]);

  return (
    <div className={`mail-root mail-skin-${skin} bg-m-canvas text-m-text t-body-md antialiased min-h-dvh`}>
      <Sidebar />
      <div className={`min-h-dvh flex flex-col bg-m-canvas transition-[padding] ${collapsed ? "lg:pl-0" : "lg:pl-64"}`}>
        <Topbar searchRef={search} />
        <main className="pt-14 h-dvh flex flex-col w-full">
          {view.kind === "thread"
            ? <div className="flex-1 overflow-y-auto bg-m-canvas"><ConversationView key={view.thread} thread={view.thread} /></div>
            : <div className="flex-1 min-h-0"><InboxView /></div>}
          <ShortcutBar />
        </main>
      </div>
      <Composer />
      {palette && <CommandPalette focusSearch={() => search.current?.focus()} />}
      <Dialogs />
      <Toasts />
      {!composer.open && <button type="button" onClick={() => compose()} aria-label="Compose" className="lg:hidden fixed right-4 bottom-4 z-40 w-14 h-14 rounded-2xl bg-m-brand text-m-on-brand shadow-xl flex items-center justify-center"><Icon name="edit_square" /></button>}
    </div>
  );
}

function LiveMail() {
  const live = useLiveSession();
  return <MailProvider live={live}><Shell /></MailProvider>;
}

export default function MailApp() {
  if (liveEnabled) return <LiveGate><LiveMail /></LiveGate>;
  return <MailProvider><Shell /></MailProvider>;
}
