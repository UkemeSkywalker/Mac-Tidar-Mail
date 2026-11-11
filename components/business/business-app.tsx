"use client";

// Mac Tidar Mail for Business: sign up with an address on your company's domain, confirm your
// backup email, then set the domain up here (DNS records, logo, team). The mailbox itself opens
// in the mail app once the domain is verified; until then this page is all the account can use.
import NextLink from "next/link";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../brand";
import { useSkin } from "../skin-store";
import { ApiError, mailApi, type DomainView } from "../mail/live/api";
import { configureAuth, confirmSignUp, getCurrentUser, resendSignUpCode, signIn, signOut, signUp } from "../mail/live/auth";
import { liveEnabled } from "../mail/live/config";
import { Icon } from "../mail/ui";
import { Btn, DomainSetup, errorMessage, inputClass, LOGO_ACCEPT, LogoPreview } from "./domain-setup";

const PASSWORD_RULES = "At least 8 characters, with upper- and lower-case letters, a number and a symbol.";
const strongEnough = (pw: string) => pw.length >= 8 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
const PROVIDERS = /^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|zoho|yandex|mail|fastmail|tutanota|hey)\.[a-z.]+$/;

/** What people type ("https://Acme.com/") as the ASCII domain DNS uses ("acme.com"); "" if it isn't one. */
function toDomain(raw: string): string {
  const typed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!typed || /[\s@]/.test(typed)) return "";
  try { const host = new URL(`http://${typed}`).hostname; return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : ""; } catch { return ""; }
}

const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return "Something went wrong.";
  if (e.name === "UsernameExistsException") return "That address already has an account. Sign in instead, or choose another address.";
  if (e.name === "UserLambdaValidationException") return e.message.replace(/^PreSignUp failed with error\s*/i, "").replace(/\.?$/, ".");
  if (e.name === "NotAuthorizedException" || e.name === "UserNotFoundException") return "Incorrect address or password.";
  if (e.name === "CodeMismatchException") return "That code isn’t right. Check the latest email and try again.";
  if (e.name === "ExpiredCodeException") return "That code has expired. Send a new one.";
  if (e.name === "InvalidPasswordException") return PASSWORD_RULES;
  return e.message;
};

interface Draft { company: string; domain: string; first: string; last: string; local: string; backup: string }
const EMPTY: Draft = { company: "", domain: "", first: "", last: "", local: "", backup: "" };

type Stage =
  | { s: "loading" } | { s: "signup"; error?: string } | { s: "confirm"; error?: string; info?: string }
  | { s: "signin"; error?: string } | { s: "working"; label: string } | { s: "setup"; address: string };

