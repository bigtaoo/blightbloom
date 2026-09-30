/**
 * `measureBodyAccess` on maps built to separate a per-room flood from a whole-map one: a room
 * whose two halves meet only through the room next door (`barracks_r2c7`'s shape, volume 116),
 * and rooms walled solid with doors only in the graph, which the gate's own fixtures are.
 */
import { describe, it, expect } from 'vitest';
import type { ArenaMap, ArenaRoom } from './arenas';
import { measureBodyAccess } from './arenaBodyAccess';

/** The four walls of a room, room-relative. */
const ring = (w: number, h: number) => [
  { x: 0, y: 0, w, h: 1 },
  { x: 0, y: h - 1, w, h: 1 },
  { x: 0, y: 0, w: 1, h },
  { x: w - 1, y: 0, w: 1, h },
];

/**
 * Rooms `l` (0..10) and `r` (10..20), 12 tall. `r`'s west wall is `l`'s east one, with a gap
 * into each half of `r`; `barred` lays a wall across `r` between the two gaps.
 */
function pair(barred: boolean): ArenaMap {
  const l: ArenaRoom = {
    id: 'l',
    rectGrid: { x: 0, y: 0, w: 10, h: 12 },
    solids: ring(10, 12).slice(0, 3),
  };
  const r: ArenaRoom = {
    id: 'r',
    rectGrid: { x: 10, y: 0, w: 10, h: 12 },
    solids: [
      ...ring(10, 12).filter((s) => !(s.x === 0 && s.w === 1)),
      { x: 0, y: 0, w: 1, h: 2 }, { x: 0, y: 4, w: 1, h: 4 }, { x: 0, y: 10, w: 1, h: 2 },
      ...(barred ? [{ x: 1, y: 6, w: 8, h: 1 }] : []),
    ],
    lootMarkers: [{ point: { x: 5, y: 3 }, tableId: 'arena_common' }, { point: { x: 5, y: 9 }, tableId: 'arena_common' }],
  };
  return {
    id: 'fixture_pair',
    sizeGrid: { w: 20, h: 12 },
    rooms: [l, r],
    doors: [{ roomA: 'l', roomB: 'r', passageGrid: { x: 10, y: 2, w: 1, h: 2 } }],
    spawns: [{ x: 4, y: 4 }],
    eyeCandidates: [{ roomId: 'l' }],
  };
}

describe('measureBodyAccess', () => {
  it('splits a room whose halves meet only through its neighbour', () => {
    expect(measureBodyAccess(pair(false))).toEqual({ splitRooms: [], unreached: [] });
    const { splitRooms, unreached } = measureBodyAccess(pair(true));
    expect(splitRooms).toEqual([{ room: 'r', pieces: 2 }]);
    // The smaller half is the south one (the bar sits below the middle): its loot is reported.
    expect(unreached).toEqual([{ room: 'r', feature: 'loot', at: { x: 15, y: 9 } }]);
  });

  it('holds a sealed room to its own floor, not to the largest room on the map', () => {
    // Doors only in the graph, the way the gate's fixtures are: a whole-map flood would strand
    // the smaller room and everything in it.
    const map: ArenaMap = {
      id: 'fixture_sealed',
      sizeGrid: { w: 40, h: 12 },
      rooms: [
        { id: 'big', rectGrid: { x: 0, y: 0, w: 14, h: 12 }, solids: ring(14, 12) },
        { id: 'small', rectGrid: { x: 20, y: 0, w: 8, h: 8 }, solids: ring(8, 8), spawns: [{ x: 1, y: 1 }] },
      ],
      doors: [],
      spawns: [{ x: 24, y: 4 }],
      eyeCandidates: [],
    };
    // (1, 1) is flush in the corner, where no body centre fits: the one-grid slack reaches it.
    expect(measureBodyAccess(map)).toEqual({ splitRooms: [], unreached: [] });
  });

  it('leaves content outside its own room, and a drop point outside every room, to other rules', () => {
    const map = pair(false);
    map.rooms[1] = { ...map.rooms[1]!, lootMarkers: [{ point: { x: 50, y: 50 }, tableId: 'arena_common' }] };
    map.spawns = [{ x: 30, y: 30 }];
    expect(measureBodyAccess(map).unreached).toEqual([]);
  });

  it('reports a drop point buried in stone against the room that holds it', () => {
    const map = pair(false);
    map.rooms[0] = { ...map.rooms[0]!, solids: [...map.rooms[0]!.solids, { x: 2, y: 2, w: 5, h: 5 }] };
    expect(measureBodyAccess(map).unreached).toEqual([{ room: 'l', feature: 'drop', at: { x: 4, y: 4 } }]);
  });
});
