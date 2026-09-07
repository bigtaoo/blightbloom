/**
 * `localSeatWon` (design/11 + design/15) — the one question the result SCREEN and the `win`
 * audio CUE both have to answer, split out of `RunOutcome` 2026-09-02 so they cannot answer
 * differently.
 *
 * Two describes, and the second is the point of the file. The first pins the function's own
 * edges — the ones neither caller reaches, and the ones a plausible simplification breaks.
 * The second drives the same `(state, winner)` through BOTH real callers and asserts they
 * agree, which is the property that made the split worth doing: re-inlining a divergent
 * condition into either one compiles, and every other test in the repo stays green.
 *
 * Fixtures come from the engine's real `createGameState` (same convention as
 * `RunOutcome.test.ts`), because the whole question turns on two fields a cast object literal
 * would let you spell wrong: `zoneEnabled` (which win model applies) and per-seat `teamId`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import type { Winner } from '@dd/engine';
import { resetLocaleForTests } from '../../i18n';
import { localSeatWon } from './localOutcome';
import { RunOutcome, type RunOutcomeHost } from './RunOutcome';
import { EventReactor, type EventReactorHost } from './EventReactor';
import { HudView } from '../ui/HudView';
import { Layers } from '../scene/layers';
import type { FxController } from '../fx/FxController';
import type { AudioBus, AudioCue } from '../../platform/types';

const MINI_ARENA: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

/** A PvE run: no `arena`, so `zoneEnabled` is false and the extract/wipe model applies. */
const pveState = (): GameState =>
  createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [] });

/** An arena match with one seat per entry, `teams[i]` being seat i's squad. */
const arenaState = (teams: readonly number[]): GameState =>
  createGameState({
    seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_ARENA,
    players: teams.map((teamId) => ({ teamId })),
  });

afterEach(() => resetLocaleForTests());

describe('localSeatWon — the edges neither caller reaches on its own', () => {
  it('PvE is a SHARED outcome: only `enemies` is a loss, and the seat is never consulted', () => {
    // Both PvE producers hardcode `winner: 0` with the comment *"single-player: player id 0"*.
    // Reading that as "seat 0 won, so ask whether I am seat 0" is the mistake this pins: in a
    // co-op run the whole party extracted, and seats 1..n would all be told they lost.
    const s = pveState();
    expect(localSeatWon(s, 0, 0)).toBe(true);
    expect(localSeatWon(s, 3, 0)).toBe(true);   // a seat that is not the one named
    expect(localSeatWon(s, 0, 'enemies')).toBe(false);
    expect(localSeatWon(s, 3, 'enemies')).toBe(false);
  });

  it('PvE treats a null winner as not-a-loss, the same as the code it replaced', () => {
    // `RunOutcome.handle` ran `s.winner === 'enemies' ? lose() : win()`, so null took the win
    // branch. Only reachable before gameover, where nobody calls either of these — but this is
    // a behaviour-preserving extraction, and "tidied" to `winner === 0` it would stop being one.
    expect(localSeatWon(pveState(), 0, null)).toBe(true);
  });

  it('an arena match with no winner named yet is nobody\'s win', () => {
    // The inverse of the PvE rule above, and the reason the two models cannot share a branch:
    // here the absence of a seat number means the match has not been decided, so `'enemies'`
    // and null both have to be false rather than falling through to a win.
    const s = arenaState([0, 1]);
    expect(localSeatWon(s, 0, null)).toBe(false);
    expect(localSeatWon(s, 0, 'enemies')).toBe(false);
  });

  it('compares squad MEMBERSHIP, so a squad-mate\'s name is your win and a rival\'s is not', () => {
    // `WinConditionSystem.tickPlacement` names the winning squad's LOWEST seat, so seat 3 never
    // appears as the winner while seat 2 shares its team. Comparing seat identity was a real bug
    // (2026-08-04): most of a winning squad saw DEFEAT.
    const s = arenaState([0, 1, 1, 0]);
    expect(localSeatWon(s, 3, 0)).toBe(true);    // our squad-mate seat 0 was named
    expect(localSeatWon(s, 3, 3)).toBe(true);    // ...or we were named ourselves
    expect(localSeatWon(s, 3, 1)).toBe(false);   // the rival squad
    expect(localSeatWon(s, 1, 0)).toBe(false);   // and symmetrically, from their side
  });

  it('team 0 is a real team, not an absent one', () => {
    // This repo's own recurring bug class — the `hurt` gate's "no local actor, never actor 0"
    // written for a teamId. `localTeam && localTeam === winnerTeam` passes every other case in
    // this file and fails this one: an all-team-0 squad is exactly what a solo/FFA seat 0 is.
    const s = arenaState([0, 0]);
    expect(localSeatWon(s, 0, 1)).toBe(true);
    expect(localSeatWon(s, 1, 0)).toBe(true);
  });

  it('two MISSING seats are not a match — an out-of-range winner never wins', () => {
    // The trap the `!== undefined` guard exists for: with both lookups undefined, a bare
    // `localTeam === winnerTeam` is `undefined === undefined`, i.e. TRUE, and every seat in a
    // stale or empty state would be told it won. Dropping that guard breaks nothing else here.
    const s = arenaState([0, 1]);
    expect(localSeatWon(s, 99, 99)).toBe(false); // neither seat exists
    expect(localSeatWon(s, 0, 99)).toBe(false);  // we exist, the named winner does not
    expect(localSeatWon(s, 99, 0)).toBe(false);  // the winner exists, we do not
    expect(localSeatWon(arenaState([]), 0, 0)).toBe(false); // no seats at all
  });
});

