"use client";

import { useState } from "react";
import { Category } from "./data";
import { folderMatch, ThreadRow, useMail } from "./store";
import { fmtListDate, Icon, IconButton, LabelChip, MenuItem, Popover, snoozeOptions, UrgentChip } from "./ui";

const PAGE = 50;
const folderTitles: Record<string, [string, string]> = {
  starred: ["Starred", "star"], snoozed: ["Snoozed", "schedule"], sent: ["Sent", "send"], drafts: ["Drafts", "draft"], scheduled: ["Scheduled", "send_and_archive"],
  archive: ["Archive", "archive"], spam: ["Spam", "report"], trash: ["Trash", "delete"],
};

function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: () => void; label: string; indeterminate?: boolean }) {
  return (
    <label className="flex items-center cursor-pointer p-1 -m-1" onClick={e => e.stopPropagation()}>
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <span className="w-3.5 h-3.5 rounded-m bg-m-low border border-m-faint/60 shadow-xs flex items-center justify-center transition-all peer-checked:bg-m-brand peer-checked:border-m-brand peer-focus-visible:ring-2 peer-focus-visible:ring-m-brand/40 text-m-on-brand">
        {(checked || indeterminate) && <Icon name={checked ? "check" : "remove"} className="text-[12px] font-bold" />}
      </span>
    </label>
  );
}

