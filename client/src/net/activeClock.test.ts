/** The visible-time clock — `activeClock.ts`. */
import { describe, it, expect } from 'vitest';
import { createActiveClock } from './activeClock';

function clockAt(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

describe('createActiveClock', () => {
  it('counts only the visible stretches, including the one in progress', () => {
    const c = clockAt(1000);
    const clock = createActiveClock(c.now, true);
    c.set(4000);
    expect(clock.activeMs()).toBe(3000);
    clock.setVisible(false);
    c.set(60_000);
    expect(clock.activeMs()).toBe(3000);
    clock.setVisible(true);
    c.set(61_000);
    expect(clock.activeMs()).toBe(4000);
  });

  it('starts at zero when the page loads hidden', () => {
    const c = clockAt(0);
    const clock = createActiveClock(c.now, false);
    c.set(5000);
    expect(clock.activeMs()).toBe(0);
    clock.setVisible(true);
    c.set(7000);
    expect(clock.activeMs()).toBe(2000);
  });

  it('ignores a repeated state rather than restarting the stretch', () => {
    const c = clockAt(0);
    const clock = createActiveClock(c.now, true);
    c.set(1000);
    clock.setVisible(true);
    c.set(2000);
    expect(clock.activeMs()).toBe(2000);
    clock.setVisible(false);
    c.set(3000);
    clock.setVisible(false);
    expect(clock.activeMs()).toBe(2000);
  });

  it('never goes negative when the clock steps backwards', () => {
    const c = clockAt(10_000);
    const clock = createActiveClock(c.now, true);
    c.set(5000);
    expect(clock.activeMs()).toBe(0);
    clock.setVisible(false);
    expect(clock.activeMs()).toBe(0);
  });
});
