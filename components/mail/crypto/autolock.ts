import type { MailboxSession } from "./keyring";

export const DEFAULT_IDLE_LOCK_MS = 15 * 60 * 1000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "visibilitychange"] as const;

/**
 * Lock the session (dropping the decrypted keys from memory) after `idleMs`
 * without user activity. Also checks wall-clock time on every activity event,
 * so a tab that was suspended past the deadline locks the moment it wakes.
 * Returns a function that stops watching.
 */
export function startAutoLock(
  session: MailboxSession,
  options: { idleMs?: number; target?: EventTarget; onLock?: () => void } = {},
): () => void {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_LOCK_MS;
  const target = options.target ?? globalThis;
  let deadline = Date.now() + idleMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const lockNow = () => {
    if (stopped) return;
    stop();
    session.lock();
    options.onLock?.();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (Date.now() >= deadline ? lockNow() : schedule()), Math.max(0, deadline - Date.now()));
  };

  const onActivity = () => {
    if (Date.now() >= deadline) return lockNow();
    deadline = Date.now() + idleMs;
    schedule();
  };

  function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const e of ACTIVITY_EVENTS) target.removeEventListener(e, onActivity);
  }

  for (const e of ACTIVITY_EVENTS) target.addEventListener(e, onActivity, { passive: true });
  schedule();
  return stop;
}
