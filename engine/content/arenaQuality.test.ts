/**
 * The gate's own tests. Two halves, and the second is the one that makes the first mean
 * anything:
 *
 *  1. the shipped map clears the bar — WITH the distance between each bound and its score,
 *     so a threshold quietly retuned onto the current content fails here rather than passing
 *     silently. This is the "do not transcribe the map's score" rule, enforced.
 *  2. every rule FIRES on content that deserves it. A gate whose rules cannot be reached is
 *     a green rubber stamp; this repo has shipped an "asserts coverage" sweep that was
 *     vacuous, so each rule below gets a map built to trip it, and where the fixture isolates
 *     exactly one rule the assertion is an EQUALITY — a bound that fires on everything is no
 *     bound, and `toContain` alone would not notice.
 *
 * The defect fixtures are `arena_prototype_60`'s real failures (deleted 2026-08-26, its
 * numbers in ROADMAP's "The Seven Districts" table): `solids: []` everywhere, so its doors
 * gated nothing, and markers authored in absolute space landing outside their own room.
 */
import { describe, it, expect } from 'vitest';
import type { ArenaMap, ArenaRoom } from './arenas';
import { LAUNCH_ARENA } from '../world/arenas';
import { measureArena } from './arenaMetrics';
import { measureEnclosure } from './arenaGeometryMetrics';
import { ARENA_QUALITY_BOUNDS, auditArenaQuality, formatViolations } from './arenaQuality';

/** A room walled on all four sides, with a pillar for cover, at an arbitrary offset.
 *  `solids` and `pillars` are room-RELATIVE (the coordinate space `arena_prototype_60`
 *  got wrong) — see `arenas.ts`'s `roomGeometry`. */
function walledRoom(id: string, x: number, y: number, w = 10, h = 10): ArenaRoom {
  return {
    id,
    rectGrid: { x, y, w, h },
    solids: [
      { x: 0, y: 0, w, h: 1 },
      { x: 0, y: h - 1, w, h: 1 },
      { x: 0, y: 0, w: 1, h },
      { x: w - 1, y: 0, w: 1, h },
    ],
    pillars: [{ center: { x: Math.floor(w / 2), y: Math.floor(h / 2) }, radius: 1 }],
  };
}

/**
 * Seven rooms that clear every bound, as the base every defect fixture mutates.
 *
 * Every footprint is a DIFFERENT size on purpose: a base map whose rooms were uniform would
 * sit on the wrong side of `stamped_rooms`, and then every fixture below would be asserting
 * against a violation it did not introduce. Same reason the graph is four rooms of degree 3
 * with a two-room tail rather than a tidy ring — a ring is all degree 2 (no branching) and
 * only two hops across (too shallow), so the tidy shape fails two bounds at once.
 */
function healthyMap(): ArenaMap {
  return {
    id: 'fixture_healthy',
    sizeGrid: { w: 60, h: 60 },
    rooms: [
      walledRoom('a', 0, 0, 10, 10),
      walledRoom('b', 20, 0, 12, 10),
      walledRoom('c', 0, 20, 10, 14),
      walledRoom('d', 20, 20, 14, 12),
      walledRoom('e', 40, 10, 11, 10),
      walledRoom('f', 40, 30, 10, 11),
      walledRoom('g', 0, 40, 12, 11),
    ],
    doors: [
      { roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 4, w: 10, h: 2 } },
      { roomA: 'a', roomB: 'c', passageGrid: { x: 4, y: 10, w: 2, h: 10 } },
      { roomA: 'c', roomB: 'd', passageGrid: { x: 10, y: 24, w: 10, h: 2 } },
      { roomA: 'b', roomB: 'd', passageGrid: { x: 24, y: 10, w: 2, h: 10 } },
      { roomA: 'b', roomB: 'e', passageGrid: { x: 32, y: 14, w: 8, h: 2 } },
      { roomA: 'd', roomB: 'e', passageGrid: { x: 34, y: 18, w: 6, h: 2 } },
      { roomA: 'e', roomB: 'f', passageGrid: { x: 44, y: 20, w: 2, h: 10 } },
      { roomA: 'c', roomB: 'g', passageGrid: { x: 4, y: 34, w: 2, h: 6 } },
    ],
    // Rooms 'a' and 'f' — three hops apart, comfortably clear of the adjacency bound.
    spawns: [{ x: 4, y: 4 }, { x: 44, y: 34 }],
    eyeCandidates: [{ roomId: 'a' }, { roomId: 'd' }, { roomId: 'f' }],
  };
}

