/**
 * Assembles `launchArenaPlan.ts`'s hand-drawn plan into a real `ArenaMap` (design/15).
 *
 * Everything here is derivation, not decision — the plan owns every choice, `slotGrid.ts`
 * owns the wall arithmetic, `interiorKits.ts` owns the furniture patterns, and this file
 * wires the three together and places the things that have to avoid geometry (loot markers,
 * enemy spawn points, the drop points) at cells it has verified are free.
 *
 * That last part is the reason this is code rather than 60 hand-typed coordinates: a loot
 * marker inside a wall is invisible until someone plays that room, and `SpawnSystem` covers
 * it with a `clampToWalkable` backstop that silently moves the crate somewhere else. Picking
 * from a computed free-cell set makes "no authored content is inside a solid" a property of
 * the map rather than a hope, and `launchArena.test.ts` asserts it over every room.
 *
 * No PRNG, no clock, no engine state: the same plan always produces the byte-identical map,
 * which is what lets the client import it directly and the audit compare two revisions.
 */
import type { ArenaMap, ArenaRoom, CellTrait, EyeCandidate, Door, LootMarker } from '../../content/arenas';
import type { AabbGrid, PillarGrid, Point, SpawnPoint, WaveEntry } from '../../content/rooms';
import { buildArenaGeometry } from '../../content/arenas';
import { measureBodyReach, type BodyReach } from '../../content/arenaBodyReach';
import { toFpGrid } from '../../content/convert';
import { INTERIOR_KITS, innerOf, type KitId } from './interiorKits';
import {
  doorBetween,
  gridExtent,
  perimeterSolids,
  slotRects,
  type Opening,
  type Rect,
} from './slotGrid';
import {
  ARTERY_DOORS,
  ARTERY_DOOR_SPAN,
  COL_WIDTHS,
  DISTRICTS,
  DISTRICT_MAP,
  DOOR_SPAN,
  EYE_SLOTS,
  GRID_MARGIN,
  GRID_ORIGIN,
  INTRA_DISTRICT_DOORS,
  KIT_MAP,
  ROW_HEIGHTS,
  SPAWN_SLOTS,
  type SlotRef,
} from './launchArenaPlan';

/** Single-character kit codes as written in `KIT_MAP`. */
const KIT_CODES: Record<string, KitId> = {
  o: 'open',
  '4': 'pillars4',
  r: 'ring',
  c: 'colonnade',
  s: 'stubs',
  h: 'chevron',
  v: 'vault',
  u: 'rubble',
  S: 'spikeField',
  l: 'spikeLine',
};

function slotRef(row: number, col: number): SlotRef {
  return `r${row}c${col}`;
}

function parseRef(ref: SlotRef): { row: number; col: number } {
  const m = /^r(\d+)c(\d+)$/.exec(ref);
  if (!m) throw new Error(`launchArena: malformed slot ref ${ref}`);
  return { row: Number(m[1]), col: Number(m[2]) };
}

/** Fail loudly at construction time on a plan that does not describe a grid — a silently
 *  short row would drop rooms off the east edge of the map. */
function validatePlan(): void {
  const rows = ROW_HEIGHTS.length;
  const cols = COL_WIDTHS.length;
  for (const [name, grid] of [
    ['DISTRICT_MAP', DISTRICT_MAP],
    ['KIT_MAP', KIT_MAP],
  ] as const) {
    if (grid.length !== rows) throw new Error(`launchArena: ${name} has ${grid.length} rows, expected ${rows}`);
    grid.forEach((line, i) => {
      if (line.length !== cols) {
        throw new Error(`launchArena: ${name} row ${i} has ${line.length} columns, expected ${cols}`);
      }
    });
  }
  DISTRICT_MAP.forEach((line, row) => {
    for (let col = 0; col < cols; col++) {
      const d = line[col]!;
      const k = KIT_MAP[row]![col]!;
      if ((d === '.') !== (k === '.')) {
        throw new Error(`launchArena: ${slotRef(row, col)} is empty in one map and furnished in the other`);
      }
      if (d !== '.' && !DISTRICTS[d]) throw new Error(`launchArena: unknown district code '${d}'`);
      if (k !== '.' && !KIT_CODES[k]) throw new Error(`launchArena: unknown kit code '${k}'`);
    }
  });
}

