"use client";

// Everything between "signed out" and "mailbox unlocked". The password is held only in this
// component's memory long enough to sign in and unlock the mailbox key, then dropped.
import NextLink from "next/link";
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSkin } from "../../skin-store";
import {
  createIndexedDbDeviceStore, InvalidRecoveryCodeError, lockedKeyCount, resetMailboxKeys, setupMailboxKeys, startAutoLock, unlockMailbox, WrongPasswordError,
  type DeviceKeyStore, type MailboxKeyState, type MailboxSession,
} from "../crypto";
import { Icon } from "../ui";
import { ApiError, mailApi, type ServerMailbox } from "./api";
import { configureAuth, confirmResetPassword, confirmSignIn, confirmSignUp, resendSignUpCode, resetPassword, signIn, signOut, signUp } from "./auth";

export interface LiveSession {
  address: string;
  displayName: string;
  session: MailboxSession;
  lockedKeys: number;
  lock: () => void;
  signOut: () => Promise<void>;
  openRecovery: () => void;
  /** Present when this account has more than one mailbox. */
  switchMailbox?: () => void;
}

const LiveContext = createContext<LiveSession | null>(null);

/** The unlocked mailbox, for components rendered inside <LiveGate>. */
export function useLiveSession(): LiveSession {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLiveSession must be used inside <LiveGate>");
  return live;
}

type Stage =
  | { s: "signin"; error?: string } | { s: "totp"; error?: string } | { s: "newPassword"; error?: string }
  | { s: "forgot"; error?: string } | { s: "forgotCode"; error?: string } | { s: "working"; label: string }
  | { s: "signup"; error?: string } | { s: "confirmSignup"; error?: string; info?: string } | { s: "claim"; error?: string }
  | { s: "pick"; mailboxes: ServerMailbox[] } | { s: "switch"; mailboxes: ServerMailbox[]; error?: string }
  | { s: "recoveryShow"; code: string; file: string } | { s: "passwordChanged"; error?: string }
  | { s: "ready" } | { s: "locked"; error?: string } | { s: "fatal"; error: string };

function device(): DeviceKeyStore | null {
  try { return createIndexedDbDeviceStore(); } catch { return null; }
}

const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return "Something went wrong.";
  if (e.name === "NotAuthorizedException" || e.name === "UserNotFoundException") return "Incorrect email or password.";
  if (e.name === "UsernameExistsException") return "There’s already an account with that email. Sign in instead, or reset your password.";
  if (e.name === "CodeMismatchException") return "That code isn’t right. Check the latest email and try again.";
  if (e.name === "ExpiredCodeException") return "That code has expired. Send a new one.";
  if (e.name === "InvalidPasswordException") return PASSWORD_RULES;
  return e.message;
};

// The pool's policy is 8+ with mixed case, a number and a symbol; the app asks for 12 because the
// password also protects the mailbox key.
const PASSWORD_RULES = "Use at least 12 characters, with upper- and lower-case letters, a number and a symbol.";
const strongEnough = (pw: string) => pw.length >= 12 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
const MAIL_DOMAIN = "mactidar.com";
const isMacTidarAddress = (v: string) => /@(?:[a-z0-9-]+\.)*mactidar\.com$/i.test(v.trim());

function Shell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="min-h-dvh grid place-items-center bg-m-canvas p-4">
      <div className="w-full max-w-md bg-m-card rounded-m-xl shadow-xl border border-m-line p-space-xl">
        <div className="flex items-center gap-3 mb-6">
          <span className="w-10 h-10 rounded-m-xl bg-m-brand text-m-on-brand flex items-center justify-center"><Icon name="mail" className="text-[20px]" /></span>
          <div><b className="t-headline-sm text-m-text block">Mac Tidar Mail</b><span className="t-label-sm text-m-muted">Zero-access encrypted</span></div>
        </div>
        <h1 className="t-headline-lg text-m-text">{title}</h1>
        {subtitle && <p className="t-body-md text-m-muted mt-1">{subtitle}</p>}
        <div className="mt-6 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="t-label-md text-m-muted">{label}</span>
      <input {...props} className="mt-1 w-full px-3 py-2.5 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
    </label>
  );
}
/** Password input with a show/hide toggle. */
function PasswordField({ label, hint, ...props }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="block">
        <span className="t-label-md text-m-muted">{label}</span>
        <span className="relative mt-1 block">
          <input {...props} type={show ? "text" : "password"} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full pl-3 pr-11 py-2.5 rounded-m-lg bg-m-low text-m-text t-body-md border border-m-line focus:outline-none focus:ring-2 focus:ring-m-brand/30" />
          <button type="button" onClick={() => setShow(v => !v)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} title={show ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 px-3 flex items-center text-m-muted hover:text-m-text focus:outline-none focus-visible:text-m-text">
            <Icon name={show ? "visibility_off" : "visibility"} className="text-[20px]" />
          </button>
        </span>
      </label>
      {hint && <p className="t-label-sm text-m-muted mt-1">{hint}</p>}
    </div>
  );
}

