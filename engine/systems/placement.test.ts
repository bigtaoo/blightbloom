/**
 * WinConditionSystem's PvP branch (design/15, ROADMAP 4.2e) — battle-royale
 * elimination placement, distinct from the PvE "enemies win"/wave-clear model.
 * Doesn't touch the zone/geometry at all, so a single trivial room is enough —
 * only `state.players[].alive`/`teamId` matter here.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { WinConditionSystem } from '@dd/engine/systems';
import type { ArenaMap } from '@dd/engine/content/arenas';

const MINI_MAP: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function pvpState(seatCount: number): GameState {
  const players = Array.from({ length: seatCount }, (_, i) => ({ teamId: i }));
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
}

describe('WinConditionSystem — PvP placement', () => {
  it('the match continues while more than one seat is alive', () => {
    const s = pvpState(4);
    new WinConditionSystem().tick(s);
    expect(s.winner).toBeNull();
    expect(s.phase).not.toBe('gameover');
    expect(s.placements).toEqual([]);
  });

  it('records each elimination in order and declares the last survivor the winner', () => {
    const s = pvpState(4);
    const sys = new WinConditionSystem();

    s.players[2]!.alive = false; // 3rd seat eliminated first
    sys.tick(s);
    expect(s.placements).toEqual([2]);
    expect(s.winner).toBeNull();

    s.players[0]!.alive = false; // 1st seat eliminated next
    sys.tick(s);
    expect(s.placements).toEqual([2, 0]);
    expect(s.winner).toBeNull();

    s.players[3]!.alive = false; // only seat 1 left standing
    sys.tick(s);
    expect(s.winner).toBe(1);
    expect(s.phase).toBe('gameover');
    expect(s.placements).toEqual([2, 0, 3]); // worst-to-best; the winner (1) never appears here
    const winEvent = s.events.find((e) => e.type === 'win');
    expect(winEvent).toMatchObject({ type: 'win', winner: 1 });
  });

  it('never re-decides once a winner is set (idempotent after gameover)', () => {
    const s = pvpState(2);
    s.players[1]!.alive = false;
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe(0);
    s.players[0]!.alive = false; // both now dead — should NOT retrigger tiebreak logic
    new WinConditionSystem().tick(s);
    expect(s.winner).toBe(0); // unchanged
  });

  it('same-tick double elimination breaks the tie by ascending teamId, never a coin flip', () => {
    const s = pvpState(4);
    const sys = new WinConditionSystem();
    s.players[1]!.alive = false; // down to {0, 2, 3}
    sys.tick(s);
    expect(s.placements).toEqual([1]);

    // Seats 0 and 2 both die on the SAME tick — only seat 3 would naturally survive,
    // but to specifically exercise the zero-survivors tiebreak we kill every
    // remaining seat simultaneously instead of leaving one standing.
    s.players[0]!.alive = false;
    s.players[2]!.alive = false;
    s.players[3]!.alive = false;
    sys.tick(s);

    // teamId === seat index here, so the lowest surviving-until-now teamId (0) wins.
    expect(s.winner).toBe(0);
    expect(s.phase).toBe('gameover');
    // The winner must never also appear in placements (it's 1st, not a loser).
    expect(s.placements).not.toContain(0);
    expect(s.placements.sort()).toEqual([1, 2, 3]);
  });

  // The tie is only among the seats that went out together. Until 2026-09-30 the tiebreak took
  // the lowest teamId of EVERY squad, so seat 0, out first, was pulled back out of placements and
  // named winner (the PvP sim's seed 1040000: seat 0 died at tick 1315, the last two at 2100).
  it('never names a seat eliminated on an earlier tick the winner of a simultaneous wipe', () => {
    const s = pvpState(4);
    const sys = new WinConditionSystem();
    s.players[0]!.alive = false;
    sys.tick(s);
    expect(s.placements).toEqual([0]);

    s.players[1]!.alive = false;
    s.players[2]!.alive = false;
    s.players[3]!.alive = false;
    sys.tick(s);

    expect(s.winner).toBe(1);
    expect(s.events.find((e) => e.type === 'win')).toMatchObject({ winner: 1 });
    // Seat 0 is still last, and the winner is not a loser.
    expect(s.placements[0]).toBe(0);
    expect([...s.placements].sort()).toEqual([0, 2, 3]);
  });
});

describe('WinConditionSystem — squads (design/05/15 PvP squad follow-up)', () => {
  /** 8 seats, 2 squads of 4 (teamId 0 = seats 0-3, teamId 1 = seats 4-7) — the exact
   * shape `buildPvpEngineConfig`/`Matchmaker` produce for an 8-seat match. */
  function squadState(): GameState {
    const players = Array.from({ length: 8 }, (_, i) => ({ teamId: Math.floor(i / 4) }));
    return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
  }

  it('a squad with a living member is NOT eliminated even if some of its seats have died', () => {
    const s = squadState();
    const sys = new WinConditionSystem();
    s.players[0]!.alive = false; // one of squad 0's four members dies
    sys.tick(s);
    expect(s.placements).toEqual([]); // squad 0 still has 3 living members — not eliminated
    expect(s.winner).toBeNull();
  });

  it('records every seat of a squad the moment its LAST member dies, in one batch', () => {
    const s = squadState();
    const sys = new WinConditionSystem();
    s.players[0]!.alive = false;
    s.players[1]!.alive = false;
    s.players[2]!.alive = false;
    sys.tick(s);
    expect(s.placements).toEqual([]); // seat 3 still alive — squad 0 not yet wiped
    s.players[3]!.alive = false; // squad 0 fully wiped now
    sys.tick(s);
    expect(s.placements.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]); // whole squad recorded at once
    expect(s.winner).toBe(4); // squad 1 (seats 4-7) wins — representative is its lowest seat
    expect(s.phase).toBe('gameover');
  });

  it('a solo/FFA match (every squad a singleton) is byte-identical to the pre-squad behavior', () => {
    // playerCount not divisible by SQUAD_SIZE (or any config with all-distinct
    // teamIds, e.g. a 4-seat match with one squad per seat) must produce the exact
    // same per-seat placement as the original FFA-only tests above.
    const players = [{ teamId: 0 }, { teamId: 1 }, { teamId: 2 }];
    const s = createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
    const sys = new WinConditionSystem();
    s.players[1]!.alive = false;
    sys.tick(s);
    expect(s.placements).toEqual([1]);
    expect(s.winner).toBeNull();
  });
});
