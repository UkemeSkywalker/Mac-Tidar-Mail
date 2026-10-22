"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { accounts, Category, FolderId, Label, Mailbox, makeMailbox, Message, Person, Settings } from "./data";
import { newId } from "./ui";

const STORE = "mtmail-v2";

type Db = { current: string; accounts: Record<string, Mailbox> };
export type View = { kind: "list" } | { kind: "thread"; thread: string };
export type Filters = { unread?: boolean; starred?: boolean; attachments?: boolean };
export type Sort = "newest" | "oldest" | "sender";
export type Toast = { id: number; text: string; undo?: () => void };
export type Draft = { id: string; to: Person[]; cc: Person[]; subject: string; body: string; thread?: string; attachments: Message["attachments"]; savedAt?: string };
export type ComposerState = { open: boolean; mode: "mini" | "full"; minimized: boolean; draft: Draft };
export type Dialog = null | { kind: "settings"; tab?: string } | { kind: "shortcuts" } | { kind: "auth"; mode: "signin" | "signup" } | { kind: "label" };
export type ThreadRow = { thread: string; latest: Message; messages: Message[]; unread: boolean; starred: boolean; count: number };

function loadDb(): Db {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null") as Db | null;
    if (saved?.accounts && saved.accounts[saved.current]) return saved;
  } catch {}
  const now = Date.now();
  return { current: accounts[0].email, accounts: Object.fromEntries(accounts.map(a => [a.email, makeMailbox(a, now)])) };
}

export const folderMatch = (folder: string, m: Message) => {
  if (folder.startsWith("label:")) return m.labels.includes(folder.slice(6)) && m.folder !== "trash" && m.folder !== "spam" && m.kind === "message";
  switch (folder as FolderId) {
    case "inbox": return m.folder === "inbox" && m.kind === "message" && !m.snoozedUntil;
    case "starred": return m.starred && m.folder !== "trash" && m.kind === "message";
    case "snoozed": return !!m.snoozedUntil && m.kind === "message";
    case "drafts": return m.kind === "draft";
    case "scheduled": return m.kind === "scheduled";
    default: return m.folder === folder && m.kind === "message";
  }
};

export const blankDraft = (): Draft => ({ id: newId("d"), to: [], cc: [], subject: "", body: "", attachments: [] });

