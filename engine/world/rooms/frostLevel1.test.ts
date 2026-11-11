/**
 * Chapter 2's content gate (design/gameplay/04-chapters.md). Two halves:
 *
 *  1. **It is still the transform it was seeded as.** `world/dungeons/frost/` came out of
 *     `tools/map-editor/scripts/deriveChapter.mjs` — chapter 1's JSON transposed, fire and ice
 *     mobs swapped, the boss room naming `glacimaw`. Pinning that is what lets the chapter
 *     inherit chapter 1's measured properties (enemy ramp, spawn clearance, chest and shop
 *     placement) without re-asserting each one. The day frost is hand-edited away from the
 *     transform, delete that block and copy across the chapter-1 assertions it stood in for.
 *  2. **It is physically passable**, through the same suite chapter 1 runs
 *     (`fixtures/floorPassability.ts`) — that one is never inherited, because placement and
 *     door carving run on the transposed geometry, not on chapter 1's.
 */
import { describe, expect, it } from 'vitest';
import { FROST_DUNGEON, FROST_L1_FLOORS, FROST_L1_ROOMS } from './frost';
import { EMBER_DUNGEON } from './ember';
import { curveAt } from '../dungeon/generateFloor';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from './emberLevel1';
import type { DungeonFloorMap } from '../dungeon';
import type { RoomPiece } from '../../content/rooms';
import { ENEMY_BLUEPRINTS } from '../../content/enemies';
import { describeFloorPassability, pieceLookup, reachesCapstoneWithout } from '../../fixtures/floorPassability';

const FLOOR_INDICES = [0, 1, 2, 3, 4] as const;
const pieceFor = pieceLookup(FROST_L1_ROOMS);
const floorAt = (i: number): DungeonFloorMap => {
  const map = FROST_L1_FLOORS[i];
  if (!map) throw new Error(`no authored floor at index ${i}`);
  return map;
};
const enemyTypes = (pieces: readonly RoomPiece[]): string[] => pieces.flatMap((p) => p.spawns.enemy.map((e) => e.type ?? 'basic'));
const count = (xs: string[], x: string): number => xs.filter((y) => y === x).length;

// ── The transform, restated (deriveChapter.mjs is the authority; this is its check) ──
const ROSTER: Record<string, string> = { emberling: 'frostling', frostling: 'emberling', boss_random: 'glacimaw' };
const NAMES: Record<string, string> = { forge: 'hollow', kiln: 'drift', furnace: 'glacier', crucible: 'cistern', caldera: 'cirque' };
const EDGE: Record<string, string> = { west: 'north', north: 'west', east: 'south', south: 'east' };
const renameId = (id: string): string => id.replace(/^ember_l1_(.+)$/, (_, s: string) => `frost_l1_${NAMES[s] ?? s}`);
const renameRoom = (id: string): string => id.replace(/^([a-z]\d+_)(.+)$/, (_, p: string, s: string) => p + (NAMES[s] ?? s));
const tRect = <T extends { x: number; y: number; w: number; h: number }>(r: T): T => ({ ...r, x: r.y, y: r.x, w: r.h, h: r.w });
const tPoint = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.y, y: p.x });

function derivePiece(p: RoomPiece): RoomPiece {
  const out: RoomPiece = {
    ...p,
    id: renameId(p.id),
    sizeGrid: { w: p.sizeGrid.h, h: p.sizeGrid.w },
    solids: p.solids.map(tRect),
    spawns: {
      player: p.spawns.player.map(tPoint),
      enemy: p.spawns.enemy.map((e) => ({ ...tPoint(e), ...(e.type !== undefined ? { type: ROSTER[e.type] ?? e.type } : {}) })),
    },
    exits: p.exits.map((x) => ({ ...x, edge: EDGE[x.edge] as RoomPiece['exits'][number]['edge'] })),
  };
  if (p.tags) out.tags = p.tags.map((t) => (t === 'ember_l1' ? 'frost_l1' : t));
  if (p.pillars) out.pillars = p.pillars.map((c) => ({ ...c, center: tPoint(c.center) }));
  if (p.props) out.props = p.props.map(tPoint);
  if (p.chests) out.chests = p.chests.map(tPoint);
  if (p.shops) out.shops = p.shops.map(tPoint);
  return out;
}

function deriveFloor(f: DungeonFloorMap): DungeonFloorMap {
  return {
    id: renameId(f.id),
    rooms: f.rooms.map((r) => ({ id: renameRoom(r.id), pieceId: renameId(r.pieceId), offsetXGrid: r.offsetYGrid, offsetYGrid: r.offsetXGrid })),
    doors: f.doors.map((d) => ({ ...d, roomA: renameRoom(d.roomA), roomB: renameRoom(d.roomB), passageGrid: tRect(d.passageGrid) })),
  };
}

