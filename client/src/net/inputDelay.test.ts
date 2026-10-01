/** The send-to-stepped delay meter (`inputDelay.ts`) that `LocalPredictor` leads by. */
import { describe, it, expect } from 'vitest';
import { InputDelayMeter } from './inputDelay';

describe('InputDelayMeter', () => {
  it('is null until a sent command comes back applied', () => {
    const m = new InputDelayMeter();
    expect(m.delayMs).toBeNull();
    m.sent(1, 0);
    expect(m.delayMs).toBeNull();
    m.applied(1, 120);
    expect(m.delayMs).toBe(120);
  });

  it('counts a held command once — the frames after the first that apply it are not samples', () => {
    const m = new InputDelayMeter();
    m.sent(1, 0);
    m.applied(1, 120);
    m.applied(1, 500);
    expect(m.delayMs).toBe(120);
  });

  it('ignores a tag it never sent (another seat, or a command from before a resync)', () => {
    const m = new InputDelayMeter();
    m.applied(7, 50);
    expect(m.delayMs).toBeNull();
  });

  it('times a re-sent tag from its LAST send — the one the server holds', () => {
    const m = new InputDelayMeter();
    m.sent(4, 0);
    m.sent(4, 10);
    m.applied(4, 110);
    expect(m.delayMs).toBe(100);
  });

  it('reads the floor of the recent samples: batch phase and jitter only ever add', () => {
    const m = new InputDelayMeter();
    const delays = [180, 120, 210, 150];
    delays.forEach((d, i) => {
      m.sent(i, i * 1000);
      m.applied(i, i * 1000 + d);
    });
    expect(m.delayMs).toBe(120);
  });

  it('lets an old floor go after eight newer samples, so a slower network is followed', () => {
    const m = new InputDelayMeter();
    m.sent(0, 0);
    m.applied(0, 50);
    for (let i = 1; i <= 8; i++) {
      m.sent(i, i * 1000);
      m.applied(i, i * 1000 + 200);
    }
    expect(m.delayMs).toBe(200);
  });

  it('drops tags superseded in flight, and bounds what it remembers', () => {
    const m = new InputDelayMeter();
    m.sent(1, 0);
    m.sent(2, 10);
    m.applied(2, 100); // 1 was overtaken by 2 and will never be applied
    m.applied(1, 400);
    expect(m.delayMs).toBe(90);

    const flood = new InputDelayMeter();
    for (let i = 0; i < 100; i++) flood.sent(i, i);
    flood.applied(0, 500); // long forgotten
    expect(flood.delayMs).toBeNull();
    flood.applied(99, 199);
    expect(flood.delayMs).toBe(100);
  });
});
