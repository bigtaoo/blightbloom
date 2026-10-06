/**
 * Chapter 3's content gate (design/gameplay/04-chapters.md), the same two halves as chapter 2's
 * `frostLevel1.test.ts`:
 *
 *  1. **It is still the transform it was seeded as.** `world/dungeons/storm/` came out of
 *     `tools/map-editor/scripts/deriveChapter.mjs storm` — chapter 1's JSON turned half a
 *     circle, fire and lightning mobs swapped, the boss room naming `voltreaver`. Pinning that
 *     is what lets the chapter inherit chapter 1's measured properties without re-asserting
 *     each one. The day storm is hand-edited away from the transform, delete that block and
 *     copy across the chapter-1 assertions it stood in for.
 *  2. **It is physically passable**, through the same suite chapters 1 and 2 run
 *     (`fixtures/floorPassability.ts`): a half-turn puts every north wall's brim on what was a
 *     south wall, so passability is re-proved on the turned geometry, never inherited.
 */
import { describe, expect, it } from 'vitest';
import { STORM_DUNGEON, STORM_L1_FLOORS, STORM_L1_ROOMS } from './storm';
import { FROST_DUNGEON } from './frost';
import { EMBER_DUNGEON } from './ember';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from './emberLevel1';
import type { DungeonFloorMap } from '../dungeon';
import type { RoomPiece } from '../../content/rooms';
import { ENEMY_BLUEPRINTS } from '../../content/enemies';
import { describeFloorPassability, pieceLookup, reachesCapstoneWithout } from '../../fixtures/floorPassability';

const FLOOR_INDICES = [0, 1, 2, 3, 4] as const;
const pieceFor = pieceLookup(STORM_L1_ROOMS);
const emberPiece = pieceLookup(EMBER_L1_ROOMS);
const floorAt = (i: number): DungeonFloorMap => {
  const map = STORM_L1_FLOORS[i];
  if (!map) throw new Error(`no authored floor at index ${i}`);
  return map;
};
const enemyTypes = (pieces: readonly RoomPiece[]): string[] => pieces.flatMap((p) => p.spawns.enemy.map((e) => e.type ?? 'basic'));
const count = (xs: string[], x: string): number => xs.filter((y) => y === x).length;

// ── The transform, restated (deriveChapter.mjs is the authority; this is its check) ──
const ROSTER: Record<string, string> = { emberling: 'galvanist', galvanist: 'emberling', boss_random: 'voltreaver' };
const NAMES: Record<string, string> = { forge: 'spire', kiln: 'coil', furnace: 'dynamo', crucible: 'conduit', caldera: 'maelstrom' };
const EDGE: Record<string, string> = { west: 'east', east: 'west', north: 'south', south: 'north' };
const renameId = (id: string): string => id.replace(/^ember_l1_(.+)$/, (_, s: string) => `storm_l1_${NAMES[s] ?? s}`);
const renameRoom = (id: string): string => id.replace(/^([a-z]\d+_)(.+)$/, (_, p: string, s: string) => p + (NAMES[s] ?? s));
/** A half-turn inside a `w` x `h` box: points are continuous, rects are cell ranges. */
const turn = (w: number, h: number) => ({
  rect: <T extends { x: number; y: number; w: number; h: number }>(r: T): T => ({ ...r, x: w - r.x - r.w, y: h - r.y - r.h }),
  point: <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: w - p.x, y: h - p.y }),
});

function derivePiece(p: RoomPiece): RoomPiece {
  const g = turn(p.sizeGrid.w, p.sizeGrid.h);
  const out: RoomPiece = {
    ...p,
    id: renameId(p.id),
    solids: p.solids.map(g.rect),
    spawns: {
      player: p.spawns.player.map(g.point),
      enemy: p.spawns.enemy.map((e) => ({ ...g.point(e), ...(e.type !== undefined ? { type: ROSTER[e.type] ?? e.type } : {}) })),
    },
    exits: p.exits.map((x) => ({ ...x, edge: EDGE[x.edge] as RoomPiece['exits'][number]['edge'] })),
  };
  if (p.tags) out.tags = p.tags.map((t) => (t === 'ember_l1' ? 'storm_l1' : t));
  if (p.pillars) out.pillars = p.pillars.map((c) => ({ ...c, center: g.point(c.center) }));
  if (p.props) out.props = p.props.map(g.point);
  if (p.chests) out.chests = p.chests.map(g.point);
  if (p.shops) out.shops = p.shops.map(g.point);
  return out;
}