interface SlotInfo {
  ref: SlotRef;
  row: number;
  col: number;
  district: string;
  kit: KitId;
  rect: Rect;
  id: string;
}

function occupiedSlots(rects: Rect[][]): Map<SlotRef, SlotInfo> {
  const out = new Map<SlotRef, SlotInfo>();
  DISTRICT_MAP.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      const district = line[col]!;
      if (district === '.') continue;
      const ref = slotRef(row, col);
      out.set(ref, {
        ref,
        row,
        col,
        district,
        kit: KIT_CODES[KIT_MAP[row]![col]!]!,
        rect: rects[row]![col]!,
        id: `${DISTRICTS[district]!.name}_${ref}`,
      });
    }
  });
  return out;
}

/** Every cell a solid, pillar or hazard occupies, room-relative — the complement of where
 *  content may be placed. A pillar blocks every cell its radius reaches into. */
function blockedCells(solids: readonly AabbGrid[], pillars: readonly PillarGrid[], traits: readonly CellTrait[]): Set<string> {
  const blocked = new Set<string>();
  for (const s of solids) {
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) blocked.add(`${x},${y}`);
  }
  for (const p of pillars) {
    const r = Math.ceil(p.radius);
    for (let y = p.center.y - r; y <= p.center.y + r; y++) {
      for (let x = p.center.x - r; x <= p.center.x + r; x++) blocked.add(`${x},${y}`);
    }
  }
  for (const t of traits) {
    const r = t.rectGrid;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) blocked.add(`${x},${y}`);
  }
  return blocked;
}

/**
 * The free interior cells of a room, ordered by distance from `target` — closest first, ties
 * broken by (y, x) so the result never depends on iteration order. Cells adjacent to a
 * blocked cell sort later, so a crate lands in open floor rather than wedged against stone
 * whenever the room has room for it. With `reach`, a cell no body can get to is skipped too
 * (`arenaBodyReach.ts`): free of stone is not the same as somewhere a player can go.
 */
function freeCellsNear(rect: Rect, blocked: ReadonlySet<string>, target: Point, reach?: BodyReach): Point[] {
  const inner = innerOf(rect);
  const cells: { p: Point; d: number; tight: number }[] = [];
  for (let y = inner.y0; y <= inner.y1; y++) {
    for (let x = inner.x0; x <= inner.x1; x++) {
      if (blocked.has(`${x},${y}`)) continue;
      if (reach && !reach.reaches(toFpGrid(rect.x + x), toFpGrid(rect.y + y))) continue;
      let tight = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (blocked.has(`${x + dx},${y + dy}`)) tight++;
      }
      cells.push({ p: { x, y }, d: Math.abs(x - target.x) + Math.abs(y - target.y), tight });
    }
  }
  cells.sort((a, b) => a.tight - b.tight || a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
  return cells.map((c) => c.p);
}

/** Collect every room's perimeter openings, and the map's door list, from the plan. */
function buildDoors(slots: Map<SlotRef, SlotInfo>): { doors: Door[]; openings: Map<SlotRef, Opening[]> } {
  const doors: Door[] = [];
  const openings = new Map<SlotRef, Opening[]>();
  const add = (ref: SlotRef, opening: Opening) => {
    const list = openings.get(ref) ?? [];
    list.push(opening);
    openings.set(ref, list);
  };

  const authored: [SlotRef, SlotRef, number][] = [
    ...INTRA_DISTRICT_DOORS.map(([a, b]) => [a, b, DOOR_SPAN] as [SlotRef, SlotRef, number]),
    ...ARTERY_DOORS.map(([a, b]) => [a, b, ARTERY_DOOR_SPAN] as [SlotRef, SlotRef, number]),
  ];

  for (const [refA, refB, span] of authored) {
    const a = slots.get(refA);
    const b = slots.get(refB);
    if (!a || !b) throw new Error(`launchArena: door ${refA}-${refB} names an empty slot`);
    // A small authored offset so a district's doors do not form one dead-straight lane.
    const bias = ((a.row + a.col) % 3) - 1;
    const built = doorBetween(a.rect, b.rect, span, bias);
    if (!built) throw new Error(`launchArena: door ${refA}-${refB} joins rooms that are not adjacent`);
    doors.push({ roomA: a.id, roomB: b.id, passageGrid: built.passageGrid });
    add(refA, built.openingA);
    add(refB, built.openingB);
  }
  return { doors, openings };
}

