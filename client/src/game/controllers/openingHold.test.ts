/**
 * `OpeningHold` — "the run has not started yet".
 *
 * A pure module (`pureLayerBoundary.test.ts` lists it), so this runs with no browser,
 * no renderer and no engine: what is asserted is the DECISION, which is the part that
 * could drift. Three of these tests exist because the hold has three ways to be wrong
 * and each one is invisible from a passing suite that only checks the happy path:
 * holding before the world has drawn itself (a frozen screen with no instruction on
 * it), swallowing the press that released it (the player's first action vanishes), and
 * never releasing at all (a seat nobody is sitting in, frozen for good).
 */
import { describe, it, expect } from 'vitest';
import type { InputState } from '../../platform/types';
import { OpeningHold, hasIntent, OPENING_HOLD_MAX_MS } from './openingHold';

const IDLE: InputState = { moveX: 0, moveY: 0, firing: false, interacting: false };
const FRAME = 16.7; // one 60 Hz render frame, the clock this is driven on

/** An armed hold that has already seen its first tick — the state every test but the
 *  first-tick ones actually cares about. */
function running(): OpeningHold {
  const hold = new OpeningHold();
  hold.arm();
  hold.sawFirstTick();
  return hold;
}

describe('hasIntent', () => {
  it('is false for a neutral read', () => {
    expect(hasIntent(IDLE)).toBe(false);
  });

  it('counts a press of either button, with no movement at all', () => {
    expect(hasIntent({ ...IDLE, firing: true })).toBe(true);
    expect(hasIntent({ ...IDLE, interacting: true })).toBe(true);
  });

  it('counts a push on either axis, and either sign', () => {
    expect(hasIntent({ ...IDLE, moveX: 1 })).toBe(true);
    expect(hasIntent({ ...IDLE, moveX: -1 })).toBe(true);
    expect(hasIntent({ ...IDLE, moveY: 1 })).toBe(true);
    expect(hasIntent({ ...IDLE, moveY: -1 })).toBe(true);
  });

  it('ignores a reading inside the dead zone — a resting thumb is not an answer', () => {
    expect(hasIntent({ ...IDLE, moveX: 0.1, moveY: 0.1 })).toBe(false);
  });

  it('measures the vector, not the larger axis: two small pushes together clear it', () => {
    // 0.15 on each axis is 0.21 long — inside the dead zone per axis, outside as a push.
    expect(hasIntent({ ...IDLE, moveX: 0.15, moveY: 0.15 })).toBe(true);
  });
});

describe('OpeningHold', () => {
  it('holds nothing until it is armed', () => {
    const hold = new OpeningHold();
    hold.sawFirstTick();
    expect(hold.update(FRAME, IDLE)).toBe(false);
    expect(hold.held).toBe(false);
  });

  it('does not hold before the first sim tick, however long it is left', () => {
    // The teaching panel and the HUD are both written from inside a tick. Freezing at
    // tick zero would hold the world still behind a screen that never said what to do.
    const hold = new OpeningHold();
    hold.arm();
    for (let ms = 0; ms < 5000; ms += FRAME) expect(hold.update(FRAME, IDLE)).toBe(false);
    // ...and it is still armed, so the hold bites the moment the first tick lands.
    hold.sawFirstTick();
    expect(hold.update(FRAME, IDLE)).toBe(true);
  });

  it('holds an idle frame once the world has stepped', () => {
    const hold = running();
    expect(hold.update(FRAME, IDLE)).toBe(true);
    expect(hold.held).toBe(true);
  });

  it('releases on the first input, and lets that same frame step', () => {
    // Returning false here is the point: the press that woke the world is the press the
    // next tick reads. Swallowing the frame would drop the player's first action.
    const hold = running();
    expect(hold.update(FRAME, IDLE)).toBe(true);
    expect(hold.update(FRAME, { ...IDLE, moveX: 1 })).toBe(false);
    expect(hold.held).toBe(false);
  });

  it('stays released once released, even if the player lets go again', () => {
    const hold = running();
    hold.update(FRAME, { ...IDLE, firing: true });
    expect(hold.update(FRAME, IDLE)).toBe(false);
    expect(hold.held).toBe(false);
  });

  it('gives up after the fuse, so an untouched seat is not frozen for good', () => {
    const hold = running();
    let frames = 0;
    while (hold.update(FRAME, IDLE)) {
      frames++;
      expect(frames).toBeLessThan(10_000); // the point of the test is that this ends
    }
    expect(frames * FRAME).toBeGreaterThanOrEqual(OPENING_HOLD_MAX_MS - FRAME);
    expect(hold.held).toBe(false);
  });

  it('counts real time, not frames — a slow device waits the same number of seconds', () => {
    const hold = running();
    expect(hold.update(OPENING_HOLD_MAX_MS / 2, IDLE)).toBe(true);
    expect(hold.waitedMsSoFar).toBe(OPENING_HOLD_MAX_MS / 2);
    expect(hold.update(OPENING_HOLD_MAX_MS / 2, IDLE)).toBe(false);
  });

  it('a latched HUD tap releases it just as a first step does', () => {
    // The fourth way to be wrong, and the one that shipped red (2026-11-11): the weapon
    // chip, the portal buttons and the shop rows latch a command instead of moving the
    // stick, so `InputState` is still neutral on the frame the player taps one. Without
    // this arm the tap would be held by the freeze it was trying to end, for the full
    // 20 s fuse.
    const hold = running();
    expect(hold.update(FRAME, IDLE)).toBe(true);
    expect(hold.update(FRAME, IDLE, true)).toBe(false);
    expect(hold.held).toBe(false);
  });

  it('keeps holding while no UI action is latched either', () => {
    // The control for the test above: `false` must not be a second way to release.
    const hold = running();
    expect(hold.update(FRAME, IDLE, false)).toBe(true);
    expect(hold.held).toBe(true);
  });

  it('re-arms for the next run, fuse and first-tick gate included', () => {
    const hold = running();
    hold.update(OPENING_HOLD_MAX_MS, IDLE); // burn the first run's fuse
    expect(hold.held).toBe(false);

    hold.arm();
    expect(hold.waitedMsSoFar).toBe(0);
    expect(hold.update(FRAME, IDLE)).toBe(false); // the new run has not stepped yet
    hold.sawFirstTick();
    expect(hold.update(FRAME, IDLE)).toBe(true);
  });
});

