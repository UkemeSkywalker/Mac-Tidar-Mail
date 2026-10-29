"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CSSProperties, ReactNode, useEffect, useState } from "react";
import { saveSkin, useSkin, type SkinKey } from "./skin-store";
import { hasStoredSignIn, liveEnabled } from "./mail/live/config";

// Every account entry point opens the mail app; the demo reads ?mode= to show sign-in or sign-up.
const APP_URL = "/app/";
const SIGN_UP_URL = "/app/?mode=signup";
const SIGN_IN_URL = "/app/?mode=signin";

type Palette = { forest: string; deep: string; night: string; mint: string; linen: string; border: string };
type Skin = { name: string; note: string; swatch: [string, string, string]; palette?: Palette };

const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

// Forest is the reference design and uses the theme tokens as-is; other skins derive the full token set.
function skinVars(p: Palette) {
  return {
    "--color-forest": p.forest,
    "--color-forest-deep": p.deep,
    "--color-forest-dark": mix(p.deep, p.night, 50),
    "--color-forest-night": p.night,
    "--color-forest-midnight": mix(p.night, "black", 70),
    "--color-forest-50": mix(p.forest, "white", 6),
    "--color-forest-100": mix(p.forest, "white", 14),
    "--color-forest-200": mix(p.forest, "white", 30),
    "--color-forest-300": p.mint,
    "--color-forest-banner": mix(p.forest, p.night, 75),
    "--color-mint": p.mint,
    "--color-mint-soft": mix(p.mint, "white", 65),
    "--color-mint-tint": mix(p.mint, "white", 18),
    "--color-mint-bright": mix(p.mint, p.forest, 85),
    "--color-linen": p.linen,
    "--color-linen-subtle": mix(p.border, p.linen, 45),
    "--color-linen-border": p.border,
  } as CSSProperties;
}

const skins: Record<SkinKey, Skin> = {
  forest: { name: "Forest", note: "Organic bento", swatch: ["#216b4d", "#8ce2b5", "#081d15"] },
  botanical: { name: "Botanical", note: "Neo editorial", swatch: ["#35694b", "#c9e6ae", "#10261a"], palette: { forest: "#35694b", deep: "#1d3c29", night: "#10261a", mint: "#c9e6ae", linen: "#f7f6ed", border: "#dfe5d6" } },
  cobalt: { name: "Cobalt", note: "Midnight studio", swatch: ["#2543eb", "#b6c4ff", "#030712"], palette: { forest: "#2543eb", deep: "#152889", night: "#030712", mint: "#b6c4ff", linen: "#f8faff", border: "#dde4f7" } },
  amber: { name: "Amber", note: "Warm espresso", swatch: ["#a55e1d", "#ffd28b", "#24150c"], palette: { forest: "#a55e1d", deep: "#663411", night: "#24150c", mint: "#ffd28b", linen: "#fdf8f0", border: "#eadcc8" } },
  cyber: { name: "Cyber", note: "Obsidian electric", swatch: ["#d38a00", "#ffe08a", "#07080a"], palette: { forest: "#d38a00", deep: "#8f5900", night: "#07080a", mint: "#ffe08a", linen: "#fbfbfb", border: "#e4e4e4" } },
  editorial: { name: "Editorial", note: "Warm modern", swatch: ["#9a5149", "#f3c6b9", "#2a1716"], palette: { forest: "#9a5149", deep: "#5d2f2a", night: "#2a1716", mint: "#f3c6b9", linen: "#fcf8f5", border: "#eadcd6" } },
};


const navLinks = [["#features", "Bento Suite"], ["#workspace", "Workspace"], ["#ecosystem", "Ecosystem"], ["#philosophy", "Values"], ["#faqs", "FAQs"]];

const faqs: [string, ReactNode][] = [
  ["What is Mac Tidar Mail?", "Mac Tidar Mail is an ultra-fast, human-centric webmail application built for professionals, founders, and modern teams. It features zero-loss offline drafting, sub-40ms vector search, and unified workspace organization."],
  ["How do I create an account?", "Click on the 'Get Started' or 'Create Your Account' buttons on this page. You will be guided through a simple registration process to reserve your personalized address."],
  ["Will my email address end in @mactidar.com?", <>Yes! All native accounts registered through the service receive an authentic <strong className="text-forest">yourname@mactidar.com</strong> email address. Custom domains are also supported for enterprise teams.</>],
  ["Can I use Mac Tidar Mail on my phone?", "Yes. Mac Tidar Mail is a responsive Progressive Web App (PWA). You can install it on iOS Safari or Android Chrome with offline cache and instant push notifications."],
  ["Is Mac Tidar Mail part of Mac Tidar Cloud?", "Yes, Mac Tidar Mail is closely integrated with Mac Tidar Cloud for document collaboration, encrypted attachment hosting, and team permissions."],
  ["Can I access other Mac Tidar products with the same account?", "Absolutely. Your Mac Tidar credentials work as a Single Sign-On (SSO) passkey across the entire Mac Tidar Suite."],
];

const pillars = [
  ["01", "Human Simplicity", "No bloated sidebars or confusing settings menus. Just a clear, calm view of who is reaching out and what requires action."],
  ["02", "Lightning Speed", "Engineered with Rust workers and pgvector indexing. Cold starts take less than 120ms and searches return in 38 milliseconds."],
  ["03", "Thoughtful Organization", "Label taxonomies for Engineering, Product, Design, and Invoices that keep projects contextually separated yet always searchable."],
  ["04", "Accessible by Design", "Full keyboard accessibility compliant with WCAG 2.2 AA standards. High contrast mode, legible typography, and low cognitive load."],
];

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`ms-icon ${className}`} aria-hidden="true">{name}</span>;
}

