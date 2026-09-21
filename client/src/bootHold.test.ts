/**
 * bootHold.ts — the floor under every boot splash this game has (DOM on web/portal, Pixi on
 * WeChat). Three things are worth pinning and all three failed silently before they existed:
 * the floor is counted from the PAGE opening rather than from this module's first line, a
 * boot slower than the floor waits zero extra, and a clock without `timeOrigin` falls back
 * rather than reporting a number that means nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MIN_BOOT_SPLASH_MS, bootElapsedMs, holdBootMinimum, remainingBootHoldMs } from './bootHold';

afterEach(() => vi.unstubAllGlobals());

describe('remainingBootHoldMs', () => {
  it('owes the rest of the floor on a fast boot', () => {
    expect(remainingBootHoldMs(500)).toBe(MIN_BOOT_SPLASH_MS - 500);
  });

  it('owes nothing once the boot has outlasted the floor', () => {
    // The half that makes this a FLOOR and not a delay. `Math.max(0, ...)` dropped would make
    // a 9-second boot sleep a negative duration — which `setTimeout` treats as 0, so the bug
    // would be invisible here and visible only as an unexplained extra wait somewhere else.
    expect(remainingBootHoldMs(MIN_BOOT_SPLASH_MS)).toBe(0);
    expect(remainingBootHoldMs(MIN_BOOT_SPLASH_MS + 6000)).toBe(0);
  });

  it('takes a different floor when a host has one', () => {
    expect(remainingBootHoldMs(0, 0)).toBe(0);
    expect(remainingBootHoldMs(100, 500)).toBe(400);
  });
});

describe('holdBootMinimum', () => {
  it('sleeps exactly what is still owed', async () => {
    const slept: number[] = [];
    await holdBootMinimum({
      elapsed: () => 1200,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(slept).toEqual([MIN_BOOT_SPLASH_MS - 1200]);
  });

  it('still resolves when nothing is owed', async () => {
    await expect(holdBootMinimum({ elapsed: () => 99_000, sleep: () => Promise.resolve() })).resolves.toBeUndefined();
  });

  it('really waits on the real clock', async () => {
    // The injected `sleep` above is what every other case uses, so nothing there would notice
    // `holdBootMinimum` forgetting to await at all. One case on the default path, with a tiny
    // floor so the suite does not pay for it.
    const before = Date.now();
    await holdBootMinimum({ elapsed: () => 0, minMs: 20 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);
  });
});

describe('bootElapsedMs', () => {
  it('measures from the page opening when the host has a navigation to measure from', () => {
    vi.stubGlobal('performance', { now: () => 1234, timeOrigin: 1_700_000_000_000 });
    expect(bootElapsedMs()).toBe(1234);
  });

  it('falls back when `now()` is not relative to anything — the WeChat runtime', () => {
    // `timeOrigin` missing is the tell. Without this branch the mini-game would read whatever
    // its `performance.now()` epoch happens to be, which on a device that has been awake for
    // an hour is millions of ms — the floor would silently never apply.
    vi.stubGlobal('performance', { now: () => 3_600_000 });
    const elapsed = bootElapsedMs();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(60_000);
  });

  it('survives a host with no `performance` at all', () => {
    vi.stubGlobal('performance', undefined);
    expect(bootElapsedMs()).toBeGreaterThanOrEqual(0);
  });
});
