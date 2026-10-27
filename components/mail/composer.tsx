"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { accounts, Attachment, directory, Person } from "./data";
import { Draft, useMail } from "./store";
import { Avatar, Icon, IconButton, MenuItem, Popover } from "./ui";

const asPerson = (raw: string): Person | null => {
  const t = raw.trim().replace(/[,;]$/, "");
  if (!t) return null;
  const known = [...directory, ...accounts].find(p => p.email.toLowerCase() === t.toLowerCase());
  return known ? { name: known.name, email: known.email } : { name: t.split("@")[0], email: t };
};

function RecipientField({ label, value, onChange, autoFocus, compact }: { label: string; value: Person[]; onChange: (p: Person[]) => void; autoFocus?: boolean; compact?: boolean }) {
  const { box } = useMail();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const contacts = useMemo(() => {
    const seen = new Map<string, Person>();
    [...directory, ...accounts, ...box.messages.map(m => m.from)].forEach(p => { if (!seen.has(p.email)) seen.set(p.email, { name: p.name, email: p.email, title: "title" in p ? p.title : undefined }); });
    return [...seen.values()];
  }, [box.messages]);
  const q = text.trim().toLowerCase();
  const suggestions = q ? contacts.filter(p => !value.some(v => v.email === p.email) && (p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))).slice(0, 5) : [];
  const add = (p: Person | null) => { if (p && !value.some(v => v.email === p.email)) onChange([...value, p]); setText(""); setActive(0); };

  return (
    <div className={`flex items-center flex-wrap gap-2 ${compact ? "min-h-7" : "min-h-[36px]"}`}>
      <span className={`${compact ? "w-8 t-body-sm text-m-muted/70" : "w-10 t-headline-sm text-m-muted"}`}>{label}</span>
      {value.map(p => (
        <span key={p.email} className="flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-m-pill shadow-xs max-w-full" style={{ background: "var(--chip-product-bg)", color: "var(--chip-product-fg)" }}>
          <Avatar person={p} size="w-5 h-5" className="text-[9px]" />
          <span className="t-label-md font-medium truncate">{p.name}</span>
          {!compact && <span className="hidden sm:inline t-label-sm opacity-70 font-mono truncate">&lt;{p.email}&gt;</span>}
          <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter(v => v.email !== p.email))} className="ml-0.5 opacity-60 hover:opacity-100"><Icon name="close" className="text-[14px]" /></button>
        </span>
      ))}
      <div className="relative flex-1 min-w-[140px]">
        <input value={text} autoFocus={autoFocus} aria-label={`${label} recipients`} placeholder={value.length ? "" : "Add recipient..."}
          onChange={e => { const v = e.target.value; if (/[,;\s]$/.test(v) && v.includes("@")) add(asPerson(v)); else setText(v); }}
          onKeyDown={e => {
            if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setActive(a => (a + 1) % suggestions.length); }
            else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setActive(a => (a - 1 + suggestions.length) % suggestions.length); }
            else if ((e.key === "Enter" || e.key === "Tab") && text.trim()) { e.preventDefault(); add(suggestions[active] ?? asPerson(text)); }
            else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => { if (text.includes("@")) add(asPerson(text)); }}
          className="w-full bg-transparent text-m-text t-body-md focus:outline-none placeholder:text-m-muted/50" />
        {suggestions.length > 0 && (
          <div className="absolute left-0 top-full mt-2 w-80 max-w-[85vw] bg-m-card rounded-m-xl shadow-xl p-space-xs z-50 flex flex-col space-y-0.5 border border-m-line" role="listbox">
            <div className="px-space-sm py-1 t-label-sm text-m-muted uppercase tracking-wider">Suggested Contacts</div>
            {suggestions.map((p, i) => (
              <button key={p.email} type="button" role="option" aria-selected={i === active} onMouseDown={e => { e.preventDefault(); add(p); }}
                className={`w-full flex items-center justify-between p-space-sm rounded-m-lg text-left transition-colors ${i === active ? "bg-m-mid" : "hover:bg-m-mid"}`}>
                <span className="flex items-center gap-space-sm min-w-0">
                  <Avatar person={p} size="w-7 h-7" />
                  <span className="min-w-0"><span className="block t-headline-sm text-m-text truncate">{p.name}</span><span className={`block t-label-sm truncate ${i === active ? "text-m-primary" : "text-m-muted"}`}>{p.email}</span></span>
                </span>
                {i === active ? <kbd className="px-1 py-0.5 rounded-m bg-m-highest text-m-muted t-code">↵</kbd> : p.title && <span className="t-label-sm text-m-muted">{p.title}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const fmtSize = (b: number) => b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export function Composer() {
  const { composer, setComposer, editDraft, persistDraft, closeComposer, send, account, box, toast } = useMail();
  const { draft, mode, minimized, open } = composer;
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Autosave into Drafts shortly after typing stops.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { persistDraft(draft); if (draft.to.length || draft.subject || draft.body) setSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })); }, 1200);
    return () => clearTimeout(t);
  }, [draft, open, persistDraft]);

  // Keep the rich editor in sync when the draft is replaced (new compose, mode switch).
  useEffect(() => { if (editor.current && editor.current.innerText !== draft.body) editor.current.innerText = draft.body; }, [draft.id, mode, minimized]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const update = (patch: Partial<Draft>) => { editDraft(patch); setError(""); };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const limit = 2 * 1_048_576;
    const ok = [...files].filter(f => f.size <= limit);
    if (ok.length < files.length) toast("Files over 2 MB were skipped (current limit)");
    const added = await Promise.all(ok.map(async f => ({ name: f.name, size: fmtSize(f.size), type: f.type, data: new Uint8Array(await f.arrayBuffer()), icon: f.type.includes("pdf") ? "picture_as_pdf" : f.type.startsWith("image/") ? "image" : "description" } satisfies Attachment)));
    update({ attachments: [...draft.attachments, ...added] });
  };
  const deliver = async (scheduleAt?: Date) => {
    if (sending) return;
    const sig = box.settings.signature.trim();
    setSending(true);
    const err = await send({ ...draft, body: sig && !draft.body.includes(sig) ? `${draft.body.trimEnd()}\n\n${sig}` : draft.body }, { scheduleAt });
    setSending(false);
    if (err) { setError(err); return; }
    setComposer(c => ({ ...c, open: false }));
  };
  const format = (cmd: string, arg?: string) => { editor.current?.focus(); document.execCommand(cmd, false, arg); update({ body: editor.current?.innerText ?? draft.body }); };
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const monday = new Date(); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(8, 0, 0, 0);
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); deliver(); } if (e.key === "Escape") { e.stopPropagation(); closeComposer(); } };
  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); },
  };
  const header = (title: string, extra?: React.ReactNode) => (
    <div className={`flex items-center justify-between select-none cursor-pointer ${mode === "full" ? "h-11 px-space-md bg-m-low" : "px-space-md py-space-sm bg-m-high"}`}
      onClick={() => setComposer(c => ({ ...c, minimized: !c.minimized }))}>
      <div className="flex items-center gap-space-sm min-w-0">
        {mode === "full" ? <span className="w-2.5 h-2.5 rounded-full bg-m-brand animate-pulse" /> : <Icon name="edit_note" className="text-[16px] text-m-primary" />}
        <span className="t-headline-sm text-m-text font-semibold truncate">{title}</span>{extra}
      </div>
      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <IconButton icon={minimized ? "expand_less" : "minimize"} title={minimized ? "Restore" : "Minimize"} size="text-[16px]" className="p-1" onClick={() => setComposer(c => ({ ...c, minimized: !c.minimized }))} />
        <IconButton icon={mode === "full" ? "close_fullscreen" : "open_in_full"} title={mode === "full" ? "Exit full window" : "Expand"} size="text-[16px]" className="p-1"
          onClick={() => setComposer(c => ({ ...c, mode: c.mode === "full" ? "mini" : "full", minimized: false }))} />
        <IconButton icon="close" title="Close (saves draft)" size="text-[16px]" className="p-1" danger onClick={() => closeComposer()} />
      </div>
    </div>
  );
  const fileInputEl = <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />;

  if (mode === "mini") return (
    <div className={`fixed right-3 sm:right-6 bottom-3 sm:bottom-12 w-[calc(100vw-1.5rem)] sm:w-96 bg-m-card rounded-m-xl shadow-2xl z-[60] overflow-hidden border border-m-line ${dragging ? "ring-2 ring-m-brand" : ""}`} onKeyDown={onKey} {...dropProps} role="dialog" aria-label="New message">
      {header(`${draft.subject ? draft.subject : "New Message"} · Draft`)}
      {!minimized && (
        <div className="p-space-md space-y-space-sm">
          <div className="flex items-center justify-between gap-2 text-m-muted t-body-sm pb-1">
            <div className="flex-1 min-w-0"><RecipientField label="To" value={draft.to} onChange={to => update({ to })} autoFocus={!draft.to.length} compact /></div>
            <button type="button" onClick={() => { setShowCc(true); setComposer(c => ({ ...c, mode: "full" })); }} className="text-[11px] text-m-primary hover:underline shrink-0">Cc Bcc</button>
          </div>
          <div className="w-full h-px bg-m-high" />
          <div className="flex items-center gap-2 text-m-muted t-body-sm pb-1">
            <span className="text-m-muted/70 w-8">Subj</span>
            <input value={draft.subject} onChange={e => update({ subject: e.target.value })} placeholder="Subject" aria-label="Subject" className="w-full bg-transparent text-m-text font-semibold focus:outline-none" />
          </div>
          <div className="w-full h-px bg-m-high" />
          <textarea value={draft.body} onChange={e => update({ body: e.target.value })} rows={5} placeholder="Type your message here..." aria-label="Message body"
            className="w-full bg-transparent text-m-text t-body-sm focus:outline-none resize-none pt-1" />
          {draft.attachments.length > 0 && <div className="flex flex-wrap gap-1">{draft.attachments.map(a => <span key={a.name} className="flex items-center gap-1 px-2 py-0.5 rounded-m-pill bg-m-mid t-label-sm text-m-muted"><Icon name="attach_file" className="text-[12px]" />{a.name}</span>)}</div>}
          {error && <p className="t-label-md text-m-error" role="alert">{error}</p>}
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1 text-m-muted">
              <IconButton icon="format_bold" title="Formatting — opens the full composer" size="text-[16px]" className="p-1" onClick={() => setComposer(c => ({ ...c, mode: "full" }))} />
              <IconButton icon="format_italic" title="Formatting — opens the full composer" size="text-[16px]" className="p-1" onClick={() => setComposer(c => ({ ...c, mode: "full" }))} />
              <IconButton icon="link" title="Insert link — opens the full composer" size="text-[16px]" className="p-1" onClick={() => setComposer(c => ({ ...c, mode: "full" }))} />
              <IconButton icon="attach_file" title="Attach files" size="text-[16px]" className="p-1" onClick={() => fileInput.current?.click()} />
              <IconButton icon="sentiment_satisfied" title="Insert emoji" size="text-[16px]" className="p-1" onClick={() => update({ body: draft.body + "🙂" })} />
              {fileInputEl}
            </div>
            <button type="button" onClick={() => deliver()} className="px-3 py-1.5 rounded-m-lg bg-m-brand text-m-on-brand t-headline-sm text-xs font-semibold hover:bg-m-brand-hover transition-all flex items-center gap-1 shadow-xs">
              <span>Send</span><Icon name="send" className="text-[14px]" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-end p-3 sm:p-6 bg-m-canvas/50 backdrop-blur-[2px]" onMouseDown={e => { if (e.target === e.currentTarget) closeComposer(); }}>
      <div className={`w-full max-w-[760px] max-h-full bg-m-card rounded-m-xl shadow-2xl flex flex-col overflow-hidden border border-m-line ${dragging ? "ring-2 ring-m-brand" : ""}`} onKeyDown={onKey} {...dropProps} role="dialog" aria-label="New message">
        {header(draft.thread ? "Reply" : "New Message", draft.subject && <span className="hidden sm:inline t-label-sm text-m-muted px-space-xs py-0.5 rounded-m bg-m-mid truncate max-w-[220px]">Thread: {draft.subject.replace(/^(re|fwd):\s*/i, "")}</span>)}
        {!minimized && <>
          <div className="px-space-md pt-space-sm pb-space-xs flex flex-col gap-space-xs relative bg-m-card">
            <div className="flex items-start gap-2">
              <div className="flex-1"><RecipientField label="To" value={draft.to} onChange={to => update({ to })} autoFocus={!draft.to.length} /></div>
              {!showCc && <div className="flex items-center gap-1 text-m-muted pt-1.5"><button type="button" onClick={() => setShowCc(true)} className="px-space-xs py-0.5 rounded-m t-label-sm hover:bg-m-mid hover:text-m-text">Cc</button><button type="button" onClick={() => setShowCc(true)} className="px-space-xs py-0.5 rounded-m t-label-sm hover:bg-m-mid hover:text-m-text">Bcc</button></div>}
            </div>
            {showCc && <RecipientField label="Cc" value={draft.cc} onChange={cc => update({ cc })} />}
            <div className="flex items-center gap-2 pt-space-xs">
              <span className="w-10 t-headline-sm text-m-muted">Subj</span>
              <input value={draft.subject} onChange={e => update({ subject: e.target.value })} placeholder="Subject" aria-label="Subject" className="flex-1 bg-transparent text-m-text t-headline-sm font-semibold focus:outline-none" />
            </div>
          </div>
          <div className="px-space-md py-1.5 bg-m-low flex items-center gap-1 flex-wrap">
            {[["format_bold", "Bold (⌘B)", "bold"], ["format_italic", "Italic (⌘I)", "italic"], ["format_underlined", "Underline (⌘U)", "underline"], ["strikethrough_s", "Strikethrough", "strikeThrough"]].map(([i, t, c]) =>
              <IconButton key={i} icon={i} title={t} className="p-1" onClick={() => format(c)} />)}
            <div className="w-px h-4 bg-m-faint/40 mx-1" />
            <IconButton icon="title" title="Heading" className="p-1" onClick={() => format("formatBlock", "h3")} />
            <IconButton icon="format_list_bulleted" title="Bullet list" className="p-1" onClick={() => format("insertUnorderedList")} />
            <IconButton icon="format_list_numbered" title="Numbered list" className="p-1 hidden sm:block" onClick={() => format("insertOrderedList")} />
            <div className="w-px h-4 bg-m-faint/40 mx-1 hidden sm:block" />
            <IconButton icon="code_blocks" title="Code block" className="p-1 hidden sm:block" onClick={() => format("formatBlock", "pre")} />
            <IconButton icon="link" title="Insert link (⌘K)" className="p-1" onClick={() => { const u = prompt("Link URL"); if (u && /^https?:\/\//i.test(u)) format("createLink", u); else if (u) toast("Links must start with http:// or https://"); }} />
            <IconButton icon="format_quote" title="Quote" className="p-1 hidden sm:block" onClick={() => format("formatBlock", "blockquote")} />
            {draft.attachments.map(a => (
              <span key={a.name} className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded-m-pill bg-m-mid text-m-muted t-label-sm max-w-[260px]">
                <Icon name="attach_file" className="text-[14px] text-m-primary" /><span className="truncate">{a.name}</span><span className="text-m-muted/60">({a.size})</span>
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => update({ attachments: draft.attachments.filter(x => x !== a) })}><Icon name="close" className="text-[12px]" /></button>
              </span>
            ))}
          </div>
          <div className="p-space-md min-h-[220px] max-h-[50vh] overflow-y-auto bg-m-card flex flex-col justify-between">
            <div ref={editor} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message body"
              onInput={e => update({ body: (e.target as HTMLDivElement).innerText })}
              className="min-h-[140px] t-body-lg text-m-text leading-relaxed focus:outline-none whitespace-pre-wrap [&_blockquote]:border-l-2 [&_blockquote]:border-m-faint [&_blockquote]:pl-3 [&_blockquote]:text-m-muted [&_pre]:bg-m-low [&_pre]:p-2 [&_pre]:rounded-m-lg [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h3]:t-headline-md [&_a]:text-m-primary [&_a]:underline empty:before:content-['Write_your_message…'] empty:before:text-m-outline" />
            {box.settings.signature && (
              <div className="mt-6 flex items-center gap-space-md bg-m-low/70 p-space-md rounded-m-xl">
                <Avatar person={account} size="w-12 h-12" className="t-headline-sm shadow-xs" />
                <div className="flex flex-col min-w-0">
                  <span className="t-headline-sm text-m-text font-semibold">{account.name}</span>
                  <span className="t-label-md text-m-primary font-medium">{account.role}</span>
                  <div className="flex flex-wrap items-center gap-space-xs text-m-muted t-body-sm mt-0.5"><span>{account.email}</span><span>•</span><span className="text-m-secondary font-medium">mactidar.com</span></div>
                </div>
              </div>
            )}
          </div>
          {error && <p className="px-space-md pb-1 t-label-md text-m-error" role="alert">{error}</p>}
          <div className="min-h-14 px-space-md py-2 bg-m-mid flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-space-xs">
              <div className="relative inline-flex rounded-m-lg shadow-xs">
                <button type="button" onClick={() => deliver()} className="flex items-center gap-space-sm px-space-md py-1.5 bg-m-brand text-m-on-brand hover:bg-m-brand-hover transition-colors t-headline-sm rounded-l-m-lg">
                  <span>Send</span><kbd className="px-1 py-0.5 rounded-m bg-white/20 t-code">⌘↵</kbd>
                </button>
                <button type="button" title="More send options" aria-label="More send options" onClick={() => setMenu(o => !o)} className="px-space-xs py-1.5 bg-m-brand text-m-on-brand hover:bg-m-brand-hover transition-colors border-l border-white/20 rounded-r-m-lg">
                  <Icon name="arrow_drop_down" className="text-[18px]" />
                </button>
                <Popover open={menu} onClose={() => setMenu(false)} className="left-0 bottom-full mb-2 w-56">
                  <div className="px-3 py-1 t-label-sm text-m-muted uppercase tracking-wider">Schedule send</div>
                  <MenuItem icon="timer" onClick={() => { setMenu(false); deliver(new Date(Date.now() + 60_000)); }} hint="demo">In 1 minute</MenuItem>
                  <MenuItem icon="wb_twilight" onClick={() => { setMenu(false); deliver(tomorrow); }}>Tomorrow, 8:00 AM</MenuItem>
                  <MenuItem icon="next_week" onClick={() => { setMenu(false); deliver(monday); }}>Monday, 8:00 AM</MenuItem>
                </Popover>
              </div>
              <button type="button" onClick={() => deliver(tomorrow)} className="hidden sm:flex items-center gap-1 px-space-sm py-1.5 rounded-m-lg bg-m-card hover:bg-m-high text-m-text transition-colors shadow-xs t-label-md">
                <Icon name="schedule_send" className="text-[16px] text-m-secondary" /><span>Send tomorrow, 8:00 AM</span>
              </button>
            </div>
            <div className="hidden md:flex items-center gap-1.5 text-m-muted t-label-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-m-success" /><span>{savedAt ? `Draft saved at ${savedAt} (Local persistence)` : "Drafts save automatically"}</span>
            </div>
            <div className="flex items-center gap-1">
              <IconButton icon="attach_file" title="Attach file" onClick={() => fileInput.current?.click()} />
              <IconButton icon="link" title="Insert link" onClick={() => { const u = prompt("Link URL"); if (u && /^https?:\/\//i.test(u)) format("createLink", u); }} />
              <IconButton icon="add_reaction" title="Insert emoji" onClick={() => format("insertText", "🙂")} />
              <div className="w-px h-4 bg-m-faint/40 mx-1" />
              <IconButton icon="delete" title="Discard draft" danger onClick={() => closeComposer(true)} />
              {fileInputEl}
            </div>
          </div>
        </>}
      </div>
    </div>
  );
}
