import { describe, it, expect, vi } from 'vitest';
import {
  settleIdentity,
  DEFAULT_IDENTITY_BUDGET_MS,
  type IdentityGateTimer,
} from './identityGate';
import { SDK_WAIT_MS } from './crazygames/sdk';

/** A timer whose budget fires only when the test says so, so nothing here sleeps. */
function manualTimer(): IdentityGateTimer & {
  fire(): void;
  readonly started: Array<{ ms: number; handle: unknown }>;
  readonly cancelled: unknown[];
} {
  const started: Array<{ ms: number; handle: unknown }> = [];
  const cancelled: unknown[] = [];
  let pending: (() => void) | null = null;
  let next = 1;
  return {
    started,
    cancelled,
    start(fn, ms) {
      const handle = { id: next++ };
      started.push({ ms, handle });
      pending = fn;
      return handle;
    },
    cancel(handle) {
      cancelled.push(handle);
    },
    fire() {
      const fn = pending;
      expect(fn, 'the budget timer was never started').not.toBeNull();
      pending = null;
      fn?.();
    },
  };
}

describe('settleIdentity', () => {
  it('reports settled when the login answers, and calls it exactly once', async () => {
    const login = vi.fn(async () => 'an account');
    const timer = manualTimer();
    await expect(settleIdentity({ login, budgetMs: 500, timer })).resolves.toEqual({
      outcome: 'settled',
    });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('cancels the budget timer it started — the exact handle, not just any call', async () => {
    // A gate that leaves its timer running holds the boot open for the rest of the budget in
    // a Node runner and leaks a timer in a browser. Asserting the HANDLE is what separates
    // "cancel was called" from "the right timer was cancelled".
    const timer = manualTimer();
    await settleIdentity({ login: async () => undefined, budgetMs: 500, timer });
    expect(timer.started).toHaveLength(1);
    expect(timer.started[0].ms).toBe(500);
    expect(timer.cancelled).toEqual([timer.started[0].handle]);
  });

  it('reports failed — with the message — when the login rejects', async () => {
    // Separated from `timedOut` on purpose: both mean "guest", and a page full of guests
    // looks the same either way, so the only way to tell a refusing server from a slow one
    // is that this value says which.
    const timer = manualTimer();
    const settled = await settleIdentity({
      login: async () => {
        throw new Error('portal token rejected');
      },
      budgetMs: 500,
      timer,
    });
    expect(settled).toEqual({ outcome: 'failed', error: 'portal token rejected' });
  });

  it('flattens a non-Error rejection rather than reporting [object Object]', async () => {
    const timer = manualTimer();
    const settled = await settleIdentity({ login: () => Promise.reject('503'), budgetMs: 5, timer });
    expect(settled).toEqual({ outcome: 'failed', error: '503' });
  });

  it('gives up at the budget while the login is still in flight', async () => {
    const timer = manualTimer();
    const pending = settleIdentity({ login: () => new Promise<never>(() => {}), timer });
    timer.fire();
    await expect(pending).resolves.toEqual({ outcome: 'timedOut' });
  });

  it('a login that rejects AFTER the budget expired changes nothing and blows nothing up', async () => {
    // Worth stating what this does NOT prove, because it was written believing it did: it is
    // not evidence that the `.catch` placement prevents an unhandled rejection. A mutation run
    // moving that `.catch` onto the race stayed green, and the reason is that `Promise.race`
    // subscribes to every input, so the late failure is handled in both shapes. What survives
    // as a real claim is the one in the title — the outcome already reported is final.
    const timer = manualTimer();
    let reject: (e: unknown) => void = () => {};
    const pending = settleIdentity({
      login: () => new Promise<never>((_, rej) => { reject = rej; }),
      timer,
    });
    timer.fire();
    expect(await pending).toEqual({ outcome: 'timedOut' });
    reject(new Error('arrived too late'));
    // Two macrotask turns: enough for an unhandled rejection to be reported if there is one.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('clamps a negative budget to zero instead of waiting forever', async () => {
    const timer = manualTimer();
    void settleIdentity({ login: () => new Promise<never>(() => {}), budgetMs: -1, timer });
    expect(timer.started[0].ms).toBe(0);
  });

  it('defaults the budget when none is given', async () => {
    const timer = manualTimer();
    void settleIdentity({ login: () => new Promise<never>(() => {}), timer });
    expect(timer.started[0].ms).toBe(DEFAULT_IDENTITY_BUDGET_MS);
  });

  it('falls back to a REAL timer when none is injected', async () => {
    // Everything above runs on a hand-fired timer, which leaves the production path — the
    // one the portal entry actually takes — unexercised. A 1 ms budget against a login that
    // never settles can only end one way, so this is deterministic without being a sleep.
    const settled = await settleIdentity({ login: () => new Promise<never>(() => {}), budgetMs: 1 });
    expect(settled).toEqual({ outcome: 'timedOut' });
  });

  it('stringifies a rejection that is neither an Error nor a string', async () => {
    const timer = manualTimer();
    const settled = await settleIdentity({ login: () => Promise.reject({ code: 503 }), budgetMs: 5, timer });
    expect(settled.outcome).toBe('failed');
    expect(settled.error).toBe('[object Object]');
  });

  it('the default budget sits below the SDK wait it is racing', () => {
    // The number's whole justification (see its doc comment): the SDK spends its 3 s only
    // when the script never arrives, and that case answers "guest" however long anyone
    // waits. If someone raises this above the SDK deadline, a blocked visitor pays the full
    // poll loop before seeing a menu.
    expect(DEFAULT_IDENTITY_BUDGET_MS).toBeLessThan(SDK_WAIT_MS);
  });
});
