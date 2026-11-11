"use client";
/* eslint-disable @next/next/no-img-element -- static export serves images unoptimized */

// A company domain as its owner sets it up: DNS records with live ticks and Verify now, the
// company name and logo, and the team (unlocked once the domain is verified).
import { ReactNode, useEffect, useRef, useState } from "react";
import { mailApi, type DomainCheck, type DomainView, type PersonView } from "../mail/live/api";
import { Icon } from "../mail/ui";

export const Btn = ({ children, onClick, tone = "plain", disabled, type = "button" }: { children: ReactNode; onClick?: () => void; tone?: "plain" | "brand" | "danger"; disabled?: boolean; type?: "button" | "submit" }) => (
  <button type={type} onClick={onClick} disabled={disabled} className={`px-3 py-2 rounded-m-lg t-headline-sm whitespace-nowrap transition-colors disabled:opacity-60 ${tone === "brand" ? "bg-m-brand text-m-on-brand hover:bg-m-brand-hover" : tone === "danger" ? "bg-m-error-soft text-m-on-error-soft hover:brightness-95" : "bg-m-low text-m-text hover:bg-m-mid"}`}>{children}</button>
);
export const inputClass = "w-full px-3 py-2.5 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30";
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
export const errorMessage = (e: unknown) => e instanceof Error ? e.message : "Something went wrong.";

const STATUS: Record<DomainView["status"], [string, string]> = {
  pending: ["Waiting for DNS records", "bg-m-low text-m-muted"],
  active: ["Verified", "bg-m-success/15 text-m-success"],
  suspended: ["Not working", "bg-m-error-soft text-m-on-error-soft"],
};
const PURPOSE: Record<string, string> = {
  Ownership: "Proves this sign-up, not just someone, controls the domain",
  DKIM: "Signs your mail so receivers trust it",
  MX: "Delivers mail for the domain to Mac Tidar Mail",
  SPF: "Lets receivers trust mail sent for you",
  DMARC: "Tells receivers what to do with forged mail",
};
/** Records the domain needs to work; SPF and DMARC are strongly recommended but optional. */
const REQUIRED: DomainCheck[] = ["ownership", "dkim", "mx"];

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title="Copy" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}
      className="group inline-flex items-start gap-1 text-left t-code text-m-text break-all hover:text-m-brand">
      <span>{text}</span><Icon name={done ? "check" : "content_copy"} className="text-[14px] shrink-0 mt-0.5 text-m-muted group-hover:text-m-brand" />
    </button>
  );
}

function Section({ title, icon, children, aside }: { title: string; icon: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="pt-4 border-t border-m-line space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><b className="flex items-center gap-2 t-headline-sm text-m-text"><Icon name={icon} className="text-[18px] text-m-muted" />{title}</b>{aside}</div>
      {children}
    </section>
  );
}