const Primary = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button {...p} className="w-full py-2.5 rounded-m-lg bg-m-brand text-m-on-brand t-headline-sm hover:bg-m-brand-hover disabled:opacity-50">{children}</button>;
const Link = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" {...p} className="t-label-md text-m-primary hover:underline">{children}</button>;
const ErrorLine = ({ text }: { text?: string }) => text ? <p role="alert" className="t-label-md text-m-error">{text}</p> : null;

export function LiveGate({ children }: { children: ReactNode }) {
  const skin = useSkin();
  const [stage, setStage] = useState<Stage>({ s: "working", label: "Starting…" });
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  /** The Cognito username to use for the account behind `email` (resolved from an @mactidar.com address). */
  const loginName = useRef<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const password = useRef<string>("");
  const mailbox = useRef<ServerMailbox | null>(null);
  /** Every mailbox on this account, and the one to open after a switch's fresh sign-in. */
  const boxes = useRef<ServerMailbox[]>([]);
  const target = useRef<string | null>(null);
  const [multiple, setMultiple] = useState(false);
  const keyState = useRef<{ state: MailboxKeyState; version: number } | null>(null);
  const [session, setSession] = useState<MailboxSession | null>(null);
  /** Render-side copy of the open mailbox (refs above are for async flows only). */
  const [opened, setOpened] = useState<{ address: string; displayName: string; lockedKeys: number } | null>(null);
  const dev = useRef<DeviceKeyStore | null>(null);

  // Always start from a fresh sign-in: the mailbox key needs the password anyway.
  useEffect(() => {
    configureAuth();
    dev.current = device();
    const signup = new URLSearchParams(location.search).get("mode") === "signup";
    signOut().catch(() => {}).finally(() => setStage({ s: signup ? "signup" : "signin" }));
  }, []);

  const saveKeys = async (state: MailboxKeyState) => {
    const mb = mailbox.current!, current = keyState.current;
    const { keyVersion } = await mailApi.saveKeys(mb.address, state, current?.version ?? mb.keyVersion);
    keyState.current = { state, version: keyVersion };
    setOpened({ address: mb.address, displayName: mb.displayName, lockedKeys: lockedKeyCount(state) });
  };

  const finishUnlock = useCallback((s: MailboxSession) => {
    password.current = "";
    setSession(s);
    setStage({ s: "ready" });
  }, []);

  async function openMailbox(mb: ServerMailbox) {
    mailbox.current = mb;
    setOpened({ address: mb.address, displayName: mb.displayName, lockedKeys: mb.keyState ? lockedKeyCount(mb.keyState) : 0 });
    if (!mb.keyState) {
      setStage({ s: "working", label: "Creating your mailbox key…" });
      const { state, session: s, recovery } = await setupMailboxKeys({ address: mb.address, password: password.current, displayName: mb.displayName }, { device: dev.current });
      keyState.current = { state, version: mb.keyVersion };
      await saveKeys(state);
      setSession(s);
      password.current = "";
      setStage({ s: "recoveryShow", code: recovery.code, file: recovery.file });
      return;
    }
    keyState.current = { state: mb.keyState, version: mb.keyVersion };
    setStage({ s: "working", label: "Unlocking your mailbox…" });
    try {
      const { session: s, state, restored } = await unlockMailbox(mb.keyState, password.current, { device: dev.current });
      if (restored.length) await saveKeys(state);
      finishUnlock(s);
    } catch (e) {
      if (e instanceof WrongPasswordError) setStage({ s: "passwordChanged" });
      else throw e;
    }
  }

  async function afterSignIn() {
    setStage({ s: "working", label: "Finding your mailbox…" });
    const list = await mailApi.mailboxes();
    boxes.current = list;
    setMultiple(list.length > 1);
    const chosen = list.find(m => m.address === target.current);
    target.current = null;
    if (chosen) return openMailbox(chosen);
    if (!list.length) return setStage({ s: "claim" });
    if (list.length > 1) return setStage({ s: "pick", mailboxes: list });
    await openMailbox(list[0]!);
  }

  const run = (fn: () => Promise<void>, back: (error: string) => Stage) => fn().catch(e => setStage(back(e instanceof ApiError || e instanceof Error ? errorText(e) : "Something went wrong.")));

  /**
   * Who to sign in as. An @mactidar.com address signs in to the account that owns it (whose
   * email is the backup address); anything else is the account email itself.
   */
  async function loginNames(input: string): Promise<string[]> {
    const id = input.trim().toLowerCase();
    if (!isMacTidarAddress(id)) return [id];
    const owner = await mailApi.signInName(id).catch(() => null);
    return owner ? [owner, id] : [id];
  }

  async function doSignIn(pw: string) {
    password.current = pw;
    setStage({ s: "working", label: "Signing in…" });
    let res: Awaited<ReturnType<typeof signIn>> | undefined;
    const names = await loginNames(email);
    for (const [i, username] of names.entries()) {
      try { res = await signIn({ username, password: pw }); loginName.current = username; break; }
      catch (e) { if (i === names.length - 1 || !(e instanceof Error) || !["NotAuthorizedException", "UserNotFoundException"].includes(e.name)) throw e; }
    }
    const step = res!.nextStep.signInStep;
    if (step === "DONE") return afterSignIn();
    if (step === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") return setStage({ s: "totp" });
    if (step === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") return setStage({ s: "newPassword" });
    if (step === "CONFIRM_SIGN_UP") {
      await resendSignUpCode({ username: loginName.current! });
      return setStage({ s: "confirmSignup", info: "Your account isn’t verified yet. We’ve sent a new code to your backup email." });
    }
    if (step === "RESET_PASSWORD") return setStage({ s: "forgot", error: "Your password must be reset before you can sign in." });
    throw new Error("This account needs to finish setup in Mac Tidar Cloud first.");
  }

  const lock = useCallback(() => { session?.lock(); setSession(null); setStage({ s: "locked" }); }, [session]);

  useEffect(() => {
    if (stage.s !== "ready" || !session) return;
    return startAutoLock(session, { onLock: () => { setSession(null); setStage({ s: "locked" }); } });
  }, [stage.s, session]);

  const doSignOut = useCallback(async () => {
    session?.lock(); setSession(null); password.current = "";
    await signOut().catch(() => {});
    setStage({ s: "signin" });
  }, [session]);

  // Each mailbox key is unlocked with the password, which is never kept; switching signs in again.
  const switchMailbox = useCallback(() => {
    session?.lock(); setSession(null); password.current = "";
    setStage({ s: "switch", mailboxes: boxes.current.filter(m => m.address !== mailbox.current?.address) });
  }, [session]);

  const wrap = (node: ReactNode) => <div className={`mail-root mail-skin-${skin} t-body-md antialiased`}>{node}</div>;
  const form = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return new FormData(e.currentTarget); };
  const field = (f: FormData, name: string) => String(f.get(name) ?? "");

  /** Bring locked keys back with the recovery file/code or the previous password, then reload with them. */
  async function recoverOlderKeys(input: string, kind: "recovery" | "password") {
    const ks = keyState.current, s = session;
    if (!ks || !s) return;
    const result = kind === "password" ? await s.unlockWithOldPassword(ks.state, input) : await s.restoreWithRecovery(ks.state, input, { device: dev.current });
    if (!result.restored.length) throw new Error("No locked keys could be opened with that.");
    await saveKeys(result.state);
    setRecoveryOpen(false);
    location.reload();
  }

  if (stage.s === "ready" && session && opened) {
    const live: LiveSession = {
      address: opened.address, displayName: opened.displayName, session,
      lockedKeys: opened.lockedKeys, lock, signOut: doSignOut, openRecovery: () => setRecoveryOpen(true),
      ...(multiple ? { switchMailbox } : {}),
    };
    return <>
      <LiveContext.Provider value={live}>{children}</LiveContext.Provider>
      {recoveryOpen && <div className={`mail-root mail-skin-${skin} t-body-md antialiased`}><RecoveryDialog onClose={() => setRecoveryOpen(false)} recover={recoverOlderKeys} /></div>}
    </>;
  }

  switch (stage.s) {
    case "working":
      return wrap(<div className="min-h-dvh grid place-items-center bg-m-canvas text-m-muted"><div className="flex items-center gap-3 t-body-md"><span className="w-4 h-4 rounded-full border-2 border-m-brand border-t-transparent animate-spin" />{stage.label}</div></div>);
    case "signin":
      return wrap(<Shell title="Sign in" subtitle="Use your @mactidar.com address or your account email.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(() => doSignIn(field(f, "password")), error => ({ s: "signin", error })); }}>
          <Field label="Email" name="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
          <PasswordField label="Password" name="password" autoComplete="current-password" required />
          <ErrorLine text={stage.error} />
          <Primary type="submit">Sign in</Primary>
        </form>
        <div className="flex justify-between"><Link onClick={() => setStage({ s: "forgot" })}>Forgot password?</Link><NextLink href="/" className="t-label-md text-m-muted hover:underline">Back to home</NextLink></div>
        <p className="t-body-sm text-m-muted text-center pt-2 border-t border-m-line">New to Mac Tidar Mail? <Link onClick={() => setStage({ s: "signup" })}>Create an account</Link></p>
      </Shell>);
    case "signup":
      return wrap(<Shell title="Create your account" subtitle="Next you’ll choose your @mactidar.com address.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          const backup = field(f, "email").trim().toLowerCase(), pw = field(f, "password"), name = field(f, "name").trim();
          if (isMacTidarAddress(backup)) throw new Error("Use an email outside Mac Tidar (Gmail, Outlook…), so you can always reset your password.");
          if (!strongEnough(pw)) throw new Error(PASSWORD_RULES);
          setEmail(backup); setFullName(name); password.current = pw; loginName.current = backup;
          setStage({ s: "working", label: "Creating your account…" });
          const r = await signUp({ username: backup, password: pw, options: { userAttributes: { email: backup, name } } });
          if (r.nextStep.signUpStep === "DONE") return doSignIn(pw);
          setStage({ s: "confirmSignup" });
        }, error => ({ s: "signup", error })); }}>
          <Field label="Your name" name="name" autoComplete="name" required maxLength={64} defaultValue={fullName} />
          <div>
            <Field label="Backup email" name="email" type="email" autoComplete="email" required defaultValue={email} />
            <p className="t-label-sm text-m-muted mt-1">Your current email (Gmail, Outlook…). We send sign-up and password-reset codes here.</p>
          </div>
          <PasswordField label="Password" name="password" autoComplete="new-password" minLength={12} required hint={PASSWORD_RULES} />
          <ErrorLine text={stage.error} />
          <Primary type="submit">Continue</Primary>
        </form>
        <p className="t-body-sm text-m-muted">Your password also locks your mailbox key. Mac Tidar never sees it and can’t read your mail.</p>
        <p className="t-body-sm text-m-muted text-center pt-2 border-t border-m-line">Already have an account? <Link onClick={() => setStage({ s: "signin" })}>Sign in</Link></p>
      </Shell>);
    case "confirmSignup":
      return wrap(<Shell title="Check your email" subtitle={stage.info ?? `We sent a 6-digit code to ${email}. It can take a minute to arrive.`}>
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          await confirmSignUp({ username: loginName.current ?? email.trim().toLowerCase(), confirmationCode: field(f, "code").trim() });
          await doSignIn(password.current);
        }, error => ({ s: "confirmSignup", error })); }}>
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required autoFocus />
          <ErrorLine text={stage.error} /><Primary type="submit">Verify</Primary>
        </form>
        <div className="flex justify-between">
          <Link onClick={() => run(async () => { await resendSignUpCode({ username: loginName.current ?? email.trim().toLowerCase() }); setStage({ s: "confirmSignup", info: `New code sent to ${email}.` }); }, error => ({ s: "confirmSignup", error }))}>Send a new code</Link>
          <Link onClick={() => setStage({ s: "signup" })}>Change email</Link>
        </div>
      </Shell>);
    case "claim":
      return wrap(<Shell title="Choose your address" subtitle="This is your new email address. It can’t be changed later.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          const mb = await mailApi.claim(field(f, "local").trim().toLowerCase(), field(f, "name").trim());
          boxes.current = [mb];
          await openMailbox(mb);
        }, error => ({ s: "claim", error })); }}>
          <label className="block">
            <span className="t-label-md text-m-muted">Address</span>
            <span className="mt-1 flex items-stretch rounded-m-lg border border-m-line bg-m-low focus-within:ring-2 focus-within:ring-m-brand/30 overflow-hidden">
              <input name="local" required minLength={3} maxLength={30} pattern="[A-Za-z0-9]([A-Za-z0-9]|[._\-](?=[A-Za-z0-9])){2,29}" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus
                className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-m-text t-body-md focus:outline-none" />
              <span className="px-3 flex items-center t-body-md text-m-muted bg-m-mid">@{MAIL_DOMAIN}</span>
            </span>
            <span className="t-label-sm text-m-muted mt-1 block">3–30 letters or numbers; dots, dashes and underscores allowed between them.</span>
          </label>
          <Field label="Name people see" name="name" autoComplete="name" required maxLength={64} defaultValue={fullName} />
          <ErrorLine text={stage.error} /><Primary type="submit">Create my mailbox</Primary>
        </form>
        <Link onClick={doSignOut}>Sign out</Link>
      </Shell>);
    case "totp":
      return wrap(<Shell title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => { const r = await confirmSignIn({ challengeResponse: field(f, "code").trim() }); if (r.nextStep.signInStep !== "DONE") throw new Error("Verification incomplete"); await afterSignIn(); }, error => ({ s: "totp", error })); }}>
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required />
          <ErrorLine text={stage.error} /><Primary type="submit">Verify</Primary>
        </form>
      </Shell>);
    case "newPassword":
      return wrap(<Shell title="Choose a new password" subtitle="Your account needs a new password before first use.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => { const pw = field(f, "password"); password.current = pw; const r = await confirmSignIn({ challengeResponse: pw }); if (r.nextStep.signInStep !== "DONE") throw new Error("Sign-in incomplete"); await afterSignIn(); }, error => ({ s: "newPassword", error })); }}>
          <PasswordField label="New password" name="password" autoComplete="new-password" minLength={12} required hint={PASSWORD_RULES} />
          <ErrorLine text={stage.error} /><Primary type="submit">Continue</Primary>
        </form>
      </Shell>);
    case "forgot":
      return wrap(<Shell title="Reset your password" subtitle="Enter your @mactidar.com address or account email. We’ll send a code to your backup email.">
        <form className="space-y-4" onSubmit={e => { form(e); run(async () => {
          loginName.current = (await loginNames(email))[0]!;
          await resetPassword({ username: loginName.current });
          setStage({ s: "forgotCode" });
        }, error => ({ s: "forgot", error })); }}>
          <Field label="Email" name="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          <ErrorLine text={stage.error} /><Primary type="submit">Send code</Primary>
        </form>
        <Link onClick={() => setStage({ s: "signin" })}>Back to sign in</Link>
      </Shell>);
    case "forgotCode":
      return wrap(<Shell title="Enter the code" subtitle="Check your backup email for a 6-digit code, then choose a new password. Your mail is never lost: new mail works straight away, and older mail can be recovered.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          const pw = field(f, "password");
          if (!strongEnough(pw)) throw new Error(PASSWORD_RULES);
          await confirmResetPassword({ username: loginName.current ?? email.trim().toLowerCase(), confirmationCode: field(f, "code").trim(), newPassword: pw });
          await doSignIn(pw);
        }, error => ({ s: "forgotCode", error })); }}>
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
          <PasswordField label="New password" name="password" autoComplete="new-password" minLength={12} required hint={PASSWORD_RULES} />
          <ErrorLine text={stage.error} /><Primary type="submit">Reset password</Primary>
        </form>
      </Shell>);
    case "pick":
      return wrap(<Shell title="Choose a mailbox">
        {stage.mailboxes.map(m => <button key={m.address} type="button" onClick={() => run(() => openMailbox(m), error => ({ s: "fatal", error }))} className="w-full flex items-center justify-between p-3 rounded-m-xl border border-m-line hover:bg-m-low text-left"><span><b className="block t-headline-sm text-m-text">{m.displayName}</b><span className="t-body-sm text-m-muted">{m.address}</span></span><Icon name="arrow_forward" className="text-m-muted" /></button>)}
      </Shell>);
    case "switch": {
      const others = stage.mailboxes;
      return wrap(<Shell title="Switch mailbox" subtitle="Enter your password to unlock the other mailbox.">
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          await signOut().catch(() => {});
          target.current = field(f, "mailbox");
          await doSignIn(field(f, "password"));
        }, error => ({ s: "switch", mailboxes: others, error })); }}>
          <div className="space-y-2">
            {others.map((m, i) => <label key={m.address} className="flex items-center gap-3 p-3 rounded-m-xl border border-m-line hover:bg-m-low cursor-pointer">
              <input type="radio" name="mailbox" value={m.address} defaultChecked={i === 0} required />
              <span><b className="block t-headline-sm text-m-text">{m.displayName}</b><span className="t-body-sm text-m-muted">{m.address}</span></span>
            </label>)}
          </div>
          <PasswordField label="Password" name="password" autoComplete="current-password" required autoFocus />
          <ErrorLine text={stage.error} /><Primary type="submit">Open mailbox</Primary>
        </form>
        <Link onClick={doSignOut}>Sign out instead</Link>
      </Shell>);
    }
    case "recoveryShow":
      return wrap(<RecoveryCode code={stage.code} file={stage.file} address={opened?.address ?? ""} onDone={() => setStage({ s: "ready" })} />);
    case "passwordChanged":
      return wrap(<Shell title="Your password changed" subtitle="Your mailbox key was locked with your previous password. Choose how to continue.">
        <form className="space-y-3" onSubmit={e => { const f = form(e); run(async () => {
          // New key under the current password, then bring the old keys back onto it.
          const { session: s, state } = await resetMailboxKeys(keyState.current!.state, password.current, { device: dev.current });
          let restoredState = state;
          try { restoredState = (await s.unlockWithOldPassword(state, field(f, "old"))).state; }
          catch (e) { if (e instanceof WrongPasswordError) throw new Error("That previous password didn’t match."); throw e; }
          await saveKeys(restoredState);
          finishUnlock(s);
        }, error => ({ s: "passwordChanged", error })); }}>
          <PasswordField label="Previous password" name="old" autoComplete="off" required />
          <Primary type="submit">Unlock with previous password</Primary>
        </form>
        <div className="t-label-md text-m-muted text-center">or</div>
        <Primary onClick={() => run(async () => {
          setStage({ s: "working", label: "Creating a new key…" });
          const { session: s, state } = await resetMailboxKeys(keyState.current!.state, password.current, { device: dev.current });
          await saveKeys(state);
          finishUnlock(s);
        }, error => ({ s: "passwordChanged", error }))}>Start with a new key</Primary>
        <p className="t-body-sm text-m-muted">New mail is readable immediately. Older mail stays locked until you recover it with your recovery file, your previous password, or a device that’s still signed in.</p>
        <ErrorLine text={stage.error} />
      </Shell>);
    case "locked":
      return wrap(<Shell title="Mailbox locked" subtitle={`Locked after inactivity. Enter your password to unlock ${opened?.address ?? "your mailbox"}.`}>
        <form className="space-y-4" onSubmit={e => { const f = form(e); run(async () => {
          setStage({ s: "working", label: "Unlocking…" });
          try {
            const { session: s, state, restored } = await unlockMailbox(keyState.current!.state, field(f, "password"), { device: dev.current });
            if (restored.length) await saveKeys(state);
            finishUnlock(s);
          } catch (e) { if (e instanceof WrongPasswordError) throw new Error("Incorrect password."); throw e; }
        }, error => ({ s: "locked", error })); }}>
          <PasswordField label="Password" name="password" autoComplete="current-password" required autoFocus />
          <ErrorLine text={stage.error} /><Primary type="submit">Unlock</Primary>
        </form>
        <Link onClick={doSignOut}>Sign out instead</Link>
      </Shell>);
    case "fatal":
      return wrap(<Shell title="Couldn't open your mailbox" subtitle={stage.error}><Primary onClick={doSignOut}>Back to sign in</Primary></Shell>);
    default:
      return null;
  }
}