/** Six rooms in a line, every footprint distinct so only the graph shape is on trial. */
function chainMap(): ArenaMap {
  const sizes: Array<[number, number]> = [[10, 10], [11, 10], [10, 11], [12, 10], [10, 12], [11, 11]];
  return {
    id: 'fixture_chain',
    sizeGrid: { w: 90, h: 30 },
    rooms: sizes.map(([w, h], i) => walledRoom(`r${i}`, i * 14, 0, w, h)),
    doors: [0, 1, 2, 3, 4].map((i) => ({
      roomA: `r${i}`, roomB: `r${i + 1}`, passageGrid: { x: i * 14 + 12, y: 4, w: 2, h: 2 },
    })),
    spawns: [{ x: 4, y: 4 }, { x: 74, y: 4 }],
    eyeCandidates: [{ roomId: 'r0' }, { roomId: 'r5' }],
  };
}

const rules = (map: ArenaMap): string[] => auditArenaQuality(map).map((v) => v.rule).sort();

describe('the arena quality gate — the shipped map clears it, with headroom', () => {
  it('passes `arena_launch` with no violations at all', () => {
    const violations = auditArenaQuality(LAUNCH_ARENA);
    expect(formatViolations(violations)).toBe('  (clears the bar)');
    expect(violations).toEqual([]);
  });

  it('and clears every DESIGN bound by a real margin, not by a hair', () => {
    // The anti-transcription check. If a future edit tunes a bound down onto whatever the
    // map happens to score, the margin collapses and this fails — which is the whole reason
    // the bounds are exported as values rather than inlined at their comparison.
    const m = measureArena(LAUNCH_ARENA);
    const e = measureEnclosure(LAUNCH_ARENA);
    const B = ARENA_QUALITY_BOUNDS;

    const dominant = Math.max(m.footprints.dominantShare, m.interiorShapes.dominantShare);
    expect(dominant).toBeLessThan(B.maxDominantShare / 2); // 0.067 vs a 0.5 bound

    expect(m.cover.roomsWithNoCover.length / m.roomCount).toBe(0); // bound 0.1

    const median = m.cover.coverFractions[Math.floor(m.cover.coverFractions.length / 2)]!;
    expect(median).toBeGreaterThan(B.minMedianCoverFraction * 3); // 0.333 vs 0.05
    expect(median).toBeLessThan(B.maxMedianCoverFraction / 1.5); // 0.333 vs 0.7

    expect(m.spawns.minPairHops).toBeGreaterThanOrEqual(B.minSpawnPairHops * 2); // 4 vs 2
    expect(m.graph.diameter).toBeGreaterThan(B.minDiameter * 3); // 15 vs 3

    const branching = Object.entries(m.graph.degreeHistogram)
      .filter(([deg]) => Number(deg) >= 3)
      .reduce((n, [, c]) => n + c, 0) / m.roomCount;
    expect(branching).toBeGreaterThan(B.minBranchingShare * 3); // 0.52 vs 0.1

    expect(m.eyeCandidates).toBeGreaterThan(B.minEyeCandidates * 3); // 14 vs 2
    expect(e.perimeterCoverage[0]!).toBeGreaterThan(B.minPerimeterCoverage * 1.2); // 0.667 vs 0.5
  });

  it('and both fixtures the defect cases are built from clear it too', () => {
    // Load-bearing: every case below mutates ONE thing off one of these, so if a base itself
    // had a violation, those tests would be asserting against noise.
    expect(auditArenaQuality(healthyMap())).toEqual([]);
    // The chain is the ONE exception, and it is deliberate — it exists to trip `no_branching`.
    expect(rules(chainMap())).toEqual(['no_branching']);
  });
});

