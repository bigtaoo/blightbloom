/**
 * The arena quality GATE (design/15) — `arenaMetrics`/`arenaGeometryMetrics` measure a map,
 * this decides whether the measurement is acceptable.
 *
 * Why it is separate from `sim/arenaAudit.sim.ts`: that prints a report for a person to read,
 * and a report cannot fail CI. Why it is separate from `world/arenas/launchArena.test.ts`:
 * that asserts the shipped map's own geometry, by hand, for `arena_launch` specifically. This
 * is the bar EVERY map in the catalog is held to, so the next arena is measured against it on
 * the day it lands rather than the day someone remembers to write its test. The two overlap
 * deliberately on the geometry invariants — a per-map test is free to be stricter, and the
 * gate has to keep holding once that map is deleted.
 *
 * ## How the thresholds were chosen
 *
 * NOT by transcribing what `arena_launch` scores. Every bound below is an answer to "what
 * would make a PvP arena unplayable, or unauthored", and each is far enough from the shipped
 * map's own number that the map has real headroom — `arenaQuality.test.ts` asserts that
 * headroom, so a threshold quietly tightened onto the current content fails there.
 *
 * Two severities, and the distinction is not cosmetic:
 *   - `defect` — wrong at ANY nonzero value, and every one of them is a bug that really
 *     shipped. `arena_prototype_60` (deleted 2026-08-26) authored its pillars and loot in the
 *     wrong coordinate space and left `solids: []` everywhere, so its 71 doors gated nothing
 *     and 90 of 120 markers landed off the map. Those are the rules with a 0 bound.
 *   - `design` — a band, where both ends are a real failure and the middle is a judgement
 *     call. A map can be structurally perfect and still be a shooting gallery.
 *
 * Deliberately NOT gated: `chokepoints` and `deadEnds`. Both read as defects from a graph
 * metric and are legitimate authored content — a vault worth walking into a dead end for is
 * the whole point of one, and `arena_launch` ships 8 dead ends and 10 chokepoints on purpose.
 * Gating them would be the "transcribe the current score" mistake pointed the other way.
 */
import type { ArenaMap } from './arenas';
import { measureArena } from './arenaMetrics';
import { measureEnclosure, measurePlacement } from './arenaGeometryMetrics';
import { measureBodyAccess } from './arenaBodyAccess';

export interface ArenaViolation {
  /** Stable id, so a test can name the rule it expects to fire without matching prose. */
  rule: string;
  severity: 'defect' | 'design';
  /** The measured value against its bound, for a failure message worth reading. */
  detail: string;
}

/**
 * The design bands, exported so the report can print the bar it is reporting against and a
 * test can pin the distance between a bound and the shipped map's score.
 */
export const ARENA_QUALITY_BOUNDS = {
  /** One room variant covering half the map means it was stamped, not authored.
   *  `arena_prototype_60` scored 1.0 here; `arena_launch` scores 0.067. */
  maxDominantShare: 0.5,
  /** A cover shooter's room with nothing to stand behind is a shooting gallery. A few
   *  deliberate open plazas are fine, so this is a share rather than a zero.
   *  `arena_launch` scores 0. */
  maxRoomsWithoutCoverShare: 0.1,
  /** Below this the median room has nothing in it; above it, the map is a maze you cannot
   *  fight in. `arena_launch`'s median is 0.333, near the middle of the band. */
  minMedianCoverFraction: 0.05,
  maxMedianCoverFraction: 0.7,
  /** Two seats starting in adjacent rooms is a spawn-camp. Same-room is caught as a defect
   *  (`spawns.colliding`); this adds the neighbour. `arena_launch` scores 4. */
  minSpawnPairHops: 2,
  /** A map you can cross in two hops has no rotation in it. `arena_launch` scores 15. */
  minDiameter: 3,
  /** The share of rooms with three or more doors. A pure chain scores 0 and plays as one
   *  corridor however many rooms it has — this is the shape gate a diameter ceiling only
   *  approximates. `arena_launch` scores 0.52. */
  minBranchingShare: 0.1,
  /** A zone that can only ever shrink to one place makes every match identical.
   *  `arena_launch` offers 14. */
  minEyeCandidates: 2,
  /** A room walled on half its boundary or less is not a room. `arena_launch`'s worst is
   *  0.667. Compared with `<=`, and whole authored sides land at 0.227 / 0.455 / 0.727 on a
   *  10x10 room — so exactly 0.5 is unreachable on grid-aligned walls and the `<=`-vs-`<`
   *  boundary is deliberately untested; `arenaQuality.test.ts` straddles it instead. */
  minPerimeterCoverage: 0.5,
} as const;

