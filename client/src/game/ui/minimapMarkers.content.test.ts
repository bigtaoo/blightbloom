/**
 * The minimap's room markers against the SHIPPED level, through the real engine
 * (2026-10-03). `minimapLayout.test.ts` pins `dungeonRoomMarkers`'s rules on hand-made rooms;
 * this file pins what those rules make of level 1 as a run actually places it — every floor
 * map a run can draw (`floorMaps` plus every `floorLayoutVariants` entry), placed by
 * `SpawnSystem`, with `state.chests`/`state.shops` as `SpawnSystem` itself fills them.
 *
 * What it catches that the unit tests cannot: a capstone authored without a role (or a role
 * on the wrong room), a side room whose chest or counter lands under a `roomId` the minimap
 * does not draw, and a side room accidentally made the capstone, where the exit marker would
 * silently hide the chest.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine, EMBER_DUNGEON, EMBER_L1_ROOMS } from '@dd/engine';
import type { DungeonFloorMap } from '@dd/engine/world/dungeon';
import { dungeonRoomMarkers } from './minimapLayout';

const LAST_FLOOR = EMBER_DUNGEON.floorCount - 1;

/** Every authored map a run can place, with the floor index it is placed on. */
function everyFloorMap(): { floor: number; map: DungeonFloorMap }[] {
  const out: { floor: number; map: DungeonFloorMap }[] = [];
  for (let floor = 0; floor <= LAST_FLOOR; floor++) {
    const maps = EMBER_DUNGEON.floorLayoutVariants?.[floor] ?? [EMBER_DUNGEON.floorMaps![floor]!];
    for (const map of maps) out.push({ floor, map });
  }
  return out;
}

/** A real engine whose FIRST floor is `map`, stepped once so `SpawnSystem` places it. The
 * marker rules never read the floor index, so placing a later floor's map on floor 0 tests
 * exactly what that floor would show. */
function placed(map: DungeonFloorMap) {
  const engine = createGameEngine({
    seed: 7, worldW: 4000, worldH: 4000, waves: [], skinId: 'vanguard', loadout: [],
    dungeon: { config: { ...EMBER_DUNGEON, floorMaps: { 0: map }, floorLayoutVariants: undefined }, library: EMBER_L1_ROOMS },
  });
  engine.step([]);
  return engine.state;
}

describe('minimap markers on the shipped level 1', () => {
  const floors = everyFloorMap();

  it('sweeps every map a run can draw, not just the five plain floors', () => {
    // 5 plain floors + the three branch variants (floors 1-3).
    expect(floors.length).toBe(8);
  });

  it.each(floors.map((f) => [`floor ${f.floor} — ${f.map.id}`, f] as const))(
    '%s: the capstone, and only the capstone, carries the exit (boss on the last floor)',
    (_name, { floor, map }) => {
      const s = placed(map);
      expect(s.dungeonRooms.map((r) => r.id)).toEqual(map.rooms.map((r) => r.id));
      const markers = dungeonRoomMarkers(s.dungeonRooms, s.chests, s.shops);

      const capstones = [...markers].filter(([, m]) => m === 'exit' || m === 'boss');
      // The last placed room is what ExtractionSystem gates the floor on.
      expect(capstones).toEqual([[s.dungeonRooms.at(-1)!.id, floor === LAST_FLOOR ? 'boss' : 'exit']]);
    },
  );

  it.each(floors.map((f) => [`floor ${f.floor} — ${f.map.id}`, f] as const))(
    '%s: every chest and every shop the floor placed is marked on its own room',
    (_name, { map }) => {
      const s = placed(map);
      const markers = dungeonRoomMarkers(s.dungeonRooms, s.chests, s.shops);
      const drawn = new Set(s.dungeonRooms.map((r) => r.id));

      for (const c of s.chests) expect(drawn.has(c.roomId)).toBe(true);
      for (const sh of s.shops) expect(drawn.has(sh.roomId)).toBe(true);
      // Each room's marker is exactly what it holds, by the shop > chest priority — the vault
      // (floor index 2) authors BOTH its big chest and the run's second counter.
      for (const r of s.dungeonRooms.slice(0, -1)) {
        const shop = s.shops.some((sh) => sh.roomId === r.id);
        const chest = s.chests.some((c) => c.roomId === r.id);
        expect(markers.get(r.id)).toBe(shop ? 'shop' : chest ? 'chest' : undefined);
      }
    },
  );

  it('the level as a whole places chests and a shop — the sweep above is not vacuous', () => {
    let chests = 0;
    let shops = 0;
    for (const { map } of floors) {
      const s = placed(map);
      chests += s.chests.length;
      shops += s.shops.length;
    }
    expect(chests).toBeGreaterThanOrEqual(5);
    expect(shops).toBeGreaterThanOrEqual(1);
  });

  it('a room holding both shows the shop while it has stock, then the chest, then nothing', () => {
    const vault = floors.find(({ map }) => map.rooms.some((r) => r.pieceId === 'ember_l1_vault'))!;
    const s = placed(vault.map);
    const shop = s.shops[0]!;
    const chest = s.chests.find((c) => c.roomId === shop.roomId)!;
    expect(chest).toBeDefined();
    const markerNow = () => dungeonRoomMarkers(s.dungeonRooms, s.chests, s.shops).get(shop.roomId);

    expect(markerNow()).toBe('shop');
    for (const o of shop.stock) o.sold = true;
    expect(markerNow()).toBe('chest');
    chest.opened = true;
    expect(markerNow()).toBeUndefined();
  });
});