describe('the arena quality gate — every rule fires on content that deserves it', () => {
  it('`no_walls` + `door_gates_nothing` + `unenclosed_room`: prototype_60s empty solids', () => {
    // The exact shape of the deleted prototype: rooms and doors that exist only in the data.
    const map = healthyMap();
    map.rooms = map.rooms.map((r) => ({ ...r, solids: [], pillars: [] }));
    const fired = rules(map);
    expect(fired).toContain('no_walls');
    expect(fired).toContain('door_gates_nothing');
    expect(fired).toContain('unenclosed_room');
    // ...and the cover rules too, since removing the pillars removed the cover. Named
    // rather than tolerated, so this stays a statement about what the fixture is.
    expect(fired).toContain('rooms_without_cover');
    expect(fired).toContain('cover_too_sparse');
  });

  it('`content_outside_room`: a marker authored in absolute space', () => {
    const map = healthyMap();
    // Room 'd' sits at (20,20); a loot marker authored as if `point` were absolute lands
    // outside its own room, which is prototype_60's second defect verbatim.
    map.rooms[3] = { ...map.rooms[3]!, lootMarkers: [{ point: { x: 24, y: 24 }, tableId: 'arena_common' }] };
    expect(rules(map)).toEqual(['content_outside_room']);
  });

  it('`content_off_map`: a marker past the map extent', () => {
    const map = healthyMap();
    map.rooms[0] = { ...map.rooms[0]!, lootMarkers: [{ point: { x: 500, y: 500 }, tableId: 'arena_common' }] };
    // Off the map is also outside its own room, so both fire — the pair IS the finding.
    expect(rules(map)).toEqual(['content_off_map', 'content_outside_room']);
  });

  it('`graph_disconnected` + `room_unreachable` + `zone_unreachable`: a room with no door', () => {
    const map = healthyMap();
    // NOT added to `eyeCandidates` — a room that is its own eye candidate is zero hops from
    // one, which would hide `zone_unreachable` behind the very defect being tested.
    map.rooms.push(walledRoom('orphan', 40, 45, 10, 10));
    const fired = rules(map);
    expect(fired).toEqual(['graph_disconnected', 'room_unreachable', 'zone_unreachable']);
  });

  it('`no_spawns`: a map a real match cannot start on', () => {
    const map = healthyMap();
    map.spawns = [];
    expect(rules(map)).toEqual(['no_spawns']); // and nothing else moved
  });

  it('`spawn_outside_room` and `spawn_shared_room` are distinct findings', () => {
    const orphaned = healthyMap();
    orphaned.spawns = [{ x: 55, y: 55 }, { x: 24, y: 24 }];
    expect(rules(orphaned)).toContain('spawn_outside_room');

    const shared = healthyMap();
    shared.spawns = [{ x: 4, y: 4 }, { x: 5, y: 5 }]; // both inside room 'a'
    expect(rules(shared)).toContain('spawn_shared_room');
  });

  it('`spawns_too_close`: two seats in adjacent rooms — and the far pair stays silent', () => {
    const map = healthyMap();
    map.spawns = [{ x: 4, y: 4 }, { x: 24, y: 4 }]; // rooms 'a' and 'b', one hop apart
    expect(rules(map)).toEqual(['spawns_too_close']);
    // The bound is "not adjacent", so the same map with a far room must be silent —
    // the boundary asserted in BOTH directions rather than only on the failing side.
    const ok = healthyMap();
    ok.spawns = [{ x: 4, y: 4 }, { x: 44, y: 14 }]; // rooms 'a' and 'e', two hops
    expect(measureArena(ok).spawns.minPairHops).toBeGreaterThanOrEqual(ARENA_QUALITY_BOUNDS.minSpawnPairHops);
    expect(rules(ok)).toEqual([]);
  });

  it('`stamped_rooms`: one footprint repeated across the map', () => {
    const map = healthyMap();
    // Every room the same 10x10 footprint — `arena_prototype_60`'s headline number (1.0).
    map.rooms = map.rooms.map((r) => walledRoom(r.id, r.rectGrid.x, r.rectGrid.y, 10, 10));
    expect(rules(map)).toEqual(['stamped_rooms']);
  });

  it('`cover_too_sparse` and `cover_too_dense` are a band, not a floor', () => {
    // Rooms big enough that a one-cell wall ring is a small share of their own floor —
    // 396 cells of 10,000 — with no interior cover at all.
    const sparse: ArenaMap = {
      ...healthyMap(),
      sizeGrid: { w: 400, h: 400 },
      rooms: [
        { ...walledRoom('a', 0, 0, 100, 100), pillars: [] },
        { ...walledRoom('b', 150, 0, 101, 100), pillars: [] },
        { ...walledRoom('c', 0, 150, 100, 101), pillars: [] },
      ],
      doors: [
        { roomA: 'a', roomB: 'b', passageGrid: { x: 100, y: 40, w: 50, h: 2 } },
        { roomA: 'a', roomB: 'c', passageGrid: { x: 40, y: 100, w: 2, h: 50 } },
      ],
      spawns: [{ x: 40, y: 40 }, { x: 190, y: 40 }],
      eyeCandidates: [{ roomId: 'a' }, { roomId: 'b' }],
    };
    expect(rules(sparse)).toContain('cover_too_sparse');
    // ...and NOT `rooms_without_cover`, which is a different claim: these rooms have their
    // wall ring authored, so cover EXISTS and is merely a tiny share of a huge floor. The
    // two rules would be redundant if either one implied the other.
    expect(rules(sparse)).not.toContain('rooms_without_cover');

    // Filled solid except a one-cell channel: a maze, not an arena.
    const dense = healthyMap();
    dense.rooms = dense.rooms.map((r) => ({
      ...r,
      solids: [{ x: 0, y: 0, w: r.rectGrid.w, h: r.rectGrid.h - 1 }],
      pillars: [],
    }));
    expect(rules(dense)).toContain('cover_too_dense');
  });

  it('`map_too_shallow`: two rooms and one door', () => {
    const map: ArenaMap = {
      id: 'fixture_shallow',
      sizeGrid: { w: 40, h: 20 },
      rooms: [walledRoom('a', 0, 0, 10, 10), walledRoom('b', 20, 0, 11, 10)],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 4, w: 10, h: 2 } }],
      spawns: [{ x: 4, y: 4 }],
      eyeCandidates: [{ roomId: 'a' }, { roomId: 'b' }],
    };
    const fired = rules(map);
    expect(fired).toContain('map_too_shallow');
    expect(fired).toContain('no_branching');
    // A one-seat map must NOT trip the spawn-separation rule — `minPairHops` is +Infinity
    // with nothing to pair, and a bound that fired there would be reading a sentinel.
    expect(fired).not.toContain('spawns_too_close');
  });

  it('`no_branching` fires on a CHAIN even when it is deep enough', () => {
    // The reason this rule exists rather than a diameter ceiling: a 6-room corridor has a
    // perfectly healthy diameter and plays as one hallway.
    const map = chainMap();
    expect(rules(map)).toEqual(['no_branching']);
    expect(measureArena(map).graph.diameter).toBeGreaterThanOrEqual(ARENA_QUALITY_BOUNDS.minDiameter);
  });

  it('`zone_has_no_choices`: a single eye candidate', () => {
    const map = healthyMap();
    map.eyeCandidates = [{ roomId: 'a' }];
    expect(rules(map)).toEqual(['zone_has_no_choices']);
  });

  it('`room_barely_walled`: a room missing most of its boundary', () => {
    const map = healthyMap();
    map.rooms[2] = { ...map.rooms[2]!, solids: [{ x: 0, y: 0, w: 3, h: 1 }] };
    expect(rules(map)).toContain('room_barely_walled');
  });

  it('`undoored_leak`: two rooms sharing an open edge with no door between them', () => {
    // The rule's own subject, and the one shape the other fixtures never produce: rooms are
    // ADJACENT (no gap) and the shared edge carries neither a wall nor a door.
    const map = healthyMap();
    map.rooms = [
      // 'a' with no east wall, 'h' butted straight against it with no west wall.
      { ...walledRoom('a', 0, 0, 10, 10), solids: walledRoom('a', 0, 0, 10, 10).solids.slice(0, 3) },
      { ...walledRoom('h', 10, 0, 11, 10), solids: walledRoom('h', 10, 0, 11, 10).solids.filter((s) => s.x === 0 ? false : true).slice(0, 3) },
      walledRoom('c', 0, 20, 10, 14),
    ];
    map.doors = [{ roomA: 'a', roomB: 'c', passageGrid: { x: 4, y: 10, w: 2, h: 10 } }];
    map.spawns = [{ x: 4, y: 4 }, { x: 4, y: 24 }];
    map.eyeCandidates = [{ roomId: 'a' }, { roomId: 'c' }];
    expect(rules(map)).toContain('undoored_leak');
  });

  // The two body-reach rules (`arenaBodyAccess.ts`). `arena_launch` shipped both until
  // 2026-09-30: floor sealed off inside a room, mobs spawned in it, and rooms in two halves.
  it('`room_split`: a bar laid wall to wall across one room', () => {
    const map = healthyMap();
    map.rooms[3] = { ...map.rooms[3]!, solids: [...map.rooms[3]!.solids, { x: 1, y: 6, w: 12, h: 1 }] };
    expect(rules(map)).toEqual(['room_split']);
    // One short of the far wall, a body walks round the end of it: one piece again.
    map.rooms[3] = { ...map.rooms[3]!, solids: [...healthyMap().rooms[3]!.solids, { x: 1, y: 6, w: 10, h: 1 }] };
    expect(rules(map)).toEqual([]);
  });

  it('`content_unreached`: loot in the middle of a block, and not loot beside it', () => {
    const map = healthyMap();
    const block = { x: 2, y: 2, w: 4, h: 4 };
    map.rooms[3] = { ...map.rooms[3]!, solids: [...map.rooms[3]!.solids, block], lootMarkers: [{ point: { x: 4, y: 4 }, tableId: 'arena_common' }] };
    expect(rules(map)).toEqual(['content_unreached']);
    // Against the block's face is reached: a body stands a grid off it.
    map.rooms[3] = { ...map.rooms[3]!, lootMarkers: [{ point: { x: 6, y: 4 }, tableId: 'arena_common' }] };
    expect(rules(map)).toEqual([]);
  });

  it('`room_split` + `content_unreached`: a mob spawned in a pocket sealed inside its room', () => {
    // The volume 116 shape: standable floor no door leads to, and something placed on it.
    const map = healthyMap();
    const ring = [{ x: 2, y: 2, w: 5, h: 1 }, { x: 2, y: 6, w: 5, h: 1 }, { x: 2, y: 2, w: 1, h: 5 }, { x: 6, y: 2, w: 1, h: 5 }];
    map.rooms[3] = { ...map.rooms[3]!, solids: [...map.rooms[3]!.solids, ...ring], spawns: [{ x: 4, y: 4 }] };
    expect(rules(map)).toEqual(['content_unreached', 'room_split']);
  });

  it('`content_unreached` checks drop points too, against the room that holds them', () => {
    const map = healthyMap();
    map.rooms[0] = { ...map.rooms[0]!, solids: [...map.rooms[0]!.solids, { x: 2, y: 2, w: 5, h: 5 }] };
    expect(auditArenaQuality(map).map((v) => v.detail)).toEqual([expect.stringContaining('a drop -> (4, 4)')]);
  });

  it('every rule the gate can emit is covered by a case above', () => {
    // The sweep's own completeness check. Both directions: nothing in the list went
    // unreached, and nothing was emitted that the list does not name (which would mean a
    // rule was added to the gate without a case here).
    const emitted = new Set<string>();
    const collect = (m: ArenaMap) => auditArenaQuality(m).forEach((v) => emitted.add(v.rule));

    const empty = healthyMap();
    empty.rooms = empty.rooms.map((r) => ({ ...r, solids: [], pillars: [] }));
    collect(empty);
    const absolute = healthyMap();
    absolute.rooms[3] = { ...absolute.rooms[3]!, lootMarkers: [{ point: { x: 24, y: 24 }, tableId: 'arena_common' }] };
    collect(absolute);
    const offMap = healthyMap();
    offMap.rooms[0] = { ...offMap.rooms[0]!, lootMarkers: [{ point: { x: 500, y: 500 }, tableId: 'arena_common' }] };
    collect(offMap);
    const orphanRoom = healthyMap();
    orphanRoom.rooms.push(walledRoom('orphan', 40, 45, 10, 10));
    collect(orphanRoom);
    const noSpawn = healthyMap(); noSpawn.spawns = []; collect(noSpawn);
    const outside = healthyMap(); outside.spawns = [{ x: 55, y: 55 }, { x: 24, y: 24 }]; collect(outside);
    const shared = healthyMap(); shared.spawns = [{ x: 4, y: 4 }, { x: 5, y: 5 }]; collect(shared);
    const close = healthyMap(); close.spawns = [{ x: 4, y: 4 }, { x: 24, y: 4 }]; collect(close);
    const stamped = healthyMap();
    stamped.rooms = stamped.rooms.map((r) => walledRoom(r.id, r.rectGrid.x, r.rectGrid.y, 10, 10));
    collect(stamped);
    const sparse: ArenaMap = {
      ...healthyMap(),
      sizeGrid: { w: 400, h: 400 },
      rooms: [
        { ...walledRoom('a', 0, 0, 100, 100), pillars: [] },
        { ...walledRoom('b', 150, 0, 101, 100), pillars: [] },
        { ...walledRoom('c', 0, 150, 100, 101), pillars: [] },
      ],
      doors: [
        { roomA: 'a', roomB: 'b', passageGrid: { x: 100, y: 40, w: 50, h: 2 } },
        { roomA: 'a', roomB: 'c', passageGrid: { x: 40, y: 100, w: 2, h: 50 } },
      ],
      spawns: [{ x: 40, y: 40 }, { x: 190, y: 40 }],
      eyeCandidates: [{ roomId: 'a' }, { roomId: 'b' }],
    };
    collect(sparse);
    const dense = healthyMap();
    dense.rooms = dense.rooms.map((r) => ({ ...r, solids: [{ x: 0, y: 0, w: r.rectGrid.w, h: r.rectGrid.h - 1 }], pillars: [] }));
    collect(dense);
    collect({
      id: 'fixture_shallow',
      sizeGrid: { w: 40, h: 20 },
      rooms: [walledRoom('a', 0, 0, 10, 10), walledRoom('b', 20, 0, 11, 10)],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 4, w: 10, h: 2 } }],
      spawns: [{ x: 4, y: 4 }],
      eyeCandidates: [{ roomId: 'a' }, { roomId: 'b' }],
    });
    collect(chainMap());
    const oneEye = healthyMap(); oneEye.eyeCandidates = [{ roomId: 'a' }]; collect(oneEye);
    const thinWall = healthyMap();
    thinWall.rooms[2] = { ...thinWall.rooms[2]!, solids: [{ x: 0, y: 0, w: 3, h: 1 }] };
    collect(thinWall);
    const leak = healthyMap();
    leak.rooms = [
      { ...walledRoom('a', 0, 0, 10, 10), solids: walledRoom('a', 0, 0, 10, 10).solids.slice(0, 3) },
      { ...walledRoom('h', 10, 0, 11, 10), solids: walledRoom('h', 10, 0, 11, 10).solids.slice(0, 3) },
      walledRoom('c', 0, 20, 10, 14),
    ];
    leak.doors = [{ roomA: 'a', roomB: 'c', passageGrid: { x: 4, y: 10, w: 2, h: 10 } }];
    leak.spawns = [{ x: 4, y: 4 }, { x: 4, y: 24 }];
    leak.eyeCandidates = [{ roomId: 'a' }, { roomId: 'c' }];
    collect(leak);
    const split = healthyMap();
    split.rooms[3] = { ...split.rooms[3]!, solids: [...split.rooms[3]!.solids, { x: 1, y: 6, w: 12, h: 1 }] };
    collect(split);
    const buried = healthyMap();
    buried.rooms[3] = { ...buried.rooms[3]!, solids: [...buried.rooms[3]!.solids, { x: 2, y: 2, w: 4, h: 4 }], lootMarkers: [{ point: { x: 4, y: 4 }, tableId: 'arena_common' }] };
    collect(buried);

    const ALL_RULES = [
      'content_off_map', 'content_outside_room', 'no_walls', 'unenclosed_room',
      'door_gates_nothing', 'undoored_leak', 'graph_disconnected', 'room_unreachable',
      'no_spawns', 'spawn_outside_room', 'spawn_shared_room', 'stamped_rooms',
      'rooms_without_cover', 'cover_too_sparse', 'cover_too_dense', 'spawns_too_close',
      'map_too_shallow', 'no_branching', 'zone_has_no_choices', 'zone_unreachable',
      'room_barely_walled', 'room_split', 'content_unreached',
    ];
    expect([...emitted].sort().filter((r) => !ALL_RULES.includes(r))).toEqual([]);
    expect(ALL_RULES.filter((r) => !emitted.has(r)).sort()).toEqual([]);
  });
});

