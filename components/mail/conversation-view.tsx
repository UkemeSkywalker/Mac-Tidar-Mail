"use client";

import { useEffect, useRef, useState } from "react";
import { Message, Person } from "./data";
import { useMail } from "./store";
import { Avatar, fmtLongDate, newId, Icon, IconButton, LabelChip, MenuItem, Popover, snoozeOptions, UrgentChip } from "./ui";

/** Body from designs/conversation_q3_product_roadmap (Elena’s summary). */
function Q3RoadmapBody() {
  const stats = [
    ["p95 Search Latency", "< 38ms", "text-m-primary", <span key="t" className="t-label-sm text-m-success-text font-medium flex items-center gap-1"><Icon name="trending_down" className="text-[14px]" />62% decrease from Q2</span>],
    ["Tenant Isolation", "RLS + Schema", "text-m-text", <span key="t" className="t-label-sm text-m-muted font-medium">SOC-2 Type II compliant</span>],
    ["Offline Draft Sync", "100% Zero-Loss", "text-m-secondary", <span key="t" className="t-label-sm text-m-muted font-medium">IndexedDB + CRDT merge</span>],
  ] as const;
  const deliverables: [string, React.ReactNode][] = [
    ["Multi-tenant workspace isolation:", "Dynamic connection pooling with strict row-level security per organization partition, guaranteeing zero cross-tenant leakage."],
    ["Instant indexing pipeline:", <>Asynchronous streaming of message bodies directly through pgvector workers, achieving end-to-end searchable availability within <strong>45ms</strong>.</>],
    ["Offline First Cache:", "Local background thread store on modern web clients using client-side Web Workers, ensuring composition and navigation continue seamlessly in disconnected states."],
    ["Mac Tidar Suite Unified SSO:", "OIDC integration across all native desktop and mobile touchpoints, complete with automated SAML 2.0 directory sync."],
  ];
  return <>
    <p>Hi Ukeme &amp; Alex,</p>
    <p>I’ve reviewed the revised technical feasibility study and Alex’s preliminary performance benchmarks. I’m confident we can commit to these Q3 targets ahead of Thursday&apos;s executive sync.</p>
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm my-space-md">
      {stats.map(([label, value, tone, note]) => (
        <div key={label} className="p-space-md rounded-m-xl bg-m-low flex flex-col gap-1">
          <span className="t-label-sm text-m-muted uppercase tracking-wider font-semibold">{label}</span>
          <span className={`t-display tracking-tight ${tone}`}>{value}</span>{note}
        </div>
      ))}
    </div>
    <div className="space-y-3 pt-1">
      <div className="t-headline-sm text-m-text font-semibold">Primary Architecture Deliverables for Sprint 42–46:</div>
      <ul className="space-y-2.5 pl-1">
        {deliverables.map(([title, text]) => <li key={title} className="flex items-start gap-2.5"><Icon name="check_circle" className="text-m-primary text-[18px] mt-1 shrink-0" /><span><strong>{title}</strong> {text}</span></li>)}
      </ul>
    </div>
    <div className="rounded-m-xl bg-m-mid p-space-md space-y-space-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Icon name="hub" className="text-m-secondary text-[20px]" /><span className="t-headline-sm font-semibold">Multi-tenant Vector Ingestion Pipeline</span></div>
        <span className="px-2 py-0.5 rounded-m-pill t-code font-semibold" style={{ background: "var(--chip-product-bg)", color: "var(--chip-product-fg)" }}>v3.2 Draft</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center pt-1 t-body-sm">
        {[["Client TLS", "HTTP/3 QUIC"], ["Edge Gateway", "JWT Tenant Routing"], ["Worker Pool", "Rust Vectorizer"], ["pgvector DB", "Isolated Namespaces"]].map(([a, b]) => (
          <div key={a} className="p-2.5 rounded-m-lg bg-m-card shadow-xs flex flex-col items-center"><span className="font-medium text-m-text">{a}</span><span className="text-m-muted t-label-sm mt-0.5">{b}</span></div>
        ))}
      </div>
    </div>
    <p>Please check the linked architectural specs and benchmark CSV below. Alex, let’s run the final failover stress test on Staging-US-East this evening.</p>
    <p className="pt-2 text-m-text font-medium">Best regards,<br /><span className="text-m-muted font-normal">Elena Rostova<br />Vice President of Product Engineering</span></p>
  </>;
}