/** One room's encounter, spawn points and loot markers, all placed on verified free cells —
 *  and, given `reach`, on cells a body can get to. */
function furnish(
  slot: SlotInfo,
  openings: readonly Opening[],
  encounter: boolean,
  reach?: BodyReach,
): ArenaRoom {
  const profile = DISTRICTS[slot.district]!;
  const variant = slot.row * 3 + slot.col;
  const kit = INTERIOR_KITS[slot.kit](innerOf(slot.rect), variant);
  // The kit's blocks are the room's FREE-STANDING cover; the perimeter ring is not. That
  // distinction is only knowable here, where the two lists are still separate, and it is the
  // one input to the north brim `MovementSystem` gives a standing block (config's
  // `WALL_NORTH_BRIM`, v47). Marked rather than re-derived downstream: once the lists are
  // concatenated no rect can be asked which one it came from.
  const solids = [
    ...perimeterSolids(slot.rect, openings),
    ...kit.solids.map((s) => ({ ...s, freeStanding: true as const })),
  ];
  const blocked = blockedCells(solids, kit.pillars, kit.cellTraits);

  const centre = { x: Math.floor(slot.rect.w / 2), y: Math.floor(slot.rect.h / 2) };
  const isVault = slot.kit === 'vault';
  const central = freeCellsNear(slot.rect, blocked, centre, reach);
  const lootMarkers: LootMarker[] = [];
  if (central[0]) lootMarkers.push({ point: central[0], tableId: isVault ? profile.vaultLoot : profile.loot });
  if (isVault && central[1]) lootMarkers.push({ point: central[1], tableId: profile.vaultLoot });

  // Enemies come in from the room's far corners, away from whatever the loot is next to.
  const corners: Point[] = [
    { x: 1, y: 1 },
    { x: slot.rect.w - 2, y: slot.rect.h - 2 },
    { x: slot.rect.w - 2, y: 1 },
  ];
  const taken = new Set(lootMarkers.map((m) => `${m.point.x},${m.point.y}`));
  const spawns: SpawnPoint[] = [];
  for (const corner of corners) {
    const cell = freeCellsNear(slot.rect, blocked, corner, reach).find((c) => !taken.has(`${c.x},${c.y}`));
    if (!cell) continue;
    taken.add(`${cell.x},${cell.y}`);
    spawns.push({ ...cell, type: profile.enemies[spawns.length % profile.enemies.length] });
  }

  const entries: WaveEntry[] = encounter
    ? spawns.map((sp, i) => ({
        atTick: i * 45,
        enemyType: sp.type!,
        spawnPoint: i,
        count: profile.name === 'atrium' ? 2 : 1,
      }))
    : [];

  return {
    id: slot.id,
    rectGrid: { x: slot.rect.x, y: slot.rect.y, w: slot.rect.w, h: slot.rect.h },
    solids,
    ...(kit.pillars.length > 0 ? { pillars: kit.pillars } : {}),
    ...(kit.cellTraits.length > 0 ? { cellTraits: kit.cellTraits.map((t) => ({ ...t, id: `${slot.id}_${t.id}` })) } : {}),
    ...(spawns.length > 0 ? { spawns } : {}),
    ...(entries.length > 0 ? { encounter: { entries } } : {}),
    lootMarkers,
  };
}

/** Which rooms carry an encounter: every district's rooms in authored order, taking the
 *  profile's share as an evenly-spaced stride. Deterministic and inspectable — the map has
 *  no PRNG in it at all (design/15: "no PRNG in what spawns, only the eye and the drop"). */