describe('FROST_DUNGEON is chapter 2', () => {
  it('declares 5 floors and carries an authored map for every one of them', () => {
    expect(FROST_DUNGEON.floorCount).toBe(5);
    for (const i of FLOOR_INDICES) expect(FROST_DUNGEON.floorMaps?.[i]).toBeDefined();
  });

  it('is its own biome, with its own piece tag and capstones resolved against its own library', () => {
    expect(FROST_DUNGEON.biomeId).toBe('frost');
    expect(FROST_DUNGEON.pieceTags).toEqual(['frost_l1']);
    expect(pieceFor(FROST_DUNGEON.extractionPieceId).role).toBe('extraction');
    expect(pieceFor(FROST_DUNGEON.bossPieceId).role).toBe('boss');
    // Nothing in chapter 2 may resolve into chapter 1's library — a shared id would mean
    // editing one chapter in the map editor silently edits the other.
    const emberIds = new Set(EMBER_L1_ROOMS.map((p) => p.id));
    expect(FROST_L1_ROOMS.filter((p) => emberIds.has(p.id))).toEqual([]);
  });

  it('is the harder chapter: every floor scales mob HP above the same floor of chapter 1', () => {
    // Stated floor by floor rather than as "same perFloor, higher base": since ENGINE_VERSION 90
    // chapter 1 starts lower and climbs faster (it is the learning chapter, ember.ts), so the two
    // curves no longer run parallel, and the property that matters is the one in the title.
    for (const i of FLOOR_INDICES) {
      expect(curveAt(FROST_DUNGEON.difficultyCurve, i), `floor ${i}`).toBeGreaterThan(curveAt(EMBER_DUNGEON.difficultyCurve, i));
    }
    // And chapter 1's one-shooter opener stays chapter 1's: a later chapter that copied it would
    // stop testing what its first floor was tuned to test.
    expect(FROST_DUNGEON.fireBudgetByFloor).toBeUndefined();
  });

  it('wires the same three branch variants as chapter 1, plain layout first', () => {
    expect(Object.keys(FROST_DUNGEON.floorLayoutVariants ?? {})).toEqual(Object.keys(EMBER_DUNGEON.floorLayoutVariants ?? {}));
    for (const [i, pool] of Object.entries(FROST_DUNGEON.floorLayoutVariants ?? {})) expect(pool?.[0]).toBe(floorAt(Number(i)));
  });
});

// ── The one place the transform is deliberately NOT followed (2026-11-11) ──────────────
//
// Chapter 1's three floor-one fight rooms were cut below the density ramp — alcove 9→5,
// gallery 10→7, forge 10→8 — because `run_death.room` on the Playgama sandbox put 23 of 25
// deaths inside them (design/22 §4.1, `engine/world/rooms/emberLevel1.test.ts`). That is
// beginner tuning for the first rooms a NEW player ever meets, and chapter 2 is reached by
// essentially nobody: `run_end.floor` has a p50 of 1.
//
// Propagating the cut here was tried and measured, and it is worse: `client/sim/chapterSim.sim.ts`
// turns red twice — chapter 3's floor-2 trial stops being harder than chapter 2's (20.6 vs a
// 18.75 ceiling), and a chapter-4 blight room starts bursting 12 damage into a 10-point
// effective HP pool. The chapters keep the garrisons they were authored with.
//
// So the pieces below are exempt from `toEqual(derivePiece(ember))` in ONE field, and the
// exemption is checked rather than waved through: everything outside `spawns.enemy` must still
// match the transform exactly, and the garrison chapter 1 kept must be a strict SUBSET of the
// one this chapter still fields. `deriveChapter.mjs` would silently re-propagate the cut if it
// were ever re-run over these three — delete this block and re-derive the day a chapter is
// deliberately brought back in line.
const BEGINNER_CUT = new Set(['ember_l1_alcove', 'ember_l1_gallery', 'ember_l1_forge']);
const spawnKey = (e: RoomPiece['spawns']['enemy'][number]): string => `${e.type ?? 'basic'}@${e.x},${e.y}`;

const CUT_RENAMED = new Set([...BEGINNER_CUT].map(renameId));
/**
 * The garrison OUTSIDE the three rooms chapter 1 thinned — the fair basis for comparing two
 * chapters' rosters now that those three deliberately differ. Takes either chapter's library;
 * the ids are filtered under both spellings.
 */
