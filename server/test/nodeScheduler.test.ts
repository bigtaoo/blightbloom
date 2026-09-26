/**
 * `nodeScheduler` — the production clock `index.ts` hands every room. Driven with vitest's
 * fake timers so each method is checked against the Node timer it must wrap: the delay is
 * honoured, the clear really cancels, and an interval repeats while a timeout fires once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeScheduler } from '../src/nodeScheduler';
import { SETTLE_TIMEOUT_MS } from '../src/settlement';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nodeScheduler', () => {
  it('fires a timeout once, and not a millisecond early', () => {
    const fn = vi.fn();
    nodeScheduler.setTimeout(fn, SETTLE_TIMEOUT_MS);
    vi.advanceTimersByTime(SETTLE_TIMEOUT_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SETTLE_TIMEOUT_MS * 3);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancels a timeout that is cleared before it is due', () => {
    const fn = vi.fn();
    const h = nodeScheduler.setTimeout(fn, 100);
    nodeScheduler.clearTimeout(h);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('repeats an interval until it is cleared', () => {
    const fn = vi.fn();
    const h = nodeScheduler.setInterval(fn, 100);
    vi.advanceTimersByTime(350);
    expect(fn).toHaveBeenCalledTimes(3);
    nodeScheduler.clearInterval(h);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
