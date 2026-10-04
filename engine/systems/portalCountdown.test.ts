/**
 * The co-op portal countdown (design/05, ENGINE_VERSION 87). Any standing seat opens a
 * cleared floor's portal; every later press is a confirm; the portal goes the tick every
 * living seat has confirmed, or when `PORTAL_COUNTDOWN_TICKS` runs out.
 *
 * It replaced "player 0's press, and nobody else's", which stranded a co-op run whose seat
 * 0 bled out with a teammate still up (volume 124). Solo behaviour is pinned elsewhere
 * (`floorCardCheckpoint.test.ts`, `extraction.test.ts`): a solo press resolves on the press.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { PORTAL_COUNTDOWN_TICKS } from '@dd/engine/config';

/** Floor 0's checkpoint opens on tick 1 (no waves). `floors: [[]]` gives it a floor 1 to
 *  descend to; `floors: []` makes floor 0 the last, where the portal extracts. */
const CFG: EngineConfig = { seed: 9, worldW: 800, worldH: 600, waves: [], floors: [[]] };

function cmd(owner: number, tick: number, o: { buttons?: number; cardVote?: number } = {}) {
  return makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: o.buttons ?? 0, cardVote: o.cardVote ?? 0 });
}

/** A two-seat engine parked at floor 0's checkpoint, both seats having voted card 1. */
function atCheckpoint(floors: EngineConfig['floors'] = [[]]) {
  const eng = createGameEngine({ ...CFG, floors, players: [{ start: [100, 100] }, { start: [140, 100] }] });
  eng.step([cmd(0, 1, { cardVote: 1 }), cmd(1, 1, { cardVote: 1 })]);
  return eng;
}

type Eng = ReturnType<typeof atCheckpoint>;
/** One tick: the listed seats press `button`, the rest idle. */
function press(eng: Eng, seats: number[], button = Button.CONFIRM_DESCEND): void {
  const t = eng.state.tick + 1;
  eng.step([0, 1].map((i) => cmd(i, t, seats.includes(i) ? { buttons: button } : {})));
}
function idle(eng: Eng, ticks: number): void {
  for (let i = 0; i < ticks; i++) press(eng, []);
}

describe('any standing seat opens the portal', () => {
  it('seat 1’s press opens it and starts the countdown; nobody has left yet', () => {
    const eng = atCheckpoint();
    press(eng, [1]);
    expect(eng.state.floorIndex).toBe(0);
    expect(eng.state.portalCountdownTicks).toBe(PORTAL_COUNTDOWN_TICKS - 1);
    expect(eng.state.players.map((p) => p.portalReady)).toEqual([false, true]);
  });

  it('goes the tick the last living seat confirms, without waiting out the countdown', () => {
    const eng = atCheckpoint();
    press(eng, [1]);
    idle(eng, 10);
    expect(eng.state.floorIndex).toBe(0);
    press(eng, [0]);
    expect(eng.state.floorIndex).toBe(1);
  });

  it('goes on its own when the countdown runs out, taking the seat that never confirmed', () => {
    const eng = atCheckpoint();
    press(eng, [1]); // the opening tick counts as the first of the countdown
    idle(eng, PORTAL_COUNTDOWN_TICKS - 2);
    expect(eng.state.floorIndex).toBe(0);
    expect(eng.state.portalCountdownTicks).toBe(1);
    idle(eng, 1);
    expect(eng.state.floorIndex).toBe(1);
  });

  it('both seats pressing on the same tick go at once', () => {
    const eng = atCheckpoint();
    press(eng, [0, 1]);
    expect(eng.state.floorIndex).toBe(1);
  });

  it('closes the countdown and every seat’s confirm once it resolves', () => {
    const eng = atCheckpoint([[], []]);
    press(eng, [0, 1]);
    expect(eng.state.portalCountdownTicks).toBe(0);
    expect(eng.state.players.map((p) => p.portalReady)).toEqual([false, false]);
  });

  it('a second press by a seat already confirmed does not restart the countdown', () => {
    const eng = atCheckpoint();
    press(eng, [1]);
    idle(eng, 100);
    press(eng, [1]);
    expect(eng.state.portalCountdownTicks).toBe(PORTAL_COUNTDOWN_TICKS - 102);
  });
});

describe('who may press, and who is waited for', () => {
  it('a press with no card voted does not open the portal', () => {
    const eng = createGameEngine({ ...CFG, players: [{ start: [100, 100] }, { start: [140, 100] }] });
    eng.step([cmd(0, 1), cmd(1, 1)]);
    press(eng, [1]);
    expect(eng.state.portalCountdownTicks).toBe(0);
    expect(eng.state.players[1]!.portalReady).toBe(false);
  });

  it('an EXTRACT press on an interior floor does not open it', () => {
    const eng = atCheckpoint();
    press(eng, [1], Button.CONFIRM_EXTRACT);
    expect(eng.state.portalCountdownTicks).toBe(0);
  });

  it('seat 1 descends alone once seat 0 is dead: a dead seat is not waited for', () => {
    // Volume 124's stranded run: seat 0 bled out, seat 1 is still up.
    const eng = atCheckpoint();
    eng.state.players[0]!.alive = false;
    press(eng, [1]);
    expect(eng.state.floorIndex).toBe(1);
  });

  it('a downed seat cannot open or confirm, and is waited for until the countdown ends', () => {
    const eng = atCheckpoint();
    const downed = eng.state.players[0]!;
    downed.downed = true;
    downed.bleedoutTicks = PORTAL_COUNTDOWN_TICKS * 2; // outlives the countdown
    press(eng, [0]);
    expect(eng.state.portalCountdownTicks).toBe(0);
    press(eng, [1]);
    press(eng, [0]);
    expect(downed.portalReady).toBe(false);
    idle(eng, PORTAL_COUNTDOWN_TICKS - 3);
    expect(eng.state.floorIndex).toBe(0);
    idle(eng, 1);
    expect(eng.state.floorIndex).toBe(1);
  });
});

describe('the last floor extracts the same way', () => {
  it('seat 1 opens it, and the countdown ends the run in a win', () => {
    const eng = atCheckpoint([]);
    press(eng, [1], Button.CONFIRM_EXTRACT);
    expect(eng.state.phase).not.toBe('gameover');
    idle(eng, PORTAL_COUNTDOWN_TICKS - 1);
    expect(eng.state.phase).toBe('gameover');
    expect(eng.state.events.some((e) => e.type === 'win')).toBe(true);
  });

  it('a DESCEND press on the last floor does not open it', () => {
    const eng = atCheckpoint([]);
    press(eng, [1]);
    expect(eng.state.portalCountdownTicks).toBe(0);
  });
});
