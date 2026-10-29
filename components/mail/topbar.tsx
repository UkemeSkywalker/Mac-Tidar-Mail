"use client";

import Link from "next/link";
import { useState } from "react";
import { saveSkin, SkinKey, useSkin } from "../skin-store";
import { MAIL_SKINS } from "./skins";
import { useMail } from "./store";
import { Avatar, Icon, MenuItem, Popover } from "./ui";

export function Topbar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const { query, setQuery, filters, setFilters, setPalette, setDialog, setSidebarOpen, collapsed, setCollapsed, account, toast, live } = useMail();
  const [menu, setMenu] = useState<null | "filters" | "skin" | "apps" | "account">(null);
  const skin = useSkin();
  const close = () => setMenu(null);
  const toggle = (m: typeof menu) => setMenu(cur => cur === m ? null : m);
  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <header className={`fixed top-0 right-0 h-14 bg-m-header backdrop-blur-xl border-b border-m-header-line shadow-[0_1px_8px_rgba(0,0,0,0.04)] z-40 px-gutter flex items-center justify-between gap-space-md transition-[left] left-0 ${collapsed ? "lg:left-0" : "lg:left-64"}`}>
      <div className="flex items-center gap-space-md flex-1 max-w-2xl min-w-0">
        <button type="button" title="Toggle sidebar" aria-label="Toggle sidebar" onClick={() => matchMedia("(min-width: 1024px)").matches ? setCollapsed(c => !c) : setSidebarOpen(o => !o)}
          className="p-space-xs rounded-m text-m-muted hover:bg-m-mid hover:text-m-text transition-colors">
          <Icon name={collapsed ? "menu" : "menu_open"} className="text-[20px]" />
        </button>
        <div className="relative flex-1 min-w-0">
          <div className="absolute inset-y-0 left-0 pl-space-sm flex items-center pointer-events-none"><Icon name="search" className="text-[18px] text-m-muted" /></div>
          <input ref={searchRef} type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search mail"
            placeholder="Search messages, people, or labels (Press / to search)..."
            className="w-full h-9 pl-8 pr-16 bg-m-low rounded-m-lg text-m-text placeholder:text-m-muted focus:outline-none focus:bg-m-mid t-body-sm [&::-webkit-search-cancel-button]:hidden" />
          <div className="absolute inset-y-0 right-0 pr-space-xs flex items-center gap-1">
            <button type="button" onClick={() => setPalette(true)} title="Command palette" className="hidden sm:block px-1.5 py-0.5 rounded-m bg-m-high text-m-muted t-code hover:text-m-text">⌘K</button>
            <div className="relative">
              <button type="button" title="Search filters" aria-label="Search filters" onClick={() => toggle("filters")} className={`p-1 hover:text-m-text relative ${activeFilters ? "text-m-primary" : "text-m-muted"}`}>
                <Icon name="tune" className="text-[16px]" />
                {activeFilters > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-m-brand" />}
              </button>
              <Popover open={menu === "filters"} onClose={close} className="right-0 top-full mt-2 w-52">
                <div className="px-3 py-1 t-label-sm text-m-muted uppercase tracking-wider">Search filters</div>
                {([["unread", "Unread", "mark_email_unread"], ["starred", "Starred", "star"], ["attachments", "Has attachment", "attach_file"]] as const).map(([k, label, icon]) => (
                  <MenuItem key={k} icon={icon} onClick={() => setFilters(f => ({ ...f, [k]: !f[k] }))} hint={filters[k] ? "✓" : undefined}>{label}</MenuItem>
                ))}
                <div className="my-1 border-t border-m-line" />
                <MenuItem icon="filter_alt_off" onClick={() => { setFilters({}); close(); }}>Clear filters</MenuItem>
              </Popover>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-space-sm">
        <div className="relative">
          <button type="button" title="Interface skin" aria-label="Interface skin" onClick={() => toggle("skin")} className="p-space-xs rounded-m text-m-muted hover:bg-m-mid hover:text-m-text transition-colors">
            <Icon name="light_mode" className="text-[20px]" />
          </button>
          <Popover open={menu === "skin"} onClose={close} className="right-0 top-full mt-2 w-60 p-1">
            <div className="px-2 py-1 t-label-sm text-m-muted uppercase tracking-wider">Interface skin</div>
            {MAIL_SKINS.map(s => (
              <button key={s.key} type="button" onClick={() => { saveSkin(s.key as SkinKey); close(); }} className={`w-full flex items-center gap-3 px-2 py-2 rounded-m-xl text-left hover:bg-m-mid ${s.key === skin ? "bg-m-mid" : ""}`}>
                <span className="flex -space-x-1">{s.swatch.map(c => <i key={c} className="w-3.5 h-3.5 rounded-full border border-white/70" style={{ background: c }} />)}</span>
                <span className="flex-1 min-w-0"><b className="block t-label-md text-m-text">{s.name}</b><em className="not-italic t-label-sm text-m-muted">{s.note}</em></span>
                {s.key === skin && <Icon name="check" className="text-[16px] text-m-primary" />}
              </button>
            ))}
          </Popover>
        </div>
        <button type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setDialog({ kind: "shortcuts" })} className="hidden sm:block p-space-xs rounded-m text-m-muted hover:bg-m-mid hover:text-m-text transition-colors"><Icon name="help" className="text-[20px]" /></button>
        <button type="button" title="Settings" aria-label="Settings" onClick={() => setDialog({ kind: "settings" })} className="p-space-xs rounded-m text-m-muted hover:bg-m-mid hover:text-m-text transition-colors"><Icon name="settings" className="text-[20px]" /></button>
        <div className="relative hidden sm:block">
          <button type="button" title="Mac Tidar apps" aria-label="Mac Tidar apps" onClick={() => toggle("apps")} className="p-space-xs rounded-m text-m-muted hover:bg-m-mid hover:text-m-text transition-colors"><Icon name="apps" className="text-[20px]" /></button>
          <Popover open={menu === "apps"} onClose={close} className="right-0 top-full mt-2 w-64 p-2">
            <div className="px-1 pb-2 t-label-sm text-m-muted uppercase tracking-wider">Mac Tidar Suite</div>
            <div className="grid grid-cols-3 gap-1">
              {[["mail", "Mail", "/app/"], ["cloud", "Cloud", ""], ["key", "Account", ""], ["home", "Home", "/"]].map(([icon, name, href]) => href
                ? <Link key={name} href={href} onClick={close} className="flex flex-col items-center gap-1 p-2 rounded-m-xl hover:bg-m-mid text-m-text"><Icon name={icon} className="text-[22px] text-m-primary" /><span className="t-label-sm">{name}</span></Link>
                : <button key={name} type="button" onClick={() => { toast(`Mac Tidar ${name} is coming soon`); close(); }} className="flex flex-col items-center gap-1 p-2 rounded-m-xl hover:bg-m-mid text-m-muted"><Icon name={icon} className="text-[22px]" /><span className="t-label-sm">{name}</span></button>)}
            </div>
          </Popover>
        </div>
        <div className="relative ml-space-xs">
          <button type="button" onClick={() => toggle("account")} aria-label="Account menu" className="flex items-center gap-space-sm p-1 rounded-full hover:bg-m-mid transition-colors">
            <Avatar person={account} />
            <span className="hidden xl:flex flex-col text-left">
              <span className="flex items-center gap-1"><span className="t-label-md text-m-text font-semibold">{account.name}</span><span className="w-2 h-2 rounded-full bg-m-success" /></span>
              <span className="t-label-sm text-m-muted">{account.email}</span>
            </span>
            <Icon name="expand_more" className="text-[16px] text-m-muted hidden xl:block" />
          </button>
          <Popover open={menu === "account"} onClose={close} className="right-0 top-full mt-2 w-72 p-1">
            <div className="px-2 py-1 t-label-sm text-m-muted uppercase tracking-wider">Mac Tidar Account</div>
            <div className="w-full flex items-center gap-3 px-2 py-2 rounded-m-xl">
              <Avatar person={account} />
              <span className="flex-1 min-w-0"><b className="block t-label-md text-m-text truncate">{account.name}</b><span className="t-label-sm text-m-muted truncate">{account.email}</span></span>
              <Icon name="check" className="text-[16px] text-m-primary" />
            </div>
            <div className="my-1 border-t border-m-line" />
            {live.switchMailbox && <MenuItem icon="switch_account" onClick={() => { close(); live.switchMailbox?.(); }}>Switch mailbox</MenuItem>}
            <MenuItem icon="lock" onClick={() => { close(); live.lock(); }}>Lock mailbox</MenuItem>
            <MenuItem icon="logout" onClick={() => { close(); void live.signOut(); }}>Sign out</MenuItem>
            <MenuItem icon="devices" onClick={() => { close(); if (confirm("Sign out of Mac Tidar Mail on every device, including this one?")) void live.signOutEverywhere(); }}>Sign out of all devices</MenuItem>
          </Popover>
        </div>
      </div>
    </header>
  );
}
