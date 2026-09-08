/**
 * `settle.ts` — the two wrappers every call into the portal's SDK goes through, plus the
 * reporting variant added 2026-09-08.
 *
 * The pair exists so that a missing method, a rejected promise and a throwing callback all
 * arrive as "nothing happened" rather than as an exception mid-frame. What is asserted here
 * is mostly the DISTINCTION `settleReporting` draws and `settle` deliberately does not:
 * a call that failed versus a call that legitimately returned nothing. Those are the same
 * value and different bugs, and conflating them is what made a broken account integration
 * look like a page full of guests.
 */
import { describe, it, expect, vi } from 'vitest';
import { guard, settle, settleReporting } from './settle';

describe('settle', () => {
  it('returns what fn returned, awaiting a promise', async () => {
    expect(await settle(() => 42)).toBe(42);
    expect(await settle(async () => 'later')).toBe('later');
  });

  it('returns undefined for a throw and for a rejection', async () => {
    expect(await settle(() => {
      throw new Error('sync');
    })).toBeUndefined();
    expect(await settle(async () => {
      throw new Error('async');
    })).toBeUndefined();
  });

  it('erases the difference between a failure and a legitimate nothing', async () => {
    // This is the documented contract, asserted so that "improving" it is a deliberate act:
    // no caller of `settle` may branch on why nothing came back.
    const failed = await settle(() => {
      throw new Error('boom');
    });
    const nothing = await settle(() => undefined);
    expect(failed).toBe(nothing);
  });
});

describe('settleReporting', () => {
  it('reports success, including a legitimate undefined', async () => {
    expect(await settleReporting(() => 7)).toEqual({ value: 7, failed: false, reason: null });
    // The case that must NOT be called a failure — a method that answers "nothing" answered.
    expect(await settleReporting(() => undefined)).toEqual({ value: undefined, failed: false, reason: null });
    expect(await settleReporting(() => null)).toEqual({ value: null, failed: false, reason: null });
  });

  it('reports a rejection with its message', async () => {
    expect(await settleReporting(async () => {
      throw new Error('gated in BETA');
    })).toEqual({ value: undefined, failed: true, reason: 'gated in BETA' });
  });

  it('reports a synchronous throw too', async () => {
    expect(await settleReporting(() => {
      throw new Error('no such method');
    })).toEqual({ value: undefined, failed: true, reason: 'no such method' });
  });

  it('describes a thrown non-Error', async () => {
    // An SDK is free to throw a string, and a reason of "undefined" in a diagnostics line
    // would be worse than useless.
    expect((await settleReporting(() => {
      throw 'userNotAuthenticated';
    })).reason).toBe('userNotAuthenticated');
    expect((await settleReporting(() => {
      throw { code: 17 };
    })).reason).toBe('[object Object]');
  });

  it('never reports an EMPTY reason, whatever was thrown', async () => {
    // Two ways to get there: an Error carrying no message, and a thrown empty string. Both
    // have to leave something a human can read, because the alternative is a diagnostics
    // line that says a call failed and then says nothing.
    for (const thrown of [new Error(''), '']) {
      const reason = (await settleReporting(() => {
        throw thrown;
      })).reason;
      expect(reason, String(thrown)).not.toBeNull();
      expect(reason!.length, String(thrown)).toBeGreaterThan(0);
    }
  });

  it('is what settle is built on, so the two can never disagree', async () => {
    // `settle` delegates rather than reimplementing the try/catch — asserted because two
    // copies of this logic drifting apart is exactly the bug neither one would show.
    for (const fn of [() => 1, () => undefined, () => { throw new Error('x'); }]) {
      expect(await settle(fn)).toBe((await settleReporting(fn)).value);
    }
  });
});

describe('guard', () => {
  it('runs the hook', () => {
    const fn = vi.fn();
    guard(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('tolerates no hook at all', () => {
    expect(() => guard(undefined)).not.toThrow();
  });

  it('swallows a throwing hook, so the SDK dispatch keeps going', () => {
    // The failure this prevents is an ad that ends with the game still muted, because one
    // hook threw and the rest never ran.
    expect(() => guard(() => {
      throw new Error('hook');
    })).not.toThrow();
  });
});
