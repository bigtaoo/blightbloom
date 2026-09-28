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
import { Container, type Graphics } from 'pixi.js';
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
  const staged = vi.spyOn(rb, 'buildStaged');
  return { layers, rb, build, staged };
}

/** Render frames until a staged build is done (`tickFixtures` is what advances it). */
function finish(rb: RoomBuilder, dt = 16): number {
  let frames = 0;
  while (rb.building && frames < 1000) {
    rb.tickFixtures(dt, null, null);
    frames++;
  }
  return frames;
}

/** A clock on which every step takes the whole 4 ms budget, so each frame runs exactly one step —
 *  node runs a whole small floor inside one real budget, which would hide the middle of a build. */
function oneStepPerFrame(): () => void {
  let t = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => (t += 5));
  return () => now.mockRestore();
}

/** The descend cover: the first child `DescendCover` puts under the screen-space UI. */
function coverOf(layers: Layers): Graphics {
  return layers.ui.children[0] as Graphics;
}

/** A new floor in place, the way SpawnSystem does it on a descend: clear, then push new rooms. */
function descend(s: GameState): void {
  s.dungeonRooms.length = 0;
  s.dungeonRooms.push(room('r1'), room('r2'));
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
    const { layers, rb, staged } = setup();
    const s = dungeonState();
    rb.build(s);
    const before = groundKids(layers);
    descend(s);
    rb.enterRoom(s);
    expect(staged).toHaveBeenCalledTimes(1); // a descend: staged, not synchronous
    finish(rb);
    expect(before.every((c) => c.destroyed)).toBe(true);
    expect(layers.ground.children.length).toBeGreaterThan(0);
  });

  it('rebuilds when the floor index moved, even if the first room object were somehow reused', () => {
    const { rb, staged } = setup();
    const s = dungeonState();
    rb.build(s);
    s.floorIndex += 1;
    rb.enterRoom(s);
    expect(staged).toHaveBeenCalledTimes(1);
  });

  it('rebuilds for a different run state, even one sharing the floor index and the room object', () => {
    const { rb, staged } = setup();
    const a = dungeonState();
    rb.build(a);
    const b = dungeonState();
    b.dungeonRooms[0] = a.dungeonRooms[0]!;
    rb.enterRoom(b);
    expect(staged).toHaveBeenCalledTimes(1);
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

/**
 * A descend's floor, built over frames behind a cover (2026-09-28). Measured before: the frame a new
 * floor's `room_enter` landed cost 48 ms on a 1080p desktop (24 ms of build, 20 ms of render, 12 of it
 * triangulating the new geometry) — three vsyncs, every descend. These pin that the staged path
 * builds the same floor the synchronous one does, that the player never sees it half-built, and
 * that every way out of the middle of one is clean.
 */
describe('RoomBuilder — a descend builds over frames, behind the cover', () => {
  /** What a build leaves standing, as counts per layer — the shape two builds are compared by. */
  function census(layers: Layers): number[] {
    return [layers.ground.children.length, layers.entities.children.length, layers.shadow.children.length];
  }

  it('builds exactly what the synchronous build builds', () => {
    const sync = setup();
    const a = dungeonState();
    sync.rb.build(a);
    descend(a);
    sync.rb.build(a);

    const stagedRb = setup();
    const b = dungeonState();
    stagedRb.rb.build(b);
    descend(b);
    stagedRb.rb.enterRoom(b);
    finish(stagedRb.rb);

    expect(census(stagedRb.layers)).toEqual(census(sync.layers));
    expect(census(sync.layers).every((n) => n > 0)).toBe(true);
  });

  it('takes more than one frame and covers the world the whole time it is building', () => {
    const { layers, rb } = setup();
    const s = dungeonState();
    rb.build(s);
    expect(coverOf(layers).visible).toBe(false); // a run's first build is never covered
    descend(s);
    rb.enterRoom(s);
    expect(rb.building).toBe(true);
    let frames = 0;
    const restore = oneStepPerFrame();
    while (rb.building) {
      expect(coverOf(layers).visible).toBe(true);
      expect(coverOf(layers).alpha).toBe(1);
      rb.tickFixtures(16, null, null);
      frames++;
    }
    restore();
    expect(frames).toBeGreaterThan(3);
  });

  it('fades the cover out once the floor is up, and then it is gone', () => {
    const { layers, rb } = setup();
    const s = dungeonState();
    rb.build(s);
    descend(s);
    rb.enterRoom(s);
    finish(rb);
    const cover = coverOf(layers);
    rb.tickFixtures(16, null, null);
    expect(cover.alpha).toBeLessThan(1);
    expect(cover.alpha).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) rb.tickFixtures(16, null, null);
    expect(cover.visible).toBe(false);
  });

  it('keeps the HUD above the cover — it goes under everything already in the UI layer', () => {
    const { layers } = setup();
    expect(layers.ui.children.indexOf(coverOf(layers))).toBe(0);
    expect(layers.ui.children.indexOf(layers.hudOverlay)).toBeGreaterThan(0);
  });

  it('clear() mid-build drops the rest and uncovers; the next floor then builds at once', () => {
    const { layers, rb, build } = setup();
    const s = dungeonState();
    rb.build(s);
    descend(s);
    rb.enterRoom(s);
    rb.tickFixtures(16, null, null);
    rb.clear();
    expect(rb.building).toBe(false);
    expect(coverOf(layers).visible).toBe(false);
    expect(layers.ground.children).toHaveLength(0);
    rb.enterRoom(s); // nothing built: synchronous, as a run's first floor always was
    expect(build).toHaveBeenCalledTimes(2);
    expect(rb.building).toBe(false);
    expect(layers.ground.children.length).toBeGreaterThan(0);
  });

  it('a synchronous build during a staged one supersedes it rather than interleaving', () => {
    const sync = setup();
    const a = dungeonState();
    sync.rb.build(a);

    const { layers, rb } = setup();
    const s = dungeonState();
    rb.build(s);
    descend(s);
    rb.enterRoom(s);
    rb.tickFixtures(16, null, null);
    rb.build(s);
    expect(rb.building).toBe(false);
    expect(census(layers)).toEqual(census(sync.layers));
  });

  it('door calls in the middle of a build are safe, and the finished doors answer them', () => {
    const { rb } = setup();
    const s = dungeonState();
    rb.build(s);
    descend(s);
    rb.enterRoom(s);
    const restore = oneStepPerFrame();
    rb.tickFixtures(16, null, null); // the old floor is gone, the new doors are not up yet
    restore();
    expect(rb.building).toBe(true);
    expect(() => {
      rb.updateDoors(s);
      rb.rejectDoor(0);
      rb.setPortalOpen(true);
    }).not.toThrow();
    finish(rb);
    expect(doorFixtures(rb)).toHaveLength(1);
    const setLocked = vi.spyOn(doorFixtures(rb)[0]!, 'setLocked');
    s.dungeonDoors[0]!.locked = true;
    rb.updateDoors(s);
    expect(setLocked).toHaveBeenLastCalledWith(true, undefined);
  });

  it("the old floor's doors and portal are gone from the first building frame, not just their art", () => {
    const { rb } = setup();
    const s = dungeonState();
    rb.build(s);
    expect(rb.portalPx).not.toBeNull();
    descend(s);
    rb.enterRoom(s);
    const restore = oneStepPerFrame();
    rb.tickFixtures(16, null, null);
    restore();
    expect(rb.building).toBe(true);
    expect(doorFixtures(rb)).toHaveLength(0);
    expect(rb.portalPx).toBeNull();
    expect(rb.doorFootprint(0)).toBeNull();
  });
});
