"use client";

import { CSSProperties, ReactNode, useEffect, useRef } from "react";
import { Label, LabelTone, Person } from "./data";

export function Icon({ name, className = "", fill = false }: { name: string; className?: string; fill?: boolean }) {
  return <span className={`ms-icon ${fill ? "ms-fill" : ""} ${className}`} aria-hidden="true">{name}</span>;
}

export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <kbd className={`px-1.5 py-0.5 rounded-m t-code ${className}`}>{children}</kbd>;
}

/** Unique-enough ids for locally created drafts and messages. */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase();

const avatarTones = ["var(--m-brand)", "var(--dot-product)", "var(--dot-investors)", "var(--dot-design)", "var(--dot-invoices)", "var(--dot-security)"];
export function Avatar({ person, size = "w-8 h-8", className = "" }: { person: Pick<Person, "name" | "email">; size?: string; className?: string }) {
  const tone = avatarTones[[...person.email].reduce((a, c) => a + c.charCodeAt(0), 0) % avatarTones.length];
  return (
    <span className={`${size} shrink-0 rounded-full inline-flex items-center justify-center t-label-md font-semibold text-white ${className}`} style={{ background: tone }} aria-hidden="true">
      {initials(person.name)}
    </span>
  );
}

const toneStyle = (tone: LabelTone | "urgent"): CSSProperties =>
  tone === "custom" ? { background: "var(--m-mid)", color: "var(--m-muted)" } : { background: `var(--chip-${tone}-bg)`, color: `var(--chip-${tone}-fg)` };
export const labelDot = (label?: Label): CSSProperties => ({ background: label && label.tone !== "custom" ? `var(--dot-${label.tone})` : "var(--m-outline)" });

export function LabelChip({ label, className = "" }: { label: Label; className?: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-m-pill t-label-sm font-medium ${className}`} style={toneStyle(label.tone)}>{label.name}</span>;
}
export function UrgentChip() {
  return <span className="inline-flex items-center px-2 py-0.5 rounded-m-pill t-label-sm font-semibold tracking-wide uppercase" style={toneStyle("urgent")}>Urgent</span>;
}

/** Popover that closes on outside click or Escape. */
export function Popover({ open, onClose, children, className = "" }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key, true); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={`absolute z-50 bg-m-card rounded-m-xl shadow-xl border border-m-line py-1 ${className}`}>{children}</div>;
}

export function MenuItem({ icon, children, onClick, hint, active }: { icon?: string; children: ReactNode; onClick: () => void; hint?: ReactNode; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 hover:bg-m-mid text-m-text t-body-md ${active ? "bg-m-mid" : ""}`}>
      <span className="flex items-center gap-2 min-w-0">{icon && <Icon name={icon} className="text-[16px] text-m-muted" />}<span className="truncate">{children}</span></span>
      {hint && <span className="t-code text-m-muted shrink-0">{hint}</span>}
    </button>
  );
}

export function IconButton({ icon, title, onClick, className = "", size = "text-[18px]", danger, disabled }: { icon: string; title: string; onClick?: () => void; className?: string; size?: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className={`p-1.5 rounded-m-lg text-m-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${danger ? "hover:text-m-error hover:bg-m-error-soft" : "hover:text-m-text hover:bg-m-high"} ${className}`}>
      <Icon name={icon} className={size} />
    </button>
  );
}

export function fmtListDate(iso: string) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

export function fmtLongDate(iso: string) {
  const d = new Date(iso), now = new Date();
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  const rel = mins < 60 ? `${Math.max(mins, 1)} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"} ago` : mins < 2880 ? "Yesterday" : `${Math.round(mins / 1440)} days ago`;
  const day = d.toDateString() === now.toDateString() ? "Today" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${rel})`;
}

export function snoozeOptions() {
  const later = new Date(); later.setHours(18, 0, 0, 0); if (later.getTime() < Date.now() + 30 * 60000) later.setTime(Date.now() + 3 * 3_600_000);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const monday = new Date(); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(8, 0, 0, 0);
  return [
    { icon: "sunny", label: "Later today", hint: later.toLocaleTimeString([], { hour: "numeric" }), at: later },
    { icon: "wb_twilight", label: "Tomorrow", hint: "8 AM", at: tomorrow },
    { icon: "next_week", label: "Next week", hint: "Mon", at: monday },
  ];
}
