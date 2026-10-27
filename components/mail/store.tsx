"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { accounts, Category, FolderId, Label, Mailbox, makeMailbox, Message, Person, Settings } from "./data";
import { mailApi, type MessagePatch } from "./live/api";
import type { LiveSession } from "./live/gate";
import { bodyText, createLabel as newLiveLabel, decryptDraft, decryptSettings, defaultSettings, encryptDraft, encryptSettings, toMessage, uiLabels, type LiveSettings } from "./live/mapping";
import { buildSend } from "./live/outgoing";
import { connectPush } from "./live/push";
import { readPublicKey } from "./crypto/core";
import { initials, newId } from "./ui";

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

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

const isFuture = (d?: Date): d is Date => !!d && d.getTime() > Date.now();

export const blankDraft = (): Draft => ({ id: newId("d"), to: [], cc: [], subject: "", body: "", attachments: [] });

/** The server-synced fields of a live message, with label names mapped to opaque ids. */
type Synced = { read: boolean; starred: boolean; folder: Message["folder"]; labels: string[]; snoozedUntil: string | null };

function useMailState(live?: LiveSession) {
  const [db, setDb] = useState<Db>(() => live
    ? { current: live.address, accounts: { [live.address]: { messages: [], labels: [], settings: { density: "comfortable", signature: "", notifications: true } } } }
    : loadDb());
  const [loading, setLoading] = useState(!!live);
  const liveSettings = useRef<{ settings: LiveSettings; version: number } | null>(null);
  const synced = useRef<Map<string, Synced> | null>(null);
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

  // Demo data persists locally; live (decrypted) mail never touches browser storage.
  useEffect(() => { if (!live) try { localStorage.setItem(STORE, JSON.stringify(db)); } catch {} }, [db, live]);

  const box = db.accounts[db.current];
  const account = live
    ? { name: live.displayName, email: live.address, initials: initials(live.displayName), role: "Mac Tidar Mail" }
    : accounts.find(a => a.email === db.current) ?? accounts[0];

  const toast = useCallback((text: string, undo?: () => void) => {
    const id = ++toastId.current;
    setToasts(t => [...t.slice(-2), { id, text, undo }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);
  const dismissToast = (id: number) => setToasts(t => t.filter(x => x.id !== id));

  // ── Live mode: load + decrypt, then mirror every local change to the server ──────────────
  const labelIds = () => new Map(liveSettings.current?.settings.labels.map(l => [l.name, l.id]) ?? []);
  const snapshot = (m: Message, ids: Map<string, string>): Synced => ({ read: m.read, starred: m.starred, folder: m.folder, labels: m.labels.map(n => ids.get(n)).filter((x): x is string => !!x).sort(), snoozedUntil: m.snoozedUntil ?? null });

  const saveLiveSettings = useCallback(async (next: LiveSettings) => {
    if (!live) return;
    const prev = liveSettings.current;
    liveSettings.current = { settings: next, version: prev?.version ?? 0 };
    try {
      const { version } = await mailApi.saveSettings(live.address, await encryptSettings(next, live.session), prev?.version ?? 0);
      liveSettings.current = { settings: next, version };
    } catch { toast("Couldn't save your settings. Reload and try again."); }
  }, [live, toast]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    (async () => {
      try {
        const remote = await mailApi.settings(live.address);
        let settings = remote.blob ? await decryptSettings(remote.blob, live.session) : null;
        liveSettings.current = { settings: settings ?? defaultSettings(live.displayName), version: remote.version };
        if (!settings) { settings = liveSettings.current.settings; await saveLiveSettings(settings); }
        const names = new Map(settings.labels.map(l => [l.id, l.name]));
        const folders = await Promise.all((["inbox", "sent", "archive", "spam", "trash"] as const).map(f => mailApi.listFolder(live.address, f)));
        const items = folders.flat();
        const messages: Message[] = [];
        for (let i = 0; i < items.length; i += 20) messages.push(...await Promise.all(items.slice(i, i + 20).map(it => toMessage(it, live.session, names))));
        const me = { name: live.displayName, email: live.address };
        for (const d of await mailApi.drafts(live.address).catch(() => [])) {
          const draft = await decryptDraft(d.blob, live.session);
          if (draft) messages.push({ id: d.id, thread: draft.thread ?? d.id, kind: "draft", folder: "sent", category: "primary", from: me, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, date: d.updatedAt, read: true, starred: false, snoozedUntil: null, labels: [], attachments: [] });
        }
        if (cancelled) return;
        const ids = labelIds();
        synced.current = new Map(messages.map(m => [m.id, snapshot(m, ids)]));
        setDb({ current: live.address, accounts: { [live.address]: { messages, labels: uiLabels(settings.labels), settings: { density: settings.density, signature: settings.signature, notifications: settings.notifications } } } });
      } catch {
        if (!cancelled) toast("Couldn't load your mail. Check your connection and reload.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!live || loading || !synced.current) return;
    const ids = labelIds();
    const prev = synced.current, next = new Map<string, Synced>();
    const groups = new Map<string, { set: MessagePatch; sks: string[] }>();
    for (const m of db.accounts[db.current].messages) {
      if (!m.ref) continue;
      const now = snapshot(m, ids), was = prev.get(m.id);
      next.set(m.id, now);
      if (!was) continue;
      const set: MessagePatch = {};
      if (now.read !== was.read) set.read = now.read;
      if (now.starred !== was.starred) set.starred = now.starred;
      if (now.folder !== was.folder) set.folder = now.folder;
      if (now.snoozedUntil !== was.snoozedUntil) set.snoozedUntil = now.snoozedUntil;
      if (now.labels.join() !== was.labels.join()) set.labels = now.labels;
      if (!Object.keys(set).length) continue;
      const key = JSON.stringify(set);
      groups.set(key, { set, sks: [...(groups.get(key)?.sks ?? []), m.ref] });
    }
    const removed = [...prev.entries()].filter(([id, s]) => !next.has(id) && (s.folder === "trash" || s.folder === "spam")).map(([id]) => id);
    synced.current = next;
    const fail = () => toast("Couldn't save that change. Reload to see the latest state.");
    for (const { set, sks } of groups.values()) for (let i = 0; i < sks.length; i += 100) mailApi.patch(live.address, sks.slice(i, i + 100), set).catch(fail);
    for (let i = 0; i < removed.length; i += 100) mailApi.deleteForever(live.address, removed.slice(i, i + 100)).catch(fail);
  }, [db]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a handle on the latest mailbox for background refreshes (updated after each render).
  const dbRef = useRef(db);
  useEffect(() => { dbRef.current = db; }, [db]);
  const refreshing = useRef(false);

  /** Pull new mail and changes made elsewhere (live mode). Local edits not yet echoed back win. */
  const refresh = useCallback(async (manual = false, folders: readonly ("inbox" | "sent" | "archive" | "spam" | "trash")[] = ["inbox", "sent", "archive", "spam", "trash"]) => {
    if (!live || loading || refreshing.current || !synced.current) return;
    refreshing.current = true;
    try {
      const names = new Map(liveSettings.current?.settings.labels.map(l => [l.id, l.name]) ?? []);
      const ids = labelIds();
      const items = (await Promise.all(folders.map(f => mailApi.listFolder(live.address, f)))).flat();
      const local = new Map(dbRef.current.accounts[dbRef.current.current].messages.map(m => [m.id, m]));
      const serverIds = new Set(items.map(i => i.sk));
      const added: Message[] = [], changed = new Map<string, Partial<Message>>(), removed = new Set<string>();
      for (const it of items) {
        const mine = local.get(it.sk);
        if (!mine) { added.push(await toMessage(it, live.session, names)); continue; }
        const server: Synced = { read: it.read, starred: it.starred, folder: it.folder, labels: [...it.labels].sort(), snoozedUntil: it.snoozedUntil };
        const last = synced.current.get(it.sk);
        if (!last || JSON.stringify(server) === JSON.stringify(last)) continue;
        if (JSON.stringify(snapshot(mine, ids)) !== JSON.stringify(last)) continue; // a local change is still on its way
        changed.set(it.sk, { read: it.read, starred: it.starred, folder: it.folder, snoozedUntil: it.snoozedUntil, deliveryStatus: it.deliveryStatus, labels: it.labels.map(id => names.get(id)).filter((n): n is string => !!n) });
        synced.current.set(it.sk, server);
      }
      if (folders.length === 5) for (const [id, m] of local) if (m.ref && !serverIds.has(id) && synced.current.has(id)) { removed.add(id); synced.current.delete(id); }
      for (const m of added) synced.current.set(m.id, snapshot(m, ids));
      if (added.length || changed.size || removed.size) {
        setDb(d => {
          const b = d.accounts[d.current];
          const known = new Set(b.messages.map(m => m.id));
          const messages = [...added.filter(m => !known.has(m.id)), ...b.messages.filter(m => !removed.has(m.id)).map(m => changed.has(m.id) ? { ...m, ...changed.get(m.id) } : m)];
          return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages } } };
        });
      }
      const fresh = added.filter(m => m.folder === "inbox" && !m.read).length;
      if (fresh) toast(fresh === 1 ? "1 new message" : `${fresh} new messages`);
      else if (manual) toast("Mail is up to date");
    } catch {
      if (manual) toast("Couldn’t refresh your mail. Check your connection.");
    } finally {
      refreshing.current = false;
    }
  }, [live, loading, toast]);

  // Instant delivery: the server pushes a content-free "new mail" signal; polling stays as a fallback.
  useEffect(() => {
    if (!live || loading) return;
    // New mail only ever lands in Inbox or Spam, so a push only needs those two folders.
    return connectPush(live.address, () => void refresh(false, ["inbox", "spam"]));
  }, [live, loading, refresh]);

  useEffect(() => {
    if (!live || loading) return;
    const tick = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, [live, loading, refresh]);

  /** Fetch and decrypt the bodies of a conversation's messages (live mode). */
  const loadBodies = async (thread: string) => {
    if (!live) return;
    const pending = db.accounts[db.current].messages.filter(m => m.thread === thread && m.ref && !m.locked && m.bodyState !== "loaded" && m.bodyState !== "loading");
    if (!pending.length) return;
    const mark = (ids: string[], patch: (m: Message) => Partial<Message>) => setDb(d => ({ ...d, accounts: { ...d.accounts, [d.current]: { ...d.accounts[d.current], messages: d.accounts[d.current].messages.map(m => ids.includes(m.id) ? { ...m, ...patch(m) } : m) } } }));
    mark(pending.map(m => m.id), () => ({ bodyState: "loading" }));
    // At most 3 downloads at a time: the AWS account runs only 10 Lambdas concurrently in af-south-1.
    await mapLimit(pending, 3, async m => {
      try {
        const sender = m.e2e && m.folder !== "sent" ? await mailApi.publicKey(m.from.email).catch(() => null) : null;
        const verificationKeys = sender ? [await readPublicKey(sender.publicKey)] : undefined;
        const { body, signature } = await live.session.decryptBody(await mailApi.download(live.address, m.ref!, "body"), { verificationKeys });
        mark([m.id], () => ({ body: bodyText(body), bodyState: "loaded", ...(m.e2e && m.folder !== "sent" ? { signature } : {}) }));
      } catch { mark([m.id], () => ({ bodyState: "error" })); }
    });
  };

  /** Decrypt an attachment in the browser and hand it to the user as a download (live mode). */
  const downloadAttachment = useCallback(async (m: Message, index: number) => {
    if (!live || !m.ref) return;
    try {
      const { data } = await live.session.decryptAttachment(await mailApi.download(live.address, m.ref, "attachment", index));
      const url = URL.createObjectURL(new Blob([data as BlobPart]));
      const a = document.createElement("a"); a.href = url; a.download = m.attachments[index]?.name ?? "attachment"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast("Couldn't download that attachment."); }
  }, [live, toast]);

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
    void loadBodies(thread);
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
    if (live && liveSettings.current) void saveLiveSettings({ ...liveSettings.current.settings, labels: [...liveSettings.current.settings.labels, newLiveLabel(clean)] });
    update(b => ({ ...b, labels: [...b.labels, { name: clean, tone: "custom" } satisfies Label] }), "Label created");
    return true;
  };
  const updateSettings = (s: Partial<Settings>) => {
    update(b => ({ ...b, settings: { ...b.settings, ...s } }));
    if (live && liveSettings.current) void saveLiveSettings({ ...liveSettings.current.settings, ...s });
  };
  const emptyTrash = () => update(b => ({ ...b, messages: b.messages.filter(m => m.folder !== "trash") }), "Trash emptied");
  const resetAccount = () => { setDb(d => ({ ...d, accounts: { ...d.accounts, [d.current]: makeMailbox(account) } })); setView({ kind: "list" }); toast("Demo data reset"); };
  const switchAccount = (email: string) => {
    if (live) { toast("Sign out to use a different mailbox"); return; }
    setDb(d => ({ ...d, current: email })); setFolderState("inbox"); setSelected([]); setView({ kind: "list" }); setQuery(""); setFilters({});
    toast(`Switched to ${accounts.find(a => a.email === email)?.name}`);
  };

  // Composer: drafts persist into the Drafts folder so nothing typed is lost.
  const compose = (draft?: Partial<Draft>, mode: ComposerState["mode"] = "mini") => setComposer({ open: true, mode, minimized: false, draft: { ...blankDraft(), ...draft } });
  const editDraft = (patch: Partial<Draft>) => setComposer(c => ({ ...c, draft: { ...c.draft, ...patch } }));
  const persistDraft = useCallback((draft: Draft) => {
    const has = draft.to.length || draft.subject.trim() || draft.body.trim();
    if (live) {
      if (has) void encryptDraft({ v: 1, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, thread: draft.thread }, live.session).then(blob => mailApi.saveDraft(live.address, draft.id, blob)).catch(() => toast("Couldn’t save your draft"));
      else void mailApi.deleteDraft(live.address, draft.id).catch(() => {});
    }
    setDb(d => {
      const b = d.accounts[d.current];
      const me = live ? { name: live.displayName, email: live.address } : accounts.find(a => a.email === d.current)!;
      const others = b.messages.filter(m => m.id !== draft.id);
      if (!has) return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages: others } } };
      const msg: Message = { id: draft.id, thread: draft.thread ?? draft.id, kind: "draft", folder: "sent", category: "primary", from: { name: me.name, email: me.email }, to: draft.to, cc: draft.cc,
        subject: draft.subject, body: draft.body, date: new Date().toISOString(), read: true, starred: false, snoozedUntil: null, labels: [], attachments: draft.attachments };
      return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages: [msg, ...others] } } };
    });
  }, [live, toast]);
  const closeComposer = (discard = false) => {
    if (discard) {
      update(b => ({ ...b, messages: b.messages.filter(m => m.id !== composer.draft.id) })); toast("Draft discarded");
      if (live) void mailApi.deleteDraft(live.address, composer.draft.id).catch(() => {});
    }
    else persistDraft(composer.draft);
    setComposer(c => ({ ...c, open: false }));
  };
  const openDraft = (m: Message) => compose({ id: m.id, to: m.to, cc: m.cc ?? [], subject: m.subject, body: m.body, thread: m.thread === m.id ? undefined : m.thread, attachments: m.attachments }, "full");

  /** Validates and sends (or schedules) a draft. Returns an error message when it can't. */
  async function send(draft: Draft, opts: { scheduleAt?: Date; archive?: boolean } = {}): Promise<string | null> {
    if (live) return sendLive(draft, opts);
    if (!draft.to.length) return "Add at least one recipient";
    if (draft.to.some(p => !/^\S+@\S+\.\S+$/.test(p.email))) return "One of the recipients isn’t a valid email address";
    if (!draft.subject.trim()) return "Add a subject before sending";
    const scheduled = isFuture(opts.scheduleAt);
    const sid = newId("s");
    const msg: Message = { id: sid, thread: draft.thread ?? sid, kind: scheduled ? "scheduled" : "message", folder: "sent", category: "primary",
      from: { name: account.name, email: account.email }, to: draft.to, cc: draft.cc, subject: draft.subject.trim(), body: draft.body.trim() || "(No message body)",
      date: new Date().toISOString(), scheduledAt: scheduled ? opts.scheduleAt!.toISOString() : null, read: true, starred: false, snoozedUntil: null, labels: [], attachments: draft.attachments };
    update(b => ({ ...b, messages: [msg, ...b.messages.filter(m => m.id !== draft.id).map(m => opts.archive && draft.thread && m.thread === draft.thread ? { ...m, folder: m.folder === "inbox" ? "archive" as const : m.folder } : m)] }),
      scheduled ? `Scheduled for ${opts.scheduleAt!.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : opts.archive ? "Sent and archived — demo only" : "Message sent — demo only", true);
    if (opts.archive && view.kind === "thread") setView({ kind: "list" });
    return null;
  }

  async function sendLive(draft: Draft, opts: { scheduleAt?: Date; archive?: boolean }): Promise<string | null> {
    if (!live) return null;
    if (isFuture(opts.scheduleAt)) return "Scheduled send isn’t available yet: it would require the server to keep a readable copy, which zero-access encryption doesn’t allow.";
    if (!draft.to.length) return "Add at least one recipient";
    if (draft.to.concat(draft.cc).some(p => !/^[^\s@<>",]+@[^\s@<>",]+\.[A-Za-z]{2,}$/.test(p.email))) return "One of the recipients isn’t a valid email address";
    if (!draft.subject.trim()) return "Add a subject before sending";
    if (draft.attachments.some(a => !a.data)) return "Re-attach your files before sending (attachments aren’t kept in saved drafts)";
    const parent = draft.thread ? threadMessages(draft.thread).filter(m => m.rfcMessageId).at(-1) : undefined;
    try {
      const payload = await buildSend(live.session, live.address, live.displayName, {
        id: draft.id, to: draft.to.map(p => p.email), cc: draft.cc.map(p => p.email), subject: draft.subject.trim(), text: draft.body.trim() || " ",
        attachments: draft.attachments.map(a => ({ name: a.name, type: a.type ?? "application/octet-stream", data: a.data! })),
        replyTo: parent ? { rfcMessageId: parent.rfcMessageId, references: parent.references } : undefined,
      });
      const item = await mailApi.send(live.address, payload);
      const names = new Map(liveSettings.current?.settings.labels.map(l => [l.id, l.name]) ?? []);
      const message = { ...await toMessage(item, live.session, names), body: draft.body.trim(), bodyState: "loaded" as const };
      synced.current?.set(message.id, snapshot(message, labelIds()));
      setDb(d => {
        const b = d.accounts[d.current];
        const others = b.messages.filter(m => m.id !== draft.id).map(m => opts.archive && draft.thread && m.thread === draft.thread && m.folder === "inbox" ? { ...m, folder: "archive" as const } : m);
        return { ...d, accounts: { ...d.accounts, [d.current]: { ...b, messages: [message, ...others] } } };
      });
      void mailApi.deleteDraft(live.address, draft.id).catch(() => {});
      toast(payload.external ? (opts.archive ? "Sent and archived" : "Message sent") : "Sent with end-to-end encryption");
      if (opts.archive && view.kind === "thread") setView({ kind: "list" });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn’t send your message";
    }
  }

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
    live, loading, loadBodies, downloadAttachment, refresh,
    db, box, account, rows, threadMessages, folder, setFolder, tab, setTab: (t: Category) => { setTab(t); setSelected([]); setPage(0); }, query, setQuery: (q: string) => { setQuery(q); setPage(0); if (q) setView({ kind: "list" }); },
    filters, setFilters, sort, setSort, selected, setSelected, view, openThread, closeThread, page, setPage,
    move, destroy, markRead, toggleStar, snooze, toggleLabel, createLabel, updateSettings, emptyTrash, resetAccount, switchAccount,
    composer, setComposer, compose, editDraft, persistDraft, closeComposer, openDraft, send,
    palette, setPalette, dialog, setDialog, sidebarOpen, setSidebarOpen, collapsed, setCollapsed, toasts, toast, dismissToast,
  };
}

export type MailState = ReturnType<typeof useMailState>;
const MailContext = createContext<MailState | null>(null);

export function MailProvider({ children, live }: { children: ReactNode; live?: LiveSession }) {
  const state = useMailState(live);
  return <MailContext.Provider value={state}>{children}</MailContext.Provider>;
}

export function useMail() {
  const ctx = useContext(MailContext);
  if (!ctx) throw new Error("useMail must be used inside <MailProvider>");
  return ctx;
}