function Check({ tone = "forest" }: { tone?: "forest" | "mint" }) {
  const colors = tone === "forest" ? "bg-forest text-mint" : "bg-mint text-forest-night";
  return <span className={`w-4 h-4 rounded-full ${colors} flex items-center justify-center text-[10px] font-bold`}>✓</span>;
}

function SkinPicker({ skinKey }: { skinKey: SkinKey }) {
  const [open, setOpen] = useState(false);
  const current = skins[skinKey] || skins.forest;
  // Like Gmail: someone already signed in goes straight to their inbox.
  useEffect(() => {
    if (liveEnabled && hasStoredSignIn()) location.replace(APP_URL);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest("[data-skin-picker]")) setOpen(false); };
    document.addEventListener("keydown", close); document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); };
  }, [open]);
  return (
    <div className="relative" data-skin-picker>
      <button aria-label="Choose a visual skin" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center -space-x-1 p-2 rounded-full hover:bg-linen-subtle transition-colors">
        {current.swatch.map((c, i) => <i key={i} className="w-3 h-3 rounded-full border border-white" style={{ background: c }} />)}
      </button>
      {open && (
        <div className="absolute right-0 mt-3 w-56 bg-white rounded-2xl p-2 border border-linen-border shadow-xl z-50">
          <small className="block px-2 pt-1 pb-2 text-[10px] font-bold uppercase tracking-wider text-stone-500">Interface skin</small>
          {Object.entries(skins).map(([key, skin]) => (
            <button key={key} onClick={() => { saveSkin(key as SkinKey); setOpen(false); }} className={`w-full flex items-center gap-3 px-2 py-2 rounded-xl text-left hover:bg-linen-subtle ${key === skinKey ? "bg-linen-subtle" : ""}`}>
              <i className="w-4 h-4 rounded-full shrink-0" style={{ background: skin.swatch[0] }} />
              <span className="flex-1 leading-tight"><b className="block text-xs text-forest-night">{skin.name}</b><em className="not-italic text-[10px] text-stone-500">{skin.note}</em></span>
              <strong className="text-xs text-forest">{key === skinKey ? "✓" : ""}</strong>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketingHome() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const skinKey = useSkin();
  const palette = (skins[skinKey] || skins.forest).palette;

  // The Get Started button advertises ↵: pressing Enter with nothing focused opens sign-up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || document.activeElement !== document.body) return;
      router.push(SIGN_UP_URL);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="home-shell bg-linen text-stone-800 antialiased font-sans selection:bg-mint selection:text-forest-night" style={palette ? skinVars(palette) : undefined}>
      {/* FLOATING TOP NAVIGATION */}
      <div className="sticky top-4 z-50 max-w-6xl mx-auto px-4 sm:px-6">
        <header className="bg-white/85 backdrop-blur-xl border border-linen-border/80 rounded-full py-2.5 px-4 sm:px-6 shadow-xs shadow-forest/5 flex items-center justify-between transition-all">
          <Link aria-label="Mac Tidar Mail Homepage" className="flex items-center gap-3 group" href="#">
            <div className="w-9 h-9 rounded-full bg-forest text-mint flex items-center justify-center font-bold shadow-md shadow-forest/20 group-hover:scale-105 transition-transform">
              <Icon name="mail" className="text-[19px]" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-forest-night">Mac Tidar</span>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-mint-tint text-forest border border-mint/50">Mail</span>
            </div>
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-xs font-semibold text-stone-600 tracking-wide uppercase">
            {navLinks.map(([href, label]) => <a key={href} className="hover:text-forest transition-colors" href={href}>{label}</a>)}
          </nav>
          <div className="flex items-center gap-2.5">
            <Link className="hidden sm:inline-flex text-xs font-bold text-forest-night hover:text-forest px-3 py-2 rounded-full hover:bg-linen-subtle transition-colors" href={SIGN_IN_URL}>Sign In</Link>
            <SkinPicker skinKey={skinKey} />
            <Link className="inline-flex items-center gap-2 px-4 sm:px-5 py-2 rounded-full bg-forest hover:bg-forest-deep text-mint font-semibold text-xs tracking-wide shadow-md shadow-forest/25 transition-all hover:-translate-y-0.5" href={SIGN_UP_URL}>
              <span>Get Started</span>
              <kbd className="hidden sm:inline-block px-1.5 text-[10px] font-mono bg-forest-dark text-mint-soft rounded-sm">↵</kbd>
            </Link>
            <button aria-label="Toggle menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)} className="md:hidden p-2 text-forest hover:bg-mint-tint rounded-full">
              <Icon name={menuOpen ? "close" : "menu"} className="text-xl" />
            </button>
          </div>
        </header>
        {menuOpen && (
          <div className="md:hidden mt-2 bg-white rounded-3xl p-5 border border-linen-border shadow-xl space-y-3 text-sm font-semibold" onClick={e => { if ((e.target as Element).closest("a")) setMenuOpen(false); }}>
            {navLinks.map(([href, label]) => <a key={href} className="block py-2 text-stone-700 hover:text-forest" href={href}>{label}</a>)}
            <div className="pt-3 border-t border-linen-border flex flex-col gap-2">
              <Link className="w-full text-center py-2.5 rounded-full border border-forest/20 text-forest" href={SIGN_IN_URL}>Sign In</Link>
              <Link className="w-full text-center py-2.5 rounded-full bg-forest text-mint" href={SIGN_UP_URL}>Create Free Account</Link>
            </div>
          </div>
        )}
      </div>

      {/* HERO BENTO COMPOSITION */}
      <section className="relative pt-12 pb-20 sm:pt-16 sm:pb-28 overflow-hidden bg-grid-organic">
        <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[650px] h-[450px] bg-mint-tint/80 rounded-full blur-3xl -z-10 pointer-events-none" />
        <div className="absolute top-40 right-10 w-96 h-96 bg-mint/15 rounded-full blur-3xl -z-10 pointer-events-none" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center mb-8">
            <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white border border-mint/70 shadow-xs text-xs font-semibold text-forest-night">
              <span className="w-2 h-2 rounded-full bg-forest animate-ping" />
              <span className="text-forest font-bold">Mac Tidar 2.14</span>
              <span className="text-stone-300">/</span>
              <span className="text-stone-600">Pure Organic Clarity &amp; Sub-40ms Search</span>
              <Icon name="arrow_forward" className="text-[15px] text-forest" />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            <div className="lg:col-span-7 bg-white rounded-3xl sm:rounded-[36px] p-8 sm:p-12 border border-linen-border flex flex-col justify-between shadow-bento relative overflow-hidden group">
              <div className="absolute -right-20 -top-20 w-72 h-72 bg-mint/20 rounded-full blur-2xl group-hover:bg-mint/30 transition-all pointer-events-none" />
              <div className="space-y-6 relative z-10">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-forest-50 text-forest text-xs font-bold uppercase tracking-wider border border-forest/10">
                  <span className="w-1.5 h-1.5 rounded-full bg-forest" />
                  Ambient Neo-Modern Webmail
                </div>
                <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-forest-night leading-[1.08] sm:leading-none">
                  Your inbox.<br />
                  Your sanctuary.<br />
                  <span className="text-transparent bg-clip-text bg-linear-to-r from-forest via-forest to-emerald-700">A calmer way to connect.</span>
                </h1>
                <p className="text-base sm:text-lg text-stone-600 max-w-xl font-normal leading-relaxed sm:leading-7">
                  Replace cluttered noise with lush, intuitive structure. End-to-end encrypted threads, zero-loss offline drafts, and lighting-fast pgvector intelligence built for creative founders and modern teams.
                </p>
              </div>
              <div className="pt-8 sm:pt-10 space-y-6 relative z-10">
                <div className="flex flex-wrap items-center gap-3">
                  <Link className="inline-flex items-center gap-3 px-7 py-3.5 rounded-full bg-forest hover:bg-forest-deep text-mint font-bold text-sm tracking-wide shadow-lg shadow-forest/20 transition-all hover:-translate-y-0.5" href={SIGN_UP_URL}>
                    <span>Claim @mactidar.com</span>
                    <Icon name="arrow_forward" className="text-lg" />
                  </Link>
                  <a className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-linen-subtle hover:bg-stone-200/80 text-forest-night font-bold text-sm transition-all border border-linen-border" href="#workspace">
                    <Icon name="play_circle" className="text-[19px] text-forest" />
                    <span>Explore Workspace</span>
                  </a>
                </div>
                <div className="pt-4 border-t border-linen-border flex flex-wrap items-center gap-6 text-xs font-semibold text-stone-600">
                  {["Zero-loss CRDT Drafts", "SOC-2 Type II Certified", "Pure Privacy Guaranteed"].map(t => <span key={t} className="flex items-center gap-1.5"><Check />{t}</span>)}
                </div>
              </div>
            </div>

            <div className="lg:col-span-5 relative rounded-3xl sm:rounded-[36px] overflow-hidden border border-linen-border shadow-bento min-h-[420px] flex flex-col justify-end p-6 group">
              {/* eslint-disable-next-line @next/next/no-img-element -- static export serves images unoptimized */}
              <img alt="Creative African tech entrepreneur working in a bright studio" className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" src="/assets/reference-hero.jpg" />
              <div className="absolute inset-0 bg-linear-to-t from-forest-midnight/90 via-forest-dark/40 to-transparent" />
              <div className="relative z-10 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="glass-mint-pill px-3 py-1.5 rounded-full text-xs font-bold text-forest-night inline-flex items-center gap-2 shadow-xs">
                    <span className="w-2 h-2 rounded-full bg-mint animate-pulse" />
                    Live Sync: 38ms pgvector
                  </div>
                  <div className="bg-forest-night/80 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-mono text-mint border border-mint/30">SOC-2 Type II</div>
                </div>
                <div className="bg-white/95 backdrop-blur-md rounded-2xl p-4 border border-white shadow-xl text-stone-900">
                  <div className="flex items-center justify-between pb-2 border-b border-stone-100">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-forest text-mint flex items-center justify-center font-bold text-xs">ER</div>
                      <div>
                        <h4 className="text-xs font-bold text-stone-900">Elena Rostova</h4>
                        <p className="text-[10px] text-stone-500">VP Product • Sub-40ms sprint</p>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold bg-mint-tint text-forest border border-mint/60">URGENT</span>
                  </div>
                  <p className="text-xs font-semibold text-stone-800 pt-2 truncate">Q3 Product Roadmap: Multi-tenant Search Index</p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
            {[
              ["bolt", "< 38ms", "p95 Latency", "Instant retrieval via Rust workers and vector pipelines."],
              ["shield_lock", "100% Zero-Loss", "CRDT Sync", "Local-first IndexedDB buffer preserves every single draft keystroke."],
              ["alternate_email", "@mactidar", "Identity", "Unified Single Sign-On passkey across Cloud and Account services."],
            ].map(([icon, value, label, copy]) => (
              <div key={icon} className="bg-white rounded-3xl p-6 border border-linen-border shadow-bento flex items-center gap-5 hover:border-mint transition-all">
                <div className="w-14 h-14 rounded-2xl bg-forest-50 border border-forest/10 flex items-center justify-center text-forest shrink-0">
                  <Icon name={icon} className="text-3xl" />
                </div>
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-extrabold text-forest-night">{value}</span>
                    <span className="text-xs font-bold text-forest uppercase tracking-wider">{label}</span>
                  </div>
                  <p className="text-xs text-stone-500 mt-1">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PHILOSOPHY BANNER */}
      <section className="relative bg-forest-midnight text-white py-24 sm:py-32 overflow-hidden border-y border-forest-dark" id="philosophy">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-forest/40 rounded-full blur-[130px] pointer-events-none" />
        <div className="absolute inset-0 bg-grid-forest opacity-40 pointer-events-none" />
        <div className="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-6">
          <div className="inline-flex items-center gap-2 px-4 py-1 rounded-full bg-forest-night border border-mint/30 text-mint text-xs font-mono font-semibold uppercase tracking-widest">
            <span className="w-2 h-2 rounded-full bg-mint" />
            The Organic Standard
          </div>
          <h2 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white leading-tight sm:leading-none">
            Good communication makes <br className="hidden sm:inline" />
            everything possible.
          </h2>
          <p className="text-lg sm:text-2xl text-stone-300 max-w-3xl mx-auto font-light leading-relaxed sm:leading-8">
            From everyday conversations to your biggest ideas, Mac Tidar Mail gives every message a serene place to belong.
          </p>
          <div className="pt-8 flex flex-wrap justify-center items-center gap-4 sm:gap-10 text-xs sm:text-sm font-semibold text-stone-300">
            {["No invasive ad trackers", "Zero algorithmic noise", "Pure human clarity"].map(t => (
              <div key={t} className="flex items-center gap-2 bg-white/5 backdrop-blur-md px-4 py-2 rounded-full border border-white/10">
                <span className="w-2 h-2 rounded-full bg-mint" />
                <span>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES BENTO */}
      <section className="py-24 sm:py-32 bg-linen relative" id="features">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center mb-16">
            <span className="text-xs uppercase font-extrabold tracking-widest text-forest">Engineered with Purpose</span>
            <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold text-forest-night tracking-tight">Everything you need. Nothing you don&apos;t.</h2>
            <p className="mt-3 text-stone-600 text-base sm:text-lg">Designed intentionally to replace cluttered email apps with speed, structured taxonomies, and calm elegance.</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 bg-white rounded-3xl sm:rounded-[32px] p-6 sm:p-8 border border-linen-border shadow-bento flex flex-col justify-between">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-linen-border">
                <div>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-mint-tint text-forest text-xs font-bold mb-2 border border-mint/50">01 • Intelligent Workspace</div>
                  <h3 className="text-2xl font-bold text-forest-night">A workspace tailored for true focus.</h3>
                  <p className="text-sm text-stone-600 mt-1 max-w-lg">Intelligent triage separating peer conversations from automated build notifications and newsletter noise.</p>
                </div>
                <div className="flex items-center gap-1.5 self-start bg-linen-subtle p-1 rounded-full border border-linen-border text-xs font-bold text-forest-night">
                  <span className="px-3 py-1 bg-white rounded-full shadow-xs text-forest">Primary (12)</span>
                  <span className="px-3 py-1 text-stone-500 hover:text-stone-800 cursor-pointer">Updates</span>
                  <span className="px-3 py-1 text-stone-500 hover:text-stone-800 cursor-pointer">Newsletters</span>
                </div>
              </div>
              <div className="my-6 rounded-2xl border border-stone-200 overflow-hidden bg-white shadow-xs">
                <div className="p-3.5 bg-mint-tint/30 hover:bg-mint-tint/50 border-b border-stone-100 flex items-center justify-between gap-3 transition-colors">
                  <div className="flex items-center gap-3 truncate">
                    <span className="w-2.5 h-2.5 rounded-full bg-forest shrink-0" />
                    <span className="font-bold text-xs text-forest-night w-32 truncate">Elena Rostova</span>
                    <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold bg-forest text-mint">Product</span>
                    <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold bg-amber-100 text-amber-900">URGENT</span>
                    <span className="text-xs font-semibold text-stone-800 truncate">Q3 Product Roadmap: Multi-tenant Latency Benchmarks</span>
                  </div>
                  <span className="text-xs font-mono text-stone-500 shrink-0">10:42 AM</span>
                </div>
                <div className="p-3.5 hover:bg-stone-50 border-b border-stone-100 flex items-center justify-between gap-3 transition-colors">
                  <div className="flex items-center gap-3 truncate">
                    <span className="w-2.5 h-2.5 rounded-full bg-forest shrink-0" />
                    <span className="font-bold text-xs text-forest-night w-32 truncate">AWS Cloud Alerts</span>
                    <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold bg-emerald-100 text-forest">Engineering</span>
                    <span className="text-xs text-stone-600 truncate">[Production] AWS Amplify build succeeded for mail.mactidar.com</span>
                  </div>
                  <span className="text-xs font-mono text-stone-500 shrink-0">9:15 AM</span>
                </div>
                <div className="p-3.5 hover:bg-stone-50 flex items-center justify-between gap-3 transition-colors">
                  <div className="flex items-center gap-3 truncate">
                    <span className="w-2.5 h-2.5 rounded-full bg-transparent shrink-0" />
                    <span className="font-medium text-xs text-stone-700 w-32 truncate">Tariq Al-Mansoor</span>
                    <span className="px-2 py-0.5 rounded-sm text-[10px] font-bold bg-teal-100 text-teal-800">Investors</span>
                    <span className="text-xs text-stone-500 truncate">Follow-up: Mac Tidar Series A allocation &amp; term sheet syndicate</span>
                  </div>
                  <span className="text-xs font-mono text-stone-400 shrink-0">Yesterday</span>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs font-medium text-stone-600">
                {["Auto categorization", "One-tap snooze velocity", "Zero unread clutter"].map(t => <div key={t} className="flex items-center gap-2"><Check />{t}</div>)}
              </div>
            </div>

            <div className="lg:col-span-4 bg-forest-night rounded-3xl sm:rounded-[32px] p-6 sm:p-8 text-white border border-forest-dark shadow-bento flex flex-col justify-between relative overflow-hidden">
              <div className="absolute -right-12 -top-12 w-48 h-48 bg-mint/10 rounded-full blur-2xl" />
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-forest-dark text-mint text-xs font-bold mb-3 border border-mint/20">02 • Keyboard First</div>
                <h3 className="text-2xl font-bold text-white">Commands at the speed of thought.</h3>
                <p className="text-xs text-stone-400 mt-2 leading-relaxed">Never leave your home row. Jump anywhere instantly with global palettes and tactile shortcuts.</p>
                <div className="mt-6 p-4 rounded-2xl bg-forest-midnight border border-forest-dark space-y-3">
                  <div className="flex items-center justify-between text-xs text-stone-300 pb-2 border-b border-forest-dark">
                    <span className="flex items-center gap-2"><Icon name="search" className="text-[16px] text-mint" /><span>Jump anywhere</span></span>
                    <kbd className="px-2 py-0.5 rounded-sm bg-forest-dark text-mint font-mono text-[11px]">⌘K</kbd>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="p-2 rounded-xl bg-forest/40 border border-mint/20 text-white flex items-center justify-between">
                      <span>Elena Rostova (Roadmap)</span>
                      <span className="text-mint font-mono text-[10px]">Jump ↵</span>
                    </div>
                    <div className="p-2 rounded-xl text-stone-400 hover:text-white flex items-center justify-between">
                      <span>Filter: #Engineering</span>
                      <span className="text-stone-500 font-mono text-[10px]">8 threads</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="pt-6 mt-6 border-t border-forest-dark flex flex-wrap gap-2">
                {[["C", "Compose"], ["E", "Archive"], ["J/K", "Navigate"]].map(([key, label]) => (
                  <span key={key} className="px-2.5 py-1 rounded-lg bg-forest-midnight border border-forest-dark text-[11px] font-mono text-mint"><strong className="text-white">{key}</strong> {label}</span>
                ))}
              </div>
            </div>

            <div className="lg:col-span-5 relative rounded-3xl sm:rounded-[32px] overflow-hidden border border-linen-border shadow-bento min-h-[360px] flex flex-col justify-end p-6 group">
              {/* eslint-disable-next-line @next/next/no-img-element -- static export serves images unoptimized */}
              <img alt="Two diverse creative tech professionals collaborating happily" className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" src="/assets/reference-collaboration.jpg" />
              <div className="absolute inset-0 bg-linear-to-t from-forest-midnight/95 via-forest-midnight/50 to-transparent" />
              <div className="relative z-10 space-y-2 text-white">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-forest text-mint text-xs font-bold uppercase tracking-wider">Human Centered</div>
                <h4 className="text-2xl font-bold leading-tight">Made for the way you live and work.</h4>
                <p className="text-xs text-stone-200 line-clamp-2">Whether you’re building something new or staying close to the people who matter, your email should work with you.</p>
              </div>
            </div>

            <div className="lg:col-span-7 bg-white rounded-3xl sm:rounded-[32px] p-6 sm:p-8 border border-linen-border shadow-bento flex flex-col justify-between">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-mint-tint text-forest text-xs font-bold mb-2 border border-mint/50">03 • Architectural Integrity</div>
                <h3 className="text-2xl font-bold text-forest-night">Conversations that stay organized.</h3>
                <p className="text-sm text-stone-600 mt-1 max-w-xl">No endless unraveling threads or broken reply chains. Mac Tidar Mail groups related documents, latency benchmarks, and architectural decisions into crystal clear timeline records.</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6">
                  <div className="p-4 rounded-2xl bg-forest-50 border border-forest/10">
                    <span className="text-[10px] font-bold text-forest uppercase tracking-wider block">Search Latency</span>
                    <span className="text-2xl font-extrabold text-forest-night block mt-1">&lt; 38ms</span>
                    <span className="text-[11px] text-forest font-semibold">↘ 62% decrease</span>
                  </div>
                  <div className="p-4 rounded-2xl bg-linen-subtle border border-linen-border">
                    <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider block">Tenant Isolation</span>
                    <span className="text-lg font-bold text-forest-night block mt-1">RLS + Schema</span>
                    <span className="text-[11px] text-stone-500">Strict Organization</span>
                  </div>
                  <div className="p-4 rounded-2xl bg-mint-tint/50 border border-mint/40">
                    <span className="text-[10px] font-bold text-forest uppercase tracking-wider block">Offline Cache</span>
                    <span className="text-lg font-bold text-forest block mt-1">100% Zero-Loss</span>
                    <span className="text-[11px] text-forest font-medium">IndexedDB + CRDT</span>
                  </div>
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-linen-border flex items-center justify-between text-xs text-stone-600">
                <span className="font-semibold flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-forest" />Multi-tenant Vector Ingestion Pipeline</span>
                <span className="font-mono text-forest font-bold">v3.2 Production</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PRODUCT WORKSPACE SHOWCASE */}
      <section className="py-24 sm:py-32 bg-forest-midnight text-white relative overflow-hidden border-t border-forest-dark" id="workspace">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[850px] h-[500px] bg-forest/30 rounded-full blur-[140px] pointer-events-none" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-forest-dark border border-mint/20 text-mint text-xs font-mono uppercase tracking-widest">Desktop Workspace</div>
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">The Modern Inbox Environment</h2>
            <p className="text-stone-300 text-base sm:text-lg">Zero clutter, instant vector search, and unified team identity under a single elegant roof.</p>
          </div>
          <div className="rounded-3xl bg-forest-night border border-forest-dark/80 shadow-forest-glow p-3 sm:p-5 overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-forest-dark text-xs">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-mint inline-block" />
                <span className="ml-3 text-stone-400 font-mono text-[11px]">Inbox — Mac Tidar Mail (mail.mactidar.com)</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[11px] text-mint">
                <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-mint animate-pulse" />Cluster: v2.14.0 Production</span>
              </div>
            </div>
            <div className="mt-3 rounded-2xl overflow-hidden border border-forest-dark bg-forest-midnight">
              <div className="grid grid-cols-1 md:grid-cols-12 min-h-[480px]">
                <div className="hidden md:block md:col-span-3 bg-forest-night/80 p-4 border-r border-forest-dark space-y-6">
                  <Link href={APP_URL} className="w-full py-2.5 px-4 bg-forest hover:bg-forest-deep text-mint rounded-xl font-bold text-xs flex items-center justify-between shadow-xs transition-all">
                    <span className="flex items-center gap-2"><Icon name="edit" className="text-[17px]" /><span>New Message</span></span>
                    <kbd className="text-[10px] bg-forest-dark px-1.5 py-0.5 rounded-sm text-mint font-mono">C</kbd>
                  </Link>
                  <div className="space-y-1 text-xs">
                    <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider px-2">Mailboxes</span>
                    <Link className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-forest/30 text-mint font-bold border border-mint/20" href={APP_URL}>
                      <span className="flex items-center gap-2"><Icon name="inbox" className="text-[16px]" />Inbox</span>
                      <span className="bg-forest text-mint text-[10px] px-1.5 rounded-full font-bold">14</span>
                    </Link>
                    <Link className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-stone-400 hover:text-stone-200" href={APP_URL}>
                      <span className="flex items-center gap-2"><Icon name="star" className="text-[16px]" />Starred</span>
                      <span className="text-stone-500">4</span>
                    </Link>
                    <Link className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-stone-400 hover:text-stone-200" href={APP_URL}><Icon name="schedule" className="text-[16px]" />Snoozed</Link>
                    <Link className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-stone-400 hover:text-stone-200" href={APP_URL}><Icon name="send" className="text-[16px]" />Sent</Link>
                    <Link className="flex items-center justify-between px-2.5 py-1.5 rounded-lg text-stone-400 hover:text-stone-200" href={APP_URL}>
                      <span className="flex items-center gap-2"><Icon name="draft" className="text-[16px]" />Drafts</span>
                      <span className="text-mint font-mono">2</span>
                    </Link>
                  </div>
                  <div className="space-y-1.5 text-xs pt-4 border-t border-forest-dark">
                    <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider px-2">Labels</span>
                    {[["bg-mint", "Engineering", 8], ["bg-forest-300", "Product", 3], ["bg-emerald-400", "Design", 5]].map(([dot, label, count]) => (
                      <div key={label} className="flex items-center justify-between px-2 text-stone-400">
                        <span className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${dot}`} /> {label}</span>
                        <span className="text-stone-500 text-[10px]">{count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="pt-4 border-t border-forest-dark text-[11px] text-stone-400 space-y-1">
                    <div className="flex justify-between"><span>Storage</span><span className="font-mono text-mint">4.2 GB / 15 GB</span></div>
                    <div className="w-full bg-forest-midnight h-1.5 rounded-full overflow-hidden border border-forest-dark"><div className="bg-mint h-full w-[28%] rounded-full" /></div>
                  </div>
                </div>
                <div className="col-span-12 md:col-span-9 p-4 sm:p-6 flex flex-col justify-between relative bg-forest-midnight/60">
                  <div className="bg-forest-night border border-forest-dark rounded-2xl px-4 py-2.5 flex items-center justify-between text-xs text-stone-400">
                    <div className="flex items-center gap-2.5 w-full">
                      <Icon name="search" className="text-[17px] text-mint" />
                      <span className="text-stone-400 truncate">Search messages, people, or labels (Press / to search)...</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <kbd className="font-mono text-[10px] bg-forest-midnight text-mint px-2 py-0.5 rounded-sm border border-forest-dark">⌘K</kbd>
                      <div className="w-6 h-6 rounded-full bg-forest text-[10px] flex items-center justify-center font-bold text-mint">MT</div>
                    </div>
                  </div>
                  <div className="my-6 max-w-lg mx-auto w-full bg-forest-night border border-forest-dark/90 rounded-2xl shadow-2xl p-4 sm:p-5 space-y-3 z-10">
                    <div className="flex items-center justify-between pb-2 border-b border-forest-dark text-xs">
                      <span className="font-bold text-mint flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-mint animate-pulse" />New Message - Draft</span>
                      <div className="flex items-center gap-2 text-stone-500"><span>—</span><span>⤢</span><span>✕</span></div>
                    </div>
                    <div className="text-xs space-y-1.5">
                      <div className="flex items-center text-stone-400 gap-2">
                        <span className="w-10 text-stone-500">To:</span>
                        <span className="bg-forest-midnight text-mint px-2 py-0.5 rounded-sm font-mono text-[11px] border border-forest-dark">elena@mactidar.com</span>
                      </div>
                      <div className="flex items-center text-stone-400 gap-2">
                        <span className="w-10 text-stone-500">Subj:</span>
                        <span className="text-stone-200 font-semibold">Re: Q3 Product Roadmap Feedback</span>
                      </div>
                    </div>
                    <p className="text-xs text-stone-300 font-mono leading-relaxed pt-1">
                      Hi Elena, <br /><br />
                      Latency reduction benchmarks look extremely solid (&lt; 38ms). Let&apos;s greenlight the vector cache indexer before Thursday&apos;s sprint.
                    </p>
                    <div className="pt-3 flex items-center justify-between border-t border-forest-dark">
                      <div className="flex items-center gap-2 text-stone-400 text-xs font-mono">
                        <span className="px-1.5 py-0.5 hover:bg-forest-midnight rounded-sm cursor-pointer">B</span>
                        <span className="px-1.5 py-0.5 hover:bg-forest-midnight rounded-sm cursor-pointer italic">I</span>
                        <span className="px-1.5 py-0.5 hover:bg-forest-midnight rounded-sm cursor-pointer">🔗</span>
                        <span className="px-1.5 py-0.5 hover:bg-forest-midnight rounded-sm cursor-pointer">📎</span>
                      </div>
                      <Link href={APP_URL} className="bg-forest hover:bg-forest-deep text-mint px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-xs">
                        <span>Send</span>
                        <Icon name="send" className="text-[15px]" />
                      </Link>
                    </div>
                  </div>
                  <div className="bg-forest-night border border-forest-dark rounded-2xl p-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-lg bg-forest text-mint flex items-center justify-center font-bold">✓</span>
                      <div>
                        <h5 className="font-bold text-stone-200">Inbox Zero Progress</h5>
                        <p className="text-[11px] text-stone-400">You handled 18 priority communications today with calm velocity.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 font-mono text-[11px] text-stone-400">
                      <span><kbd className="text-mint font-bold">C</kbd> Compose</span>
                      <span><kbd className="text-mint font-bold">J / K</kbd> Navigate</span>
                      <span><kbd className="text-mint font-bold">E</kbd> Archive</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ECOSYSTEM */}
      <section className="py-24 sm:py-32 bg-linen-subtle border-b border-linen-border" id="ecosystem">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <span className="text-xs uppercase tracking-widest font-extrabold text-forest">Unified Architecture</span>
            <h2 className="mt-4 text-3xl sm:text-4xl font-extrabold text-forest-night tracking-tight">One account. More possibilities.</h2>
            <p className="mt-4 text-stone-600 text-base sm:text-lg">Mac Tidar Mail is the communication backbone of a unified product suite designed for builders, creators, and modern teams.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              { icon: "mail", title: "Mac Tidar Mail", badge: "Available Now", badgeClass: "bg-mint-tint text-forest border border-mint/50", copy: "Lightweight, rapid personal and business email with built-in instant search, tags, and encrypted storage.", footer: null },
              { icon: "cloud", title: "Mac Tidar Cloud", badge: "Connected", badgeClass: "bg-stone-100 text-stone-600", copy: "Directly attach large roadmaps, specs, and design assets from Mac Tidar Cloud with seamless permission control.", footer: "Seamless file bridge" },
              { icon: "key", title: "Mac Tidar Account", badge: "Single Sign-On", badgeClass: "bg-mint-tint text-forest border border-mint/50", copy: "Your single passkey to all Mac Tidar experiences. Passkeys, 2FA hardware tokens, and enterprise SAML 2.0 readiness.", footer: "Integrated security" },
            ].map(card => (
              <div key={card.title} className="bg-white rounded-3xl p-8 border border-linen-border shadow-bento hover:border-mint transition-all group flex flex-col justify-between">
                <div>
                  <div className="w-12 h-12 rounded-2xl bg-forest-50 border border-forest/10 text-forest flex items-center justify-center mb-6 group-hover:scale-105 transition-transform">
                    <Icon name={card.icon} className="text-2xl" />
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xl font-bold text-forest-night">{card.title}</h3>
                    <span className={`px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ${card.badgeClass}`}>{card.badge}</span>
                  </div>
                  <p className="text-stone-600 text-sm leading-relaxed mb-6">{card.copy}</p>
                </div>
                {card.footer ? (
                  <div className="text-sm font-semibold text-stone-500 flex items-center gap-2 pt-4 border-t border-linen-border"><Check tone="mint" /><span>{card.footer}</span></div>
                ) : (
                  <Link className="text-sm font-bold text-forest group-hover:text-forest-deep flex items-center gap-1.5 pt-4 border-t border-linen-border" href={APP_URL}>
                    <span>Access web app</span>
                    <Icon name="arrow_forward" className="text-base group-hover:translate-x-1 transition-transform" />
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* THE CORE STANDARD */}
      <section className="py-24 sm:py-32 bg-white" id="why-mac-tidar">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">
            <div className="lg:col-span-5 lg:sticky lg:top-32">
              <span className="text-xs uppercase tracking-widest font-extrabold text-forest">The Core Standard</span>
              <h2 className="mt-6 text-3xl sm:text-4xl font-extrabold text-forest-night tracking-tight leading-snug sm:leading-10">Technology should make life easier. Not more complicated.</h2>
              <p className="mt-6 text-stone-600 leading-relaxed text-base sm:text-lg sm:leading-7">We built Mac Tidar Mail because modern communication became noisy, slow, and overwhelming. Here is what we refuse to compromise on:</p>
              <div className="mt-6 p-6 rounded-3xl bg-forest-50 border border-forest/15 space-y-3">
                <div className="flex items-center gap-2 text-forest font-bold text-sm"><Icon name="verified_user" className="text-lg" /><span>Our Privacy Pledge</span></div>
                <p className="text-xs text-forest-deep leading-relaxed">We never scan your private messages for advertising. Your communications are encrypted at rest and in transit across all endpoints.</p>
              </div>
            </div>
            <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-5">
              {pillars.map(([num, title, copy]) => (
                <div key={num} className="p-6 sm:p-7 rounded-3xl border border-linen-border hover:border-mint hover:shadow-bento transition-all bg-linen">
                  <div className="w-10 h-10 rounded-xl bg-forest text-mint flex items-center justify-center font-bold mb-4 shadow-xs">{num}</div>
                  <h3 className="text-lg font-bold text-forest-night mb-2">{title}</h3>
                  <p className="text-xs sm:text-sm text-stone-600 leading-relaxed sm:leading-5">{copy}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* GET STARTED BANNER */}
      <section className="py-20 sm:py-28 px-4 sm:px-6 lg:px-8 bg-linen" id="get-started">
        <div className="max-w-6xl mx-auto rounded-3xl sm:rounded-[48px] bg-linear-to-br from-forest via-forest-banner to-forest-night p-10 sm:p-20 text-white relative overflow-hidden shadow-2xl border border-mint/20 text-center">
          <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-mint/20 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-forest/50 blur-3xl pointer-events-none" />
          <div className="relative z-10 max-w-3xl mx-auto space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-forest-night/80 border border-mint/40 text-mint text-xs font-mono uppercase tracking-widest">Official @mactidar.com Identity</div>
            <h2 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-tight sm:leading-none text-white">A better inbox is waiting.</h2>
            <p className="text-lg sm:text-xl text-stone-200 max-w-2xl mx-auto font-normal leading-relaxed sm:leading-7">
              Your conversations deserve a tranquil home. Discover a simpler, more beautiful way to communicate with an authentic <span className="text-mint font-bold">@mactidar.com</span> address.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
              <Link className="w-full sm:w-auto px-8 py-4 rounded-full bg-mint hover:bg-mint-soft text-forest-night font-bold text-base shadow-xl hover:shadow-mint-glow transition-all hover:-translate-y-0.5" href={SIGN_UP_URL}>Create Your Account</Link>
              <Link className="w-full sm:w-auto px-8 py-4 rounded-full bg-forest-midnight/60 hover:bg-forest-midnight text-white border border-mint/30 font-semibold text-base transition-all" href={SIGN_IN_URL}>Sign In to Webmail</Link>
            </div>
            <div className="pt-6 flex flex-wrap items-center justify-center gap-6 text-xs text-mint/80 font-medium">
              <span>Instant setup</span><span>•</span><span>Free tier available</span><span>•</span><span>Cancel anytime</span>
            </div>
          </div>
        </div>
      </section>

      {/* FAQS */}
      <section className="py-24 sm:py-32 bg-white border-t border-linen-border" id="faqs">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <span className="text-xs uppercase tracking-widest font-extrabold text-forest">Got Questions?</span>
            <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold text-forest-night tracking-tight">Frequently Asked Questions</h2>
            <p className="mt-3 text-stone-600 text-base">Everything you need to know about Mac Tidar Mail and our suite ecosystem.</p>
          </div>
          <div className="space-y-4">
            {faqs.map(([q, a]) => (
              <details key={q} className="group bg-linen rounded-2xl sm:rounded-3xl border border-linen-border p-6 transition-all hover:border-mint">
                <summary className="flex items-center justify-between cursor-pointer list-none text-forest-night font-bold text-base sm:text-lg">
                  <span>{q}</span>
                  <span className="faq-icon ml-4 w-8 h-8 shrink-0 rounded-full bg-white flex items-center justify-center text-forest transition-transform duration-300 shadow-xs">
                    <Icon name="add" className="text-lg" />
                  </span>
                </summary>
                <div className="mt-4 text-stone-600 text-sm leading-relaxed border-t border-linen-border pt-4">{a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-forest-midnight text-stone-400 pt-16 pb-12 border-t border-forest-dark">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-10 pb-12 border-b border-forest-dark">
            <div className="md:col-span-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-forest text-mint flex items-center justify-center font-bold"><Icon name="mail" className="text-base" /></div>
                <span className="text-base font-bold text-white tracking-tight">Mac Tidar Mail</span>
                <span className="text-[10px] font-bold uppercase bg-forest-night text-mint px-2 py-0.5 rounded-full border border-mint/20">Suite</span>
              </div>
              <p className="text-sm text-stone-400 max-w-sm leading-relaxed">The next-generation communication layer built with craft, privacy, and speed for high-performing product teams.</p>
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-forest-night border border-forest-dark text-xs font-mono text-mint">
                <span className="w-2 h-2 rounded-full bg-mint animate-pulse" />
                <span>All systems operational @ mail.mactidar.com</span>
              </div>
            </div>
            <div className="md:col-span-2 space-y-3 text-xs">
              <h4 className="font-bold text-stone-200 uppercase tracking-wider">Product</h4>
              <ul className="space-y-2">
                <li><a className="hover:text-mint transition-colors" href="#features">Bento Suite</a></li>
                <li><a className="hover:text-mint transition-colors" href="#workspace">Desktop App</a></li>
                <li><Link className="hover:text-mint transition-colors" href={APP_URL}>Web Client</Link></li>
                <li><a className="hover:text-mint transition-colors" href="#ecosystem">Mac Tidar Suite</a></li>
                <li><a className="hover:text-mint transition-colors" href="#faqs">Changelog (v2.14)</a></li>
              </ul>
            </div>
            <div className="md:col-span-2 space-y-3 text-xs">
              <h4 className="font-bold text-stone-200 uppercase tracking-wider">Ecosystem</h4>
              <ul className="space-y-2">
                {["Mac Tidar Cloud", "Mac Tidar Account", "Enterprise SAML", "Security & SOC-2"].map(t => <li key={t}><a className="hover:text-mint transition-colors" href="#">{t}</a></li>)}
              </ul>
            </div>
            <div className="md:col-span-3 space-y-3 text-xs">
              <h4 className="font-bold text-stone-200 uppercase tracking-wider">Legal &amp; Trust</h4>
              <ul className="space-y-2">
                {["Privacy Policy", "Terms of Service", "Data Processing Addendum", "Responsible Disclosure"].map(t => <li key={t}><a className="hover:text-mint transition-colors" href="#">{t}</a></li>)}
              </ul>
            </div>
          </div>
          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between text-xs text-stone-500 gap-4">
            <p>© 2025 Mac Tidar Technologies Inc. All rights reserved.</p>
            <div className="flex items-center gap-6">
              <span className="hover:text-mint cursor-pointer">Security Audited</span>
              <span className="hover:text-mint cursor-pointer">End-to-End Encrypted</span>
              <span className="hover:text-mint cursor-pointer">English (US)</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
