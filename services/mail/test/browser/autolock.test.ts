import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupMailboxKeys, startAutoLock } from "../../../../components/mail/crypto";
import { FAST_KDF } from "../helpers";

describe("idle auto-lock", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("locks after the idle period and calls onLock once", async () => {
    vi.useRealTimers();
    const { session } = await setupMailboxKeys({ address: "a@mactidar.com", password: "pw" }, { kdf: FAST_KDF });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const target = new EventTarget();
    const onLock = vi.fn();
    const stop = startAutoLock(session, { idleMs: 60_000, target, onLock });

    vi.advanceTimersByTime(59_000);
    expect(session.locked).toBe(false);
    target.dispatchEvent(new Event("keydown")); // activity resets the clock
    vi.advanceTimersByTime(59_000);
    expect(session.locked).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(session.locked).toBe(true);
    expect(onLock).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops watching once stopped", async () => {
    vi.useRealTimers();
    const { session } = await setupMailboxKeys({ address: "a@mactidar.com", password: "pw" }, { kdf: FAST_KDF });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const stop = startAutoLock(session, { idleMs: 1_000, target: new EventTarget() });
    stop();
    vi.advanceTimersByTime(5_000);
    expect(session.locked).toBe(false);
  });

  it("locks immediately if the page was hidden longer than the idle period", async () => {
    vi.useRealTimers();
    const { session } = await setupMailboxKeys({ address: "a@mactidar.com", password: "pw" }, { kdf: FAST_KDF });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const target = new EventTarget();
    startAutoLock(session, { idleMs: 10_000, target });
    // Simulate a suspended tab: wall clock jumps but timers did not fire.
    vi.setSystemTime(Date.now() + 60_000);
    target.dispatchEvent(new Event("pointerdown"));
    expect(session.locked).toBe(true);
  });
});
