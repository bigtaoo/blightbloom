/**
 * Shared PvP arena EngineConfig builder (design/15, ROADMAP Phase 4 closeout). Pulled out
 * of `Game.buildOnlineConfig` so there is exactly ONE place that turns `(seed,
 * playerCount)` into the arena run config — the same anti-drift lesson design/06 already
 * states for the wire protocol ("two hand-mirrored copies inevitably drift") applies here
 * too, now that a headless bot client (server/src/BotClient.ts) needs to build the
 * byte-identical config independently, without importing the Pixi-heavy Game.ts.
 *
 * MUST stay a pure function of `seed`/`playerCount` (determinism, design/06): seats are
 * skinned by index, real or bot, no chosen character or crafted loadout enters here.
 *
 * `teamId` (design/05/15's PvP squad follow-up) is likewise derived purely from
 * `(owner, playerCount)` via `teamIdForOwner` below — NOT threaded in from a match
 * ticket — precisely because this function has no ticket to read: `BotClient.ts` calls
 * it with only `(seed, playerCount)`, same as a real client. `server/src/Matchmaker.ts`
 * assigns real (and bot) SEATS using this exact same formula (imported from here via
 * the `@dd/game/pvpConfig` alias it already uses for this file), so a seat's squad is
 * never in question regardless of who ends up sitting in it.
 */
import { Prng, SKIN_DEFS, type EngineConfig } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { ARENA_CATALOG } from './arenaCatalog';
import { fpToPx } from '../coords';

// Ignored once `arena` is set (each arena's own geometry defines the bounds) — mirrors
// the PLACEHOLDER_WORLD literal Game.ts uses for its own (non-PvP) online/offline configs.
const PLACEHOLDER_WORLD = 800;

/** PvP squad size (design/05/15, the long-deferred "squads" reserved interface). Also
 * the cap `server/src/PartyService.ts` enforces on party membership. */
export const SQUAD_SIZE = 4;

/** The effective squad size for a given match's total seat count — `SQUAD_SIZE` when
 * it divides evenly into AT LEAST 2 squads, else `1` (today's exact free-for-all)
 * rather than guessing an uneven split. The "at least 2" guard matters: a bare
 * divisibility check would make a `playerCount === SQUAD_SIZE` match (e.g. a 4-seat
 * match with SQUAD_SIZE=4) resolve to ONE squad covering every seat — everyone on the
 * same team, unable to ever damage each other, never reaching a winner. Keeps any
 * non-standard `?seats=` dev value safe instead of crashing OR silently deadlocking. */
export function squadSizeForPlayerCount(playerCount: number): number {
  return SQUAD_SIZE > 1 && playerCount % SQUAD_SIZE === 0 && playerCount / SQUAD_SIZE >= 2 ? SQUAD_SIZE : 1;
}

/** Which squad a seat (`owner`, 0-indexed) belongs to for a match of this size —
 * contiguous chunks of `squadSizeForPlayerCount(playerCount)`. */
export function teamIdForOwner(owner: number, playerCount: number): number {
  return Math.floor(owner / squadSizeForPlayerCount(playerCount));
}

/** Seeds the spawn-assignment stream. Distinct from every engine stream (`GameState`'s
 *  `SEED_*`), and read here only, before the engine exists. */
export const SEED_SPAWN = 0x5b4a5e11;

/**
 * The authored spawns in ring order: sorted by angle round their own centroid, in exact
 * integer arithmetic (no `atan2`: the client and the server must build the same config, and
 * a float that rounds differently on one JS engine would seat a squad elsewhere). Ties, and
 * a spawn standing on the centroid itself, fall back to authored order. Neighbours in this
 * order are neighbours on the map as long as the spawns ring the map, which the launch
 * arena's do (one per outer district; `pvpConfig.test.ts` pins the order).
 */
