/**
 * `platform/sessionEvents.ts` — the "somebody logged in without using our login screen"
 * registry. Module state, so every case resets it first (`resetSessionEvents`, the
 * convention `resetHostKind`/`resetAssetHost` already set here).
 *
 * The stickiness cases are the reason this file exists. A boot-time portal login can resolve
 * either side of screen assembly, and the losing order is silent: the player is logged in on
 * the server and the main menu still says LOGIN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifySessionChanged, onSessionChanged, resetSessionEvents } from './sessionEvents';

beforeEach(() => resetSessionEvents());

describe('onSessionChanged', () => {
  it('calls a subscriber on every notification', () => {
    const seen = vi.fn();
    onSessionChanged(seen);
    notifySessionChanged();
    notifySessionChanged();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('calls every subscriber, not just the first', () => {
    const a = vi.fn();
    const b = vi.fn();
    onSessionChanged(a);
    onSessionChanged(b);
    notifySessionChanged();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops calling an unsubscribed listener', () => {
    const seen = vi.fn();
    const off = onSessionChanged(seen);
    off();
    notifySessionChanged();
    expect(seen).not.toHaveBeenCalled();
  });

  it('survives a listener that throws, and still reaches the next one', () => {
    // Nothing here can retry, and one screen failing to refresh must not stop another.
    const boom = vi.fn(() => {
      throw new Error('a screen blew up');
    });
    const after = vi.fn();
    onSessionChanged(boom);
    onSessionChanged(after);
    expect(() => notifySessionChanged()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('lets a listener unsubscribe DURING dispatch without skipping the next one', () => {
    // The `[...listeners]` copy. Iterating the live Set while a listener removes itself is
    // the classic way the listener after it silently never runs.
    const order: string[] = [];
    const off = onSessionChanged(() => {
      order.push('first');
      off();
    });
    onSessionChanged(() => order.push('second'));
    notifySessionChanged();
    expect(order).toEqual(['first', 'second']);
  });
});

describe('a change that happened before anyone subscribed', () => {
  it('is delivered on the next subscribe', () => {
    notifySessionChanged();
    const seen = vi.fn();
    onSessionChanged(seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is delivered ONCE, however many times it was announced', () => {
    notifySessionChanged();
    notifySessionChanged();
    notifySessionChanged();
    const seen = vi.fn();
    onSessionChanged(seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is delivered to the FIRST subscriber only — it is a catch-up, not a replay', () => {
    notifySessionChanged();
    const first = vi.fn();
    const second = vi.fn();
    onSessionChanged(first);
    onSessionChanged(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('is not delivered to a subscriber that arrives after a live dispatch', () => {
    // Proof the pending flag is cleared by the dispatch that consumed it, rather than
    // living on to fire spuriously later.
    const first = vi.fn();
    onSessionChanged(first);
    notifySessionChanged();
    const late = vi.fn();
    onSessionChanged(late);
    expect(late).not.toHaveBeenCalled();
  });
});

describe('resetSessionEvents', () => {
  it('drops listeners AND a remembered change', () => {
    const seen = vi.fn();
    onSessionChanged(seen);
    notifySessionChanged();
    expect(seen).toHaveBeenCalledTimes(1);

    resetSessionEvents();
    notifySessionChanged(); // remembered by nobody now
    resetSessionEvents(); // ...and the memory is dropped too
    const fresh = vi.fn();
    onSessionChanged(fresh);
    expect(fresh).not.toHaveBeenCalled();
    notifySessionChanged();
    expect(seen).toHaveBeenCalledTimes(1); // the old listener is gone for good
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
