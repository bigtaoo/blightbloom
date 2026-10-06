/**
 * Chapter 4's content gate (design/gameplay/04-chapters.md), the same two halves as chapters 2
 * and 3 (`frostLevel1.test.ts`, `stormLevel1.test.ts`):
 *
 *  1. **It is still the transform it was seeded as.** `world/dungeons/blight/` came out of
 *     `tools/map-editor/scripts/deriveChapter.mjs blight` — chapter 1's JSON mirrored across the
 *     anti-diagonal, every emberling a blightling, the boss room naming `rotbloom`. Pinning that
 *     is what lets the chapter inherit chapter 1's measured properties without re-asserting
 *     each one. The day blight is hand-edited away from the transform, delete that block and
 *     copy across the chapter-1 assertions it stood in for.
 *  2. **It is physically passable**, through the same suite chapters 1-3 run
 *     (`fixtures/floorPassability.ts`): the mirror puts every north wall's brim on what was an
 *     east wall, so passability is re-proved on the mirrored geometry, never inherited.
 */
import { describe, expect, it } from 'vitest';
import { BLIGHT_DUNGEON, BLIGHT_L1_FLOORS, BLIGHT_L1_ROOMS } from './blight';
import { STORM_DUNGEON } from './storm';
import { FROST_DUNGEON } from './frost';
import { EMBER_DUNGEON } from './ember';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from './emberLevel1';
import type { DungeonFloorMap } from '../dungeon';
import type { RoomPiece } from '../../content/rooms';
import { ENEMY_BLUEPRINTS } from '../../content/enemies';
import { describeFloorPassability, pieceLookup, reachesCapstoneWithout } from '../../fixtures/floorPassability';

const FLOOR_INDICES = [0, 1, 2, 3, 4] as const;
const pieceFor = pieceLookup(BLIGHT_L1_ROOMS);
const emberPiece = pieceLookup(EMBER_L1_ROOMS);
const floorAt = (i: number): DungeonFloorMap => {
  const map = BLIGHT_L1_FLOORS[i];
  if (!map) throw new Error(`no authored floor at index ${i}`);
  return map;
};
const enemyTypes = (pieces: readonly RoomPiece[]): string[] => pieces.flatMap((p) => p.spawns.enemy.map((e) => e.type ?? 'basic'));
const count = (xs: string[], x: string): number => xs.filter((y) => y === x).length;

// ── The transform, restated (deriveChapter.mjs is the authority; this is its check) ──
const ROSTER: Record<string, string> = { emberling: 'blightling', boss_random: 'rotbloom' };
const NAMES: Record<string, string> = { forge: 'mire', kiln: 'warren', furnace: 'thicket', crucible: 'sump', caldera: 'canker' };
const EDGE: Record<string, string> = { west: 'south', south: 'west', north: 'east', east: 'north' };
const renameId = (id: string): string => id.replace(/^ember_l1_(.+)$/, (_, s: string) => `blight_l1_${NAMES[s] ?? s}`);
const renameRoom = (id: string): string => id.replace(/^([a-z]\d+_)(.+)$/, (_, p: string, s: string) => p + (NAMES[s] ?? s));
/** The mirror across the anti-diagonal of a `w` x `h` box, (x, y) -> (h - y, w - x): points are
 *  continuous, rects are cell ranges, and the box itself comes out `h` x `w`. */
const mirror = (w: number, h: number) => ({
  rect: <T extends { x: number; y: number; w: number; h: number }>(r: T): T => ({ ...r, x: h - r.y - r.h, y: w - r.x - r.w, w: r.h, h: r.w }),
  point: <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: h - p.y, y: w - p.x }),
});

