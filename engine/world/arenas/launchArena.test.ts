/**
 * The launch arena as a whole: the properties that make it a map rather than a data file.
 *
 * These are deliberately stated against the ASSEMBLED map and the shared metrics modules,
 * not against the plan — the plan is a drawing, and every defect the previous arena shipped
 * was a drawing that assembled into something else. `arenaMetrics`/`arenaGeometryMetrics`
 * are the same functions `npm run audit:arena` prints, so a number here and a number in the
 * report can never disagree.
 */
import { describe, it, expect } from 'vitest';
import { LAUNCH_ARENA, buildLaunchArena } from './launchArena';
import { DISTRICTS, DISTRICT_MAP, KIT_MAP, SPAWN_SLOTS, EYE_SLOTS } from './launchArenaPlan';
import { measureArena } from '../../content/arenaMetrics';
import { measureEnclosure, measurePlacement, solidCellSet } from '../../content/arenaGeometryMetrics';
import { buildArenaGeometry, type ArenaMap } from '../../content/arenas';
import { PLAYER_BASE } from '../../content/players';
import { WALL_NORTH_BRIM } from '../../config';
import { toFpGrid } from '../../content/convert';
import { measureBodyReach } from '../../content/arenaBodyReach';
import { measureBodyAccess } from '../../content/arenaBodyAccess';
import { auditArenaQuality } from '../../content/arenaQuality';
import { FP_SCALE } from '../../math/fixed';

const metrics = measureArena(LAUNCH_ARENA);
/** The map without its pocket fill: the control for everything the fill claims. */
const AS_AUTHORED = buildLaunchArena({ fillPockets: false });
const placement = measurePlacement(LAUNCH_ARENA);
const enclosure = measureEnclosure(LAUNCH_ARENA);

describe('the plan and the map agree', () => {
  it('has one room per non-empty slot', () => {
    const authored = DISTRICT_MAP.join('').split('').filter((c) => c !== '.').length;
    expect(authored).toBe(60);
    expect(LAUNCH_ARENA.rooms).toHaveLength(authored);
  });

  it('gives every room a unique id naming its district and slot', () => {
    const ids = LAUNCH_ARENA.rooms.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = Object.values(DISTRICTS).map((d) => d.name);
    for (const id of ids) expect(names).toContain(id.split('_')[0]);
  });

  it('is a pure function of the plan — rebuilding produces an identical map', () => {
    expect(buildLaunchArena()).toEqual(LAUNCH_ARENA);
  });

  it('places every room inside the map extent', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      const r = room.rectGrid;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(LAUNCH_ARENA.sizeGrid.w);
      expect(r.y + r.h).toBeLessThanOrEqual(LAUNCH_ARENA.sizeGrid.h);
    }
  });

  it('never overlaps two rooms', () => {
    const rects = LAUNCH_ARENA.rooms.map((r) => r.rectGrid);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap).toBe(false);
      }
    }
  });
});

/**
 * The defect class the previous map shipped. Every one of these is 0 there and 0 here — but
 * there it was 0 only because nothing measured it, and the metrics that do measure it were
 * pointed at this map first.
 */