// ---------------------------------------------------------------------------------------
// The two real callers, on one state, asked the same question.
// ---------------------------------------------------------------------------------------

/** Records only what this file asks of the result screen: did it say we won? */
function outcomeHost(localOwner: number): RunOutcomeHost & { won(): boolean | undefined } {
  let won: boolean | undefined;
  return {
    localOwner,
    addScore: () => {},
    currentScore: () => 0,
    setPhase: () => {},
    hideHud: () => {},
    bankRunMaterials: () => {},
    isOnline: () => false,
    showOutcomeScreen: (w) => { won = w; },
    won: () => won,
  };
}

/** A reactor over one live state, reporting the cues a frame asked the bus for. */
function reactorOver(s: GameState, localOwner: number) {
  const hud = new HudView();
  hud.build(new Layers(), { w: 1280, h: 720 });
  const cues: AudioCue[] = [];
  const audio = {
    play: (cue: AudioCue) => { cues.push(cue); },
    preload: async () => {}, setSfxVolume: () => {}, setMusicVolume: () => {},
    updateMusic: () => {}, invalidateMusic: () => {}, resume: () => {},
  } as unknown as AudioBus;
  const fx = {
    flash: () => {}, muzzleFlare: () => {}, addShake: () => {}, addHitStop: () => {},
    pulseChromatic: () => {},
    particles: { muzzleFlame: () => {}, shellCasing: () => {}, explosionDebris: () => {}, shieldShards: () => {} },
  } as unknown as FxController;
  const host: EventReactorHost = {
    localOwner,
    activeState: () => s,
    addScore: () => {},
    onRoomEnter: () => {},
    onDoorStateChange: () => {},
    onForceRegroup: () => {},
    onWeaponPickup: () => {},
    actorAt: () => undefined,
  };
  return { reactor: new EventReactor(fx, hud, audio, host), cues };
}

describe('the result screen and the win cue answer together', () => {
  // Every distinct shape of finished run: the PvE pair, the arena pair, and the two squad
  // cases where seat identity and team membership disagree.
  const CASES: { name: string; state: () => GameState; seat: number; winner: Winner; won: boolean }[] = [
    { name: 'PvE extract', state: pveState, seat: 0, winner: 0, won: true },
    { name: 'PvE extract, a co-op seat nobody named', state: pveState, seat: 2, winner: 0, won: true },
    { name: 'PvE wipe', state: pveState, seat: 0, winner: 'enemies', won: false },
    { name: 'arena, we are named', state: () => arenaState([0, 1]), seat: 0, winner: 0, won: true },
    { name: 'arena, a rival is named', state: () => arenaState([0, 1]), seat: 0, winner: 1, won: false },
    { name: 'arena, our squad-mate is named', state: () => arenaState([0, 1, 1, 0]), seat: 3, winner: 0, won: true },
    { name: 'arena, a rival squad, our seat outlived one of theirs', state: () => arenaState([0, 1, 1, 0]), seat: 1, winner: 0, won: false },
  ];

  for (const c of CASES) {
    it(`${c.name}: the screen says ${c.won ? 'VICTORY' : 'DEFEAT'} and the frame plays ${c.won ? 'win' : 'death.player'}`, () => {
      // Both real objects, one state, one winner. This is the assertion no unit owns and the
      // reason `localSeatWon` is a shared module rather than a method on either of them: a
      // future edit that re-derives the rule in one place still compiles and still passes
      // every per-object test, and lands here as a screen and a sound that disagree.
      const s = c.state();
      s.winner = c.winner;
      s.phase = 'gameover';

      const host = outcomeHost(c.seat);
      new RunOutcome(host).handle(s);

      const { reactor, cues } = reactorOver(s, c.seat);
      reactor.consume([{ type: 'win', winner: c.winner }] as never);

      expect(host.won()).toBe(c.won);
      expect(cues).toEqual([c.won ? 'win' : 'death.player']);
      expect(host.won()).toBe(cues[0] === 'win'); // stated as the invariant, not just the pair
    });
  }

  it('covers both answers, so the loop cannot pass by agreeing on one of them', () => {
    // A table that had drifted to all-wins or all-losses would still assert "they agree" on
    // every row. The mix is what makes the agreement mean something.
    expect(CASES.filter((c) => c.won).length).toBeGreaterThan(1);
    expect(CASES.filter((c) => !c.won).length).toBeGreaterThan(1);
  });
});
