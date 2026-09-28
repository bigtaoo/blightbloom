/**
 * `RoomBuilder.enterRoom` — `room_enter` rebuilds only a floor it has not drawn (`floorKey.ts`).
 *
 * Every room of a floor is placed when the floor is generated, so `room_enter` (the first step
 * into each room) used to rebuild the SAME floor several times per floor, mid-fight: ~11 ms of
 * build plus ~12 ms of re-triangulation in the next render on a 1080p desktop, i.e. a dropped
 * frame or two at every doorway. These pin both halves of the fix: the skip happens, and every
 * case where the geometry could really differ still rebuilds.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, DoorRuntime } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import type { PlacedRoom, RoomPiece } from '@dd/engine';
import { Layers } from './layers';
import { RoomBuilder } from './RoomBuilder';
import { Backdrop } from './Backdrop';
import type { DoorFixture } from './doorRender';

vi.mock('../../render/biomeTiles', () => ({
  getFloorTexture: () => undefined,
  getWallTexture: () => undefined,
  getWallFaceTexture: () => undefined,
  getPillarTexture: () => undefined,
}));

vi.mock('../../render/environmentSprites', () => ({
  getDoorTexture: () => undefined,
  getDoorCurtainTexture: () => undefined,
  getPortalArchTexture: () => undefined,
  getPickupTexture: () => undefined,
  getPropTexture: () => undefined,
}));

function room(id: string): PlacedRoom {
  const piece: RoomPiece = { id: `piece_${id}`, sizeGrid: { w: 20, h: 20 }, solids: [], spawns: { player: [], enemy: [] }, exits: [], props: [] };
  return { id, piece, offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } };
}

/** A dungeon-shaped state: one wall, one door (open), and a placed floor of two rooms. */
function dungeonState(): GameState {
  const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [[100, 100, 64, 64]], obstacles: [] });
  s.dungeonRooms.push(room('r1'), room('r2'));
  const passageAabb = { x: pxToFp(300), y: pxToFp(100), w: pxToFp(20), h: pxToFp(64) };
  s.dungeonDoors.push({ door: { roomA: 'r1', roomB: 'r2', passageGrid: { x: 300, y: 100, w: 20, h: 64 } }, passageAabb, locked: false } as DoorRuntime);
  return s;
}

function setup() {
  const layers = new Layers();
  const rb = new RoomBuilder(layers, new Backdrop(layers));
  const build = vi.spyOn(rb, 'build');
  return { layers, rb, build };
}

/** The ground layer's current children — a rebuild destroys and replaces every one of them. */
function groundKids(layers: Layers): Container[] {
  return [...layers.ground.children];
}

function doorFixtures(rb: RoomBuilder): DoorFixture[] {
  return (rb as unknown as { doorFixtures: DoorFixture[] }).doorFixtures;
}

describe('RoomBuilder.enterRoom', () => {
  it('does NOT rebuild a floor it has already drawn — the whole point', () => {
    const { layers, rb, build } = setup();
    const s = dungeonState();
    rb.build(s);
    const before = groundKids(layers);
    rb.enterRoom(s);
    rb.enterRoom(s);
    expect(build).toHaveBeenCalledTimes(1);
    // The same display objects, not an equal-looking rebuild of them.
    expect(groundKids(layers)).toEqual(before);
    expect(before.every((c) => !c.destroyed)).toBe(true);
  });

  it('rebuilds when nothing has been built yet', () => {
    const { rb, build } = setup();
    rb.enterRoom(dungeonState());
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on a NEW floor — generateAndPlaceFloor refills dungeonRooms with fresh rooms', () => {
    const { layers, rb, build } = setup();
    const s = dungeonState();
    rb.build(s);
    const before = groundKids(layers);
    // What SpawnSystem does in place on a descend: clear, then push newly placed rooms.
    s.dungeonRooms.length = 0;
    s.dungeonRooms.push(room('r1'), room('r2'));
    rb.enterRoom(s);
    expect(build).toHaveBeenCalledTimes(2);
    expect(before.every((c) => c.destroyed)).toBe(true);
  });

  it('rebuilds when the floor index moved, even if the first room object were somehow reused', () => {
    const { rb, build } = setup();
    const s = dungeonState();
    rb.build(s);
    s.floorIndex += 1;
    rb.enterRoom(s);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds for a different run state, even one sharing the floor index and the room object', () => {
    const { rb, build } = setup();
    const a = dungeonState();
    rb.build(a);
    const b = dungeonState();
    b.dungeonRooms[0] = a.dungeonRooms[0]!;
    rb.enterRoom(b);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('rebuilds after clear() — otherwise a restart would be left with an empty room', () => {
    const { layers, rb, build } = setup();
    const s = dungeonState();
    rb.build(s);
    rb.clear();
    expect(layers.ground.children).toHaveLength(0);
    rb.enterRoom(s);
    expect(build).toHaveBeenCalledTimes(2);
    expect(layers.ground.children.length).toBeGreaterThan(0);
  });

  it('always rebuilds a state with no placed rooms (flat / arena) — nothing vouches for its geometry', () => {
    const { rb, build } = setup();
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [[100, 100, 64, 64]], obstacles: [] });
    rb.build(s);
    rb.enterRoom(s);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a lock change after the skip still reaches the doors, through updateDoors like a fresh build', () => {
    // The room_enter tick is also the tick DoorSystem locks the room in; its door_locked event
    // follows room_enter and calls updateDoors. With the rebuild skipped, that call is what turns
    // the door — so the skipped path must end in the same lock state a fresh build would draw.
    const { rb } = setup();
    const s = dungeonState();
    rb.build(s);
    const fixture = doorFixtures(rb)[0]!;
    const setLocked = vi.spyOn(fixture, 'setLocked');
    const dr = s.dungeonDoors[0]!;
    dr.locked = true;
    s.walls.push(dr.passageAabb); // DoorSystem.rebuildWalls pushes the SAME object
    rb.enterRoom(s);
    rb.updateDoors(s);
    expect(doorFixtures(rb)[0]).toBe(fixture); // not rebuilt...
    expect(setLocked).toHaveBeenLastCalledWith(true, undefined); // ...but locked all the same
  });
});