describe('geometry is real', () => {
  it('walls every room and leaves no room unenclosed', () => {
    expect(enclosure.unenclosedRooms).toEqual([]);
    expect(enclosure.solidCells).toBeGreaterThan(2000);
    // A perimeter is never fully closed — a room with no opening would be unreachable — but
    // it is never mostly open either.
    expect(Math.min(...enclosure.perimeterCoverage)).toBeGreaterThan(0.5);
    expect(Math.max(...enclosure.perimeterCoverage)).toBeLessThan(1);
  });

  it('makes every door the only way between its two rooms', () => {
    expect(enclosure.doorsWithoutWalls).toBe(0);
    expect(enclosure.undoorLeaks).toBe(0);
  });

  it('authors every feature in room-relative space, so nothing lands outside its room', () => {
    expect(placement.outsideOwnRoom).toEqual([]);
    expect(placement.offMap).toEqual([]);
    // The counterweight: an empty finding list must mean "checked and clean", not "nothing
    // to check". Every feature kind this map uses has to be represented.
    for (const kind of ['pillar', 'loot', 'trait', 'enemySpawn', 'solid'] as const) {
      expect(placement.byFeature[kind].authored).toBeGreaterThan(0);
    }
  });

  it('never places loot, an enemy spawn or a drop point inside a solid', () => {
    const solids = solidCellSet(LAUNCH_ARENA);
    for (const room of LAUNCH_ARENA.rooms) {
      const abs = (p: { x: number; y: number }) => `${p.x + room.rectGrid.x},${p.y + room.rectGrid.y}`;
      for (const m of room.lootMarkers ?? []) expect(solids.has(abs(m.point))).toBe(false);
      for (const s of room.spawns ?? []) expect(solids.has(abs(s))).toBe(false);
    }
    for (const s of LAUNCH_ARENA.spawns) expect(solids.has(`${s.x},${s.y}`)).toBe(false);
  });

  // Missing a solid is a bullet-sized test; a player is a body. Volume 116 found mobs spawned
  // in five pockets no body can enter, two of them sealed only by a block's north brim, and a
  // crate in one of them. The builder now places content only where `arenaBodyReach` says a
  // body gets to; this is the check, and the second case is its control.
  it('never places loot, an enemy spawn or a drop point where no body can get to it', () => {
    const reach = measureBodyReach(buildArenaGeometry(LAUNCH_ARENA));
    const stranded: string[] = [];
    for (const room of LAUNCH_ARENA.rooms) {
      const ok = (p: { x: number; y: number }) => reach.reaches(toFpGrid(p.x + room.rectGrid.x), toFpGrid(p.y + room.rectGrid.y));
      (room.lootMarkers ?? []).forEach((m, i) => { if (!ok(m.point)) stranded.push(`${room.id} loot ${i}`); });
      (room.spawns ?? []).forEach((sp, i) => { if (!ok(sp)) stranded.push(`${room.id} spawn ${i}`); });
    }
    LAUNCH_ARENA.spawns.forEach((p, i) => { if (!reach.reaches(toFpGrid(p.x), toFpGrid(p.y))) stranded.push(`drop ${i}`); });
    expect(stranded).toEqual([]);
  });

  // The pockets themselves are stone since 2026-09-30 (`pocketFill.ts`). The shipped map has
  // no floor a body stands on but cannot get to; the map as authored, built without the fill,
  // is the control, so the first assertion has something to have removed. Volume 116's five
  // pockets were all chevron rooms, and the chevron no longer seals (the next case); what the
  // fill still closes is two slivers, catacombs_r5c4 (9 half-grid cells) and barracks_r5c8 (3).
  const pocketRooms = (map: ArenaMap) => {
    const reach = measureBodyReach(buildArenaGeometry(map));
    const half = FP_SCALE / 2;
    return map.rooms
      .filter((room) => {
        const { x, y, w, h } = room.rectGrid;
        for (let cy = Math.ceil((y * FP_SCALE) / half); cy <= ((y + h) * FP_SCALE) / half; cy++) {
          for (let cx = Math.ceil((x * FP_SCALE) / half); cx <= ((x + w) * FP_SCALE) / half; cx++) {
            const k = cy * reach.w + cx;
            if (reach.standable[k] && !reach.main[k]) return true;
          }
        }
        return false;
      })
      .map((room) => room.id)
      .sort();
  };

  it('has no floor a body can stand on but not get to: the pockets are stone', () => {
    expect(pocketRooms(LAUNCH_ARENA)).toEqual([]);
    expect(pocketRooms(AS_AUTHORED)).toEqual(['barracks_r5c8', 'catacombs_r5c4']);
  });

  // The catalog gate holds every future map to the same rule (`arenaBodyAccess.ts`). This map
  // without its fill is the real-content proof that it fires: each sliver is a second piece of
  // its room's floor.
  it('fails the catalog gate without its fill, on exactly the two sliver rooms', () => {
    expect(auditArenaQuality(LAUNCH_ARENA)).toEqual([]);
    expect(auditArenaQuality(AS_AUTHORED).map((v) => v.rule)).toEqual(['room_split']);
    expect(measureBodyAccess(AS_AUTHORED).splitRooms.map((r) => r.room).sort()).toEqual(['barracks_r5c8', 'catacombs_r5c4']);
  });

  // Reachable is not enough: a room whose floor is two pieces, joined only through other rooms,
  // is two rooms to a player, and a door that opens into the smaller one leads nowhere. Eight
  // chevron rooms, one rubble room and one ring room were built that way until 2026-09-30:
  // barracks_r2c7 and catacombs_r5c5 in halves (volume 116), five more as pockets, and the rest
  // found by this case. Pieces are counted over main-region lattice points inside the room's
  // closed rect, so a doorway counts with the room it opens into.
  const roomPieces = (map: ArenaMap) => {
    const reach = measureBodyReach(buildArenaGeometry(map));
    const half = FP_SCALE / 2;
    const out: Record<string, number> = {};
    for (const room of map.rooms) {
      const { x, y, w, h } = room.rectGrid;
      const [x0, y0, x1, y1] = [x, y, x + w, y + h].map((v) => (v * FP_SCALE) / half) as [number, number, number, number];
      const seen = new Set<number>();
      let pieces = 0;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const k = cy * reach.w + cx;
          if (!reach.main[k] || seen.has(k)) continue;
          pieces++;
          const stack = [k];
          seen.add(k);
          while (stack.length > 0) {
            const c = stack.pop()!;
            const px = c % reach.w;
            const py = (c - px) / reach.w;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = px + dx;
              const ny = py + dy;
              const j = ny * reach.w + nx;
              if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || !reach.main[j] || seen.has(j)) continue;
              seen.add(j);
              stack.push(j);
            }
          }
        }
      }
      if (pieces !== 1) out[room.id] = pieces;
    }
    return out;
  };

  it('keeps every room one piece: a body crosses it without leaving it', () => {
    expect(roomPieces(LAUNCH_ARENA)).toEqual({});
    // Control: the same count sees a bar laid wall to wall across one room.
    const room = LAUNCH_ARENA.rooms.find((r) => r.id === 'barracks_r2c7')!;
    const barred: ArenaMap = {
      ...LAUNCH_ARENA,
      rooms: LAUNCH_ARENA.rooms.map((r) =>
        r === room ? { ...r, solids: [...r.solids, { x: 1, y: 6, w: room.rectGrid.w - 2, h: 1 }] } : r,
      ),
    };
    const pieces = roomPieces(barred);
    expect(Object.keys(pieces)).toEqual(['barracks_r2c7']);
    expect(pieces.barracks_r2c7).toBeGreaterThan(1);
  });

  // Walkable is not visible. A free-standing block is drawn 70 px tall, north of its footprint
  // (the client's `WALL_H_INTERIOR`), so a two-row chevron lane (64 px) is covered by the lower
  // run's face, and where the runs overlap they read as one wall (`catacombs_r4c6`, found in the
  // client on 2026-09-30). Three rows leave 26 px of floor in view. A 9-row room has seven inner
  // rows: north strip, run, lane, run, south strip leave it two, so no 9-row room is a chevron
  // (its three were refurnished on 2026-09-30).
  it('keeps the chevron lane three rows, so its floor shows past the lower run', () => {
    const lanes: Record<string, number> = {};
    for (const room of LAUNCH_ARENA.rooms) {
      const [, r, c] = /_r(\d+)c(\d+)$/.exec(room.id)!.map(Number) as [number, number, number];
      if (KIT_MAP[r]![c] !== 'h') continue;
      const runs = room.solids.filter((s) => s.freeStanding && s.h === 1).map((s) => s.y);
      expect(runs).toHaveLength(2);
      lanes[room.id] = Math.abs(runs[1]! - runs[0]!) - 1;
    }
    expect(Object.keys(lanes).sort()).toEqual([
      'barracks_r2c7',
      'barracks_r3c8',
      'catacombs_r4c6',
      'catacombs_r5c5',
      'catacombs_r7c5',
    ]);
    for (const [id, n] of Object.entries(lanes)) expect(n, id).toBe(3);
  });

  it('fills only the pockets: no route, no standing place and no content moves', () => {
    const filled = measureBodyReach(buildArenaGeometry(LAUNCH_ARENA));
    const authored = measureBodyReach(buildArenaGeometry(AS_AUTHORED));
    // The main region, lattice point for lattice point.
    expect(filled.main).toEqual(authored.main);
    // Everything but the solids is the same map.
    const strip = (map: ArenaMap) => ({ ...map, rooms: map.rooms.map(({ solids: _s, ...rest }) => rest) });
    expect(strip(LAUNCH_ARENA)).toEqual(strip(AS_AUTHORED));
    // Only the seven rooms gained stone, and each kept its authored solids in front.
    const grew = LAUNCH_ARENA.rooms
      .filter((room, i) => room.solids.length !== AS_AUTHORED.rooms[i]!.solids.length)
      .map((room) => room.id)
      .sort();
    expect(grew).toEqual(pocketRooms(AS_AUTHORED));
    LAUNCH_ARENA.rooms.forEach((room, i) => {
      expect(room.solids.slice(0, AS_AUTHORED.rooms[i]!.solids.length)).toEqual(AS_AUTHORED.rooms[i]!.solids);
    });
  });

  // A mutation battery left "ignore the target cell, take the first free cell" alive: nothing
  // asserted that content goes WHERE it was aimed, only that it misses the walls. Loot is
  // aimed at the room's middle and enemies at its corners, and that difference is the whole
  // reason a vault pen has anything in it.
  it('aims loot at the middle of the room and enemies at its edges', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      const half = { x: room.rectGrid.w / 2, y: room.rectGrid.h / 2 };
      const centre = { x: (room.rectGrid.w - 1) / 2, y: (room.rectGrid.h - 1) / 2 };
      const offCentre = (p: { x: number; y: number }) =>
        Math.max(Math.abs(p.x - centre.x) / half.x, Math.abs(p.y - centre.y) / half.y);

      const loot = room.lootMarkers?.[0];
      expect(loot).toBeDefined();
      // Never out in the outermost fifth of the room — i.e. never shoved against a wall,
      // which is where "first free cell in scan order" would always put it.
      expect(offCentre(loot!.point)).toBeLessThanOrEqual(0.8);
    }
  });

  // Per ROOM the two aims can invert — a small room whose middle is walled pushes the loot
  // further out than a corner-seeking spawn lands. The claim that holds is distributional,
  // and it is the one the mutant breaks.
  it('separates those two aims across the map', () => {
    const mean = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;
    const fractions = (pick: (r: (typeof LAUNCH_ARENA.rooms)[number]) => { x: number; y: number }[]) =>
      LAUNCH_ARENA.rooms.flatMap((room) => {
        const half = { x: room.rectGrid.w / 2, y: room.rectGrid.h / 2 };
        const centre = { x: (room.rectGrid.w - 1) / 2, y: (room.rectGrid.h - 1) / 2 };
        return pick(room).map((p) =>
          Math.max(Math.abs(p.x - centre.x) / half.x, Math.abs(p.y - centre.y) / half.y),
        );
      });
    const loot = mean(fractions((r) => (r.lootMarkers ?? []).map((m) => m.point)));
    const spawns = mean(fractions((r) => r.spawns ?? []));
    expect(spawns).toBeGreaterThan(loot + 0.25);
  });

  it('never places content inside a pillar footprint either', () => {
    for (const room of LAUNCH_ARENA.rooms) {
      for (const pillar of room.pillars ?? []) {
        const reach = Math.ceil(pillar.radius);
        const content = [...(room.lootMarkers ?? []).map((m) => m.point), ...(room.spawns ?? [])];
        for (const p of content) {
          const inside =
            Math.abs(p.x - pillar.center.x) <= reach && Math.abs(p.y - pillar.center.y) <= reach;
          expect(inside).toBe(false);
        }
      }
      // Not a vacuous pass: this map's rooms really do carry both.
      if ((room.pillars ?? []).length > 0) expect((room.lootMarkers ?? []).length).toBeGreaterThan(0);
    }
  });

  it('builds real collision geometry through the engine own stitcher', () => {
    const geo = buildArenaGeometry(LAUNCH_ARENA);
    expect(geo.walls.length).toBeGreaterThan(400);
    expect(geo.obstacles.length).toBeGreaterThan(100);
  });
});