function deriveFloor(f: DungeonFloorMap): DungeonFloorMap {
  const size = (id: string) => emberPiece(id).sizeGrid;
  const g = turn(
    Math.max(...f.rooms.map((r) => r.offsetXGrid + size(r.pieceId).w)),
    Math.max(...f.rooms.map((r) => r.offsetYGrid + size(r.pieceId).h)),
  );
  return {
    id: renameId(f.id),
    rooms: f.rooms.map((r) => {
      const box = g.rect({ x: r.offsetXGrid, y: r.offsetYGrid, ...size(r.pieceId) });
      return { id: renameRoom(r.id), pieceId: renameId(r.pieceId), offsetXGrid: box.x, offsetYGrid: box.y };
    }),
    doors: f.doors.map((d) => ({ ...d, roomA: renameRoom(d.roomA), roomB: renameRoom(d.roomB), passageGrid: g.rect(d.passageGrid) })),
  };
}

describe('STORM_DUNGEON is chapter 3', () => {
  it('declares 5 floors and carries an authored map for every one of them', () => {
    expect(STORM_DUNGEON.floorCount).toBe(5);
    for (const i of FLOOR_INDICES) expect(STORM_DUNGEON.floorMaps?.[i]).toBeDefined();
  });

  it('is its own biome, with its own piece tag and capstones resolved against its own library', () => {
    expect(STORM_DUNGEON.biomeId).toBe('storm');
    expect(STORM_DUNGEON.pieceTags).toEqual(['storm_l1']);
    expect(pieceFor(STORM_DUNGEON.extractionPieceId).role).toBe('extraction');
    expect(pieceFor(STORM_DUNGEON.bossPieceId).role).toBe('boss');
    // Nothing in chapter 3 may resolve into chapter 1's library (see the chapter-2 twin).
    const emberIds = new Set(EMBER_L1_ROOMS.map((p) => p.id));
    expect(STORM_L1_ROOMS.filter((p) => emberIds.has(p.id))).toEqual([]);
  });

  it('is laid out differently from both earlier chapters: no floor places its rooms where they do', () => {
    // The point of turning chapter 1 rather than copying it. Chapter 2 is chapter 1
    // transposed; a turn that coincided with either would be a third copy of one map.
    const at = (m: DungeonFloorMap) => m.rooms.map((r) => `${r.offsetXGrid},${r.offsetYGrid}`).join(' ');
    for (const i of FLOOR_INDICES) {
      expect(at(floorAt(i))).not.toBe(at(EMBER_L1_FLOORS[i]!));
      expect(at(floorAt(i))).not.toBe(at(FROST_DUNGEON.floorMaps![i]!));
    }
  });

  it("is the hardest chapter so far past its entrance: chapter 2's entrance, a steeper step", () => {
    // The base cannot move: any step above 1.125 rounds the 3-HP basic mob up to 4 and walls
    // floor 0 (STORM_DUNGEON's doc comment). So the entrance matches chapter 2 and every
    // later floor is scaled above the same floor of both earlier chapters.
    expect(STORM_DUNGEON.difficultyCurve.base).toBe(FROST_DUNGEON.difficultyCurve.base);
    expect(STORM_DUNGEON.difficultyCurve.perFloor).toBeGreaterThan(FROST_DUNGEON.difficultyCurve.perFloor);
    expect(FROST_DUNGEON.difficultyCurve.perFloor).toBe(EMBER_DUNGEON.difficultyCurve.perFloor);
  });

  it('wires the same three branch variants as chapter 1, plain layout first', () => {
    expect(Object.keys(STORM_DUNGEON.floorLayoutVariants ?? {})).toEqual(Object.keys(EMBER_DUNGEON.floorLayoutVariants ?? {}));
    for (const [i, pool] of Object.entries(STORM_DUNGEON.floorLayoutVariants ?? {})) expect(pool?.[0]).toBe(floorAt(Number(i)));
  });
});