function derivePiece(p: RoomPiece): RoomPiece {
  const g = mirror(p.sizeGrid.w, p.sizeGrid.h);
  const out: RoomPiece = {
    ...p,
    id: renameId(p.id),
    sizeGrid: { w: p.sizeGrid.h, h: p.sizeGrid.w },
    solids: p.solids.map(g.rect),
    spawns: {
      player: p.spawns.player.map(g.point),
      enemy: p.spawns.enemy.map((e) => ({ ...g.point(e), ...(e.type !== undefined ? { type: ROSTER[e.type] ?? e.type } : {}) })),
    },
    exits: p.exits.map((x) => ({ ...x, edge: EDGE[x.edge] as RoomPiece['exits'][number]['edge'] })),
  };
  if (p.tags) out.tags = p.tags.map((t) => (t === 'ember_l1' ? 'blight_l1' : t));
  if (p.pillars) out.pillars = p.pillars.map((c) => ({ ...c, center: g.point(c.center) }));
  if (p.props) out.props = p.props.map(g.point);
  if (p.chests) out.chests = p.chests.map(g.point);
  if (p.shops) out.shops = p.shops.map(g.point);
  return out;
}

function deriveFloor(f: DungeonFloorMap): DungeonFloorMap {
  const size = (id: string) => emberPiece(id).sizeGrid;
  const g = mirror(
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

describe('BLIGHT_DUNGEON is chapter 4', () => {
  it('declares 5 floors and carries an authored map for every one of them', () => {
    expect(BLIGHT_DUNGEON.floorCount).toBe(5);
    for (const i of FLOOR_INDICES) expect(BLIGHT_DUNGEON.floorMaps?.[i]).toBeDefined();
  });

  it('is its own biome, with its own piece tag and capstones resolved against its own library', () => {
    expect(BLIGHT_DUNGEON.biomeId).toBe('blight');
    expect(BLIGHT_DUNGEON.pieceTags).toEqual(['blight_l1']);
    expect(pieceFor(BLIGHT_DUNGEON.extractionPieceId).role).toBe('extraction');
    expect(pieceFor(BLIGHT_DUNGEON.bossPieceId).role).toBe('boss');
    // Nothing in chapter 4 may resolve into chapter 1's library (see the chapter-2 twin).
    const emberIds = new Set(EMBER_L1_ROOMS.map((p) => p.id));
    expect(BLIGHT_L1_ROOMS.filter((p) => emberIds.has(p.id))).toEqual([]);
  });

  it('is laid out differently from all three earlier chapters: no floor places its rooms where they do', () => {
    // The point of mirroring chapter 1 rather than copying it. A mirror that coincided with any
    // earlier chapter's layout would be a second copy of one map.
    const at = (m: DungeonFloorMap) => m.rooms.map((r) => `${r.offsetXGrid},${r.offsetYGrid}`).join(' ');
    for (const i of FLOOR_INDICES) {
      expect(at(floorAt(i))).not.toBe(at(EMBER_L1_FLOORS[i]!));
      expect(at(floorAt(i))).not.toBe(at(FROST_DUNGEON.floorMaps![i]!));
      expect(at(floorAt(i))).not.toBe(at(STORM_DUNGEON.floorMaps![i]!));
    }
  });

  it("is the hardest chapter past its entrance: chapters 2 and 3's entrance, the steepest step", () => {
    // The base cannot move: any step above 1.125 rounds the 3-HP basic mob up to 4 and walls
    // floor 0 (STORM_DUNGEON's doc comment). So the entrance matches chapters 2 and 3 and every
    // later floor is scaled above the same floor of every earlier chapter.
    expect(BLIGHT_DUNGEON.difficultyCurve.base).toBe(STORM_DUNGEON.difficultyCurve.base);
    expect(STORM_DUNGEON.difficultyCurve.base).toBe(FROST_DUNGEON.difficultyCurve.base);
    expect(BLIGHT_DUNGEON.difficultyCurve.perFloor).toBeGreaterThan(STORM_DUNGEON.difficultyCurve.perFloor);
  });

  it('wires the same three branch variants as chapter 1, plain layout first', () => {
    expect(Object.keys(BLIGHT_DUNGEON.floorLayoutVariants ?? {})).toEqual(Object.keys(EMBER_DUNGEON.floorLayoutVariants ?? {}));
    for (const [i, pool] of Object.entries(BLIGHT_DUNGEON.floorLayoutVariants ?? {})) expect(pool?.[0]).toBe(floorAt(Number(i)));
  });
});

describe('chapter 4 is still the transform of chapter 1 it was seeded as', () => {
  it.each(EMBER_L1_ROOMS.map((p) => [p.id, p] as const))('%s', (_, ember) => {
    expect(pieceFor(renameId(ember.id))).toEqual(derivePiece(ember));
  });

  it('every floor map, plain and branch', () => {
    for (const i of FLOOR_INDICES) expect(floorAt(i)).toEqual(deriveFloor(EMBER_L1_FLOORS[i]!));
    for (const [i, pool] of Object.entries(EMBER_DUNGEON.floorLayoutVariants ?? {})) {
      expect(BLIGHT_DUNGEON.floorLayoutVariants?.[Number(i)]?.[1]).toEqual(deriveFloor(pool![1]!));
    }
  });

  it('the library holds exactly the derived pieces, no more', () => {
    expect(BLIGHT_L1_ROOMS.map((p) => p.id).sort()).toEqual(EMBER_L1_ROOMS.map((p) => renameId(p.id)).sort());
  });
});

describe('chapter 4 garrison', () => {
  it('ends in its own boss, not a draw from the random pool', () => {
    const boss = pieceFor(BLIGHT_DUNGEON.bossPieceId);
    expect(boss.spawns.enemy[0]?.type).toBe('rotbloom');
    expect(ENEMY_BLUEPRINTS.rotbloom?.boss).toBe(true);
    expect(enemyTypes(BLIGHT_L1_ROOMS)).not.toContain('boss_random');
  });

  it('is poison-led: every chapter-1 emberling is a blightling, everything else unchanged', () => {
    const blight = enemyTypes(BLIGHT_L1_ROOMS);
    const ember = enemyTypes(EMBER_L1_ROOMS);
    expect(count(blight, 'blightling')).toBe(count(ember, 'emberling'));
    expect(count(blight, 'emberling')).toBe(0);
    // The leading element: more blightlings than any other elemental critter, and the others as
    // chapter 1 had them.
    for (const other of ['frostling', 'galvanist', 'ironclad']) {
      expect(count(blight, 'blightling'), other).toBeGreaterThan(count(blight, other));
      expect(count(blight, other), other).toBe(count(ember, other));
    }
  });

  it('names only blueprints that exist', () => {
    for (const t of enemyTypes(BLIGHT_L1_ROOMS)) expect(ENEMY_BLUEPRINTS[t], t).toBeDefined();
  });
});

const BRANCH_VARIANTS = [
  { index: 1, skippable: ['r3_span'] },
  { index: 2, skippable: ['r5_bastion'] },
  { index: 3, skippable: ['r4_rampart', 'b1_cache'] },
].map((v) => ({ ...v, map: BLIGHT_DUNGEON.floorLayoutVariants![v.index]![1]! }));

describeFloorPassability(
  [
    ...FLOOR_INDICES.map((i) => ({ name: `blight floor ${i}`, map: floorAt(i) })),
    ...BRANCH_VARIANTS.map((v) => ({ name: `blight floor ${v.index} branch`, map: v.map })),
  ],
  BLIGHT_L1_ROOMS,
);

describe.each(BRANCH_VARIANTS)("blight floor $index's branch variant", ({ map, skippable }) => {
  it('genuinely lets the named rooms be skipped, and nothing else', () => {
    const chain = map.rooms.slice(1, -1).map((r) => r.id);
    for (const id of chain) {
      const side = pieceFor(map.rooms.find((r) => r.id === id)!.pieceId).spawns.enemy.length === 0;
      if (skippable.includes(id)) expect(reachesCapstoneWithout(map, id), `${id} should be skippable`).toBe(true);
      else if (!side) expect(reachesCapstoneWithout(map, id), `${id} should be mandatory`).toBe(false);
    }
  });
});