describe('the map is authored, not stamped', () => {
  it('varies room footprints', () => {
    expect(metrics.footprints.distinct).toBeGreaterThanOrEqual(20);
    // No single footprint may dominate — the previous map's was 100%.
    expect(metrics.footprints.dominantShare).toBeLessThan(0.2);
  });

  it('gives every room a different interior, by numbers AND by shape', () => {
    expect(metrics.interiors.distinct).toBe(60);
    // The distinction that caught the previous map: identical shapes at different offsets.
    expect(metrics.interiorShapes.distinct).toBe(60);
  });

  it('gives every room cover without filling it in', () => {
    expect(metrics.cover.roomsWithNoCover).toEqual([]);
    expect(Math.min(...metrics.cover.coverFractions)).toBeGreaterThan(0.1);
    expect(Math.max(...metrics.cover.coverFractions)).toBeLessThan(0.7);
  });

  it('differentiates its loot tables', () => {
    const tables = Object.keys(metrics.lootTables);
    expect(tables.length).toBeGreaterThanOrEqual(3);
    expect(tables).toContain('arena_vault');
  });

  it('populates roughly half its rooms with an encounter, from more than one script', () => {
    expect(metrics.encounters.rooms).toBeGreaterThan(20);
    expect(metrics.encounters.rooms).toBeLessThan(45);
    expect(metrics.encounters.distinct).toBeGreaterThan(3);
  });

  it('puts hazards in more than one district', () => {
    const hazardDistricts = new Set(
      LAUNCH_ARENA.rooms.filter((r) => (r.cellTraits ?? []).length > 0).map((r) => r.id.split('_')[0]),
    );
    expect(hazardDistricts.size).toBeGreaterThan(1);
  });
});

