/**
 * buildPvpEngineConfig / squad helpers (design/15, ROADMAP Phase 4 closeout;
 * design/05/15's PvP squad follow-up for teamId). Pins the determinism invariant
 * `BotClient.ts` relies on (pure function of seed+playerCount, no ticket/party input)
 * and the squad-chunking math `server/src/Matchmaker.ts` mirrors via the same
 * `@dd/game/pvpConfig` import.
 */
import { describe, it, expect } from 'vitest';
import { createGameState, Prng } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { assignArenaStarts, buildPvpEngineConfig, spawnRingOrder, squadSizeForPlayerCount, teamIdForOwner, SEED_SPAWN, SQUAD_SIZE } from './pvpConfig';
import { ARENA_CATALOG } from './arenaCatalog';
import { fpToPx } from '../coords';

describe('squadSizeForPlayerCount / teamIdForOwner', () => {
  it('uses SQUAD_SIZE when playerCount divides evenly into at least 2 squads', () => {
    expect(squadSizeForPlayerCount(8)).toBe(SQUAD_SIZE); // 2 squads of 4
    expect(squadSizeForPlayerCount(12)).toBe(SQUAD_SIZE); // 3 squads of 4
  });

  it('falls back to 1 (free-for-all) for a playerCount that does not divide evenly', () => {
    for (const n of [1, 2, 3, 5, 6, 7]) expect(squadSizeForPlayerCount(n)).toBe(1);
  });

  it('falls back to 1 when playerCount === SQUAD_SIZE exactly — one "squad" covering everyone would be a single team that can never fight itself', () => {
    expect(squadSizeForPlayerCount(SQUAD_SIZE)).toBe(1);
    const teamIds = Array.from({ length: SQUAD_SIZE }, (_, i) => teamIdForOwner(i, SQUAD_SIZE));
    expect(new Set(teamIds).size).toBe(SQUAD_SIZE); // every seat its own team, not one shared team
  });

  it('splits an 8-seat match into two 4-seat squads', () => {
    const teamIds = Array.from({ length: 8 }, (_, i) => teamIdForOwner(i, 8));
    expect(teamIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('gives every seat its own distinct squad when playerCount does not divide evenly', () => {
    const teamIds = Array.from({ length: 3 }, (_, i) => teamIdForOwner(i, 3));
    expect(teamIds).toEqual([0, 1, 2]);
  });
});

describe('buildPvpEngineConfig', () => {
  it('is a pure function of (seed, playerCount) — identical config on every call, matching BotClient.ts\'s own independent derivation', () => {
    const a = buildPvpEngineConfig(42, 8);
    const b = buildPvpEngineConfig(42, 8);
    expect(a).toEqual(b);
  });

  it('assigns squad-derived teamIds for an 8-seat match, not one-per-seat', () => {
    const cfg = buildPvpEngineConfig(1, 8);
    const teamIds = cfg.players!.map((p) => p.teamId);
    expect(teamIds).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('keeps the pre-squad one-team-per-seat shape for a playerCount that does not divide by SQUAD_SIZE', () => {
    const cfg = buildPvpEngineConfig(1, 3);
    const teamIds = cfg.players!.map((p) => p.teamId);
    expect(teamIds).toEqual([0, 1, 2]);
  });
});

describe('assignArenaStarts', () => {
  const arena = ARENA_CATALOG.arena_launch;
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  const authored = arena.spawns.map((p) => `${px(p.x)},${px(p.y)}`);

  it('drops every seat of a full lobby at its own authored spawn', () => {
    for (const seed of [1, 2, 3, 99]) {
      const starts = buildPvpEngineConfig(seed, arena.spawns.length).players!.map((p) => `${p.start![0]},${p.start![1]}`);
      expect(new Set(starts).size).toBe(arena.spawns.length);
      for (const s of starts) expect(authored).toContain(s);
    }
  });

  it('seats land where the config says — not on the default centre point', () => {
    const cfg = buildPvpEngineConfig(7, 2);
    const s = createGameState(cfg);
    s.players.forEach((p, i) => {
      expect(fpToPx(p.gx)).toBe(cfg.players![i]!.start![0]);
      expect(fpToPx(p.gy)).toBe(cfg.players![i]!.start![1]);
    });
    expect(s.players[0]!.gx === s.players[1]!.gx && s.players[0]!.gy === s.players[1]!.gy).toBe(false);
  });

  it('varies the seat-to-spawn mapping with the seed', () => {
    const firsts = new Set(Array.from({ length: 16 }, (_, seed) => buildPvpEngineConfig(seed, 2).players![0]!.start!.join(',')));
    expect(firsts.size).toBeGreaterThan(3);
  });

  it('refuses a lobby bigger than the authored spawn list', () => {
    expect(() => assignArenaStarts(arena, 1, arena.spawns.length + 1)).toThrow(/spawns for/);
  });
});

// A squad starts together (volume 118). Until then the free-for-all shuffle also seated
// squads, so an 8-seat match dropped squadmates in separate districts all over the map.
describe('assignArenaStarts: squads', () => {
  const arena = ARENA_CATALOG.arena_launch;
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  const spawnOf = (a: typeof arena, start: [number, number]) =>
    a.spawns.findIndex((p) => px(p.x) === start[0] && px(p.y) === start[1]);
  // The volume-115 assignment, which every match used before this: one plain shuffle.
  const plainShuffle = (a: typeof arena, seed: number, n: number) => {
    const order = a.spawns.map((_, i) => i);
    new Prng(seed ^ SEED_SPAWN).shuffle(order);
    return order.slice(0, n);
  };
  // A synthetic map whose `count` spawns sit on a circle, authored in a scrambled order so
  // the ring order has to be derived rather than read off the list.
  const circleArena = (count: number) => {
    const pts = Array.from({ length: count }, (_, i) => ({
      x: 100 + Math.round(80 * Math.cos((2 * Math.PI * i) / count)),
      y: 100 + Math.round(80 * Math.sin((2 * Math.PI * i) / count)),
    }));
    const scramble = pts.map((_, i) => (i * 5) % count); // 5 is coprime to 8 and 12
    return { arena: { ...arena, spawns: scramble.map((i) => pts[i]!) }, circlePos: scramble };
  };
  const SEEDS = Array.from({ length: 64 }, (_, i) => i);

  it('orders spawns round their centroid, falling back to authored order on a tie', () => {
    // A square authored out of order, then two points on one ray from the centroid, and a
    // point on the centroid's west axis (the y === 0, x < 0 edge of the half-plane split).
    const square = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    expect(spawnRingOrder(square)).toEqual([1, 3, 0, 2]);
    const ray = [{ x: 2, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }, { x: -6, y: 0 }];
    expect(spawnRingOrder(ray)).toEqual([0, 1, 2, 3]);
    // Due west and due east cross to zero, so only the half-plane split puts west after east.
    const compass = [{ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 0, y: -10 }];
    expect(spawnRingOrder(compass)).toEqual([1, 2, 0, 3]);
  });

  it('puts the launch arena spawns in their ring round the map', () => {
    // E, SE, S, SW, W, NW, N, NE: each spawn's ring neighbours are neighbours on the map.
    const named = spawnRingOrder(arena.spawns).map((i) => `${arena.spawns[i]!.x},${arena.spawns[i]!.y}`);
    expect(named).toEqual(['101,53', '101,88', '61,69', '24,87', '24,42', '7,11', '75,7', '112,17']);
  });

  it('gives each squad a run of neighbouring ring spawns, and the runs never overlap', () => {
    for (const [count, seats] of [[8, 8], [12, 8], [12, 12]] as const) {
      const { arena: a, circlePos } = circleArena(count);
      const squad = squadSizeForPlayerCount(seats);
      for (const seed of SEEDS) {
        const spawns = assignArenaStarts(a, seed, seats).map((st) => spawnOf(a, st));
        expect(new Set(spawns).size).toBe(seats);
        for (let k = 0; k < seats / squad; k++) {
          const pos = spawns.slice(k * squad, (k + 1) * squad).map((i) => circlePos[i]!);
          // A cyclic run of `squad` positions: some member is the start of it.
          const run = pos.some((p0) => pos.every((p) => (p - p0 + count) % count < squad));
          expect(run, `${count} spawns, ${seats} seats, seed ${seed}, squad ${k}: ${pos}`).toBe(true);
        }
        // Spare spawns go between the squads, not all on one side: 8 seats on 12 spawns
        // leave two empty spawns on each side of each run.
        const gap = Math.floor(count / (seats / squad)) - squad + 1;
        spawns.forEach((a, i) => spawns.forEach((b, j) => {
          if (teamIdForOwner(i, seats) === teamIdForOwner(j, seats)) return;
          const apart = (circlePos[a]! - circlePos[b]! + count) % count;
          expect(Math.min(apart, count - apart), `${count} spawns, ${seats} seats, seed ${seed}`).toBeGreaterThanOrEqual(gap);
        }));
      }
    }
  });

  it('starts every squadmate nearer its squad than the enemy, on the launch arena', () => {
    const d = (a: number, b: number) => Math.hypot(arena.spawns[a]!.x - arena.spawns[b]!.x, arena.spawns[a]!.y - arena.spawns[b]!.y);
    const lonely = (spawns: number[]) =>
      spawns.filter((me, seat) => {
        const mates = spawns.filter((_, o) => o !== seat && teamIdForOwner(o, 8) === teamIdForOwner(seat, 8));
        const foes = spawns.filter((_, o) => teamIdForOwner(o, 8) !== teamIdForOwner(seat, 8));
        const mean = (xs: number[]) => xs.reduce((t, x) => t + d(me, x), 0) / xs.length;
        return mean(mates) >= mean(foes);
      }).length;
    let before = 0;
    for (const seed of SEEDS) {
      expect(lonely(assignArenaStarts(arena, seed, 8).map((st) => spawnOf(arena, st))), `seed ${seed}`).toBe(0);
      before += lonely(plainShuffle(arena, seed, 8));
    }
    // The control: the plain shuffle strands a large share of seats among the enemy.
    expect(before).toBeGreaterThan(SEEDS.length);
  });

  it('lets the seed choose which squad takes which half, and the seats within it', () => {
    const west = new Set(['61,69', '24,87', '24,42', '7,11']);
    const halves = new Set<string>();
    const seatings = new Set<string>();
    for (const seed of SEEDS) {
      const starts = assignArenaStarts(arena, seed, 8).map((st) => spawnOf(arena, st));
      const side = starts.map((i) => (west.has(`${arena.spawns[i]!.x},${arena.spawns[i]!.y}`) ? 'W' : 'E')).join('');
      expect(['WWWWEEEE', 'EEEEWWWW'], `seed ${seed}`).toContain(side);
      halves.add(side);
      seatings.add(starts.join());
    }
    expect(halves.size).toBe(2);
    expect(seatings.size).toBeGreaterThan(SEEDS.length / 2);
  });

  it('leaves every free-for-all match where the plain shuffle put it', () => {
    for (const seats of [2, 3, 4, 5, 6, 7]) {
      for (const seed of SEEDS) {
        expect(assignArenaStarts(arena, seed, seats).map((st) => spawnOf(arena, st))).toEqual(plainShuffle(arena, seed, seats));
      }
    }
  });
});
