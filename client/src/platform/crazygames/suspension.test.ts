/**
 * `adSuspension` — mute and freeze, and the idempotence `AdController` depends on.
 *
 * The release path is called more often than the acquire path BY DESIGN (it runs from a
 * `finally` that also covers "the ad never started"), so "resume without suspend does
 * nothing" is a contract and not a defensive nicety.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { adSuspension } from './suspension';
import { isExternallyMuted, resetExternalMute } from '../../audio/externalMute';

afterEach(() => resetExternalMute());

function clock() {
  const log: string[] = [];
  return { log, stop: () => void log.push('stop'), start: () => void log.push('start') };
}

describe('adSuspension', () => {
  it('mutes and stops the clock, then unmutes and restarts it', () => {
    const c = clock();
    const s = adSuspension(c);
    s.suspend();
    expect(isExternallyMuted()).toBe(true);
    expect(c.log).toEqual(['stop']);
    s.resume();
    expect(isExternallyMuted()).toBe(false);
    expect(c.log).toEqual(['stop', 'start']);
  });

  it('does nothing on a second suspend', () => {
    const c = clock();
    const s = adSuspension(c);
    s.suspend();
    s.suspend();
    expect(c.log).toEqual(['stop']);
  });

  it('does nothing on a resume that was never suspended', () => {
    // The `finally` case: an unfilled ad request resumes without ever having suspended, and
    // restarting a ticker the game deliberately stopped for some other reason would be a
    // bug that only shows up as a paused game resuming itself.
    const c = clock();
    adSuspension(c).resume();
    expect(c.log).toEqual([]);
    expect(isExternallyMuted()).toBe(false);
  });

  it('unmutes before restarting the clock', () => {
    // Order matters by exactly one frame: the audio bus is set synchronously from the mute
    // release, so releasing first means the first frame back is already at the player's own
    // volume instead of silent.
    const order: string[] = [];
    resetExternalMute();
    const s = adSuspension({
      stop: () => {},
      start: () => void order.push(`start:muted=${isExternallyMuted()}`),
    });
    s.suspend();
    s.resume();
    expect(order).toEqual(['start:muted=false']);
  });

  it('leaves two independent suspensions independent', () => {
    // There is only one in the shipped game, but the module-level mute is shared state and
    // a second instance must not release the first one's mute by accident.
    const a = adSuspension(clock());
    const b = adSuspension(clock());
    a.suspend();
    b.resume(); // never suspended — must not touch the mute a holds
    expect(isExternallyMuted()).toBe(true);
  });
});