export function LogoPreview({ url, name, size = "w-12 h-12" }: { url: string | null; name: string; size?: string }) {
  return url
    ? <img src={url} alt={`${name} logo`} className={`${size} rounded-m-lg object-contain bg-white border border-m-line shrink-0`} />
    : <span className={`${size} rounded-m-lg bg-m-low border border-m-line grid place-items-center t-headline-sm text-m-muted shrink-0`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

export function DomainSetup({ d, onChange, onRemoved }: { d: DomainView; onChange: (d: DomainView) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(d.displayName);
  const fileInput = useRef<HTMLInputElement>(null);
  const live = d.status !== "pending";
  const [showRecords, setShowRecords] = useState(!live);
  const act = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what); setError(""); setNote("");
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };

  // While it's pending, pick up the server's own 15-minute checks without a reload.
  useEffect(() => {
    if (live) return;
    const t = setInterval(() => { mailApi.domains().then(r => { const x = r.domains.find(y => y.domain === d.domain); if (x) onChange(x); }).catch(() => {}); }, 60_000);
    return () => clearInterval(t);
  }, [live, d.domain, onChange]);

  const verify = () => act("verify", async () => {
    const next = await mailApi.checkDomain(d.domain);
    onChange(next);
    if (next.status === "active" && d.status === "pending") setNote("Verified! Your domain is live.");
    else if (next.status === "pending") {
      // Records we read straight from the domain's own nameservers, so this is what's really there.
      const missing = [...new Set(next.records.filter(r => REQUIRED.includes(r.check) && !next.checks[r.check] && !(r.check === "dkim" && next.checks.dkimRecords)).map(r => r.purpose === "DKIM" ? "the 3 DKIM records" : `the ${r.purpose} record`))];
      const awaitingAmazon = !next.checks.dkim && !!next.checks.dkimRecords;
      const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
      setNote(missing.length
        ? `Not found yet: ${list}. Check ${missing.length === 1 ? "it was" : "they were"} added exactly as shown; new records usually appear within a few minutes.${awaitingAmazon ? " Your DKIM records are in place and waiting for Amazon to confirm them." : ""}`
        : "All your records are in place. Amazon is confirming the DKIM records, which usually takes up to an hour; we check every 15 minutes and email you the moment it’s verified.");
    }
  });
  const [label, tone] = STATUS[d.status];

  return (
    <article className="bg-m-card rounded-m-xl border border-m-line shadow-sm p-space-lg space-y-4">
      <header className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <LogoPreview url={d.logoUrl} name={d.displayName} />
          <div className="min-w-0"><b className="block t-headline-md text-m-text truncate">{d.displayName}</b><span className="t-body-sm text-m-muted">{d.domain}</span></div>
        </div>
        <span className={`px-2.5 py-1 rounded-m-pill t-label-sm font-semibold ${tone}`}>{label}</span>
      </header>

      <div className="t-body-md text-m-text space-y-2">
        {d.status === "pending" && <>
          <p>Add the records below where you manage DNS for <b>{d.domain}</b> (your registrar or DNS host). We check every 15 minutes and email your backup address as soon as it’s verified, or choose <b>Verify now</b>.</p>
          {d.expiresAt && <p className="t-body-sm text-m-muted">If it isn’t verified by {new Date(d.expiresAt).toLocaleString()}, the setup is released{d.ownAddress ? ", along with your sign-up," : ""} so nobody can hold a domain they don’t control.</p>}
        </>}
        {d.status === "active" && <p>Mail for {d.domain} now arrives in Mac Tidar Mail, end-to-end encrypted.{d.ownAddress && <> Your own mailbox, <b>{d.ownAddress}</b>, is ready.</>}</p>}
        {d.status === "suspended" && <p>{d.suspendedFor === "abuse" ? "Sending is paused for this domain. Contact us to sort it out." : `Some records Mac Tidar Mail needs are missing or changed, so mail for ${d.domain} isn’t working. It starts again by itself once they’re back.`}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        <Btn tone="brand" onClick={verify} disabled={!!busy}>{busy === "verify" ? "Checking…" : "Verify now"}</Btn>
        {live && <Btn onClick={() => setShowRecords(!showRecords)}>{showRecords ? "Hide DNS records" : "Show DNS records"}</Btn>}
        {d.status === "active" && d.ownAddress && <a href="/app/" className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-low text-m-text hover:bg-m-mid inline-flex items-center gap-1.5"><Icon name="inbox" className="text-[18px]" />Open your mailbox</a>}
      </div>
      {note && <p className="t-body-sm text-m-text bg-m-low rounded-m-lg px-3 py-2" role="status">{note}</p>}
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}

      {showRecords && (
        <div className="space-y-2">
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full t-body-sm">
              <thead><tr className="text-left text-m-muted"><th className="py-1 pr-2 font-medium">Type</th><th className="py-1 pr-2 font-medium">Name</th><th className="py-1 pr-2 font-medium">Value</th><th className="py-1 font-medium"><span className="sr-only">Status</span></th></tr></thead>
              <tbody>{d.records.map(r => {
                const ok = d.checks[r.check], optional = !REQUIRED.includes(r.check);
                // DKIM: found in DNS, waiting for Amazon SES to confirm it.
                const waiting = !ok && r.check === "dkim" && !!d.checks.dkimRecords;
                return (
                  <tr key={r.name + r.value} className="border-t border-m-line align-top">
                    <td className="py-2 pr-2"><span className="t-code text-m-muted whitespace-nowrap">{r.type}</span><span className="block t-label-sm text-m-muted mt-0.5" title={PURPOSE[r.purpose]}>{r.purpose}{optional ? " (recommended)" : ""}</span></td>
                    <td className="py-2 pr-2 min-w-[7rem]"><CopyText text={r.host} /></td>
                    <td className="py-2 pr-2 min-w-[12rem]">{r.priority !== undefined && <span className="t-code text-m-muted">priority {r.priority} · </span>}<CopyText text={r.value} /></td>
                    <td className="py-2" title={waiting ? "Found. Waiting for Amazon to confirm it (usually within an hour)." : undefined}>
                      <Icon name={ok ? "check_circle" : waiting ? "hourglass_top" : "radio_button_unchecked"} className={`text-[18px] ${ok ? "text-m-success" : waiting ? "text-m-brand" : "text-m-muted"}`} />
                      <span className="sr-only">{ok ? "Found" : waiting ? "Found, waiting for Amazon to confirm" : "Not found yet"}</span>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <p className="t-body-sm text-m-muted">Names are shown the way most DNS providers want them (“@” means {d.domain} itself). If yours asks for the full name, add <span className="t-code">.{d.domain}</span>. If {d.domain} already has a record starting <span className="t-code">v=spf1</span>, add <span className="t-code">include:amazonses.com</span> to it instead of adding a second one. Every MX record must point at Mac Tidar Mail.</p>
          {d.checkedAt && <p className="t-label-sm text-m-muted">Last checked {new Date(d.checkedAt).toLocaleString()}</p>}
        </div>
      )}

      <Section title="Company" icon="apartment">
        <div className="flex flex-wrap items-center gap-4">
          <LogoPreview url={d.logoUrl} name={d.displayName} size="w-16 h-16" />
          <div className="flex flex-wrap gap-2">
            <input ref={fileInput} type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void act("logo", async () => onChange(await mailApi.uploadLogo(d.domain, f))); }} />
            <Btn onClick={() => fileInput.current?.click()} disabled={!!busy}>{busy === "logo" ? "Uploading…" : d.logoUrl ? "Replace logo" : "Upload logo"}</Btn>
            {d.logoUrl && <Btn onClick={() => void act("logo", async () => onChange(await mailApi.removeLogo(d.domain)))} disabled={!!busy}>Remove logo</Btn>}
            {!renaming && <Btn onClick={() => { setName(d.displayName); setRenaming(true); }}>Rename</Btn>}
          </div>
        </div>
        <p className="t-body-sm text-m-muted">PNG, JPEG or WebP, up to 1 MB; a square image looks best. It appears with {d.displayName}’s name at the top of everyone’s inbox on {d.domain}.{d.status === "pending" && " Until the domain is verified, only you can see it."}</p>
        {renaming && (
          <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void act("rename", async () => { onChange(await mailApi.renameDomain(d.domain, name)); setRenaming(false); }); }}>
            <input value={name} onChange={e => setName(e.target.value)} maxLength={40} required aria-label="Company name" className={`${inputClass} flex-1 min-w-[12rem]`} />
            <Btn type="submit" tone="brand" disabled={!!busy}>Save</Btn><Btn onClick={() => setRenaming(false)}>Cancel</Btn>
          </form>
        )}
      </Section>

      {d.web && <WebAddress d={d} onChange={onChange} />}

      <Section title="Team" icon="group">
        {d.status === "pending"
          ? <p className="t-body-sm text-m-muted flex items-center gap-2"><Icon name="lock" className="text-[16px]" />Unlocks once {d.domain} is verified. Then you can create addresses for your team.</p>
          : <People domain={d.domain} />}
      </Section>

      <div className="pt-4 border-t border-m-line">
        {d.status === "pending"
          ? <Btn tone="danger" disabled={!!busy} onClick={() => { if (confirm(`Cancel setting up ${d.domain}?`)) void act("remove", async () => { await mailApi.removeDomain(d.domain); onRemoved(); }); }}>Cancel setup</Btn>
          : !d.ownAddress && <Btn tone="danger" disabled={!!busy} onClick={() => { if (confirm(`Disconnect ${d.domain} from Mac Tidar Mail?`)) void act("remove", async () => { await mailApi.removeDomain(d.domain); onRemoved(); }); }}>Disconnect domain</Btn>}
      </div>
    </article>
  );
}

// mail.<domain>: Mac Tidar Mail on the company's own web address. One CNAME; CloudFront issues
// and renews the HTTPS certificate itself once it points at us.
function WebAddress({ d, onChange }: { d: DomainView; onChange: (d: DomainView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const w = d.web!;
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  const certReady = w.certificate === "issued";
  const steps: [boolean, string][] = [[w.dns, `CNAME added: mail → ${w.record.value}`], [certReady, "Secure (HTTPS) certificate issued"], [w.status === "active", `${w.host} is live`]];
  return (
    <Section title="Web address" icon="language" aside={w.status === "active" ? <span className="px-2.5 py-1 rounded-m-pill t-label-sm font-semibold bg-m-success/15 text-m-success">Live</span> : undefined}>
      {!w.enabled ? <>
        <p className="t-body-sm text-m-muted">Let your team open their mail at <b className="text-m-text">{w.host}</b>, with your logo from the first screen. It takes one more DNS record; mail.mactidar.com keeps working too.</p>
        <Btn tone="brand" disabled={busy} onClick={() => void act(async () => onChange(await mailApi.enableWeb(d.domain)))}>{busy ? "Setting up…" : `Set up ${w.host}`}</Btn>
      </> : <>
        {w.status === "active"
          ? <p className="t-body-sm text-m-text">Your team can sign in at <b>{w.host}</b>.</p>
          : <p className="t-body-sm text-m-muted">Add this record where you manage DNS for {d.domain}. Once it’s in place, the secure certificate is issued automatically, usually within 30 minutes. If <span className="t-code">mail.{d.domain}</span> already has a record, replace it.</p>}
        <div className="overflow-x-auto"><table className="w-full t-body-sm"><tbody><tr className="border-y border-m-line align-top">
          <td className="py-2 pr-2"><span className="t-code text-m-muted">CNAME</span></td>
          <td className="py-2 pr-2"><CopyText text={w.record.host} /></td>
          <td className="py-2 pr-2"><CopyText text={w.record.value} /></td>
          <td className="py-2"><Icon name={w.dns ? "check_circle" : "radio_button_unchecked"} className={`text-[18px] ${w.dns ? "text-m-success" : "text-m-muted"}`} /></td>
        </tr></tbody></table></div>
        <ul className="space-y-1">{steps.map(([ok, text]) => <li key={text} className="flex items-center gap-2 t-body-sm text-m-text"><Icon name={ok ? "check_circle" : "radio_button_unchecked"} className={`text-[16px] ${ok ? "text-m-success" : "text-m-muted"}`} />{text}</li>)}</ul>
        <div className="flex flex-wrap gap-2">
          {w.status === "active" && <a href={`https://${w.host}/app/`} className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-low text-m-text hover:bg-m-mid">Open {w.host}</a>}
          <Btn tone="danger" disabled={busy} onClick={() => { if (confirm(`Turn off ${w.host}? Your team can still sign in at mail.mactidar.com.`)) void act(async () => onChange(await mailApi.disableWeb(d.domain))); }}>Turn off</Btn>
        </div>
        <p className="t-label-sm text-m-muted">Use Verify now above to re-check.</p>
      </>}
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
    </Section>
  );
}

// The people on a domain: add (Cognito emails them an invite), resend, remove.
function People({ domain }: { domain: string }) {
  const [list, setList] = useState<{ people: PersonView[]; limit: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const empty = { localPart: "", givenName: "", familyName: "", backupEmail: "" };
  const [form, setForm] = useState(empty);
  useEffect(() => { mailApi.people(domain).then(setList, e => setError(errorMessage(e))); }, [domain]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } };
  if (!list) return <p className="t-body-sm text-m-muted">{error || "Loading your team…"}</p>;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2"><span className="t-body-sm text-m-muted">{list.people.length} of {list.limit} addresses</span>
        {!adding && list.people.length < list.limit && <Btn tone="brand" onClick={() => setAdding(true)}>Add a person</Btn>}</div>
      {list.people.length === 0 && !adding && <p className="t-body-sm text-m-muted">Nobody has an address on {domain} yet.</p>}
      {list.people.map(x => (
        <div key={x.address} className="flex flex-wrap items-center justify-between gap-2 py-2 border-t border-m-line">
          <div className="min-w-0"><b className="block t-body-md text-m-text truncate">{x.givenName} {x.familyName}{x.owner && <span className="ml-2 t-label-sm text-m-muted font-normal">You</span>}</b>
            <span className="t-body-sm text-m-muted break-all">{x.address}{x.status === "invited" && !x.owner ? ` · invited (${x.backupEmail})` : ""}</span></div>
          {!x.owner && <div className="flex gap-2">
            {x.status === "invited" && <Btn disabled={busy} onClick={() => void act(async () => { await mailApi.resendInvite(domain, x.address); alert(`Invite sent again to ${x.backupEmail}.`); })}>Resend invite</Btn>}
            <Btn tone="danger" disabled={busy} onClick={() => {
              if (confirm(`Remove ${x.address}?\n\nTheir sign-in stops now, and their mailbox and all its mail are deleted for good. This can’t be undone.`))
                void act(async () => { await mailApi.removePerson(domain, x.address); setList({ ...list, people: list.people.filter(y => y.address !== x.address) }); });
            }}>Remove</Btn>
          </div>}
        </div>
      ))}
      {adding && (
        <form className="rounded-m-lg bg-m-low/60 p-3 space-y-3" onSubmit={e => { e.preventDefault(); if (!busy) void act(async () => {
          const p = await mailApi.addPerson(domain, form);
          setList({ ...list, people: [...list.people, p] }); setForm(empty); setAdding(false);
        }); }}>
          <div className="grid sm:grid-cols-2 gap-3">
            <label><span className="t-label-sm text-m-muted block mb-1">First name</span><input value={form.givenName} onChange={set("givenName")} required maxLength={40} className={inputClass} /></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Last name</span><input value={form.familyName} onChange={set("familyName")} required maxLength={40} className={inputClass} /></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Their address</span>
              <span className="flex items-center gap-1"><input value={form.localPart} onChange={set("localPart")} required placeholder="ana" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} /><span className="t-body-md text-m-muted whitespace-nowrap">@{domain}</span></span></label>
            <label><span className="t-label-sm text-m-muted block mb-1">Their personal email</span><input type="email" value={form.backupEmail} onChange={set("backupEmail")} required placeholder="them@gmail.com" className={inputClass} /></label>
          </div>
          <p className="t-body-sm text-m-muted">We email them an invite with a temporary password. On first sign-in they choose their own password, which also locks their mailbox key: you can’t read their mail, and only they can reset their password.</p>
          <div className="flex gap-2"><Btn type="submit" tone="brand" disabled={busy}>{busy ? "Adding…" : "Add and send invite"}</Btn><Btn onClick={() => setAdding(false)}>Cancel</Btn></div>
        </form>
      )}
      {error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
    </div>
  );
}