function RecoveryCode({ code, file, address, onDone }: { code: string; file: string; address: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([file], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = `mactidar-mail-recovery-${address}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };
  return (
    <Shell title="Save your recovery file" subtitle="This is the only way to open old mail if you forget your password and lose access to every signed-in device. Mac Tidar can't recover it for you.">
      <div className="p-3 rounded-m-lg bg-m-low border border-m-line font-mono t-body-sm text-m-text break-all select-all">{code}</div>
      <Primary onClick={download}><span className="inline-flex items-center gap-2"><Icon name="download" className="text-[18px]" />Download recovery file</span></Primary>
      <label className="flex items-start gap-2 t-body-md text-m-text">
        <input type="checkbox" className="mt-1" checked={saved} onChange={e => setSaved(e.target.checked)} />
        <span>I’ve saved my recovery file somewhere safe (not in this mailbox).</span>
      </label>
      <Primary disabled={!saved} onClick={onDone}>Open my mailbox</Primary>
    </Shell>
  );
}

function RecoveryDialog({ onClose, recover }: { onClose: () => void; recover: (input: string, kind: "recovery" | "password") => Promise<void> }) {
  const [kind, setKind] = useState<"recovery" | "password">("recovery");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md bg-m-card rounded-m-xl shadow-2xl border border-m-line p-space-lg space-y-4" role="dialog" aria-label="Recover older mail">
        <div className="flex items-center justify-between"><b className="t-headline-md text-m-text">Recover older mail</b><button type="button" onClick={onClose} aria-label="Close"><Icon name="close" className="text-m-muted" /></button></div>
        <div className="flex gap-1 bg-m-low p-1 rounded-m-lg">
          {(["recovery", "password"] as const).map(k => <button key={k} type="button" onClick={() => { setKind(k); setValue(""); setError(""); }} className={`flex-1 py-1.5 rounded-m t-label-md ${kind === k ? "bg-m-card text-m-text shadow-xs" : "text-m-muted"}`}>{k === "recovery" ? "Recovery file or code" : "Previous password"}</button>)}
        </div>
        {kind === "recovery" ? <>
          <textarea value={value} onChange={e => setValue(e.target.value)} rows={4} placeholder="Paste your recovery code, or choose the file below" className="w-full p-3 rounded-m-lg bg-m-low text-m-text t-body-sm font-mono border border-m-line focus:outline-none" />
          <input type="file" accept=".txt,text/plain" onChange={async e => { const f = e.target.files?.[0]; if (f && f.size < 20_000) setValue(await f.text()); }} className="t-body-sm text-m-muted" />
        </> : <PasswordField label="Previous password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" />}
        {error && <p role="alert" className="t-label-md text-m-error">{error}</p>}
        <Primary disabled={!value || busy} onClick={async () => {
          setBusy(true); setError("");
          try { await recover(value, kind); } catch (e) { setError(e instanceof InvalidRecoveryCodeError || e instanceof WrongPasswordError ? "That didn’t match. Check it and try again." : errorText(e)); } finally { setBusy(false); }
        }}>{busy ? "Recovering…" : "Recover"}</Primary>
      </div>
    </div>
  );
}