describe('the layout has decisions in it', () => {
  it('is connected, with no isolated room', () => {
    expect(metrics.graph.connected).toBe(true);
    expect(metrics.graph.isolated).toEqual([]);
  });

  it('is deep enough to cross but not a corridor', () => {
    expect(metrics.graph.diameter).toBeGreaterThanOrEqual(10);
    expect(metrics.graph.diameter).toBeLessThanOrEqual(25);
  });

  it('has real chokepoints, and they are a minority of rooms', () => {
    expect(metrics.graph.chokepoints.length).toBeGreaterThan(4);
    expect(metrics.graph.chokepoints.length).toBeLessThan(20);
  });

  it('has dead ends — pockets a fight can corner someone in', () => {
    expect(metrics.graph.deadEnds.length).toBeGreaterThan(2);
  });

  it('offers most rooms more than one way out', () => {
    const single = metrics.graph.degreeHistogram[1] ?? 0;
    expect(single / LAUNCH_ARENA.rooms.length).toBeLessThan(0.25);
  });
});

describe('the drop is fair, and the zone can reach everyone', () => {
  it('places one drop point per authored spawn slot, inside a room', () => {
    expect(LAUNCH_ARENA.spawns).toHaveLength(SPAWN_SLOTS.length);
    expect(metrics.spawns.orphans).toBe(0);
    expect(metrics.spawns.colliding).toBe(0);
  });

  // The check that actually moved the map: a first draft put two seats four hops apart on
  // paper and TWO through the foundry->catacombs artery.
  it('never drops two seats within three door hops of each other', () => {
    expect(metrics.spawns.minPairHops).toBeGreaterThanOrEqual(4);
  });

  it('spreads the drop across the map rather than one district', () => {
    const districts = new Set(SPAWN_SLOTS.map((ref) => {
      const room = LAUNCH_ARENA.rooms.find((r) => r.id.endsWith(`_${ref}`));
      return room?.id.split('_')[0];
    }));
    expect(districts.size).toBeGreaterThanOrEqual(5);
    expect(metrics.spawns.maxPairHops).toBeGreaterThan(metrics.spawns.minPairHops * 2);
  });

  it('never starts a seat in the atrium — the eye of the zone', () => {
    for (const ref of SPAWN_SLOTS) {
      const room = LAUNCH_ARENA.rooms.find((r) => r.id.endsWith(`_${ref}`));
      expect(room?.id.startsWith('atrium')).toBe(false);
    }
  });

  it('offers eye candidates weighted toward the atrium but not confined to it', () => {
    expect(LAUNCH_ARENA.eyeCandidates).toHaveLength(EYE_SLOTS.length);
    const atrium = LAUNCH_ARENA.eyeCandidates.filter((c) => c.roomId.startsWith('atrium'));
    expect(atrium.length).toBeGreaterThan(0);
    expect(atrium.length).toBeLessThan(LAUNCH_ARENA.eyeCandidates.length);
    const atriumWeight = atrium.reduce((sum, c) => sum + (c.weight ?? 1), 0);
    const total = LAUNCH_ARENA.eyeCandidates.reduce((sum, c) => sum + (c.weight ?? 1), 0);
    expect(atriumWeight / total).toBeGreaterThan(0.6);
  });

  it('leaves no room stranded far from every possible final circle', () => {
    expect(metrics.maxHopsToEye).toBeLessThanOrEqual(8);
  });

  it("marks the kits' blocks free-standing, and ONLY those, all the way onto the built map", () => {
    // The v47 north brim (`config.WALL_NORTH_BRIM`) does nothing at all unless the flag survives
    // `furnish` -> `roomGeometry` -> `buildArenaGeometry`, and a flag that quietly arrived `false`
    // everywhere would still leave every test above green — this map has shipped that exact class
    // of defect before (58 of 74 passages with a clip rule that was dead code). So assert it on
    // the ASSEMBLED geometry, the same arrays `state.walls` is built from.
    const geo = buildArenaGeometry(LAUNCH_ARENA);
    const flagged = geo.walls.filter((w) => w.freeStanding);
    expect(flagged.length).toBeGreaterThan(20); // real coverage, not one stray room
    expect(flagged.length).toBeLessThan(geo.walls.length); // and never the perimeter ring

    // Every flagged rect is strictly INSIDE some room's inner floor — that is what
    // "free-standing" claims, and a perimeter segment that leaked the flag would fail here.
    for (const w of flagged) {
      const room = LAUNCH_ARENA.rooms.find((r) => {
        const x0 = toFpGrid(r.rectGrid.x + 1);
        const y0 = toFpGrid(r.rectGrid.y + 1);
        const x1 = toFpGrid(r.rectGrid.x + r.rectGrid.w - 1);
        const y1 = toFpGrid(r.rectGrid.y + r.rectGrid.h - 1);
        return w.x >= x0 && w.y >= y0 && w.x + w.w <= x1 && w.y + w.h <= y1;
      });
      expect(room).toBeDefined();
    }
  });
});