/**
 * Every way this map falls short, empty when it clears the bar.
 *
 * Takes the `ArenaMap` rather than pre-computed metrics on purpose: the three measurement
 * entry points have to be called with the same map, and letting a caller pass a metrics
 * object it measured from something else is the one mistake this signature can prevent.
 */
export function auditArenaQuality(map: ArenaMap): ArenaViolation[] {
  const m = measureArena(map);
  const placement = measurePlacement(map);
  const enclosure = measureEnclosure(map);
  const access = measureBodyAccess(map);
  const out: ArenaViolation[] = [];
  const defect = (rule: string, detail: string) => out.push({ rule, severity: 'defect', detail });
  const design = (rule: string, detail: string) => out.push({ rule, severity: 'design', detail });

  // ---- defects: wrong at any nonzero value, and all of them really shipped once ----
  if (placement.offMap.length > 0) {
    const e = placement.offMap[0]!;
    defect('content_off_map', `${placement.offMap.length} markers outside the map, e.g. ${e.room} ${e.feature} -> (${e.at.x}, ${e.at.y})`);
  }
  if (placement.outsideOwnRoom.length > 0) {
    const e = placement.outsideOwnRoom[0]!;
    defect('content_outside_room', `${placement.outsideOwnRoom.length} markers outside their own room, e.g. ${e.room} ${e.feature} -> (${e.at.x}, ${e.at.y})`);
  }
  if (enclosure.solidCells === 0) defect('no_walls', 'no solid cells anywhere — every room and door is logical-only');
  if (enclosure.unenclosedRooms.length > 0) {
    defect('unenclosed_room', `${enclosure.unenclosedRooms.length} unenclosed: ${enclosure.unenclosedRooms.slice(0, 4).join(', ')}`);
  }
  if (enclosure.doorsWithoutWalls > 0) defect('door_gates_nothing', `${enclosure.doorsWithoutWalls} doors cut through no wall`);
  if (enclosure.undoorLeaks > 0) defect('undoored_leak', `${enclosure.undoorLeaks} room pairs joined by neither a door nor a wall`);
  if (!m.graph.connected) defect('graph_disconnected', 'the door graph is not connected');
  if (m.graph.isolated.length > 0) defect('room_unreachable', `${m.graph.isolated.length} isolated: ${m.graph.isolated.slice(0, 4).join(', ')}`);
  if (m.spawns.count === 0) defect('no_spawns', 'no authored spawn points — a real match cannot start here');
  if (m.spawns.orphans > 0) defect('spawn_outside_room', `${m.spawns.orphans} spawns outside every room`);
  // `> 0` rather than `>= 2` for readability; the metric SUMS the size of each over-occupied
  // room, so it is 0 or at least 2 and never 1. A battery mutant to `> 1` is equivalent.
  if (m.spawns.colliding > 0) defect('spawn_shared_room', `${m.spawns.colliding} spawns sharing a room with another`);
  // A body, not a bullet (`arenaBodyAccess.ts`): `arena_launch` shipped both until 2026-09-30.
  if (access.splitRooms.length > 0) {
    const e = access.splitRooms[0]!;
    defect('room_split', `${access.splitRooms.length} rooms whose floor is more than one piece, e.g. ${e.room} in ${e.pieces}`);
  }
  if (access.unreached.length > 0) {
    const e = access.unreached[0]!;
    defect('content_unreached', `${access.unreached.length} markers no body in their room gets to, e.g. ${e.room} ${e.feature} -> (${e.at.x}, ${e.at.y})`);
  }

  // ---- design bands: both ends are a real failure ----
  const dominant = Math.max(m.footprints.dominantShare, m.interiorShapes.dominantShare);
  if (m.roomCount > 0 && dominant >= ARENA_QUALITY_BOUNDS.maxDominantShare) {
    design('stamped_rooms', `one variant covers ${(dominant * 100).toFixed(1)}% of rooms, bound < ${ARENA_QUALITY_BOUNDS.maxDominantShare * 100}%`);
  }
  if (m.roomCount > 0) {
    const share = m.cover.roomsWithNoCover.length / m.roomCount;
    if (share > ARENA_QUALITY_BOUNDS.maxRoomsWithoutCoverShare) {
      design('rooms_without_cover', `${m.cover.roomsWithNoCover.length}/${m.roomCount} rooms have no cover (${(share * 100).toFixed(1)}%), bound <= ${ARENA_QUALITY_BOUNDS.maxRoomsWithoutCoverShare * 100}%`);
    }
  }
  // `coverFractions` is sorted ascending by `measureArena`, so the midpoint is the median.
  const median = m.cover.coverFractions[Math.floor(m.cover.coverFractions.length / 2)];
  if (median !== undefined) {
    if (median < ARENA_QUALITY_BOUNDS.minMedianCoverFraction) {
      design('cover_too_sparse', `median cover ${(median * 100).toFixed(1)}% of floor, bound >= ${ARENA_QUALITY_BOUNDS.minMedianCoverFraction * 100}%`);
    }
    if (median > ARENA_QUALITY_BOUNDS.maxMedianCoverFraction) {
      design('cover_too_dense', `median cover ${(median * 100).toFixed(1)}% of floor, bound <= ${ARENA_QUALITY_BOUNDS.maxMedianCoverFraction * 100}%`);
    }
  }
  // Only meaningful with two seats to separate. The guard is documentation rather than
  // control flow: `minPairHops` is +Infinity below two spawns, so the comparison is already
  // false — a battery mutant relaxing it to `>= 1` is equivalent. Kept so the reason the
  // sentinel is safe here is stated where someone would otherwise have to re-derive it.
  if (m.spawns.count >= 2 && m.spawns.minPairHops < ARENA_QUALITY_BOUNDS.minSpawnPairHops) {
    design('spawns_too_close', `closest pair ${m.spawns.minPairHops} hops apart, bound >= ${ARENA_QUALITY_BOUNDS.minSpawnPairHops}`);
  }
  if (m.roomCount > 1 && m.graph.diameter < ARENA_QUALITY_BOUNDS.minDiameter) {
    design('map_too_shallow', `diameter ${m.graph.diameter} hops, bound >= ${ARENA_QUALITY_BOUNDS.minDiameter}`);
  }
  if (m.roomCount > 0) {
    const branching = Object.entries(m.graph.degreeHistogram)
      .filter(([deg]) => Number(deg) >= 3)
      .reduce((n, [, count]) => n + count, 0) / m.roomCount;
    if (branching < ARENA_QUALITY_BOUNDS.minBranchingShare) {
      design('no_branching', `${(branching * 100).toFixed(1)}% of rooms have 3+ doors, bound >= ${ARENA_QUALITY_BOUNDS.minBranchingShare * 100}%`);
    }
  }
  if (m.eyeCandidates < ARENA_QUALITY_BOUNDS.minEyeCandidates) {
    design('zone_has_no_choices', `${m.eyeCandidates} eye candidates, bound >= ${ARENA_QUALITY_BOUNDS.minEyeCandidates}`);
  }
  if (!Number.isFinite(m.maxHopsToEye)) {
    design('zone_unreachable', 'some room cannot reach any eye candidate');
  }
  const worstPerimeter = enclosure.perimeterCoverage[0];
  if (worstPerimeter !== undefined && worstPerimeter <= ARENA_QUALITY_BOUNDS.minPerimeterCoverage) {
    design('room_barely_walled', `worst perimeter coverage ${(worstPerimeter * 100).toFixed(1)}%, bound > ${ARENA_QUALITY_BOUNDS.minPerimeterCoverage * 100}%`);
  }

  return out;
}

/** One line per violation, for a test failure message or the audit report. */
export function formatViolations(violations: readonly ArenaViolation[]): string {
  if (violations.length === 0) return '  (clears the bar)';
  return violations.map((v) => `  [${v.severity}] ${v.rule.padEnd(22)} ${v.detail}`).join('\n');
}
