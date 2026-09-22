/**
 * Matchmaking (design/10 screen-flow gap — connectOnlineSession previously ran with no
 * visible feedback and a post-ticket failure hung forever). Driven with a fake `connect`
 * function via a controllable deferred promise, same "no real network" DI convention as
 * PartyScreen.test.ts. Plain vitest, no renderer attached.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Matchmaking, type MatchmakingSignal } from './Matchmaking';
import { resetLocaleForTests } from '../../i18n';
import type { CoopSession } from '../../net/CoopSession';
import { MatchRequestError } from '../../net/matchmaking';
import { useLocale } from '../../i18n/loadLocale';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FAKE_SESSION = {} as CoopSession;

function privateOf(m: Matchmaking) {
  return m as unknown as {
    title: { text: string };
    statusText: { text: string };
    cancelBtn: { view: { visible: boolean }; onTap: (() => void) | null };
    retryBtn: { view: { visible: boolean }; onTap: (() => void) | null };
    backBtn: { view: { visible: boolean }; onTap: (() => void) | null };
    signal: MatchmakingSignal | null;
  };
}

afterEach(() => resetLocaleForTests());

describe('Matchmaking — connecting state', () => {
  it('calls connect immediately on show() and shows Cancel only', () => {
    const connect = vi.fn().mockReturnValue(deferred<CoopSession>().promise);
    const m = new Matchmaking();
    m.show(800, 600, connect);
    expect(connect).toHaveBeenCalledTimes(1);
    const p = privateOf(m);
    expect(p.cancelBtn.view.visible).toBe(true);
    expect(p.retryBtn.view.visible).toBe(false);
    expect(p.backBtn.view.visible).toBe(false);
  });

  it('resolves to onConnected', async () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    const calls: CoopSession[] = [];
    m.onConnected = (s) => calls.push(s);
    m.show(800, 600, connect);
    d.resolve(FAKE_SESSION);
    await d.promise;
    await Promise.resolve(); // let the .then() microtask run
    expect(calls).toEqual([FAKE_SESSION]);
  });
});

describe('Matchmaking — error state', () => {
  it('a rejection switches to Retry/Back and hides Cancel', async () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    m.show(800, 600, connect);
    d.reject(new Error('matchmaking: timed out waiting for a match'));
    await d.promise.catch(() => {});
    await Promise.resolve();
    const p = privateOf(m);
    expect(p.cancelBtn.view.visible).toBe(false);
    expect(p.retryBtn.view.visible).toBe(true);
    expect(p.backBtn.view.visible).toBe(true);
    expect(p.statusText.text).toBe('Timed out waiting for a match.');
  });

  it('a THROTTLED search says wait, not try again', async () => {
    // `POST /find` spends a per-IP budget since 2026-09-22 (`FIND_RATE_LIMIT`). This screen's
    // error state ends in a RETRY button, and the generic message points straight at it —
    // which is the one action that spends more of a budget the player has already run out of.
    const d = deferred<CoopSession>();
    const m = new Matchmaking();
    m.show(800, 600, vi.fn().mockReturnValue(d.promise));
    d.reject(new MatchRequestError('too many matchmaking requests from this address', 429));
    await d.promise.catch(() => {});
    await Promise.resolve();
    const p = privateOf(m);
    expect(p.statusText.text).toMatch(/wait a few minutes/i);
    expect(p.statusText.text).not.toMatch(/could not connect/i);
    // The server's own prose never reaches the screen — it is English, and this screen is
    // rendered in eight languages.
    expect(p.statusText.text).not.toMatch(/from this address/);
  });

  it('every other refusal keeps the message it had — the control', async () => {
    // Without this, a `classifyError` that answered "throttled" for every `MatchRequestError`
    // — or for every failure — would pass the case above while telling a player whose
    // gameserver is down to go and wait for a budget they never spent.
    for (const [status, expected] of [
      [503, 'Could not connect — try again.'],
      [400, 'Could not connect — try again.'],
    ] as const) {
      const d = deferred<CoopSession>();
      const m = new Matchmaking();
      m.show(800, 600, vi.fn().mockReturnValue(d.promise));
      d.reject(new MatchRequestError('no gameserver available', status));
      await d.promise.catch(() => {});
      await Promise.resolve();
      expect(privateOf(m).statusText.text).toBe(expected);
    }
  });

  it('Retry re-invokes connect and can succeed on the second attempt', async () => {
    const d1 = deferred<CoopSession>();
    const d2 = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const m = new Matchmaking();
    const calls: CoopSession[] = [];
    m.onConnected = (s) => calls.push(s);
    m.show(800, 600, connect);
    d1.reject(new Error('matchmaking cancelled'));
    await d1.promise.catch(() => {});
    await Promise.resolve();

    privateOf(m).retryBtn.onTap?.();
    expect(connect).toHaveBeenCalledTimes(2);
    d2.resolve(FAKE_SESSION);
    await d2.promise;
    await Promise.resolve();
    expect(calls).toEqual([FAKE_SESSION]);
  });
});

describe('Matchmaking — cancel', () => {
  it('Cancel flips the signal and fires onCancelled', () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    const calls: string[] = [];
    m.onCancelled = () => calls.push('cancelled');
    m.show(800, 600, connect);
    const signal = privateOf(m).signal;
    privateOf(m).cancelBtn.onTap?.();
    expect(signal?.cancelled).toBe(true);
    expect(calls).toEqual(['cancelled']);
  });

  it('a stale resolve after cancel does not fire onConnected', async () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    const calls: CoopSession[] = [];
    m.onConnected = (s) => calls.push(s);
    m.show(800, 600, connect);
    privateOf(m).cancelBtn.onTap?.();
    d.resolve(FAKE_SESSION); // the connect() call this cancelled resolves anyway
    await d.promise;
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it('Back on the error screen also cancels', async () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    const calls: string[] = [];
    m.onCancelled = () => calls.push('cancelled');
    m.show(800, 600, connect);
    d.reject(new Error('boom'));
    await d.promise.catch(() => {});
    await Promise.resolve();
    privateOf(m).backBtn.onTap?.();
    expect(calls).toEqual(['cancelled']);
  });

  it('hide() also invalidates any in-flight attempt', async () => {
    const d = deferred<CoopSession>();
    const connect = vi.fn().mockReturnValue(d.promise);
    const m = new Matchmaking();
    const calls: CoopSession[] = [];
    m.onConnected = (s) => calls.push(s);
    m.show(800, 600, connect);
    m.hide();
    d.resolve(FAKE_SESSION);
    await d.promise;
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});

describe('Matchmaking — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const connect = vi.fn().mockReturnValue(deferred<CoopSession>().promise);
    const m = new Matchmaking();
    m.show(800, 600, connect);
    expect(privateOf(m).title.text).toBe('Finding a match…');
  });

  it('retexts on a fresh show() after a locale change', async () => {
    const connect = vi.fn().mockReturnValue(deferred<CoopSession>().promise);
    const m = new Matchmaking();
    await useLocale('zh');
    m.show(800, 600, connect);
    expect(privateOf(m).title.text).toBe('正在匹配对局…');
  });
});