function encounterRooms(slots: readonly SlotInfo[]): Set<SlotRef> {
  const out = new Set<SlotRef>();
  for (const code of Object.keys(DISTRICTS)) {
    const inDistrict = slots.filter((s) => s.district === code);
    const want = Math.round(inDistrict.length * DISTRICTS[code]!.encounterShare);
    if (want <= 0) continue;
    const stride = inDistrict.length / want;
    for (let i = 0; i < want; i++) out.add(inDistrict[Math.floor(i * stride)]!.ref);
  }
  return out;
}

function buildLaunchArena(): ArenaMap {
  validatePlan();
  const rects = slotRects(GRID_ORIGIN, COL_WIDTHS, ROW_HEIGHTS);
  const slots = occupiedSlots(rects);
  const { doors, openings } = buildDoors(slots);
  const ordered = [...slots.values()];
  const withEncounter = encounterRooms(ordered);

  // Twice. The first pass fixes every solid, and a room's solids never depend on what it
  // holds, so the flood of that geometry is the geometry of the map. The second places the
  // content again with the cells no body reaches taken out: on the shipped plan five pockets
  // are sealed (two of them only by a block's north brim), and mobs and a crate had been
  // placed in them, where no player could get to them (volume 116).
  const draft = ordered.map((slot) => furnish(slot, openings.get(slot.ref) ?? [], withEncounter.has(slot.ref)));
  const sizeGrid = gridExtent(GRID_ORIGIN, COL_WIDTHS, ROW_HEIGHTS, GRID_MARGIN);
  const reach = measureBodyReach(buildArenaGeometry({ id: 'arena_launch', sizeGrid, rooms: draft, doors, spawns: [], eyeCandidates: [] }));
  const rooms = ordered.map((slot) => furnish(slot, openings.get(slot.ref) ?? [], withEncounter.has(slot.ref), reach));
  const byRef = new Map(ordered.map((s, i) => [s.ref, { slot: s, room: rooms[i]! }]));

  // Drop points are ABSOLUTE (ArenaMap.spawns, unlike everything inside a room), placed on
  // the free cell nearest each chosen room's centre.
  const spawns: Point[] = SPAWN_SLOTS.map((ref) => {
    const entry = byRef.get(ref);
    if (!entry) throw new Error(`launchArena: spawn slot ${ref} is empty`);
    const { slot, room } = entry;
    const blocked = blockedCells(room.solids, room.pillars ?? [], room.cellTraits ?? []);
    const centre = { x: Math.floor(slot.rect.w / 2), y: Math.floor(slot.rect.h / 2) };
    const cell = freeCellsNear(slot.rect, blocked, centre, reach)[0];
    if (!cell) throw new Error(`launchArena: spawn room ${room.id} has no free cell`);
    return { x: slot.rect.x + cell.x, y: slot.rect.y + cell.y };
  });

  const eyeCandidates: EyeCandidate[] = EYE_SLOTS.map(({ slot, weight }) => {
    const entry = byRef.get(slot);
    if (!entry) throw new Error(`launchArena: eye candidate ${slot} is empty`);
    return { roomId: entry.room.id, weight };
  });

  return {
    id: 'arena_launch',
    sizeGrid,
    rooms,
    doors,
    spawns,
    eyeCandidates,
  };
}

/** The launch arena. Built once at module load — pure, so this is a constant in every sense
 *  that matters, and the client can import it the way PvE imports `EMBER_L1_ROOMS`. */
export const LAUNCH_ARENA: ArenaMap = buildLaunchArena();

/** Re-exported for tests that want to rebuild it and compare. */
export { buildLaunchArena };

/** Slot ref → room id, for a plan-level assertion or an editor export. */
export function launchArenaRoomId(ref: SlotRef): string | null {
  const { row, col } = parseRef(ref);
  const code = DISTRICT_MAP[row]?.[col];
  return code && code !== '.' ? `${DISTRICTS[code]!.name}_${ref}` : null;
}