const typesOutsideCut = (pieces: readonly RoomPiece[]): string[] =>
  enemyTypes(pieces.filter((p) => !BEGINNER_CUT.has(p.id) && !CUT_RENAMED.has(p.id)));

describe('chapter 2 is still the transform of chapter 1 it was seeded as', () => {
  it.each(EMBER_L1_ROOMS.map((p) => [p.id, p] as const))('%s', (_, ember) => {
    const derived = derivePiece(ember);
    const actual = pieceFor(derived.id);
    if (!BEGINNER_CUT.has(ember.id)) {
      expect(actual).toEqual(derived);
      return;
    }
    const blank = (p: RoomPiece): RoomPiece => ({ ...p, spawns: { ...p.spawns, enemy: [] } });
    expect(blank(actual), `${ember.id} may differ in its garrison and nowhere else`).toEqual(blank(derived));
    const fielded = actual.spawns.enemy.map(spawnKey);
    for (const e of derived.spawns.enemy) expect(fielded, `${ember.id} dropped a mob chapter 1 kept`).toContain(spawnKey(e));
    expect(actual.spawns.enemy.length, `${ember.id} is exempt to be HEAVIER than chapter 1, not lighter`).toBeGreaterThan(derived.spawns.enemy.length);
  });

  it('every floor map, plain and branch', () => {
    for (const i of FLOOR_INDICES) expect(floorAt(i)).toEqual(deriveFloor(EMBER_L1_FLOORS[i]!));
    for (const [i, pool] of Object.entries(EMBER_DUNGEON.floorLayoutVariants ?? {})) {
      expect(FROST_DUNGEON.floorLayoutVariants?.[Number(i)]?.[1]).toEqual(deriveFloor(pool![1]!));
    }
  });

  it('the library holds exactly the derived pieces, no more', () => {
    expect(FROST_L1_ROOMS.map((p) => p.id).sort()).toEqual(EMBER_L1_ROOMS.map((p) => renameId(p.id)).sort());
  });
});

describe('chapter 2 garrison', () => {
  it('ends in its own boss, not a draw from the random pool', () => {
    const boss = pieceFor(FROST_DUNGEON.bossPieceId);
    expect(boss.spawns.enemy[0]?.type).toBe('glacimaw');
    expect(ENEMY_BLUEPRINTS.glacimaw?.boss).toBe(true);
    expect(enemyTypes(FROST_L1_ROOMS)).not.toContain('boss_random');
  });

  it('is frost-led: more frostlings than emberlings, the mirror image of chapter 1', () => {
    const frost = enemyTypes(FROST_L1_ROOMS);
    expect(count(frost, 'frostling')).toBeGreaterThan(count(frost, 'emberling'));
    // Counted outside the three rooms chapter 1 thinned for beginners (BEGINNER_CUT above).
    // There the two chapters differ on purpose, and the transform test pins exactly how.
    expect(count(typesOutsideCut(FROST_L1_ROOMS), 'frostling')).toBe(count(typesOutsideCut(EMBER_L1_ROOMS), 'emberling'));
  });

  it('names only blueprints that exist', () => {
    for (const t of enemyTypes(FROST_L1_ROOMS)) expect(ENEMY_BLUEPRINTS[t], t).toBeDefined();
  });
});

const BRANCH_VARIANTS = [
  { index: 1, skippable: ['r3_span'] },
  { index: 2, skippable: ['r5_bastion'] },
  { index: 3, skippable: ['r4_rampart', 'b1_cache'] },
].map((v) => ({ ...v, map: FROST_DUNGEON.floorLayoutVariants![v.index]![1]! }));

describeFloorPassability(
  [
    ...FLOOR_INDICES.map((i) => ({ name: `frost floor ${i}`, map: floorAt(i) })),
    ...BRANCH_VARIANTS.map((v) => ({ name: `frost floor ${v.index} branch`, map: v.map })),
  ],
  FROST_L1_ROOMS,
);

describe.each(BRANCH_VARIANTS)("frost floor $index's branch variant", ({ map, skippable }) => {
  it('genuinely lets the named rooms be skipped, and nothing else', () => {
    const chain = map.rooms.slice(1, -1).map((r) => r.id);
    for (const id of chain) {
      const side = pieceFor(map.rooms.find((r) => r.id === id)!.pieceId).spawns.enemy.length === 0;
      if (skippable.includes(id)) expect(reachesCapstoneWithout(map, id), `${id} should be skippable`).toBe(true);
      else if (!side) expect(reachesCapstoneWithout(map, id), `${id} should be mandatory`).toBe(false);
    }
  });
});