/**
 * The cases a mutation battery over `arenaQuality.ts` asked for (2026-08-26). The first run
 * killed 21 of 31 mutants; each test below is one that SURVIVED, i.e. a bound whose exact
 * position no fixture above pinned. Two survivors are recorded in `arenaQuality.ts` itself as
 * EQUIVALENT rather than tested — `colliding > 0` vs `> 1` (the metric sums group sizes, so it
 * is 0 or >= 2, never 1) and the `spawns.count >= 2` guard (`minPairHops` is +Infinity below
 * two, so the comparison is false either way).
 */
describe('the arena quality gate — the bounds sit where they claim to', () => {
  it('fires `door_gates_nothing` on ONE bogus door, not just on a map full of them', () => {
    // The empty-solids fixture trips this with 8 wall-less doors, which a `> 2` bound would
    // also catch. One door in open floor is the smallest real case.
    const map = healthyMap();
    map.doors.push({ roomA: 'a', roomB: 'b', passageGrid: { x: 3, y: 3, w: 2, h: 2 } });
    expect(measureEnclosure(map).doorsWithoutWalls).toBe(1);
    expect(rules(map)).toEqual(['door_gates_nothing']);
  });

  it('fires `unenclosed_room` on ONE unenclosed room', () => {
    const map = healthyMap();
    map.rooms[6] = { ...map.rooms[6]!, solids: [], pillars: [] };
    expect(measureEnclosure(map).unenclosedRooms).toEqual(['g']);
    expect(rules(map)).toContain('unenclosed_room');
  });

  it('reads interior SHAPE for `stamped_rooms`, not only the footprint', () => {
    // The two halves of that rule are a `Math.max`, and a map can fail on either alone: here
    // every room is a different SIZE (so footprints look varied) while carrying an identical
    // interior pattern — "60 identical rooms" wearing different rects, which is exactly the
    // shape the audit's geometry half exists to see.
    const map = healthyMap();
    map.rooms = map.rooms.map((r) => ({
      ...r,
      solids: [{ x: 1, y: 1, w: 2, h: 2 }],
      pillars: [{ center: { x: 4, y: 4 }, radius: 1 }],
    }));
    const m = measureArena(map);
    expect(m.interiorShapes.dominantShare).toBe(1);
    // Load-bearing: the footprint half is BELOW the bound, so only the shape half can be
    // firing the rule. Without this the test would pass on either reading.
    expect(m.footprints.dominantShare).toBeLessThan(ARENA_QUALITY_BOUNDS.maxDominantShare);
    expect(rules(map)).toContain('stamped_rooms');
  });

  it('fires `stamped_rooms` AT one half exactly, not only above it', () => {
    // Two of four rooms sharing a footprint is exactly the bound; the rule is `>=`.
    const map: ArenaMap = {
      id: 'fixture_half', sizeGrid: { w: 60, h: 60 },
      rooms: [
        walledRoom('a', 0, 0, 10, 10), walledRoom('b', 20, 0, 10, 10),
        walledRoom('c', 0, 20, 11, 10), walledRoom('d', 20, 20, 12, 11),
      ],
      doors: [
        { roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 4, w: 10, h: 2 } },
        { roomA: 'a', roomB: 'c', passageGrid: { x: 4, y: 10, w: 2, h: 10 } },
        { roomA: 'c', roomB: 'd', passageGrid: { x: 11, y: 24, w: 9, h: 2 } },
        { roomA: 'b', roomB: 'd', passageGrid: { x: 24, y: 10, w: 2, h: 10 } },
      ],
      spawns: [{ x: 4, y: 4 }, { x: 24, y: 24 }],
      eyeCandidates: [{ roomId: 'a' }, { roomId: 'd' }],
    };
    expect(measureArena(map).footprints.dominantShare).toBe(ARENA_QUALITY_BOUNDS.maxDominantShare);
    expect(rules(map)).toContain('stamped_rooms');
  });

  it('reads the MEDIAN room for the cover band, so one deliberately open room is allowed', () => {
    // The rule is about the typical room. A single large bare hall drags the MINIMUM under
    // the sparse bound while the median stays healthy, and that must NOT trip the gate —
    // an arena is allowed one plaza.
    const map = healthyMap();
    map.sizeGrid = { w: 200, h: 200 };
    map.rooms[6] = { ...walledRoom('g', 0, 40, 100, 100), pillars: [] };
    const fractions = measureArena(map).cover.coverFractions;
    expect(fractions[0]!).toBeLessThan(ARENA_QUALITY_BOUNDS.minMedianCoverFraction);
    expect(fractions[Math.floor(fractions.length / 2)]!).toBeGreaterThan(ARENA_QUALITY_BOUNDS.minMedianCoverFraction);
    expect(rules(map)).toEqual([]);
  });

  it('fires `map_too_shallow` at a two-hop diameter and not at three', () => {
    const chain = (n: number): ArenaMap => ({
      id: `fixture_d${n}`, sizeGrid: { w: 20 * n + 20, h: 30 },
      rooms: Array.from({ length: n }, (_, i) => walledRoom(`r${i}`, i * 20, 0, 10 + i, 10)),
      doors: Array.from({ length: n - 1 }, (_, i) => ({
        roomA: `r${i}`, roomB: `r${i + 1}`, passageGrid: { x: i * 20 + 10 + i, y: 4, w: 10 - i, h: 2 },
      })),
      spawns: [{ x: 4, y: 4 }, { x: (n - 1) * 20 + 4, y: 4 }],
      eyeCandidates: [{ roomId: 'r0' }, { roomId: `r${n - 1}` }],
    });
    const three = chain(3);
    expect(measureArena(three).graph.diameter).toBe(2);
    expect(rules(three)).toContain('map_too_shallow');
    // One room deeper clears it — the bound's other side, so lowering it to 2 breaks this.
    const four = chain(4);
    expect(measureArena(four).graph.diameter).toBe(3);
    expect(rules(four)).not.toContain('map_too_shallow');
  });

  it('straddles half a perimeter for `room_barely_walled`', () => {
    // Whole sides are what authored content actually produces, and they land at 0.455 (two
    // sides) and 0.727 (three) — either side of the bound. Exactly 0.5 is unreachable on
    // grid-aligned walls, which is why `arenaQuality.ts` records that boundary as untested
    // rather than pretending a fixture reaches it.
    const withSides = (keep: number): ArenaMap => {
      const map = healthyMap();
      map.rooms[2] = { ...map.rooms[2]!, solids: map.rooms[2]!.solids.slice(0, keep) };
      return map;
    };
    expect(measureEnclosure(withSides(2)).perimeterCoverage[0]!).toBeLessThan(ARENA_QUALITY_BOUNDS.minPerimeterCoverage);
    expect(rules(withSides(2))).toContain('room_barely_walled');
    expect(measureEnclosure(withSides(3)).perimeterCoverage[0]!).toBeGreaterThan(ARENA_QUALITY_BOUNDS.minPerimeterCoverage);
    expect(rules(withSides(3))).not.toContain('room_barely_walled');
  });

  it('sorts each rule into the right severity, and populates both', () => {
    // The `defect`/`design` split is what the report prints and what tells a reader whether
    // a finding is a bug or a judgement call, so it needs pinning independently of the rule
    // names — otherwise every rule could be relabelled with no test noticing.
    const broken = healthyMap();
    broken.rooms = broken.rooms.map((r) => ({ ...r, solids: [], pillars: [] }));
    const bySeverity = new Map(auditArenaQuality(broken).map((v) => [v.rule, v.severity]));
    expect(bySeverity.get('no_walls')).toBe('defect');
    expect(bySeverity.get('unenclosed_room')).toBe('defect');
    expect(bySeverity.get('door_gates_nothing')).toBe('defect');
    expect(bySeverity.get('rooms_without_cover')).toBe('design');
    expect(bySeverity.get('cover_too_sparse')).toBe('design');

    const stamped = healthyMap();
    stamped.rooms = stamped.rooms.map((r) => walledRoom(r.id, r.rectGrid.x, r.rectGrid.y, 10, 10));
    expect(auditArenaQuality(stamped).map((v) => v.severity)).toEqual(['design']);

    const noSpawn = healthyMap();
    noSpawn.spawns = [];
    expect(auditArenaQuality(noSpawn).map((v) => v.severity)).toEqual(['defect']);
  });
});