function Shell({ children, title, subtitle, wide }: { children: ReactNode; title: string; subtitle?: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-dvh bg-m-canvas px-4 py-8 sm:py-12">
      <div className={`mx-auto w-full ${wide ? "max-w-3xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between mb-6">
          <NextLink href="/" className="flex items-center gap-3"><BrandMark className="h-9" /><span><b className="t-headline-sm text-m-text block">Mac Tidar Mail</b><span className="t-label-sm text-m-muted">for Business</span></span></NextLink>
        </div>
        <h1 className="t-headline-lg text-m-text">{title}</h1>
        {subtitle && <div className="t-body-md text-m-muted mt-1">{subtitle}</div>}
        <div className="mt-6 space-y-4">{children}</div>
      </div>
    </div>
  );
}
const Card = ({ children }: { children: ReactNode }) => <div className="bg-m-card rounded-m-xl border border-m-line shadow-sm p-space-lg space-y-4">{children}</div>;
const Label = ({ text, hint, children }: { text: string; hint?: ReactNode; children: ReactNode }) => (
  <label className="block"><span className="t-label-md text-m-muted">{text}</span><span className="mt-1 block">{children}</span>{hint && <span className="t-label-sm text-m-muted mt-1 block">{hint}</span>}</label>
);
const Primary = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button {...p} className="w-full py-2.5 rounded-m-lg bg-m-brand text-m-on-brand t-headline-sm hover:bg-m-brand-hover disabled:opacity-50">{children}</button>;
const LinkBtn = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p} className="t-label-md text-m-primary hover:underline">{children}</button>;
const ErrorLine = ({ text }: { text?: string }) => text ? <p role="alert" className="t-label-md text-m-error">{text}</p> : null;

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input {...props} type={show ? "text" : "password"} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={`${inputClass} pr-11`} />
      <button type="button" onClick={() => setShow(v => !v)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-m-muted hover:text-m-text"><Icon name={show ? "visibility_off" : "visibility"} className="text-[20px]" /></button>
    </span>
  );
}

export function BusinessApp() {
  const skin = useSkin();
  const [stage, setStage] = useState<Stage>({ s: "loading" });
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [signinAddress, setSigninAddress] = useState("");
  const password = useRef("");
  const logo = useRef<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!liveEnabled) return;
    configureAuth();
    const wantSignin = new URLSearchParams(location.search).get("mode") === "signin";
    getCurrentUser().then(u => setStage({ s: "setup", address: u.username }), () => setStage({ s: wantSignin ? "signin" : "signup" }));
  }, []);
  useEffect(() => () => { if (logoPreview) URL.revokeObjectURL(logoPreview); }, [logoPreview]);

  const run = (fn: () => Promise<void>, back: (error: string) => Stage) => fn().catch(e => setStage(back(e instanceof ApiError ? e.message : errorText(e))));
  const form = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return new FormData(e.currentTarget); };
  const field = (f: FormData, n: string) => String(f.get(n) ?? "").trim();
  const domainOf = (d: Draft) => toDomain(d.domain);
  const usernameOf = (d: Draft) => `${d.local.toLowerCase()}@${domainOf(d)}`;

  /** After the code: sign in, start setting up the domain, attach the logo. */
  async function finishSignup(d: Draft) {
    setStage({ s: "working", label: "Signing in…" });
    const r = await signIn({ username: usernameOf(d), password: password.current });
    password.current = "";
    if (r.nextStep.signInStep !== "DONE") throw new Error("Your account is ready. Sign in to continue.");
    setStage({ s: "working", label: `Setting up ${domainOf(d)}…` });
    const view = await mailApi.connectDomain(domainOf(d), d.company);
    if (logo.current) await mailApi.uploadLogo(view.domain, logo.current).catch(() => {}); // it can be added again on the next screen
    logo.current = null;
    setStage({ s: "setup", address: usernameOf(d) });
  }

  const wrap = (node: ReactNode) => <div className={`mail-root mail-skin-${skin} t-body-md antialiased`}>{node}</div>;
  if (!liveEnabled) return wrap(<Shell title="Not configured">Mac Tidar Mail isn’t configured on this build.</Shell>);

  switch (stage.s) {
    case "loading":
    case "working":
      return wrap(<div className="min-h-dvh grid place-items-center bg-m-canvas text-m-muted"><div className="flex items-center gap-3 t-body-md"><span className="w-4 h-4 rounded-full border-2 border-m-brand border-t-transparent animate-spin" />{stage.s === "working" ? stage.label : "Loading…"}</div></div>);

    case "signup": {
      const domain = domainOf(draft);
      return wrap(<Shell title="Email on your own domain" subtitle={<>Give your team addresses like <b className="text-m-text">you@{domain || "yourcompany.com"}</b>, end-to-end encrypted. Free for up to 25 people.</>}>
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          const d: Draft = { company: field(f, "company"), domain: field(f, "domain"), first: field(f, "first"), last: field(f, "last"), local: field(f, "local").toLowerCase(), backup: field(f, "backup").toLowerCase() };
          setDraft(d);
          const dom = domainOf(d), pw = String(f.get("password") ?? "");
          if (!dom) throw new Error("Enter your company’s domain, like yourcompany.com.");
          if (PROVIDERS.test(dom)) throw new Error("That domain belongs to an email provider. Use your company’s own domain.");
          const backupHost = d.backup.split("@")[1] ?? "";
          if (backupHost === dom || backupHost.endsWith(`.${dom}`)) throw new Error(`Use a backup email outside ${dom} (Gmail, Outlook…): it’s how we reach you until ${dom} works.`);
          if (!strongEnough(pw)) throw new Error(PASSWORD_RULES);
          password.current = pw;
          setStage({ s: "working", label: "Creating your account…" });
          const r = await signUp({ username: usernameOf(d), password: pw, options: { userAttributes: { email: d.backup, given_name: d.first, family_name: d.last } } });
          if (r.nextStep.signUpStep === "DONE") return finishSignup(d);
          setStage({ s: "confirm" });
        }, error => ({ s: "signup", error })); }}>
          <Card>
            <b className="block t-headline-sm text-m-text">Your company</b>
            <Label text="Company name" hint="Shown with your logo at the top of everyone’s inbox."><input name="company" required maxLength={40} defaultValue={draft.company} autoComplete="organization" placeholder="Acme Studio" className={inputClass} /></Label>
            <Label text="Your domain" hint="The domain you already own. You’ll add a few DNS records to it next.">
              <input name="domain" required defaultValue={draft.domain} onChange={e => setDraft(x => ({ ...x, domain: e.target.value }))} placeholder="yourcompany.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} />
            </Label>
            <div>
              <span className="t-label-md text-m-muted">Logo (optional)</span>
              <div className="mt-1 flex items-center gap-3">
                <LogoPreview url={logoPreview} name={draft.company || "?"} />
                <label className="px-3 py-2 rounded-m-lg t-headline-sm bg-m-low text-m-text hover:bg-m-mid cursor-pointer">
                  {logoPreview ? "Change logo" : "Choose logo"}
                  <input type="file" accept={LOGO_ACCEPT} className="sr-only" onChange={e => {
                    const file = e.target.files?.[0] ?? null;
                    if (file && (!LOGO_ACCEPT.split(",").includes(file.type) || file.size > 1024 * 1024)) { alert("Use a PNG, JPEG or WebP image up to 1 MB."); e.target.value = ""; return; }
                    logo.current = file; setLogoPreview(file ? URL.createObjectURL(file) : null);
                  }} />
                </label>
                {logoPreview && <LinkBtn onClick={() => { logo.current = null; setLogoPreview(null); }}>Remove</LinkBtn>}
              </div>
              <span className="t-label-sm text-m-muted mt-1 block">PNG, JPEG or WebP up to 1 MB. You can add or change it later.</span>
            </div>
          </Card>
          <Card>
            <b className="block t-headline-sm text-m-text">You</b>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Label text="First name"><input name="first" required maxLength={40} defaultValue={draft.first} autoComplete="given-name" className={inputClass} /></Label>
              <Label text="Last name"><input name="last" required maxLength={40} defaultValue={draft.last} autoComplete="family-name" className={inputClass} /></Label>
            </div>
            <Label text="Your address" hint="You sign in with this. Its mailbox opens as soon as your domain is verified.">
              <span className="flex items-stretch rounded-m-lg border border-m-line bg-m-low focus-within:ring-2 focus-within:ring-m-brand/30 overflow-hidden">
                <input name="local" required minLength={3} maxLength={30} pattern="[A-Za-z0-9]([A-Za-z0-9]|[._\-](?=[A-Za-z0-9])){2,29}" defaultValue={draft.local} placeholder="you" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-m-text t-body-md focus:outline-none" />
                <span className="px-3 flex items-center t-body-md text-m-muted bg-m-mid max-w-[55%] truncate">@{domain || "yourcompany.com"}</span>
              </span>
            </Label>
            <Label text="Backup email" hint={<>Your current email (Gmail, Outlook…). We send your sign-up code here, and keep you posted until your domain is verified. It’s also for password resets; you can’t sign in with it.</>}>
              <input name="backup" type="email" required defaultValue={draft.backup} autoComplete="email" placeholder="you@gmail.com" className={inputClass} />
            </Label>
            <Label text="Password" hint={PASSWORD_RULES}><PasswordInput name="password" autoComplete="new-password" minLength={8} required /></Label>
          </Card>
          <ErrorLine text={stage.error} />
          <Primary type="submit">Create business account</Primary>
          <p className="t-body-sm text-m-muted">Your password also locks your mailbox key. Mac Tidar never sees it, so nobody, including us and the company, can read anyone’s mail. That also means a forgotten password can’t be reset by an admin.</p>
        </form>
        <p className="t-body-sm text-m-muted text-center pt-2 border-t border-m-line">Already set up? <LinkBtn onClick={() => setStage({ s: "signin" })}>Sign in</LinkBtn> · Just for you? <NextLink href="/app/?mode=signup" className="t-label-md text-m-primary hover:underline">Get a free @mactidar.com address</NextLink></p>
      </Shell>);
    }

    case "confirm":
      return wrap(<Shell title="Check your email" subtitle={stage.info ?? `We sent a 6-digit code to ${draft.backup || "your backup email"}. It can take a minute to arrive.`}>
        <Card>
          <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
            await confirmSignUp({ username: usernameOf(draft), confirmationCode: field(f, "code") });
            await finishSignup(draft);
          }, error => ({ s: "confirm", error })); }}>
            <Label text="Code"><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required autoFocus className={inputClass} /></Label>
            <ErrorLine text={stage.error} /><Primary type="submit">Verify</Primary>
          </form>
          <div className="flex justify-between">
            <LinkBtn onClick={() => run(async () => { await resendSignUpCode({ username: usernameOf(draft) }); setStage({ s: "confirm", info: "New code sent to your backup email." }); }, error => ({ s: "confirm", error }))}>Send a new code</LinkBtn>
            <LinkBtn onClick={() => setStage({ s: "signup" })}>Back</LinkBtn>
          </div>
        </Card>
      </Shell>);

    case "signin":
      return wrap(<Shell title="Sign in to set up your domain" subtitle="Use the address you signed up with, like you@yourcompany.com.">
        <Card>
          <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
            const username = signinAddress.trim().toLowerCase();
            setStage({ s: "working", label: "Signing in…" });
            const pw = String(f.get("password") ?? "");
            const r = await signIn({ username, password: pw });
            if (r.nextStep.signInStep === "CONFIRM_SIGN_UP") {
              // Signed up but never entered the code: send a new one and carry on from there.
              const [local = "", dom = ""] = username.split("@");
              password.current = pw;
              setDraft({ ...EMPTY, local, domain: dom });
              await resendSignUpCode({ username });
              setStage({ s: "confirm", info: "Your account isn’t verified yet. We’ve sent a new code to your backup email." });
              return;
            }
            // Two-step codes, first-time passwords and the mailbox itself are handled by the mail app.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load on purpose: nothing from this sign-in flow should carry over
            if (r.nextStep.signInStep !== "DONE") { location.assign("/app/"); return; }
            setStage({ s: "setup", address: username });
          }, error => ({ s: "signin", error })); }}>
            <Label text="Address"><input value={signinAddress} onChange={e => setSigninAddress(e.target.value)} type="text" inputMode="email" required autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="you@yourcompany.com" className={inputClass} /></Label>
            <Label text="Password"><PasswordInput name="password" autoComplete="current-password" required /></Label>
            <ErrorLine text={stage.error} /><Primary type="submit">Sign in</Primary>
          </form>
          <div className="flex justify-between"><NextLink href="/app/" className="t-label-md text-m-primary hover:underline">Forgot password?</NextLink><LinkBtn onClick={() => setStage({ s: "signup" })}>Create a business account</LinkBtn></div>
        </Card>
      </Shell>);

    case "setup":
      return wrap(<Setup address={stage.address} onSignOut={() => { void signOut().finally(() => setStage({ s: "signin" })); }} />);
  }
}

/** The signed-in setup screen: every domain this account has, or the form to connect one. */
function Setup({ address, onSignOut }: { address: string; onSignOut: () => void }) {
  const [state, setState] = useState<{ domains: DomainView[]; limit: number; businessDomain: string | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("");
  const logo = useRef<HTMLInputElement>(null);
  useEffect(() => { mailApi.domains().then(setState, e => setError(errorMessage(e))); }, []);
  const replace = useCallback((d: DomainView) => setState(s => s && { ...s, domains: s.domains.map(x => x.domain === d.domain ? d : x) }), []);

  const pending = state?.domains.some(d => d.status === "pending");
  const anyLive = state?.domains.find(d => d.status === "active" && d.ownAddress);
  return (
    <Shell wide title={!state ? "Your domain" : state.domains.length === 0 ? "Connect your domain" : pending ? "Finish setting up your domain" : "Your domain"}
      subtitle={<span className="flex flex-wrap items-center gap-x-3 gap-y-1">Signed in as <b className="text-m-text">{address}</b><button type="button" onClick={onSignOut} className="t-label-md text-m-primary hover:underline">Sign out</button>{anyLive && <a href="/app/" className="t-label-md text-m-primary hover:underline">Open your mailbox</a>}</span>}>
      {!state && <p className="t-body-md text-m-muted">{error || "Loading…"}</p>}
      {state && pending && <ol className="grid sm:grid-cols-3 gap-2 t-body-sm">
        {[["dns", "Add the DNS records"], ["verified", "We verify and email you"], ["group_add", "Add your team"]].map(([icon, text], i) => (
          <li key={icon} className={`flex items-center gap-2 rounded-m-lg px-3 py-2 border border-m-line ${i === 0 ? "bg-m-card text-m-text" : "bg-m-low text-m-muted"}`}><Icon name={icon!} className="text-[18px]" />{i + 1}. {text}</li>
        ))}
      </ol>}
      {state?.domains.map(d => <DomainSetup key={d.domain} d={d} onChange={replace} onRemoved={() => setState(s => s && { ...s, domains: s.domains.filter(x => x.domain !== d.domain) })} />)}
      {state && state.domains.length < state.limit && (
        <form className="bg-m-card rounded-m-xl border border-m-line shadow-sm p-space-lg space-y-4" onSubmit={e => { e.preventDefault(); if (busy) return; setBusy(true); setError("");
          (async () => {
            const target = state.businessDomain ?? toDomain(domain);
            if (!target) throw new Error("Enter a domain, like yourcompany.com.");
            const d = await mailApi.connectDomain(target, company);
            const file = logo.current?.files?.[0];
            const withLogo = file ? await mailApi.uploadLogo(d.domain, file).catch(() => d) : d;
            setState(s => s && { ...s, domains: [...s.domains, withLogo] }); setCompany(""); setDomain("");
          })().catch(err => setError(errorMessage(err))).finally(() => setBusy(false)); }}>
          <b className="block t-headline-sm text-m-text">{state.businessDomain ? `Set up ${state.businessDomain}` : "Connect a domain"}</b>
          <div className="grid sm:grid-cols-2 gap-4">
            <Label text="Company name"><input value={company} onChange={e => setCompany(e.target.value)} required maxLength={40} placeholder="Acme Studio" className={inputClass} /></Label>
            {state.businessDomain
              ? <Label text="Domain"><input value={state.businessDomain} readOnly className={`${inputClass} text-m-muted`} /></Label>
              : <Label text="Domain"><input value={domain} onChange={e => setDomain(e.target.value)} required placeholder="yourcompany.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputClass} /></Label>}
          </div>
          <Label text="Logo (optional)" hint="PNG, JPEG or WebP up to 1 MB."><input ref={logo} type="file" accept={LOGO_ACCEPT} className="t-body-sm text-m-muted" /></Label>
          <Btn type="submit" tone="brand" disabled={busy}>{busy ? "Setting up…" : "Continue"}</Btn>
        </form>
      )}
      {state && error && <p className="t-body-sm text-m-error" role="alert">{error}</p>}
      <p className="t-body-sm text-m-muted">Mail on your domain is end-to-end encrypted. You decide who has an address, but neither you nor Mac Tidar can read anyone’s mail or reset their password for them.</p>
    </Shell>
  );
}