/**
 * The one way the v47 north brim could do real damage: it makes 16 px of floor north of every
 * free-standing block unstandable, and floor that was *only just* wide enough before is floor
 * that is sealed now. A player needs `2 * solidRadius` (32 px = one grid cell) to pass between two
 * solids; north of a free-standing block they now need `2 * solidRadius + WALL_NORTH_BRIM` (48 px).
 *
 * Asserted on the ASSEMBLED map rather than reasoned about from the kit functions: a kit is a
 * function of the room's inner size and the map instantiates 60 of them at sizes the kit author
 * never enumerated — which is how this map shipped 90 of 120 features off the board once already.
 */
describe('what the north brim costs the launch map', () => {
  const geo = buildArenaGeometry(LAUNCH_ARENA);
  const R = PLAYER_BASE.solidRadius; // the player is the widest thing that has to fit
  // Plain numbers, not `Fp`: this whole block is a rasterizer doing arithmetic on coordinates, and
  // the fp brand exists to stop exactly that from happening by accident in the SIM. Converting once
  // here keeps the brand meaningful everywhere it matters instead of casting at twenty call sites.
  const roomsFp = LAUNCH_ARENA.rooms.map((r) => ({
    id: r.id,
    x: toFpGrid(r.rectGrid.x) as number, y: toFpGrid(r.rectGrid.y) as number,
    w: toFpGrid(r.rectGrid.w) as number, h: toFpGrid(r.rectGrid.h) as number,
  }));

  /**
   * Standable floor, rasterized at 8 px, as connected regions.
   *
   * Deliberately crude, and only ever read as a DIFFERENCE between two calls: the absolute counts
   * are artifacts of the raster (a cell is blocked if a solid's bounding square expanded by the
   * player radius covers it, which over-blocks at every rounded corner), so "45 regions" is a
   * statement about this function, NOT a claim that the map has 45 disconnected pieces. What the
   * raster is exact about is the comparison — both calls over-block identically, so anything that
   * moves between them moved because of the brim.
   */
  function floorRegions(brim: number): { cells: number; regions: number; reachedRooms: string[] } {
    const STEP: number = toFpGrid(0.25); // 8 px
    const minX = Math.min(...roomsFp.map((r) => r.x));
    const minY = Math.min(...roomsFp.map((r) => r.y));
    const nx = Math.ceil((Math.max(...roomsFp.map((r) => r.x + r.w)) - minX) / STEP) + 1;
    const ny = Math.ceil((Math.max(...roomsFp.map((r) => r.y + r.h)) - minY) / STEP) + 1;
    const at = (ix: number, iy: number) => iy * nx + ix;
    const ixOf = (x: number) => Math.round((x - minX) / STEP);
    const iyOf = (y: number) => Math.round((y - minY) / STEP);
    const open = new Uint8Array(nx * ny);
    for (const r of roomsFp) {
      for (let y = r.y; y < r.y + r.h; y += STEP) for (let x = r.x; x < r.x + r.w; x += STEP) open[at(ixOf(x), iyOf(y))] = 1;
    }
    const blockBox = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let iy = Math.max(0, Math.ceil((y0 - minY) / STEP)); iy <= Math.min(ny - 1, Math.floor((y1 - minY) / STEP)); iy++) {
        for (let ix = Math.max(0, Math.ceil((x0 - minX) / STEP)); ix <= Math.min(nx - 1, Math.floor((x1 - minX) / STEP)); ix++) open[at(ix, iy)] = 0;
      }
    };
    for (const w of geo.walls) blockBox(w.x - R, (w.freeStanding ? w.y - brim : w.y) - R, w.x + w.w + R, w.y + w.h + R);
    for (const o of geo.obstacles) blockBox(o.gx - o.radius - R, o.gy - o.radius - R, o.gx + o.radius + R, o.gy + o.radius + R);

    const seen = new Uint8Array(nx * ny);
    let regions = 0;
    let cells = 0;
    let bestSize = -1;
    let best: number[] = [];
    for (let i = 0; i < open.length; i++) {
      if (!open[i] || seen[i]) continue;
      regions++;
      const stack = [i];
      const members: number[] = [];
      seen[i] = 1;
      while (stack.length > 0) {
        const c = stack.pop()!;
        members.push(c);
        cells++;
        const ix = c % nx;
        const iy = (c / nx) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const jx = ix + dx;
          const jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          const j = at(jx, jy);
          if (open[j] === 1 && seen[j] === 0) { seen[j] = 1; stack.push(j); }
        }
      }
      if (members.length > bestSize) { bestSize = members.length; best = members; }
    }
    const inBest = new Set(best);
    const reachedRooms = roomsFp
      .filter((r) => {
        for (let y = r.y; y < r.y + r.h; y += STEP) for (let x = r.x; x < r.x + r.w; x += STEP) {
          if (inBest.has(at(ixOf(x), iyOf(y)))) return true;
        }
        return false;
      })
      .map((r) => r.id);
    return { cells, regions, reachedRooms };
  }

  const without = floorRegions(0);
  const withBrim = floorRegions(WALL_NORTH_BRIM);

  it('removes floor but never a ROUTE — same regions, same rooms reachable', () => {
    // The gate. A brim that sealed a corridor would split a region in two or drop a room out of
    // the largest one, and neither happens: what it removes is floor along a wall's north face,
    // which is floor already painted as stone.
    expect(withBrim.regions).toBe(without.regions);
    expect(withBrim.reachedRooms).toEqual(without.reachedRooms);
    // ...and the comparison is only meaningful if the raster found a real map to begin with.
    expect(without.regions).toBeGreaterThan(0);
    expect(without.reachedRooms.length).toBeGreaterThan(20);
  });

  it('costs about 3% of standable floor, and that number is now bounded', () => {
    // Measured 3.4%. The bound is what turns a future edit into a failure rather than a slow
    // leak: raise `WALL_NORTH_BRIM`, or author a kit that packs blocks tighter, and the floor this
    // quietly eats shows up here instead of in a playtest.
    const lost = (without.cells - withBrim.cells) / without.cells;
    expect(lost).toBeGreaterThan(0); // it does cost something — not a no-op wired up wrong
    expect(lost).toBeLessThan(0.05);
  });

  it('narrows 2 gaps past the player, and each is a CORNER, not a corridor', () => {
    // The pairs where a channel that took exactly one grid cell no longer fits a body. Sealing one
    // is only acceptable because of the shape: it overlaps in x by a single cell, so it is the
    // diagonal notch where two blocks nearly touch at a corner — the player walks one cell aside
    // and past. A pair overlapping by more than that would be a real passage, and is what this
    // assertion exists to catch if a kit is ever retuned.
    //
    // A gap something else already stands in is no channel. This read 7 until 2026-09-30: six of
    // them were a block one cell below a room's own north wall, measured against the NEXT room's
    // wall behind it, or a gap a pillar stands in. The pocket fill (volume 118) added two more
    // of the same kind, which is how the other six were found.
    const pinches: Array<{ where: string; overlap: number }> = [];
    for (const w of geo.walls) {
      if (!w.freeStanding) continue;
      for (const o of geo.walls) {
        if (o === w || !(o.x < w.x + w.w && o.x + o.w > w.x)) continue;
        const gap = w.y - (o.y + o.h);
        if (gap < 2 * R || gap >= 2 * R + WALL_NORTH_BRIM) continue;
        const x0 = Math.max(w.x, o.x);
        const x1 = Math.min(w.x + w.w, o.x + o.w);
        const y0 = o.y + o.h;
        const y1 = w.y;
        const occupied =
          geo.walls.some((q) => q !== w && q !== o && q.x < x1 && q.x + q.w > x0 && q.y < y1 && q.y + q.h > y0) ||
          geo.obstacles.some((p) => {
            const dx = p.gx - Math.max(x0, Math.min(p.gx, x1));
            const dy = p.gy - Math.max(y0, Math.min(p.gy, y1));
            return dx * dx + dy * dy < p.radius * p.radius;
          });
        if (occupied) continue;
        pinches.push({
          where: `(${w.x},${w.y}) vs (${o.x},${o.y})`,
          overlap: Math.min(w.x + w.w, o.x + o.w) - Math.max(w.x, o.x),
        });
      }
    }
    // The second is `barracks_r1c8`'s rubble (2026-09-30), the same one-cell corner notch.
    expect(pinches).toHaveLength(2);
    expect(pinches.filter((p) => p.overlap > toFpGrid(1))).toEqual([]);
  });
});