describe('chapter 3 is still the transform of chapter 1 it was seeded as', () => {
  it.each(EMBER_L1_ROOMS.map((p) => [p.id, p] as const))('%s', (_, ember) => {
    expect(pieceFor(renameId(ember.id))).toEqual(derivePiece(ember));
  });

  it('every floor map, plain and branch', () => {
    for (const i of FLOOR_INDICES) expect(floorAt(i)).toEqual(deriveFloor(EMBER_L1_FLOORS[i]!));
    for (const [i, pool] of Object.entries(EMBER_DUNGEON.floorLayoutVariants ?? {})) {
      expect(STORM_DUNGEON.floorLayoutVariants?.[Number(i)]?.[1]).toEqual(deriveFloor(pool![1]!));
    }
  });

  it('the library holds exactly the derived pieces, no more', () => {
    expect(STORM_L1_ROOMS.map((p) => p.id).sort()).toEqual(EMBER_L1_ROOMS.map((p) => renameId(p.id)).sort());
  });
});

describe('chapter 3 garrison', () => {
  it('ends in its own boss, not a draw from the random pool', () => {
    const boss = pieceFor(STORM_DUNGEON.bossPieceId);
    expect(boss.spawns.enemy[0]?.type).toBe('voltreaver');
    expect(ENEMY_BLUEPRINTS.voltreaver?.boss).toBe(true);
    expect(enemyTypes(STORM_L1_ROOMS)).not.toContain('boss_random');
  });

  it('is lightning-led: chapter 1 with its emberlings and galvanists traded', () => {
    const storm = enemyTypes(STORM_L1_ROOMS);
    const ember = enemyTypes(EMBER_L1_ROOMS);
    expect(count(storm, 'galvanist')).toBeGreaterThan(count(storm, 'emberling'));
    expect(count(storm, 'galvanist')).toBe(count(ember, 'emberling'));
    expect(count(storm, 'emberling')).toBe(count(ember, 'galvanist'));
  });

  it('names only blueprints that exist', () => {
    for (const t of enemyTypes(STORM_L1_ROOMS)) expect(ENEMY_BLUEPRINTS[t], t).toBeDefined();
  });
});

const BRANCH_VARIANTS = [
  { index: 1, skippable: ['r3_span'] },
  { index: 2, skippable: ['r5_bastion'] },
  { index: 3, skippable: ['r4_rampart', 'b1_cache'] },
].map((v) => ({ ...v, map: STORM_DUNGEON.floorLayoutVariants![v.index]![1]! }));

describeFloorPassability(
  [
    ...FLOOR_INDICES.map((i) => ({ name: `storm floor ${i}`, map: floorAt(i) })),
    ...BRANCH_VARIANTS.map((v) => ({ name: `storm floor ${v.index} branch`, map: v.map })),
  ],
  STORM_L1_ROOMS,
);

describe.each(BRANCH_VARIANTS)("storm floor $index's branch variant", ({ map, skippable }) => {
  it('genuinely lets the named rooms be skipped, and nothing else', () => {
    const chain = map.rooms.slice(1, -1).map((r) => r.id);
    for (const id of chain) {
      const side = pieceFor(map.rooms.find((r) => r.id === id)!.pieceId).spawns.enemy.length === 0;
      if (skippable.includes(id)) expect(reachesCapstoneWithout(map, id), `${id} should be skippable`).toBe(true);
      else if (!side) expect(reachesCapstoneWithout(map, id), `${id} should be mandatory`).toBe(false);
    }
  });
});
