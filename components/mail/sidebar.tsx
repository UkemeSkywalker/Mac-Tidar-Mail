"use client";

import { folderMatch, useMail } from "./store";
import { Icon, labelDot } from "./ui";

const mailboxes: [string, string, string][] = [
  ["inbox", "Inbox", "inbox"], ["starred", "Starred", "star"], ["snoozed", "Snoozed", "schedule"], ["sent", "Sent", "send"], ["drafts", "Drafts", "draft"],
  ["archive", "Archive", "archive"], ["spam", "Spam", "report"], ["trash", "Trash", "delete"],
];

export function Sidebar() {
  const { box, folder, setFolder, compose, setDialog, sidebarOpen, setSidebarOpen, collapsed } = useMail();
  const count = (id: string) => {
    const ms = box.messages.filter(m => folderMatch(id, m));
    if (id === "inbox") return new Set(ms.filter(m => !m.read && m.category === "primary").map(m => m.thread)).size;
    if (id === "starred" || id === "drafts" || id === "scheduled") return new Set(ms.map(m => m.thread)).size;
    return 0;
  };
  const labelCount = (name: string) => new Set(box.messages.filter(m => !m.read && folderMatch(`label:${name}`, m)).map(m => m.thread)).size;

  return (
    <>
      {sidebarOpen && <button aria-label="Close menu" className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={`fixed left-0 top-0 h-dvh w-64 bg-m-sb border-r border-m-sb-line flex flex-col z-50 shadow-[0_1px_8px_rgba(0,0,0,0.04)] transition-transform ${collapsed ? "lg:-translate-x-full" : "lg:translate-x-0"} ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="h-14 px-gutter flex items-center justify-between">
          <button type="button" onClick={() => setFolder("inbox")} className="flex items-center gap-space-sm min-w-0 text-left" title="Inbox">
            <span className="w-8 h-8 rounded-m-xl bg-m-sb-cta text-m-sb-cta-text flex items-center justify-center shrink-0"><Icon name="mail" className="text-[18px]" /></span>
            <span className="t-headline-sm text-m-sb-strong truncate tracking-tight">Mac Tidar Mail</span>
            <span className="px-space-xs py-0.5 rounded-m-pill bg-m-suite text-m-suite-text t-label-sm uppercase tracking-wide">Suite</span>
          </button>
        </div>

        <div className="px-gutter py-space-xs">
          <button type="button" onClick={() => compose()} className="w-full flex items-center justify-between px-space-md py-space-sm bg-m-sb-cta text-m-sb-cta-text rounded-m-xl hover:bg-m-sb-cta-hover transition-colors shadow-xs">
            <span className="flex items-center gap-space-sm"><Icon name="edit_square" className="text-[18px]" /><span className="t-headline-sm">New Message</span></span>
            <kbd className="px-space-xs py-0.5 rounded-m bg-black/10 t-code">C</kbd>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-space-xs py-space-sm space-y-space-md">
          <div className="space-y-0.5">
            <div className="px-space-md py-space-xs t-label-sm uppercase text-m-sb-muted font-medium tracking-wider">Mailboxes</div>
            <nav className="space-y-0.5">
              {mailboxes.map(([id, name, icon]) => {
                const active = folder === id, n = count(id);
                return (
                  <button key={id} type="button" onClick={() => setFolder(id)} aria-current={active ? "page" : undefined}
                    className={`w-full flex items-center justify-between px-space-md py-space-xs rounded-m-lg transition-colors ${active ? "bg-m-sb-active text-m-sb-active-text font-medium" : "text-m-sb-text hover:bg-m-sb-hover hover:text-m-sb-strong"}`}>
                    <span className="flex items-center gap-space-sm min-w-0"><Icon name={icon} className="text-[18px]" fill={active && id === "inbox"} /><span className="t-body-md truncate">{name}</span></span>
                    {n > 0 && (id === "inbox"
                      ? <span className="px-space-xs py-0.5 rounded-m-pill bg-m-sb-badge text-m-sb-badge-text t-label-sm font-semibold">{n}</span>
                      : <span className="px-space-xs py-0.5 rounded-m-pill bg-m-sb-pill text-m-sb-pill-text t-label-sm">{n}</span>)}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="space-y-0.5">
            <div className="px-space-md py-space-xs flex items-center justify-between">
              <span className="t-label-sm uppercase text-m-sb-muted font-medium tracking-wider">Labels</span>
              <button type="button" title="Create label" aria-label="Create label" onClick={() => setDialog({ kind: "label" })} className="p-0.5 rounded-m text-m-sb-muted hover:text-m-sb-strong hover:bg-m-sb-hover transition-colors">
                <Icon name="add" className="text-[16px]" />
              </button>
            </div>
            {box.labels.map(l => {
              const id = `label:${l.name}`, active = folder === id, n = labelCount(l.name);
              return (
                <button key={l.name} type="button" onClick={() => setFolder(id)}
                  className={`w-full flex items-center justify-between px-space-md py-space-xs rounded-m-lg transition-colors ${active ? "bg-m-sb-active text-m-sb-active-text" : "text-m-sb-text hover:bg-m-sb-hover hover:text-m-sb-strong"}`}>
                  <span className="flex items-center gap-space-sm min-w-0"><span className="w-2 h-2 rounded-full shrink-0" style={labelDot(l)} /><span className="t-body-md truncate">{l.name}</span></span>
                  {n > 0 && <span className="t-label-sm text-m-sb-muted">{n}</span>}
                </button>
              );
            })}
          </div>
        </div>

        <button type="button" onClick={() => setDialog({ kind: "settings", tab: "Storage" })} className="p-gutter bg-m-sb-footer text-left hover:brightness-105">
          <span className="flex items-center justify-between mb-space-xs">
            <span className="t-label-sm text-m-sb-muted">Storage</span>
            <span className="t-label-sm text-m-sb-strong font-medium">4.2 GB / 15 GB (28%)</span>
          </span>
          <span className="block w-full h-1.5 bg-m-sb-track rounded-full overflow-hidden"><span className="block h-full w-[28%] bg-m-sb-cta rounded-full" /></span>
        </button>
      </aside>
    </>
  );
}