/**
 * The report (2026-11-14). The hold's own behaviour is unchanged by it, which is half of what
 * is asserted here: a hold constructed with no callback must still hold, release and fuse
 * exactly as every test above says it does.
 *
 * The other half is the thing the 2026-11 sandbox test could not answer. 34.9% of started runs
 * were never touched, and that was an ABSENCE — a `run_start` with no `first_input` — so it
 * could not be split by cause. `fuse` is that same population reported as a presence, at the
 * moment it happens, and `input` is its control: without both arms the event would say how
 * many runs ended untouched and not what share of runs that is.
 */
describe('OpeningHold reporting', () => {
  /** A hold that records what it reported, armed and stepped like `running()`. */
  function reporting(): { hold: OpeningHold; ends: [string, number][] } {
    const ends: [string, number][] = [];
    const hold = new OpeningHold((outcome, ms) => void ends.push([outcome, ms]));
    hold.arm();
    hold.sawFirstTick();
    return { hold, ends };
  }

  it('reports `input` with the time the player took to arrive', () => {
    const { hold, ends } = reporting();
    hold.update(1000, IDLE);
    hold.update(500, IDLE);
    hold.update(FRAME, { ...IDLE, firing: true });
    // 1500, not 1500 + FRAME: the releasing frame is the player's, not part of the wait.
    expect(ends).toEqual([['input', 1500]]);
  });

  it('reports `fuse` for a run nobody ever touched', () => {
    const { hold, ends } = reporting();
    while (hold.update(FRAME, IDLE)) { /* wait it out */ }
    expect(ends).toHaveLength(1);
    expect(ends[0]![0]).toBe('fuse');
    expect(ends[0]![1]).toBeGreaterThanOrEqual(OPENING_HOLD_MAX_MS);
  });

  it('reports a latched UI tap as `input` — a tap is a player arriving', () => {
    const { hold, ends } = reporting();
    hold.update(FRAME, IDLE, true);
    expect(ends).toEqual([['input', 0]]);
  });

  it('reports exactly once per run, however many frames follow', () => {
    // Both ways to end it, each followed by frames that must add nothing: a double count
    // would inflate the untouched share without changing any other number in the funnel.
    const { hold, ends } = reporting();
    hold.update(FRAME, { ...IDLE, moveX: 1 });
    for (let i = 0; i < 10; i++) hold.update(FRAME, IDLE);
    expect(ends).toHaveLength(1);

    hold.arm();
    hold.sawFirstTick();
    while (hold.update(FRAME, IDLE)) { /* fuse */ }
    for (let i = 0; i < 10; i++) hold.update(FRAME, IDLE);
    expect(ends).toHaveLength(2);
  });

  it('reports nothing for a hold that never bit', () => {
    // A replay, the arena demo and an unarmed hold all run through `update` and must stay
    // silent — otherwise every watched recording would land in the funnel as a played run.
    const ends: unknown[] = [];
    const hold = new OpeningHold(() => void ends.push(1));
    hold.sawFirstTick();
    for (let i = 0; i < 100; i++) hold.update(FRAME, IDLE);
    expect(ends).toEqual([]);

    // Armed but never stepped: the world never froze, so nothing waited.
    hold.arm();
    for (let i = 0; i < 100; i++) hold.update(FRAME, IDLE);
    expect(ends).toEqual([]);
  });

  it('holds exactly as it does without a callback', () => {
    const plain = running();
    const { hold } = reporting();
    const frames: [boolean, boolean][] = [];
    for (let i = 0; i < 5; i++) frames.push([plain.update(FRAME, IDLE), hold.update(FRAME, IDLE)]);
    frames.push([plain.update(FRAME, { ...IDLE, moveY: 1 }), hold.update(FRAME, { ...IDLE, moveY: 1 })]);
    expect(frames.every(([a, b]) => a === b)).toBe(true);
    expect(plain.held).toBe(hold.held);
  });
});