const eml = (m: Message) => [`From: ${m.from.name} <${m.from.email}>`, `To: ${m.to.map(p => `${p.name} <${p.email}>`).join(", ")}`, `Date: ${new Date(m.date).toUTCString()}`, `Subject: ${m.subject}`, "Content-Type: text/plain; charset=utf-8", "", m.body].join("\r\n");

function MessageCard({ m, me, onReply, onReplyAll }: { m: Message; me: string; onReply: () => void; onReplyAll: () => void }) {
  const { compose, toggleStar, box, downloadAttachment } = useMail();
  const [menu, setMenu] = useState(false);
  const [raw, setRaw] = useState(false);
  const thread = box.messages.filter(x => x.thread === m.thread);
  const starred = thread.some(x => x.starred);
  const download = () => {
    const url = URL.createObjectURL(new Blob([eml(m)], { type: "message/rfc822" }));
    const a = document.createElement("a"); a.href = url; a.download = `${m.subject.replace(/[^\w\- ]+/g, "").slice(0, 60) || "message"}.eml`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const total = m.attachments.length;
  return (
    <article className="rounded-m-xl bg-m-card shadow-md overflow-hidden flex flex-col border border-m-line/60">
      <div className="p-space-lg bg-m-low/50 flex flex-col sm:flex-row sm:items-start justify-between gap-space-md">
        <div className="flex items-start gap-space-md min-w-0">
          <Avatar person={m.from} size="w-11 h-11" className="shadow-xs t-headline-sm" />
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="t-headline-md text-m-text font-semibold">{m.from.name}</span>
              <span className="t-body-sm text-m-muted">&lt;{m.from.email}&gt;</span>
              {m.from.title && <span className="px-2 py-0.5 rounded-m-pill t-label-sm font-semibold" style={{ background: "var(--chip-engineering-bg)", color: "var(--chip-engineering-fg)" }}>{m.from.title}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-m-muted t-body-sm">
              <span>To:</span>
              {m.to.map((p, i) => <span key={p.email}><span className="text-m-text font-medium">{p.email === me ? "me" : p.name}</span>{i < m.to.length - 1 ? "," : ""}</span>)}
              <button type="button" onClick={() => setRaw(r => !r)} className="text-m-primary hover:underline t-label-sm ml-1">{raw ? "hide details" : "details"}</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-space-sm shrink-0 self-end sm:self-auto">
          <span className="t-body-sm text-m-muted whitespace-nowrap">{fmtLongDate(m.date)}</span>
          <div className="flex items-center gap-0.5">
            <button type="button" title="Star message (S)" aria-label="Star" onClick={() => toggleStar(m.thread)} className={`p-1.5 rounded-m-lg hover:bg-m-mid transition-colors ${starred ? "text-m-star" : "text-m-muted hover:text-m-star"}`}><Icon name="star" className="text-[19px]" fill={starred} /></button>
            <IconButton icon="reply" title="Reply" size="text-[19px]" onClick={onReply} />
            <div className="relative">
              <IconButton icon="more_vert" title="More actions" size="text-[19px]" onClick={() => setMenu(o => !o)} />
              <Popover open={menu} onClose={() => setMenu(false)} className="right-0 top-full mt-1 w-48">
                <MenuItem icon="forward" onClick={() => { setMenu(false); compose({ subject: m.subject.startsWith("Fwd:") ? m.subject : `Fwd: ${m.subject}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${m.from.name} <${m.from.email}>\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\n\n${m.body}`, attachments: m.attachments }, "full"); }}>Forward</MenuItem>
                <MenuItem icon="reply_all" onClick={() => { setMenu(false); onReplyAll(); }}>Reply all</MenuItem>
                <MenuItem icon="code" onClick={() => { setMenu(false); setRaw(true); }}>Show original</MenuItem>
                <MenuItem icon="download" onClick={() => { setMenu(false); download(); }}>Download (.eml)</MenuItem>
              </Popover>
            </div>
          </div>
        </div>
      </div>
      {raw && <pre className="mx-space-lg mt-space-md p-space-md rounded-m-xl bg-m-low text-m-muted t-body-sm whitespace-pre-wrap break-words font-mono">{eml(m)}</pre>}
      <div className="p-space-lg space-y-space-md text-m-text t-body-lg leading-relaxed">
        {m.locked ? <p className="flex items-center gap-2 text-m-muted"><Icon name="lock" className="text-[18px]" />This message is encrypted to an older key. Recover your older keys (Settings → Accounts) to read it.</p>
          : m.bodyState === "loading" ? <p className="flex items-center gap-2 text-m-muted"><span className="w-3.5 h-3.5 rounded-full border-2 border-m-brand border-t-transparent animate-spin" />Decrypting…</p>
          : m.bodyState === "error" ? <p className="text-m-error">Couldn’t decrypt this message.</p>
          : m.rich === "q3-roadmap" ? <Q3RoadmapBody /> : m.body.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-line break-words">{p}</p>)}
      </div>
      {total > 0 && (
        <div className="p-space-lg bg-m-low/40 space-y-space-sm">
          <div className="flex items-center gap-2 text-m-muted t-headline-sm font-medium"><Icon name="attachment" className="text-[18px]" /><span>{total} Attachment{total > 1 ? "s" : ""}</span></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            {m.attachments.map((a, i) => (
              <div key={`${a.name}-${i}`} className="p-space-sm rounded-m-xl bg-m-card shadow-xs hover:shadow-md transition-shadow flex items-center justify-between gap-space-sm border border-m-line/60">
                <div className="flex items-center gap-space-sm min-w-0">
                  <div className="w-10 h-10 rounded-m-lg flex items-center justify-center shrink-0" style={a.icon === "picture_as_pdf" ? { background: "var(--m-error-soft)", color: "var(--m-on-error-soft)" } : { background: "var(--chip-engineering-bg)", color: "var(--chip-engineering-fg)" }}>
                    <Icon name={a.icon} className="text-[22px]" />
                  </div>
                  <div className="min-w-0"><div className="t-headline-sm text-m-text font-medium truncate">{a.name}</div><div className="t-label-sm text-m-muted">{a.size}</div></div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {m.ref
                    ? <IconButton icon="download" title="Decrypt and download" onClick={() => downloadAttachment(m, i)} />
                    : <IconButton icon="download" title="Downloads aren’t available in the demo" disabled />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function Collapsed({ m, onOpen }: { m: Message; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group w-full text-left rounded-m-xl bg-m-card hover:bg-m-low transition-all cursor-pointer shadow-xs overflow-hidden border border-m-line/60">
      <div className="px-space-md py-space-sm flex items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-sm min-w-0">
          <Avatar person={m.from} size="w-7 h-7" />
          <span className="t-headline-sm text-m-text font-medium whitespace-nowrap">{m.from.name}</span>
          {m.from.title && <span className="hidden sm:inline px-1.5 py-0.5 rounded-m bg-m-high text-m-muted t-label-sm whitespace-nowrap">{m.from.title}</span>}
          <span className="t-body-sm text-m-muted truncate">{m.body.replace(/\s+/g, " ").slice(0, 160)}</span>
        </div>
        <div className="flex items-center gap-space-sm shrink-0">
          {m.attachments.length > 0 && <Icon name="attach_file" className="text-[16px] text-m-faint group-hover:text-m-muted" />}
          <span className="hidden md:inline t-body-sm text-m-muted whitespace-nowrap">{fmtLongDate(m.date)}</span>
          <Icon name="unfold_more" className="text-[18px] text-m-faint" />
        </div>
      </div>
    </button>
  );
}

export function ConversationView({ thread }: { thread: string }) {
  const { threadMessages, rows, box, account, folder, closeThread, openThread, move, markRead, snooze, toggleLabel, send, compose, toast } = useMail();
  const messages = threadMessages(thread);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [menu, setMenu] = useState<null | "snooze" | "labels" | "move">(null);
  const [reply, setReply] = useState("");
  const [replyAll, setReplyAll] = useState(true);
  const [error, setError] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const close = () => setMenu(null);
  const toggle = (m: typeof menu) => setMenu(c => c === m ? null : m);

  useEffect(() => { window.scrollTo?.(0, 0); }, [thread]);
  useEffect(() => {
    const focusReply = (e: Event) => { setReplyAll((e as CustomEvent<boolean>).detail); replyRef.current?.focus(); };
    window.addEventListener("mail:reply", focusReply);
    return () => window.removeEventListener("mail:reply", focusReply);
  }, []);

  if (!messages.length) return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-m-muted">
      <Icon name="mark_email_unread" className="text-[40px] text-m-faint" /><p className="t-body-md">This conversation isn’t available any more.</p>
      <button type="button" onClick={closeThread} className="px-3 py-1.5 rounded-m-lg bg-m-low hover:bg-m-mid text-m-text t-headline-sm">Back to inbox</button>
    </div>
  );

  const latest = messages[messages.length - 1];
  const subject = latest.subject.replace(/^(re|fwd):\s*/i, "");
  const labels = box.labels.filter(l => messages.some(m => m.labels.includes(l.name)));
  const idx = rows.findIndex(r => r.thread === thread);
  const unreadInbox = new Set(box.messages.filter(m => m.folder === "inbox" && m.kind === "message" && !m.read && !m.snoozedUntil && m.category === "primary").map(m => m.thread)).size;
  const others = (all: boolean): Person[] => {
    const people = all ? [latest.from, ...latest.to, ...(latest.cc ?? [])] : [latest.from.email === account.email ? latest.to[0] : latest.from];
    return [...new Map(people.filter(p => p && p.email !== account.email).map(p => [p.email, p])).values()];
  };
  const recipients = others(replyAll);
  const draft = () => ({ id: newId("r"), to: recipients, cc: [], subject: `Re: ${subject}`, body: reply + (box.settings.signature ? `\n\n${box.settings.signature}` : ""), thread, attachments: [] });
  const doSend = (opts: { archive?: boolean; scheduleAt?: Date } = {}) => {
    if (!reply.trim()) { setError("Write a reply before sending"); replyRef.current?.focus(); return; }
    const err = send(draft(), opts);
    if (err) setError(err); else { setReply(""); setError(""); }
  };
  const startReply = (all: boolean) => { setReplyAll(all); replyRef.current?.focus(); };
  const tomorrow = snoozeOptions()[1].at;
  const backLabel = folder.startsWith("label:") ? folder.slice(6) : folder[0].toUpperCase() + folder.slice(1);

  return (
    <div className="flex flex-col w-full">
      <div className="sticky top-0 z-30 bg-m-surface/90 backdrop-blur-md px-gutter py-space-sm flex flex-wrap items-center justify-between gap-space-sm shadow-xs border-b border-m-line/60">
        <div className="flex items-center gap-space-sm">
          <button type="button" onClick={closeThread} className="inline-flex items-center gap-1.5 px-space-sm py-1 rounded-m-lg bg-m-low hover:bg-m-mid text-m-text transition-colors t-headline-sm">
            <Icon name="arrow_back" className="text-[18px]" /><span>{backLabel}</span>
            {folder === "inbox" && unreadInbox > 0 && <span className="ml-1 px-1.5 rounded-m-pill bg-m-brand text-m-on-brand t-label-sm">{unreadInbox}</span>}
          </button>
          <div className="h-4 w-px bg-m-faint/40 mx-0.5" />
          <div className="flex items-center gap-0.5">
            <IconButton icon="archive" title="Archive (E)" size="text-[19px]" onClick={() => move([thread], "archive")} />
            <IconButton icon="report" title="Report spam (!)" size="text-[19px]" onClick={() => move([thread], "spam")} />
            <IconButton icon="delete" title="Delete (#)" size="text-[19px]" danger onClick={() => move([thread], "trash")} />
            <IconButton icon="mark_email_unread" title="Mark as unread (U)" size="text-[19px]" onClick={() => { markRead([thread], false); closeThread(); }} />
            <div className="relative">
              <button type="button" onClick={() => toggle("snooze")} title="Snooze" className="flex items-center gap-0.5 px-2 py-1 rounded-m-lg text-m-muted hover:text-m-text hover:bg-m-mid transition-colors">
                <Icon name="schedule" className="text-[19px]" /><Icon name="expand_more" className="text-[14px]" />
              </button>
              <Popover open={menu === "snooze"} onClose={close} className="left-0 top-full mt-1 w-48 py-1.5">
                <div className="px-3 py-1 t-label-sm text-m-muted uppercase tracking-wider">Snooze until</div>
                {snoozeOptions().map(o => <MenuItem key={o.label} icon={o.icon} hint={o.hint} onClick={() => { snooze([thread], o.at); close(); }}>{o.label}</MenuItem>)}
              </Popover>
            </div>
            <div className="relative hidden sm:block">
              <IconButton icon="drive_file_move" title="Move to folder (V)" size="text-[19px]" onClick={() => toggle("move")} />
              <Popover open={menu === "move"} onClose={close} className="left-0 top-full mt-1 w-44">
                {([["inbox", "Inbox", "inbox"], ["archive", "Archive", "archive"], ["spam", "Spam", "report"], ["trash", "Trash", "delete"]] as const).map(([id, name, icon]) => <MenuItem key={id} icon={icon} onClick={() => { move([thread], id); close(); }}>{name}</MenuItem>)}
              </Popover>
            </div>
            <div className="relative hidden sm:block">
              <button type="button" onClick={() => toggle("labels")} className="flex items-center gap-1 px-2 py-1 rounded-m-lg text-m-muted hover:text-m-text hover:bg-m-mid transition-colors t-body-sm">
                <Icon name="label" className="text-[17px]" /><span className="font-medium">Labels</span>{labels.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-m-secondary" />}
              </button>
              <Popover open={menu === "labels"} onClose={close} className="left-0 top-full mt-1 w-52">
                {box.labels.map(l => <MenuItem key={l.name} icon={labels.includes(l) ? "check_box" : "check_box_outline_blank"} onClick={() => toggleLabel([thread], l.name)}>{l.name}</MenuItem>)}
              </Popover>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-space-xs text-m-muted">
          {idx >= 0 && <div className="flex items-center gap-1 px-2 py-1 rounded-m bg-m-low t-label-md text-m-text font-semibold"><span>{idx + 1}</span><span className="text-m-muted font-normal">of</span><span>{rows.length}</span></div>}
          <div className="flex items-center">
            <IconButton icon="chevron_left" title="Newer thread (K)" className="p-1" disabled={idx <= 0} onClick={() => openThread(rows[idx - 1].thread)} />
            <IconButton icon="chevron_right" title="Older thread (J)" className="p-1" disabled={idx < 0 || idx >= rows.length - 1} onClick={() => openThread(rows[idx + 1].thread)} />
          </div>
          <div className="h-4 w-px bg-m-faint/40 mx-1 hidden sm:block" />
          <IconButton icon="print" title="Print conversation" className="hidden sm:block" onClick={() => window.print()} />
          <IconButton icon="open_in_new" title="Open in new tab" className="hidden sm:block" onClick={() => window.open(`/app/?thread=${encodeURIComponent(thread)}`, "_blank", "noopener")} />
        </div>
      </div>

      <div className="w-full px-gutter-lg py-space-md max-w-5xl mx-auto flex flex-col gap-space-md">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm pb-space-xs">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="t-headline-lg text-m-text tracking-tight">{subject}</h1>
              <div className="flex items-center gap-1.5 flex-wrap">
                {labels.map(l => <LabelChip key={l.name} label={l} className="font-semibold tracking-wide" />)}
                {messages.some(m => m.urgent) && <UrgentChip />}
                <span className="inline-flex items-center px-2 py-0.5 rounded-m-pill bg-m-high text-m-muted t-label-sm font-medium">{messages.length} message{messages.length > 1 ? "s" : ""}</span>
              </div>
            </div>
            <p className="t-body-sm text-m-muted flex flex-wrap items-center gap-1.5">
              <Icon name="lock" className="text-[15px]" /><span>End-to-end encrypted thread via Mac Tidar Enterprise Rail</span><span>•</span><span>Thread ID: #MTR-{(9042 + [...thread].reduce((a, c) => a + c.charCodeAt(0), 0) % 900)}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 self-start md:self-auto">
            <button type="button" onClick={() => startReply(false)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-m-lg bg-m-low hover:bg-m-mid text-m-text t-headline-sm transition-colors">
              <Icon name="reply" className="text-[16px]" /><span>Reply</span><kbd className="ml-1 px-1.5 py-0.5 rounded-m bg-m-card text-m-muted t-code">R</kbd>
            </button>
            <button type="button" onClick={() => startReply(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-m-lg bg-m-low hover:bg-m-mid text-m-text t-headline-sm transition-colors">
              <Icon name="reply_all" className="text-[16px]" /><span>Reply All</span><kbd className="ml-1 px-1.5 py-0.5 rounded-m bg-m-card text-m-muted t-code">A</kbd>
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {messages.map(m => m === latest || expanded.includes(m.id)
            ? <MessageCard key={m.id} m={m} me={account.email} onReply={() => startReply(false)} onReplyAll={() => startReply(true)} />
            : <Collapsed key={m.id} m={m} onOpen={() => setExpanded(e => [...e, m.id])} />)}
        </div>

        <div className="rounded-m-xl bg-m-card shadow-md overflow-hidden transition-all mt-space-xs border border-m-line/60 focus-within:ring-2 focus-within:ring-m-brand/30">
          <div className="p-space-md bg-m-low/60 flex items-center justify-between gap-space-sm cursor-text" onClick={() => replyRef.current?.focus()}>
            <div className="flex items-center gap-2 text-m-muted t-body-md min-w-0 flex-wrap">
              <Icon name={replyAll ? "reply_all" : "reply"} className="text-[18px] text-m-primary" />
              <span>Reply to {recipients.map((p, i) => <span key={p.email}>{i > 0 && (i === recipients.length - 1 ? " and " : ", ")}<strong className="text-m-text">{p.name}</strong></span>)}</span>
              <span className="text-m-outline t-label-sm">• {account.email}</span>
            </div>
            <IconButton icon="open_in_full" title="Pop out composer window" size="text-[16px]" className="p-1"
              onClick={() => { compose({ ...draft(), id: newId("d"), body: reply }, "full"); setReply(""); }} />
          </div>
          <div className="p-space-md">
            <textarea ref={replyRef} value={reply} onChange={e => { setReply(e.target.value); setError(""); }} rows={4}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); } }}
              placeholder="Type your response... (⌘↵ to send)" aria-label="Reply"
              className="w-full bg-transparent text-m-text placeholder:text-m-outline focus:outline-none resize-none t-body-lg leading-relaxed" />
            {error && <p className="t-label-md text-m-error mt-1" role="alert">{error}</p>}
          </div>
          <div className="px-space-md py-space-sm bg-m-low/40 flex flex-wrap items-center justify-between gap-space-sm">
            <div className="flex items-center gap-0.5">
              {[["format_bold", "Bold (⌘B)"], ["format_italic", "Italic (⌘I)"], ["link", "Insert link"], ["format_list_bulleted", "Bulleted list"], ["code", "Code snippet"]].map(([i, t]) =>
                <IconButton key={i} icon={i} title={`${t} — available in the full composer`} className="hidden sm:block" onClick={() => { compose({ ...draft(), id: newId("d"), body: reply }, "full"); setReply(""); }} />)}
              <div className="h-4 w-px bg-m-faint/40 mx-1 hidden sm:block" />
              <IconButton icon="mood" title="Insert emoji" onClick={() => setReply(r => r + " 🙂")} />
              <IconButton icon="magic_button" title="Insert template" onClick={() => setReply(r => r + (r ? "\n\n" : "") + "Thanks for the update — this looks great. Let’s lock it in for Thursday.")} />
            </div>
            <div className="flex items-center gap-space-xs">
              <IconButton icon="delete" title="Discard draft" danger onClick={() => { setReply(""); setError(""); if (reply) toast("Reply discarded"); }} />
              <button type="button" onClick={() => doSend({ archive: true })} className="px-2.5 py-1.5 rounded-m-lg text-m-muted hover:text-m-text hover:bg-m-mid t-headline-sm transition-colors">Send &amp; Archive</button>
              <div className="inline-flex rounded-m-xl bg-m-brand text-m-on-brand shadow-xs overflow-hidden">
                <button type="button" onClick={() => doSend()} className="flex items-center gap-1.5 px-3.5 py-1.5 hover:bg-m-brand-hover transition-colors t-headline-sm font-medium">
                  <span>Send</span><kbd className="px-1.5 py-0.5 rounded-m bg-white/20 t-code">⌘↵</kbd>
                </button>
                <button type="button" title={`Schedule for ${tomorrow.toLocaleString([], { weekday: "short", hour: "numeric" })}`} onClick={() => doSend({ scheduleAt: tomorrow })} className="px-2 py-1.5 hover:bg-m-brand-hover transition-colors border-l border-white/20">
                  <Icon name="schedule_send" className="text-[16px]" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