function useMailState() {
  const [db, setDb] = useState<Db>(loadDb);
  const [folder, setFolderState] = useState<string>("inbox");
  const [tab, setTab] = useState<Category>("primary");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState<Sort>("newest");
  const [selected, setSelected] = useState<string[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [page, setPage] = useState(0);
  const [composer, setComposer] = useState<ComposerState>({ open: false, mode: "mini", minimized: false, draft: blankDraft() });
  const [palette, setPalette] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch {} }, [db]);

  const box = db.accounts[db.current];
  const account = accounts.find(a => a.email === db.current) ?? accounts[0];

  const toast = useCallback((text: string, undo?: () => void) => {
    const id = ++toastId.current;
    setToasts(t => [...t.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);
  const dismissToast = (id: number) => setToasts(t => t.filter(x => x.id !== id));

  /** Apply a change to the current mailbox, optionally offering undo of the whole change. */
  const update = useCallback((fn: (box: Mailbox) => Mailbox, message?: string, undoable = false) => {
    let before: Mailbox | undefined;
    setDb(d => { before = d.accounts[d.current]; return { ...d, accounts: { ...d.accounts, [d.current]: fn(d.accounts[d.current]) } }; });
    if (message) toast(message, undoable ? () => setDb(d => before ? { ...d, accounts: { ...d.accounts, [d.current]: before } } : d) : undefined);
  }, [toast]);
  const updateMessages = useCallback((pred: (m: Message) => boolean, change: (m: Message) => Partial<Message>, message?: string, undoable = true) =>
    update(b => ({ ...b, messages: b.messages.map(m => pred(m) ? { ...m, ...change(m) } : m) }), message, undoable), [update]);

  // Rows: one per thread, using the newest message that belongs to the current folder.
  const rows = useMemo<ThreadRow[]>(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, Message[]>();
    for (const m of box.messages) {
      if (!folderMatch(folder, m)) continue;
      if (folder === "inbox" && !q && m.category !== tab) continue;
      if (q && ![m.from.name, m.from.email, m.subject, m.body, ...m.to.map(t => t.email), ...m.labels, ...m.attachments.map(a => a.name)].join(" ").toLowerCase().includes(q)) continue;
      groups.set(m.thread, [...(groups.get(m.thread) ?? []), m]);
    }
    let list = [...groups.entries()].map(([thread, ms]) => {
      const sorted = [...ms].sort((a, b) => +new Date(b.date) - +new Date(a.date));
      return { thread, latest: sorted[0], messages: sorted, unread: ms.some(m => !m.read), starred: ms.some(m => m.starred), count: box.messages.filter(m => m.thread === thread && m.kind === "message").length };
    });
    if (filters.unread) list = list.filter(r => r.unread);
    if (filters.starred) list = list.filter(r => r.starred);
    if (filters.attachments) list = list.filter(r => r.messages.some(m => m.attachments.length));
    return list.sort((a, b) => sort === "sender" ? a.latest.from.name.localeCompare(b.latest.from.name) : sort === "oldest" ? +new Date(a.latest.date) - +new Date(b.latest.date) : +new Date(b.latest.date) - +new Date(a.latest.date));
  }, [box.messages, folder, tab, query, filters, sort]);

  const threadMessages = useCallback((thread: string) => box.messages.filter(m => m.thread === thread && m.kind === "message").sort((a, b) => +new Date(a.date) - +new Date(b.date)), [box.messages]);
  const inThreads = (threads: string[]) => (m: Message) => threads.includes(m.thread) && m.kind === "message";

  const setFolder = (f: string) => { setFolderState(f); setSelected([]); setView({ kind: "list" }); setPage(0); setSidebarOpen(false); };
  const openThread = (thread: string) => {
    setView({ kind: "thread", thread });
    updateMessages(m => m.thread === thread && !m.read, () => ({ read: true }), undefined, false);
  };
  const closeThread = () => setView({ kind: "list" });

  const move = (threads: string[], target: Message["folder"]) => {
    if (!threads.length) return;
    const where = { trash: "moved to Trash", spam: "reported as spam", inbox: "moved to Inbox", archive: "archived", sent: "moved to Sent" }[target];
    updateMessages(inThreads(threads), () => ({ folder: target, snoozedUntil: null }), `${threads.length > 1 ? `${threads.length} conversations` : "Conversation"} ${where}`);
    setSelected([]);
    if (view.kind === "thread" && threads.includes(view.thread)) setView({ kind: "list" });
  };
  const destroy = (threads: string[]) => {
    update(b => ({ ...b, messages: b.messages.filter(m => !threads.includes(m.thread)) }), `${threads.length > 1 ? `${threads.length} conversations` : "Conversation"} deleted forever`, true);
    setSelected([]);
    if (view.kind === "thread" && threads.includes(view.thread)) setView({ kind: "list" });
  };
  const markRead = (threads: string[], read: boolean) => { updateMessages(inThreads(threads), () => ({ read }), read ? "Marked as read" : "Marked as unread"); setSelected([]); };
  const toggleStar = (thread: string) => {
    const starred = box.messages.some(m => m.thread === thread && m.starred);
    const latest = threadMessages(thread).at(-1);
    updateMessages(m => m.thread === thread, m => ({ starred: starred ? false : m.id === latest?.id }), starred ? "Star removed" : "Starred", false);
  };
  const snooze = (threads: string[], until: Date) => {
    updateMessages(inThreads(threads), () => ({ snoozedUntil: until.toISOString() }), `Snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
    setSelected([]);
    if (view.kind === "thread" && threads.includes(view.thread)) setView({ kind: "list" });
  };
  const toggleLabel = (threads: string[], name: string) => {
    const all = threads.every(t => box.messages.some(m => m.thread === t && m.labels.includes(name)));
    updateMessages(inThreads(threads), m => ({ labels: all ? m.labels.filter(l => l !== name) : [...new Set([...m.labels, name])] }), all ? `Removed “${name}”` : `Labelled “${name}”`);
  };
  const createLabel = (name: string) => {
    const clean = name.trim();
    if (!clean) return false;
    if (box.labels.some(l => l.name.toLowerCase() === clean.toLowerCase())) { toast("That label already exists"); return false; }
    update(b => ({ ...b, labels: [...b.labels, { name: clean, tone: "custom" } satisfies Label] }), "Label created");
    return true;
  };
  const updateSettings = (s: Partial<Settings>) => update(b => ({ ...b, settings: { ...b.settings, ...s } }));
  const emptyTrash = () => update(b => ({ ...b, messages: b.messages.filter(m => m.folder !== "trash") }), "Trash emptied");
  const resetAccount = () => { setDb(d => ({ ...d, accounts: { ...d.accounts, [d.current]: makeMailbox(account) } })); setView({ kind: "list" }); toast("Demo data reset"); };
  const switchAccount = (email: string) => {
    setDb(d => ({ ...d, current: email })); setFolderState("inbox"); setSelected([]); setView({ kind: "list" }); setQuery(""); setFilters({});
    toast(`Switched to ${accounts.find(a => a.email === email)?.name}`);
  };

  // Composer: drafts persist into the Drafts folder so nothing typed is lost.
  const compose = (draft?: Partial<Draft>, mode: ComposerState["mode"] = "mini") => setComposer({ open: true, mode, minimized: false, draft: { ...blankDraft(), ...draft } });
  const editDraft = (patch: Partial<Draft>) => setComposer(c => ({ ...c, draft: { ...c.draft, ...patch } }));
  const persistDraft = useCallback((draft: Draft) => {
    const has = draft.to.length || draft.subject.trim() || draft.body.trim();
    setDb(d => {
      const b = d.accounts[d.current]; const me = accounts.find(a => a.email === d.current)!;
      const others = b.messages.filter(m => m.id !== draft.id);
      if (!has) return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages: others } } };
      const msg: Message = { id: draft.id, thread: draft.thread ?? draft.id, kind: "draft", folder: "sent", category: "primary", from: { name: me.name, email: me.email }, to: draft.to, cc: draft.cc,
        subject: draft.subject, body: draft.body, date: new Date().toISOString(), read: true, starred: false, snoozedUntil: null, labels: [], attachments: draft.attachments };
      return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages: [msg, ...others] } } };
    });
  }, []);
  const closeComposer = (discard = false) => {
    if (discard) { update(b => ({ ...b, messages: b.messages.filter(m => m.id !== composer.draft.id) })); toast("Draft discarded"); }
    else persistDraft(composer.draft);
    setComposer(c => ({ ...c, open: false }));
  };
  const openDraft = (m: Message) => compose({ id: m.id, to: m.to, cc: m.cc ?? [], subject: m.subject, body: m.body, thread: m.thread === m.id ? undefined : m.thread, attachments: m.attachments }, "full");

  /** Validates and sends (or schedules) a draft. Returns an error message when it can't. */
  const send = (draft: Draft, opts: { scheduleAt?: Date; archive?: boolean } = {}) => {
    if (!draft.to.length) return "Add at least one recipient";
    if (draft.to.some(p => !/^\S+@\S+\.\S+$/.test(p.email))) return "One of the recipients isn’t a valid email address";
    if (!draft.subject.trim()) return "Add a subject before sending";
    const scheduled = opts.scheduleAt && opts.scheduleAt.getTime() > Date.now();
    const sid = newId("s");
    const msg: Message = { id: sid, thread: draft.thread ?? sid, kind: scheduled ? "scheduled" : "message", folder: "sent", category: "primary",
      from: { name: account.name, email: account.email }, to: draft.to, cc: draft.cc, subject: draft.subject.trim(), body: draft.body.trim() || "(No message body)",
      date: new Date().toISOString(), scheduledAt: scheduled ? opts.scheduleAt!.toISOString() : null, read: true, starred: false, snoozedUntil: null, labels: [], attachments: draft.attachments };
    update(b => ({ ...b, messages: [msg, ...b.messages.filter(m => m.id !== draft.id).map(m => opts.archive && draft.thread && m.thread === draft.thread ? { ...m, folder: m.folder === "inbox" ? "archive" as const : m.folder } : m)] }),
      scheduled ? `Scheduled for ${opts.scheduleAt!.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : opts.archive ? "Sent and archived — demo only" : "Message sent — demo only", true);
    if (opts.archive && view.kind === "thread") setView({ kind: "list" });
    return null;
  };

  // Deliver scheduled mail and wake snoozed threads when they're due.
  useEffect(() => {
    const tick = () => setDb(d => {
      const now = Date.now(); let changed = false;
      const next = Object.fromEntries(Object.entries(d.accounts).map(([k, b]) => [k, { ...b, messages: b.messages.map(m => {
        if (m.kind === "scheduled" && m.scheduledAt && +new Date(m.scheduledAt) <= now) { changed = true; return { ...m, kind: "message" as const, date: new Date().toISOString(), scheduledAt: null }; }
        if (m.snoozedUntil && +new Date(m.snoozedUntil) <= now) { changed = true; return { ...m, snoozedUntil: null, read: false, date: new Date().toISOString() }; }
        return m;
      }) }]));
      return changed ? { ...d, accounts: next } : d;
    });
    tick(); const t = setInterval(tick, 15_000); return () => clearInterval(t);
  }, []);

  return {
    db, box, account, rows, threadMessages, folder, setFolder, tab, setTab: (t: Category) => { setTab(t); setSelected([]); setPage(0); }, query, setQuery: (q: string) => { setQuery(q); setPage(0); if (q) setView({ kind: "list" }); },
    filters, setFilters, sort, setSort, selected, setSelected, view, openThread, closeThread, page, setPage,
    move, destroy, markRead, toggleStar, snooze, toggleLabel, createLabel, updateSettings, emptyTrash, resetAccount, switchAccount,
    composer, setComposer, compose, editDraft, persistDraft, closeComposer, openDraft, send,
    palette, setPalette, dialog, setDialog, sidebarOpen, setSidebarOpen, collapsed, setCollapsed, toasts, toast, dismissToast,
  };
}

export type MailState = ReturnType<typeof useMailState>;
const MailContext = createContext<MailState | null>(null);

export function MailProvider({ children }: { children: ReactNode }) {
  const state = useMailState();
  return <MailContext.Provider value={state}>{children}</MailContext.Provider>;
}

export function useMail() {
  const ctx = useContext(MailContext);
  if (!ctx) throw new Error("useMail must be used inside <MailProvider>");
  return ctx;
}
