"use client";

import { useMemo, useState } from "react";
import { saveSkin, useSkin } from "../skin-store";
import { accounts } from "./data";
import { MAIL_SKINS } from "./skins";
import { useMail } from "./store";
import { Icon } from "./ui";

type Command = { id: string; label: string; hint?: string; icon: string; group: string; run: () => void };

export function CommandPalette({ focusSearch }: { focusSearch: () => void }) {
  const mail = useMail();
  const { setPalette, compose, setFolder, setQuery, setDialog, switchAccount, account, box, openThread, setFilters } = mail;
  const skin = useSkin();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const lastLight = MAIL_SKINS.find(s => !s.dark && s.key !== skin)?.key ?? "forest";
  const nextAccount = accounts.find(a => a.email !== account.email)!;
  const done = (fn: () => void) => () => { setPalette(false); fn(); };

  const commands = useMemo<Command[]>(() => [
    { id: "compose", label: "Compose", hint: "C", icon: "edit_square", group: "Actions", run: done(() => compose()) },
    { id: "search", label: "Search", hint: "/", icon: "search", group: "Actions", run: done(focusSearch) },
    { id: "inbox", label: "Go Inbox", hint: "G I", icon: "inbox", group: "Actions", run: done(() => setFolder("inbox")) },
    { id: "theme", label: "Toggle Theme", hint: "⌘D", icon: "dark_mode", group: "Actions", run: done(() => saveSkin(skin === "cyber" ? lastLight : "cyber")) },
    { id: "account", label: nextAccount.email, icon: "switch_account", group: "Actions", run: done(() => switchAccount(nextAccount.email)) },
    ...(["starred", "snoozed", "sent", "drafts", "scheduled", "archive", "spam", "trash"] as const).map(f => ({ id: `go-${f}`, label: `Go to ${f[0].toUpperCase()}${f.slice(1)}`, icon: "folder_open", group: "Navigate", run: done(() => setFolder(f)) })),
    ...box.labels.map(l => ({ id: `label-${l.name}`, label: `Open label: ${l.name}`, icon: "label", group: "Navigate", run: done(() => setFolder(`label:${l.name}`)) })),
    { id: "unread", label: "Show unread mail", icon: "mark_email_unread", group: "Filters", run: done(() => { setFolder("inbox"); setFilters({ unread: true }); }) },
    { id: "attach", label: "Show mail with attachments", icon: "attach_file", group: "Filters", run: done(() => setFilters({ attachments: true })) },
    ...MAIL_SKINS.map(s => ({ id: `skin-${s.key}`, label: `Skin: ${s.name}`, hint: s.key === skin ? "✓" : undefined, icon: "palette", group: "Appearance", run: done(() => saveSkin(s.key)) })),
    { id: "settings", label: "Settings", icon: "settings", group: "General", run: done(() => setDialog({ kind: "settings" })) },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "?", icon: "keyboard", group: "General", run: done(() => setDialog({ kind: "shortcuts" })) },
    ...accounts.filter(a => a.email !== account.email).map(a => ({ id: `acct-${a.email}`, label: `Switch to ${a.name}`, icon: "switch_account", group: "Accounts", run: done(() => switchAccount(a.email)) })),
  ], [skin, box.labels, account.email]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = text.trim().toLowerCase();
  const threadHits = q.length > 1 ? [...new Map(box.messages.filter(m => m.kind === "message" && (m.subject + " " + m.from.name).toLowerCase().includes(q)).map(m => [m.thread, m])).values()].slice(0, 4)
    .map<Command>(m => ({ id: `t-${m.thread}`, label: m.subject, hint: m.from.name, icon: "mail", group: "Conversations", run: done(() => openThread(m.thread)) })) : [];
  const results = q ? [...commands.filter(c => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)), ...threadHits,
    { id: "q", label: `Search mail for “${text.trim()}”`, icon: "manage_search", group: "Search", run: done(() => setQuery(text.trim())) }] : commands.filter(c => c.group !== "Actions").slice(0, 7);
  const quick = commands.filter(c => c.group === "Actions");
  const sel = Math.min(active, results.length - 1);

  return (
    <div className="fixed inset-0 z-[70] bg-m-canvas/40 backdrop-blur-[2px]" onMouseDown={e => { if (e.target === e.currentTarget) setPalette(false); }}>
      <div className="relative mx-auto mt-16 w-full max-w-[620px] px-gutter" role="dialog" aria-label="Command palette">
        <div className="w-full bg-m-card/95 backdrop-blur-xl rounded-m-xl shadow-2xl p-space-xs flex flex-col border border-m-line">
          <div className="flex items-center gap-space-sm px-space-md py-space-sm bg-m-low rounded-m-lg">
            <Icon name="terminal" className="text-[18px] text-m-brand" />
            <input autoFocus value={text} onChange={e => { setText(e.target.value); setActive(0); }} placeholder="Type a command or search..." aria-label="Command"
              onKeyDown={e => {
                if (e.key === "Escape") { e.stopPropagation(); setPalette(false); }
                if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => (a + 1) % results.length); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a - 1 + results.length) % results.length); }
                if (e.key === "Enter") { e.preventDefault(); results[sel]?.run(); }
              }}
              className="w-full bg-transparent text-m-text t-body-md focus:outline-none placeholder:text-m-muted" />
            <span className="px-space-xs py-0.5 rounded-m bg-m-highest text-m-muted t-code">ESC</span>
          </div>
          <div className="flex items-center gap-space-xs px-space-xs pt-space-xs overflow-x-auto pb-1">
            {quick.map(c => (
              <button key={c.id} type="button" onClick={c.run} className="flex items-center gap-1.5 px-space-sm py-1 rounded-m bg-m-mid hover:bg-m-high transition-colors text-m-text whitespace-nowrap">
                <Icon name={c.icon} className={`text-[14px] ${c.id === "compose" ? "text-m-primary" : ""}`} /><span className="t-label-sm">{c.label}</span>
                {c.hint && <kbd className="px-1 rounded-m bg-m-card text-m-muted t-code shadow-xs">{c.hint}</kbd>}
              </button>
            ))}
          </div>
          <div className="max-h-[50vh] overflow-y-auto pt-1" role="listbox">
            {results.map((c, i) => (
              <button key={c.id} type="button" role="option" aria-selected={i === sel} onMouseEnter={() => setActive(i)} onClick={c.run}
                className={`w-full flex items-center justify-between gap-3 px-space-md py-2 rounded-m-lg text-left ${i === sel ? "bg-m-mid" : ""}`}>
                <span className="flex items-center gap-2.5 min-w-0"><Icon name={c.icon} className="text-[16px] text-m-muted" /><span className="t-body-md text-m-text truncate">{c.label}</span></span>
                <span className="flex items-center gap-2 shrink-0"><span className="t-label-sm text-m-muted">{c.group}</span>{c.hint && <kbd className="px-1.5 py-0.5 rounded-m bg-m-low text-m-muted t-code">{c.hint}</kbd>}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