function Tabs() {
  const { box, tab, setTab } = useMail();
  const inbox = box.messages.filter(m => folderMatch("inbox", m));
  const senders = (c: Category) => [...new Set(inbox.filter(m => m.category === c).map(m => m.from.name.split(/[\s(]/)[0]))].slice(0, 3).join(", ");
  const unread = new Set(inbox.filter(m => m.category === "primary" && !m.read).map(m => m.thread)).size;
  const tabs: [Category, string, string][] = [["primary", "Primary", "inbox"], ["updates", "Updates", "info"], ["newsletters", "Newsletters", "newspaper"]];
  return (
    <div className="flex items-center gap-space-sm overflow-x-auto" role="tablist">
      {tabs.map(([id, name, icon]) => {
        const active = tab === id, note = id === "primary" ? (unread ? `${unread} new` : "") : senders(id);
        return (
          <button key={id} type="button" role="tab" aria-selected={active} onClick={() => setTab(id)}
            className={`group relative flex items-center gap-space-sm px-space-md py-space-sm whitespace-nowrap transition-all focus:outline-none ${active ? "text-m-primary t-headline-sm" : "text-m-muted hover:text-m-text t-body-md"}`}>
            <Icon name={icon} className="text-[18px]" fill={active} />
            <span>{name}</span>
            {note && <span className={`hidden md:inline-flex items-center justify-center px-1.5 py-0.5 rounded-m-pill t-label-sm ${active ? "bg-m-brand text-m-on-brand font-semibold tracking-tight shadow-xs" : "bg-m-mid text-m-muted"}`}>{note}</span>}
            {active && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-m-brand rounded-full" />}
          </button>
        );
      })}
    </div>
  );
}

function Toolbar({ total }: { total: number }) {
  const { rows, selected, setSelected, folder, move, destroy, markRead, snooze, toggleLabel, box, updateSettings, sort, setSort, page, setPage, toast } = useMail();
  const [menu, setMenu] = useState<null | "select" | "snooze" | "label" | "move" | "sort">(null);
  const close = () => setMenu(null);
  const toggle = (m: typeof menu) => setMenu(c => c === m ? null : m);
  const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE);
  const all = pageRows.length > 0 && pageRows.every(r => selected.includes(r.thread));
  const some = selected.length > 0;
  const by = (pred: (r: ThreadRow) => boolean) => { setSelected(pageRows.filter(pred).map(r => r.thread)); close(); };
  const density = box.settings.density;
  const start = total ? page * PAGE + 1 : 0, end = Math.min(total, (page + 1) * PAGE);
  const inBin = folder === "trash" || folder === "spam";

  return (
    <div className="flex items-center justify-between gap-space-sm px-gutter-lg py-space-xs bg-m-low">
      <div className="flex items-center gap-space-xs">
        <div className="relative inline-flex items-center rounded-m-lg bg-m-card shadow-xs hover:bg-m-mid transition-colors">
          <span className="px-2 py-1.5 flex"><Checkbox checked={all} indeterminate={some && !all} onChange={() => setSelected(all ? [] : pageRows.map(r => r.thread))} label="Select all conversations" /></span>
          <button type="button" aria-label="Selection options" onClick={() => toggle("select")} className="p-1 pr-1.5 text-m-muted hover:text-m-text"><Icon name="arrow_drop_down" className="text-[16px]" /></button>
          <Popover open={menu === "select"} onClose={close} className="left-0 top-full mt-1 w-36">
            <MenuItem onClick={() => by(() => true)} hint="⌘A">All</MenuItem>
            <MenuItem onClick={() => by(() => false)}>None</MenuItem>
            <MenuItem onClick={() => by(r => !r.unread)}>Read</MenuItem>
            <MenuItem onClick={() => by(r => r.unread)}>Unread</MenuItem>
            <MenuItem onClick={() => by(r => r.starred)}>Starred</MenuItem>
          </Popover>
        </div>
        <div className="h-4 w-px bg-m-faint/40 mx-1" />
        <div className="flex items-center gap-0.5">
          {inBin ? <>
            <IconButton icon="restore_from_trash" title={folder === "spam" ? "Not spam" : "Restore to Inbox"} disabled={!some} onClick={() => move(selected, "inbox")} />
            <IconButton icon="delete_forever" title="Delete forever" danger disabled={!some} onClick={() => destroy(selected)} />
          </> : <>
            <IconButton icon="archive" title="Archive (E)" disabled={!some} onClick={() => move(selected, "archive")} />
            <IconButton icon="report" title="Report spam (!)" disabled={!some} onClick={() => move(selected, "spam")} />
            <IconButton icon="delete" title="Delete (#)" danger disabled={!some} onClick={() => move(selected, "trash")} />
          </>}
          <IconButton icon="mark_email_read" title="Mark as read (Shift+I)" disabled={!some} onClick={() => markRead(selected, true)} />
          <div className="relative hidden sm:block">
            <IconButton icon="schedule" title="Snooze (B)" disabled={!some} onClick={() => toggle("snooze")} />
            <Popover open={menu === "snooze"} onClose={close} className="left-0 top-full mt-1 w-48">
              <div className="px-3 py-1 t-label-sm text-m-muted uppercase tracking-wider">Snooze until</div>
              {snoozeOptions().map(o => <MenuItem key={o.label} icon={o.icon} hint={o.hint} onClick={() => { snooze(selected, o.at); close(); }}>{o.label}</MenuItem>)}
            </Popover>
          </div>
          <div className="relative hidden sm:block">
            <IconButton icon="label" title="Add label (L)" disabled={!some} onClick={() => toggle("label")} />
            <Popover open={menu === "label"} onClose={close} className="left-0 top-full mt-1 w-52">
              <div className="px-3 py-1 t-label-sm text-m-muted uppercase tracking-wider">Label as</div>
              {box.labels.map(l => {
                const on = selected.every(t => box.messages.some(m => m.thread === t && m.labels.includes(l.name)));
                return <MenuItem key={l.name} icon={on ? "check_box" : "check_box_outline_blank"} onClick={() => toggleLabel(selected, l.name)}>{l.name}</MenuItem>;
              })}
            </Popover>
          </div>
          <div className="relative hidden md:block">
            <IconButton icon="drive_file_move" title="Move to folder (V)" disabled={!some} onClick={() => toggle("move")} />
            <Popover open={menu === "move"} onClose={close} className="left-0 top-full mt-1 w-44">
              {([["inbox", "Inbox", "inbox"], ["archive", "Archive", "archive"], ["spam", "Spam", "report"], ["trash", "Trash", "delete"]] as const).map(([id, name, icon]) =>
                <MenuItem key={id} icon={icon} onClick={() => { move(selected, id); close(); }}>{name}</MenuItem>)}
            </Popover>
          </div>
          {some && <span className="ml-2 t-label-sm text-m-muted whitespace-nowrap">{selected.length} selected</span>}
        </div>
      </div>

      <div className="flex items-center gap-space-sm t-label-md text-m-muted">
        <IconButton icon="refresh" title="Sync inbox (U)" onClick={() => toast("Mail is up to date")} className="hidden sm:block" />
        <div className="hidden md:flex items-center bg-m-mid p-0.5 rounded-m-lg">
          {(["comfortable", "compact"] as const).map(d => (
            <button key={d} type="button" onClick={() => updateSettings({ density: d })}
              className={`px-2 py-0.5 rounded-m t-label-sm transition-all ${density === d ? "text-m-text bg-m-card shadow-xs font-medium" : "text-m-muted hover:text-m-text"}`}>{d === "comfortable" ? "Comfortable" : "Compact"}</button>
          ))}
        </div>
        <div className="h-4 w-px bg-m-faint/40 hidden md:block" />
        <div className="relative hidden sm:block">
          <button type="button" onClick={() => toggle("sort")} className="flex items-center gap-1 px-2 py-1 rounded-m-lg hover:bg-m-high text-m-text transition-colors t-label-md">
            <span>{{ newest: "Newest first", oldest: "Oldest first", sender: "By sender" }[sort]}</span><Icon name="expand_more" className="text-[16px]" />
          </button>
          <Popover open={menu === "sort"} onClose={close} className="right-0 top-full mt-1 w-40">
            {(["newest", "oldest", "sender"] as const).map(s => <MenuItem key={s} onClick={() => { setSort(s); close(); }} hint={sort === s ? "✓" : undefined}>{{ newest: "Newest first", oldest: "Oldest first", sender: "By sender" }[s]}</MenuItem>)}
          </Popover>
        </div>
        <div className="flex items-center gap-1 pl-1">
          <span className="text-m-muted t-label-sm font-medium whitespace-nowrap">{start}–{end} of {total}</span>
          <div className="flex items-center">
            <IconButton icon="chevron_left" title="Newer" disabled={page === 0} onClick={() => setPage(page - 1)} className="p-1" />
            <IconButton icon="chevron_right" title="Older" disabled={end >= total} onClick={() => setPage(page + 1)} className="p-1" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ row }: { row: ThreadRow }) {
  const { box, folder, selected, setSelected, openThread, openDraft, toggleStar, move, markRead, snooze } = useMail();
  const m = row.latest, unread = row.unread, compact = box.settings.density === "compact";
  const isSel = selected.includes(row.thread);
  const draft = m.kind === "draft", scheduled = m.kind === "scheduled";
  const outgoing = folder === "sent" || draft || scheduled;
  const who = outgoing ? `To: ${m.to.map(p => p.name.split(" ")[0]).join(", ") || "(no recipient)"}` : m.from.name;
  const labels = box.labels.filter(l => row.messages.some(x => x.labels.includes(l.name)) && `label:${l.name}` !== folder);
  const file = row.messages.flatMap(x => x.attachments)[0];
  const open = () => draft ? openDraft(m) : openThread(row.thread);
  const preview = (m.body.split("\n").find(Boolean) ?? "").slice(0, 180);

  return (
    <div role="row" tabIndex={0} onClick={open} onKeyDown={e => { if (e.key === "Enter") open(); }} aria-selected={isSel}
      className={`group relative flex items-center justify-between px-gutter-lg ${compact ? "py-1.5" : "py-3"} cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-m-brand/50 ${isSel ? "bg-m-brand-soft" : unread ? "bg-m-surface hover:bg-m-mid/40" : "bg-m-lowest hover:bg-m-mid/30"}`}>
      {unread && <div className="absolute left-0 top-0 bottom-0 w-1 bg-m-brand" />}
      <div className="flex items-center gap-space-sm min-w-0 w-36 sm:w-52 xl:w-72 shrink-0 pr-space-sm">
        <Checkbox checked={isSel} onChange={() => setSelected(s => isSel ? s.filter(x => x !== row.thread) : [...s, row.thread])} label={`Select ${m.subject}`} />
        <button type="button" title={row.starred ? "Starred" : "Not starred"} aria-label={row.starred ? "Remove star" : "Star"} onClick={e => { e.stopPropagation(); toggleStar(row.thread); }}
          className={`hover:scale-110 transition-all focus:outline-none ${row.starred ? "text-m-star" : "text-m-faint hover:text-m-star"}`}>
          <Icon name="star" className="text-[18px]" fill={row.starred} />
        </button>
        <span className={`w-2 h-2 rounded-full shrink-0 ${unread ? "bg-m-brand" : ""}`} />
        <div className="flex items-center gap-2 min-w-0">
          <span className={`truncate ${unread ? "t-headline-sm text-m-text font-semibold" : "t-body-md text-m-text font-medium"}`}>{draft ? <span className="text-m-error">Draft</span> : who}</span>
          {!outgoing && m.from.title && <span className="hidden sm:inline t-label-sm text-m-muted truncate opacity-80">({m.from.title})</span>}
          {row.count > 1 && <span className="t-label-sm text-m-muted">{row.count}</span>}
        </div>
      </div>
      <div className="flex-1 flex items-center gap-space-md min-w-0 pr-gutter">
        {(labels.length > 0 || m.urgent) && (
          <div className="hidden md:flex items-center gap-space-xs shrink-0">
            {labels.slice(0, 2).map(l => <LabelChip key={l.name} label={l} />)}
            {row.messages.some(x => x.urgent) && <UrgentChip />}
          </div>
        )}
        <div className="flex items-baseline gap-2 min-w-0 overflow-hidden">
          <span className={`truncate shrink-0 max-w-full ${unread ? "t-headline-sm text-m-text font-semibold" : "t-body-md text-m-text"}`}>{m.subject || "(no subject)"}</span>
          <span className={`hidden sm:inline t-body-md truncate ${unread ? "text-m-muted" : "text-m-muted/80"}`}>– {preview}</span>
        </div>
        {file && (
          <div className="hidden xl:flex items-center gap-1 px-2 py-0.5 rounded-m-lg bg-m-mid text-m-muted t-label-sm shrink-0">
            <Icon name={file.icon} className="text-[14px]" /><span className="truncate max-w-[110px]">{file.name}</span><span className="text-m-muted/70 text-[10px]">{file.size}</span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-end w-24 sm:w-40 relative">
        <div className="flex items-center gap-2 group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
          {file && <Icon name="attach_file" className="text-[16px] text-m-muted" />}
          <span className={`t-label-md whitespace-nowrap ${unread ? "text-m-text font-semibold" : "text-m-muted"}`}>
            {scheduled && m.scheduledAt ? `Sends ${fmtListDate(m.scheduledAt)}` : m.snoozedUntil && folder === "snoozed" ? `Until ${fmtListDate(m.snoozedUntil)}` : fmtListDate(m.date)}
          </span>
        </div>
        {!draft && (
          <div className="absolute right-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center gap-1 bg-m-card/95 backdrop-blur-sm px-1 py-0.5 rounded-m-lg shadow-xs transition-all" onClick={e => e.stopPropagation()}>
            <IconButton icon="archive" title="Archive" size="text-[16px]" className="p-1" onClick={() => move([row.thread], "archive")} />
            <IconButton icon="delete" title="Delete" size="text-[16px]" className="p-1" danger onClick={() => move([row.thread], "trash")} />
            <IconButton icon={unread ? "drafts" : "mark_email_unread"} title={unread ? "Mark as read" : "Mark as unread"} size="text-[16px]" className="p-1" onClick={() => markRead([row.thread], unread)} />
            <IconButton icon="schedule" title="Snooze until tomorrow" size="text-[16px]" className="p-1" onClick={() => snooze([row.thread], snoozeOptions()[1].at)} />
          </div>
        )}
      </div>
    </div>
  );
}

function InboxZero() {
  const { box } = useMail();
  const today = new Date().toDateString();
  const sentToday = box.messages.filter(m => m.folder === "sent" && m.kind === "message" && new Date(m.date).toDateString() === today).length;
  return (
    <div className="p-gutter-lg flex items-center justify-between gap-space-md bg-m-low/50 my-4 rounded-2xl mx-gutter-lg">
      <div className="flex items-center gap-space-md">
        <div className="w-10 h-10 rounded-m-xl bg-m-brand-soft flex items-center justify-center text-m-primary shrink-0"><Icon name="insights" className="text-[24px]" /></div>
        <div>
          <h4 className="t-headline-sm text-m-text font-semibold">Inbox Zero Progress</h4>
          <p className="t-body-sm text-m-muted">You responded to {18 + sentToday} priority communications today with an average reply velocity of 14 minutes.</p>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-space-md">
        <div className="flex flex-col items-end">
          <span className="t-label-sm uppercase tracking-wider text-m-muted">Weekly Response Velocity</span>
          <span className="t-headline-sm text-m-text font-bold">98.4% On-Time</span>
        </div>
        <svg width="80" height="28" viewBox="0 0 80 28" fill="none" aria-hidden="true" className="text-m-primary"><path d="M1 22 L12 18 L22 20 L33 11 L44 14 L55 6 L66 9 L79 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
}

export function ShortcutBar() {
  return (
    <div className="relative shrink-0 hidden md:flex items-center justify-between px-gutter-lg py-2 bg-m-low shadow-[0_-1px_6px_rgba(0,0,0,0.03)] border-t border-m-line z-20">
      <div className="flex items-center gap-space-md text-m-muted t-label-sm overflow-x-auto py-1">
        <span className="font-semibold text-m-text uppercase tracking-wider text-[10px]">Shortcuts</span>
        {[[["C"], "Compose"], [["J", "K"], "Navigate"], [["E"], "Archive"], [["#"], "Delete"], [["R"], "Reply"], [["/"], "Search"]].map(([keys, label]) => (
          <span key={label as string} className="flex items-center gap-1.5 whitespace-nowrap">
            {(keys as string[]).map(k => <kbd key={k} className="px-1.5 py-0.5 rounded-m bg-m-card t-code text-m-text shadow-xs">{k}</kbd>)}<span>{label as string}</span>
          </span>
        ))}
      </div>
      <span className="hidden lg:inline-flex items-center gap-1 text-[11px] font-medium text-m-muted whitespace-nowrap"><span className="w-1.5 h-1.5 rounded-full bg-m-success" />Mac Tidar Production Cluster · v2.14.0</span>
    </div>
  );
}

export function InboxView() {
  const { rows, folder, page, query, filters, box, live, loading } = useMail();
  const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE);
  const [title, icon] = folder.startsWith("label:") ? [folder.slice(6), "label"] : folderTitles[folder] ?? ["Inbox", "inbox"];
  const filtered = !!query || Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      <div className="shrink-0 bg-m-lowest shadow-xs flex flex-col">
        <div className="flex items-center justify-between px-gutter-lg pt-space-sm pb-0 min-h-11">
          {folder === "inbox" && !query ? <Tabs /> : (
            <div className="flex items-center gap-space-sm px-space-md py-space-sm text-m-primary t-headline-sm">
              <Icon name={query ? "search" : icon} className="text-[18px]" />
              <span>{query ? `Results for “${query}”` : title}</span>
              <span className="px-1.5 py-0.5 rounded-m-pill bg-m-mid text-m-muted t-label-sm">{rows.length}</span>
            </div>
          )}
          <div className="hidden 2xl:flex items-center gap-space-md text-m-muted t-label-md">
            <div className="flex items-center gap-1.5 bg-m-low px-2 py-1 rounded-m-lg">
              <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-m-success opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-m-success" /></span>
              <span className="text-m-text font-medium">Sync Active</span><span className="text-m-muted">· 2s ago</span>
            </div>
          </div>
        </div>
        <Toolbar total={rows.length} />
        {live && live.lockedKeys > 0 && (
          <div className="flex items-center justify-between gap-3 px-gutter-lg py-2 t-body-sm" style={{ background: "var(--chip-invoices-bg)", color: "var(--chip-invoices-fg)" }}>
            <span className="flex items-center gap-2"><Icon name="lock" className="text-[16px]" />Some older mail is locked after a password reset.</span>
            <button type="button" onClick={live.openRecovery} className="font-semibold underline">Recover</button>
          </div>
        )}
      </div>
      <div className="flex-1 flex flex-col overflow-y-auto bg-m-lowest divide-y divide-m-line/60" role="grid" aria-label={`${title} conversations`}>
        {loading && <div className="flex-1 flex items-center justify-center gap-3 py-20 text-m-muted t-body-md"><span className="w-4 h-4 rounded-full border-2 border-m-brand border-t-transparent animate-spin" />Decrypting your mail…</div>}
        {pageRows.map(r => <Row key={r.thread} row={r} />)}
        {!loading && pageRows.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 py-20 text-m-muted">
            <Icon name={filtered ? "search_off" : "inbox"} className="text-[36px] text-m-faint" />
            <p className="t-body-md">{filtered ? "No conversations match your search." : `Your ${title.toLowerCase()} is clear.`}</p>
          </div>
        )}
        {folder === "inbox" && !filtered && pageRows.length > 0 && box.messages.length > 0 && <div className="border-0"><InboxZero /></div>}
      </div>
    </div>
  );
}