export function spawnRingOrder(spawns: readonly { x: number; y: number }[]): number[] {
  const m = spawns.length;
  const sx = spawns.reduce((a, p) => a + p.x, 0);
  const sy = spawns.reduce((a, p) => a + p.y, 0);
  // Scaled by m, so the centroid is an integer point.
  const v = spawns.map((p) => ({ x: p.x * m - sx, y: p.y * m - sy }));
  const half = (i: number) => (v[i]!.y < 0 || (v[i]!.y === 0 && v[i]!.x < 0) ? 1 : 0);
  return spawns
    .map((_, i) => i)
    .sort((a, b) => half(a) - half(b) || v[b]!.x * v[a]!.y - v[a]!.x * v[b]!.y || a - b);
}

/**
 * Which authored spawn each seat drops at, as a `start` in px (design/15: `spawns` is
 * ">= seat count; system-assigned per match, no player choice"). A seeded shuffle, so a
 * seat index is not tied to a corner of the map. Until 2026-09-29 nothing did this: every
 * seat started at the `worldW/2, worldH/2` default of `GameState.buildSeat`, which is one
 * point inside spawn 0's room, so every real match began with the whole lobby stacked there
 * and every gun firing past bodies closer than its `muzzleOffset`.
 *
 * A squad starts together (volume 118). The free-for-all shuffle scattered squadmates over
 * the whole map, so an 8-seat match opened as eight lone fights. When the match has squads
 * (`squadSizeForPlayerCount` > 1), each squad takes a run of neighbouring spawns in
 * `spawnRingOrder`, the runs spaced evenly round the ring. Of the ways to turn that cut round
 * the ring, the tightest one is used: the least summed squared distance between squadmates.
 * On the launch arena that is the west half against the east half, the only cut that starts
 * no seat nearer the enemy than its own squad; a cut ending beside an enemy run would. The
 * seed picks among equally tight cuts (which squad takes which half) and shuffles the members
 * within their run. A free-for-all match keeps the plain shuffle, seat for seat, so every
 * match without squads starts exactly where it did before.
 */
export function assignArenaStarts(arena: ArenaMap, seed: number, playerCount: number): [number, number][] {
  const m = arena.spawns.length;
  if (m < playerCount) {
    throw new Error(`arena has ${m} spawns for ${playerCount} seats`);
  }
  const prng = new Prng(seed ^ SEED_SPAWN);
  const squad = squadSizeForPlayerCount(playerCount);
  let order: number[];
  if (squad === 1) {
    order = arena.spawns.map((_, i) => i);
    prng.shuffle(order);
  } else {
    const ring = spawnRingOrder(arena.spawns);
    const squads = playerCount / squad;
    // Runs never overlap: the gap between run starts is at least floor(m / squads), which is
    // at least the squad size because m >= playerCount.
    const runs = (turn: number) =>
      Array.from({ length: squads }, (_, k) =>
        Array.from({ length: squad }, (_, j) => ring[(turn + Math.floor((k * m) / squads) + j) % m]!));
    const d2 = (a: number, b: number) =>
      (arena.spawns[a]!.x - arena.spawns[b]!.x) ** 2 + (arena.spawns[a]!.y - arena.spawns[b]!.y) ** 2;
    const spread = (turn: number) =>
      runs(turn).reduce((t, run) => t + run.reduce((u, a, i) => u + run.slice(i + 1).reduce((w, b) => w + d2(a, b), 0), 0), 0);
    const cost = ring.map((_, turn) => spread(turn));
    const least = Math.min(...cost);
    const tightest = cost.flatMap((c, turn) => (c === least ? [turn] : []));
    order = [];
    for (const run of runs(tightest[prng.nextInt(tightest.length)]!)) {
      prng.shuffle(run);
      order.push(...run);
    }
  }
  const px = (grid: number) => fpToPx(toFpGrid(grid));
  return order.slice(0, playerCount).map((i) => [px(arena.spawns[i]!.x), px(arena.spawns[i]!.y)]);
}

export function buildPvpEngineConfig(seed: number, playerCount: number): EngineConfig {
  const ids = Object.keys(SKIN_DEFS);
  const arena = ARENA_CATALOG.arena_launch;
  const starts = assignArenaStarts(arena, seed, playerCount);
  return {
    seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    players: Array.from({ length: playerCount }, (_, i) => ({
      skinId: ids[i % ids.length]!,
      teamId: teamIdForOwner(i, playerCount),
      start: starts[i]!,
    })),
    arena,
  };
}
