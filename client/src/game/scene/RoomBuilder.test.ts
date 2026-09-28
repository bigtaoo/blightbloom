/**
 * RoomBuilder (design/13's biome floor/wall art pass). `build()` picks a real tileable
 * `TilingSprite` swatch when `render/biomeTiles.ts` has one for the room's element,
 * else falls back to the same flat `Graphics` fill this repo shipped with before any
 * biome art existed — memory of this session claimed that fallback was
 * "byte-identical, confirmed by diff read-through" but never had an automated test.
 * `render/biomeTiles.ts` is mocked here (network-independent, controllable per test)
 * rather than exercised for real — biomeTiles.test.ts already covers its own registry/
 * preload contract.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Graphics, Sprite, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState, DoorRuntime } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { PLAYER_BASE } from '@dd/engine';
import type { PlacedRoom, PropPlacement, RoomPiece } from '@dd/engine';
import { Layers } from './layers';
import { RoomBuilder } from './RoomBuilder';
import { DOOR_H, WALL_H_PERIMETER, WALL_H_INTERIOR, WALL_H_KERB } from './wallGeometry';
import { groundPieceBounds } from './groundCulling';
import { deepFadeReach, XRAY_DEEP_LABEL, XRAY_LABEL } from './occlusion';
import { fpToPx, PX_PER_GRID } from '../coords';
import { Entity, SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import { Backdrop } from './Backdrop';
import { pillarTint } from './pillarRender';
import { propShadowRadius } from './propRender';
import { biomePalette } from '../theme';
import type { DoorFixture } from './doorRender';
import { FACE_BASE_LABEL } from './wallRender';

function makeRoomBuilder(layers = new Layers()): RoomBuilder {
  return new RoomBuilder(layers, new Backdrop(layers));
}

interface Occ {
  cap: { fade: number };
  deep: { fade: number };
  box: { left: number; right: number; top: number; sortY: number; foldY: number };
}

/** The x-ray occluder list RoomBuilder registers every standing block into — walls, pillars and
 *  (since 2026-08-20) doors. Module-scope because both the door tests and the x-ray tests read it. */
function occluders(rb: RoomBuilder): Occ[] {
  return (rb as unknown as { occluders: Occ[] }).occluders;
}

function doorFixtures(rb: RoomBuilder): DoorFixture[] {
  return (rb as unknown as { doorFixtures: DoorFixture[] }).doorFixtures;
}

/** The leaf sprite of door `i` — the one plain Sprite child of a fixture (its stone is
 *  TilingSprites, its recess/glow/shading Graphics). */
function leafOf(rb: RoomBuilder, i: number): Sprite {
  const kid = doorFixtures(rb)[i]!.view.children.find(
    (c) => c instanceof Sprite && !(c instanceof TilingSprite),
  );
  return kid as Sprite;
}

/**
 * Which of door `i`'s lock-state lights are live, in child order.
 *
 * A door's additive children are its two states' signals — the locked hazard bloom, and (since
 * 2026-08-30) the open state's through-light and spill — and exactly one state's worth is visible
 * at a time. This used to `find()` the first additive child and call it "the hazard bloom", which
 * silently became the through-light the moment a second one existed; the vector is what
 * `RoomBuilder` is actually responsible for anyway, since all it owns is that `updateDoors` drives
 * the swap at all. `doorRender.test.ts` is where the individual layers are pinned.
 */
function stateLightsOf(rb: RoomBuilder, i: number): boolean[] {
  return doorFixtures(rb)[i]!
    .view.children.filter((c) => c instanceof Graphics && c.blendMode === 'add')
    .map((c) => c.visible);
}

/** How tall door `i` was built — read back off its occluder's cap/face fold rather than from a
 *  private field, so the assertion is on geometry that actually reached the screen. */
function doorHeightOf(rb: RoomBuilder, i: number): number {
  const view = doorFixtures(rb)[i]!.view;
  // Matched on `left` as well as `sortY`: a door is cut INTO a wall, so the runs flanking it
  // share its ground line by construction, and `sortY` alone picks whichever occluder was pushed
  // first — the wall. That went unnoticed while a door stood at its flank's own height (the two
  // answers were equal); it reads the wall's 22 px the moment they differ.
  const box = occluders(rb).find((o) => o.box.sortY === view.y && o.box.left === view.x)!.box;
  return box.sortY - box.foldY;
}

/** How tall every NON-door standing block was built, same cap/face fold read as `doorHeightOf`.
 *  The control for a door-height assertion: `DOOR_H` must move the door and nothing else. */
function wallHeights(rb: RoomBuilder): number[] {
  // Keyed on the same `(sortY, left)` pair `doorHeightOf` matches on, for the same reason: a
  // door's flanking runs share its ground line, so dropping every occluder on that line would
  // drop the walls this is trying to look at.
  const doorKeys = new Set(doorFixtures(rb).map((d) => `${d.view.y},${d.view.x}`));
  return occluders(rb)
    .filter((o) => !doorKeys.has(`${o.box.sortY},${o.box.left}`))
    .map((o) => o.box.sortY - o.box.foldY);
}

const mocks = vi.hoisted(() => ({
  floorTex: undefined as Texture | undefined,
  wallTex: undefined as Texture | undefined,
  wallFaceTex: undefined as Texture | undefined,
  pillarTex: undefined as Texture | undefined,
  pillarTexElement: undefined as string | undefined,
  doorLockedTex: undefined as Texture | undefined,
  doorOpenTex: undefined as Texture | undefined,
  curtainTex: undefined as Texture | undefined,
}));

vi.mock('../../render/biomeTiles', () => ({
  getFloorTexture: () => mocks.floorTex,
  getWallTexture: () => mocks.wallTex,
  getWallFaceTexture: () => mocks.wallFaceTex,
  getPillarTexture: (el: string) => {
    mocks.pillarTexElement = el;
    return mocks.pillarTex;
  },
}));

vi.mock('../../render/environmentSprites', () => ({
  getDoorTexture: (locked: boolean) => (locked ? mocks.doorLockedTex : mocks.doorOpenTex),
  // Undefined by default — the open door falls back to its procedural through-light, and
  // doorRender.test.ts owns the curtain's own state machine. `mocks.curtainTex` lets the one
  // test below that cares (RoomBuilder actually WIRES this getter's result into the door skin)
  // set it without touching every other door test's assumed default.
  getDoorCurtainTexture: () => mocks.curtainTex,
  // RoomBuilder builds a Portal per room, and Portal reaches into this same module for its
  // arch (2026-08-20). Left unloaded here so a portal keeps its Graphics fallback — this
  // file's subject is the room, and Portal.test.ts owns both of the arch's paths.
  getPortalArchTexture: () => undefined,
  getPickupTexture: () => undefined,
  // No prop art exists yet (propRender.ts's own Graphics fallback) — undefined here matches
  // that, and keeps this file's props coverage independent of a future art pass.
  getPropTexture: () => undefined,
}));

// `NormalLitFilter` builds a real WebGL GlProgram at construction time — unavailable under
// plain vitest (no `document`/canvas) — and since the 2026-08-18 depth pass RoomBuilder builds
// one per standing wall. Same bare-class stub Actor.test.ts/FxController.test.ts already use;
// the tuning constants are re-exported for real so the wall/actor look assertions below are
// checked against the shipped numbers rather than against fixtures.
vi.mock('../fx/filters', async () => ({
  ...(await vi.importActual<typeof import('../fx/filters')>('../fx/filters')),
  NormalLitFilter: class {
    constructor(
      public keyColor?: number,
      public keyIntensity?: number,
      public opts?: { ambient?: number; gradient?: number },
    ) {}
  },
}));

/** A `DoorRuntime`-shaped fixture (design/05 DoorSystem) at a given px rect. Pushing
 *  the SAME `passageAabb` object into `s.walls` too (only when `locked`) mirrors
 *  `DoorSystem.rebuildWalls`'s real behaviour — it pushes the identical reference,
 *  never a copy — which is what RoomBuilder's reference-identity skip depends on. */
function pushDoor(s: GameState, locked: boolean, [x, y, w, h]: [number, number, number, number]): void {
  const passageAabb = { x: pxToFp(x), y: pxToFp(y), w: pxToFp(w), h: pxToFp(h) };
  s.dungeonDoors.push({ door: { roomA: 'a', roomB: 'b', passageGrid: { x, y, w, h } }, passageAabb, locked } as DoorRuntime);
  if (locked) s.walls.push(passageAabb);
}

function fakeTexture(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

/**
 * The drawn height of a wall block's front elevation, summed over its pieces.
 *
 * A block's face is drawn as one piece or TWO, split at the row past which the x-ray's deep pass
 * can never need to reach (`occlusion.deepFadeReach` / `wallRender.FACE_BASE_LABEL`), so the first
 * TilingSprite is not the whole elevation. How many pieces it takes is the x-ray's business; how
 * tall the wall stands is what these tier assertions are about.
 */
function faceHeight(seg: Entity): number {
  return seg.children
    .filter(
      (c): c is TilingSprite =>
        c instanceof TilingSprite && (c.label === XRAY_DEEP_LABEL || c.label === FACE_BASE_LABEL),
    )
    .reduce((n, p) => n + p.height, 0);
}

function stateWithOneWall(biomeId: string | undefined): GameState {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 600, waves: [],
    walls: [[100, 100, 64, 64]],
    obstacles: [],
  });
  // dungeonConfig is otherwise only populated via the full dungeon-generation config
  // (floorCount/pieceTags/etc.) — RoomBuilder only ever reads `.biomeId` off it (via
  // config.ts's biomeElementOf), so a minimal cast fixture is enough here.
  (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = biomeId ? { biomeId } : undefined;
  return s;
}

/**
 * Every node under `layers.ground`, in PAINT order (depth-first pre-order).
 *
 * Recursive since 2026-08-26: the ground stage is mounted one piece per room/region/door so the
 * camera can cull it (`groundCulling.ts`), and a region's floor sprites now sit inside that
 * region's own container — one level deeper than a direct `children` scan reaches.
 */
function groundNodes(layers: Layers): Container[] {
  const walk = (c: Container): Container[] => c.children.flatMap((k) => [k, ...walk(k)]);
  return walk(layers.ground);
}

/** The floor's stamped tiles, wherever they are mounted. */
function groundTiles(layers: Layers): Sprite[] {
  return groundNodes(layers).filter((c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite) && !(c instanceof Graphics));
}

describe('RoomBuilder — no biome art registered (fallback)', () => {
  it('fills the ground with flat Graphics, not a TilingSprite', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const ground = groundNodes(layers);
    expect(ground.some((c) => c instanceof TilingSprite)).toBe(false);
    expect(ground.some((c) => c instanceof Graphics)).toBe(true);
  });

  it('still builds every wall as a standing block — a missing swatch never flattens one', () => {
    // Pre-2026-08-18 a wall with no art was drawn flat on the GROUND layer. Now only the ART
    // falls back, never the geometry: the block stands either way (wallRender.ts).
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    mocks.wallFaceTex = undefined;
    const rb = makeRoomBuilder();
    rb.build(stateWithOneWall('ember'));
    expect((rb as unknown as { wallEntities: Entity[] }).wallEntities).toHaveLength(1);
  });
});

describe('RoomBuilder — biome art registered for this element', () => {
  // Since 2026-08-20 the ground fill is STAMPED (`floorRender.stampFloor`), not tiled: one Sprite
  // per tile of a world-aligned grid, so each can be mirrored independently. A single
  // `TilingSprite` gave the whole game one 256 px period, identical in every room.
  // The change that mattered most in the 2026-08-20 floor pass, and the one a mutation battery
  // caught as untested: the floor STOPS AT THE ROOMS. `worldW/worldH` are the bounding box of a
  // floor's co-resident rooms, which on a `graph2d` layout is 1.4-2.3x their own area
  // (`floorCoverage.test.ts`), and everything painted in between belonged to the backdrop.
  it('stamps the floor only where the rooms are, not over the whole world bounding box', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    const s = createGameState({ seed: 1, worldW: 1000, worldH: 1000, waves: [], walls: [], obstacles: [] });
    // One 256x256 room in a 1000x1000 world: 6.5% of the bounding box.
    s.dungeonRoomRects.push({ id: 'r', rect: { x: pxToFp(128), y: pxToFp(128), w: pxToFp(256), h: pxToFp(256) } });
    rb.build(s);
    const tiles = groundTiles(layers);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, area = 0;
    for (const t of tiles) {
      const w = Math.abs(t.width);
      const h = Math.abs(t.height);
      const x0 = t.x - w * t.anchor.x;
      const y0 = t.y - h * t.anchor.y;
      minX = Math.min(minX, x0); minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x0 + w); maxY = Math.max(maxY, y0 + h);
      area += w * h;
    }
    expect(minX).toBeCloseTo(128, 3);
    expect(minY).toBeCloseTo(128, 3);
    expect(maxX).toBeCloseTo(384, 3);
    expect(maxY).toBeCloseTo(384, 3);
    expect(area).toBeCloseTo(256 * 256, 3); // exactly the room, no gap and no overhang
  });

  // ...but an ARENA's rooms are not a partition of its walkable space (`floorCoverage.test.ts`
  // measures 5240 reachable cells outside them on the shipped 60-room map), so it keeps the
  // whole-world floor. A per-room floor there would leave a player walking over the backdrop.
  it('keeps the whole-world floor when there are no dungeon rooms (arena / flat modes)', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    const s = createGameState({ seed: 1, worldW: 640, worldH: 320, waves: [], walls: [], obstacles: [] });
    s.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(128), h: pxToFp(128) } });
    rb.build(s);
    const tiles = groundTiles(layers);
    const area = tiles.reduce((a, t) => a + Math.abs(t.width) * Math.abs(t.height), 0);
    expect(area).toBeCloseTo(640 * 320, 3); // the whole world, NOT the one 128x128 arena room
  });

  it('stamps the ground fill as one Sprite per tile, all from the floor swatch', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    const s = stateWithOneWall('ember'); // 800x600 world, no dungeon rooms -> one region
    rb.build(s);
    const tiles = groundTiles(layers);
    expect(tiles.length).toBe(Math.ceil(800 / 64) * Math.ceil(600 / 64));
    expect(tiles.every((t) => t.texture.source === mocks.floorTex!.source)).toBe(true);
    expect(groundNodes(layers).some((c) => c instanceof TilingSprite)).toBe(false);
  });

  it('uses the wall swatch as each standing block\'s top CAP, at the wall rect', () => {
    // Since 2026-08-18 `wall_<element>.png` is the raised cap, not a flat ground footprint —
    // the block itself sits on the entities layer, so the swatch is found there.
    mocks.floorTex = undefined;
    mocks.wallTex = fakeTexture(32, 32);
    mocks.wallFaceTex = undefined;
    const rb = makeRoomBuilder();
    const rect = { x: 100, y: 100, w: 64, h: 64 };
    rb.build(stateWithOneWall('ember'));
    const seg = (rb as unknown as { wallEntities: Entity[] }).wallEntities[0]!;
    const cap = seg.children.find((c) => c instanceof TilingSprite) as TilingSprite | undefined;
    expect(cap).toBeDefined();
    expect(cap!.texture).toBe(mocks.wallTex);
    // Config is given in px, converted to fp and back — a round trip, not a rescale. The
    // block's own container carries the position; the cap is local, lifted by the height.
    expect(seg.x).toBeCloseTo(rect.x);
    expect(seg.y).toBeCloseTo(rect.y + rect.h);
    // The silhouette outline still renders on top, same as before.
    expect(seg.children.some((c) => c instanceof Graphics)).toBe(true);
  });

  it('falls back to Graphics for an element with no swatch registered (e.g. neutral/poison), even with other elements loaded', () => {
    mocks.floorTex = undefined; // simulates: this call's element has no registered swatch
    mocks.wallTex = undefined;
    mocks.wallFaceTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall(undefined)); // undefined biomeId -> 'neutral' element
    expect(groundNodes(layers).some((c) => c instanceof TilingSprite)).toBe(false);
  });
});

// Standing walls (2026-08-18, design/01's "walls show a small front face"). `wallRises`
// owns WHICH walls stand (wallGeometry.test.ts); this block covers what RoomBuilder then
// draws — the layer it goes on, the zIndex it sorts by, and the face/cap geometry.
describe('RoomBuilder — standing walls', () => {
  /** One east-west wall spanning the north edge of a single 480×480 room at the origin. */
  function stateWithNorthWall(): GameState {
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [[0, 0, 480, 32]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    return s;
  }

  function wallEntities(rb: RoomBuilder): Entity[] {
    return (rb as unknown as { wallEntities: Entity[] }).wallEntities;
  }

  /** The shared wall-shadow Graphics. Read off the private field rather than found by type on
   *  `layers.shadow`, which also carries the portal's and every actor's own shadow. */
  function wallShadows(rb: RoomBuilder): Graphics | null {
    return (rb as unknown as { wallShadows: Graphics | null }).wallShadows;
  }

  it('puts it on the Y-sortable entities layer, not the ground layer, sorted by its SOUTH edge', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithNorthWall());

    expect(wallEntities(rb).length).toBe(1);
    const seg = wallEntities(rb)[0]!;
    expect(layers.entities.children).toContain(seg);
    expect(layers.ground.children).not.toContain(seg);
    // The wall footprint is y 0..32, so it stands on the line y=32 and an actor at any
    // larger gy (i.e. deeper into the room) draws in front of it.
    expect(seg.x).toBe(0);
    expect(seg.y).toBe(32);
    expect(seg.zIndex).toBe(32);
  });

  it('draws the face one PERIMETER height tall ending at the south edge, cap stacked above it', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithNorthWall());
    // The face is TWO pieces here — the x-ray's deep pass may only reach the rows a body can
    // stand in front of, so the rest of the elevation is a separate never-fading piece
    // (`occlusion.deepFadeReach`). Both are the same swatch at the same scale; between them they
    // stack over exactly -height..0.
    const [face, base, cap] = wallEntities(rb)[0]!.children as [TilingSprite, TilingSprite, TilingSprite];

    expect(face.texture).toBe(mocks.wallFaceTex);
    expect(base.texture).toBe(mocks.wallFaceTex);
    expect(faceHeight(wallEntities(rb)[0]!)).toBe(WALL_H_PERIMETER); // a room boundary → tallest tier
    expect(face.y).toBe(-WALL_H_PERIMETER); // local origin is the south edge; the face rises from it
    expect(base.y + base.height).toBe(0);
    // Uniform tile scale — the face art is used at exactly one height and must not stretch.
    expect(face.tileScale.y).toBeCloseTo(WALL_H_PERIMETER / 128, 5);
    expect(face.tileScale.x).toBeCloseTo(face.tileScale.y, 5);

    expect(cap.texture).toBe(mocks.wallTex);
    expect(cap.height).toBe(32); // the footprint's own depth, lifted to the top of the face
    expect(cap.y).toBe(-WALL_H_PERIMETER - 32);
  });

  it('casts every wall\'s ground shadow onto ONE shared Graphics on the shadow layer', () => {
    // Standing walls threw no shadow at all before 2026-08-18 — the one tall thing in a room
    // not using design/01's "cheapest 3D cheat", and the main reason they read as printed on.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithNorthWall());

    const shadows = wallShadows(rb)!;
    expect(shadows).toBeDefined();
    expect(layers.shadow.children).toContain(shadows);
    // Reaches past the footprint's own south-east corner, i.e. away from the key light.
    expect(shadows.bounds.maxX).toBeGreaterThan(480);
    expect(shadows.bounds.maxY).toBeGreaterThan(32);
  });

  it('destroys the shared shadow Graphics on rebuild and on clear()', () => {
    // It lives on `layers.shadow`, which build()/clear() never sweep wholesale (actor and
    // portal shadows live there too), so it has to be torn down explicitly like the wall
    // entities themselves.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithNorthWall());
    const first = wallShadows(rb)!;

    rb.build(stateWithNorthWall());
    expect(first.destroyed).toBe(true);
    expect(layers.shadow.children).not.toContain(first);

    const second = wallShadows(rb)!;
    expect(second).not.toBe(first);
    rb.clear();
    expect(second.destroyed).toBe(true);
    expect(wallShadows(rb)).toBeNull();
  });

  it('attaches NO per-segment filter — a room of walls costs zero render targets', () => {
    // The per-segment `NormalLitFilter` this once optionally attached (`LIT_WALLS`) was
    // measured on 2026-08-19 at a 0.06% mean difference (0.05% of pixels moving more than
    // 5/255) for one render-target pass per segment, up to 32 per room, and removed entirely
    // 2026-08-20 (see RoomBuilder.ts's git history) rather than kept as a permanently-off
    // switch. This is the cheapest possible guard on that decision staying real: if something
    // re-attaches a filter per wall, the cost is back.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithNorthWall());
    for (const seg of wallEntities(rb)) expect(seg.filters ?? []).toEqual([]);
  });

  it('still stands the wall up with no face art, using Graphics (a missing swatch never flattens it)', () => {
    mocks.wallTex = undefined;
    mocks.wallFaceTex = undefined;
    const rb = makeRoomBuilder();
    rb.build(stateWithNorthWall());
    const seg = wallEntities(rb)[0]!;
    expect(seg.zIndex).toBe(32);
    expect(seg.children.every((c) => c instanceof Graphics)).toBe(true);
    expect(seg.children.some((c) => c instanceof TilingSprite)).toBe(false);
  });

  it('a rebuild and a clear() both destroy the previous segments (they outlive the ground sweep)', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithNorthWall());
    const first = wallEntities(rb)[0]!;

    rb.build(stateWithNorthWall());
    expect(first.destroyed).toBe(true);
    expect(wallEntities(rb).length).toBe(1);
    expect(layers.entities.children).not.toContain(first);

    const second = wallEntities(rb)[0]!;
    rb.clear();
    expect(second.destroyed).toBe(true);
    expect(wallEntities(rb).length).toBe(0);
  });

  it('stands the room\'s south wall up too, but only as a low kerb', () => {
    // It used to stay dead flat on the ground layer: standing it at full height would put a
    // metre of stone between the camera and the player it is framing. A kerb is short enough
    // that the player's own collision radius keeps them well clear of it, and it still casts.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [[0, 448, 480, 32]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };

    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);

    expect(wallEntities(rb).length).toBe(1);
    const seg = wallEntities(rb)[0]!;
    const face = seg.children.find((c) => c instanceof TilingSprite) as TilingSprite;
    expect(face.height).toBe(WALL_H_KERB);
    expect(face.height).toBeLessThan(WALL_H_PERIMETER);
    expect(layers.ground.children.some((c) => c instanceof TilingSprite && c.texture === mocks.wallTex)).toBe(false);
  });

  it('gives an interior block a shorter height than the room\'s own boundary', () => {
    // Height variety, from one build: without it every vertical surface in the room is the
    // same size and the eye has no relative measure to read depth from.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [[0, 0, 480, 32], [128, 128, 64, 64]], // north perimeter + a kiln-style 2×2 block
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };

    const rb = makeRoomBuilder();
    rb.build(s);
    const heights = wallEntities(rb).map(faceHeight);
    expect(heights).toEqual([WALL_H_PERIMETER, WALL_H_INTERIOR]);
  });
});

function stateWithOneObstacle(): GameState {
  const s = createGameState({
    seed: 1, worldW: 800, worldH: 600, waves: [],
    walls: [],
    obstacles: [[150, 120, 20]],
  });
  (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
  return s;
}

describe('RoomBuilder — pillars (design/10 legibility fix, 2026-08-02: faux-shading)', () => {
  it('creates one Entity per obstacle, positioned at its grid coords (px round trip)', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    // The pillar plus the room's own portal (Portal.ts, design/10 legibility fix
    // 2026-08-02) — the portal is built AFTER pillars, so index 0 is still the pillar.
    expect(layers.entities.children.length).toBe(2);
    const pillar = layers.entities.children[0]!;
    // px -> fp -> px round trip through the grid quantizes to a fraction of a pixel
    // (same tolerance the existing wall test's `toBeCloseTo(100)` needed, just spelled
    // out here since 150 doesn't happen to land on a round grid step).
    expect(pillar.x).toBeCloseTo(150, 1);
    expect(pillar.y).toBeCloseTo(120, 1);
  });

  it('gives the pillar body real drawn geometry, not a blank placeholder', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    const pillar = layers.entities.children[0]!;
    const body = pillar.children[0] as Graphics;
    // Shading bands + rim strokes extend a little past the base body rect — real
    // drawn content, not a zero-size stub.
    expect(body.getLocalBounds().width).toBeGreaterThan(0);
    expect(body.getLocalBounds().height).toBeGreaterThan(0);
  });

  it('adds a matching shadow to the shadow layer for each pillar', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    // The pillar's shadow, the portal's own (Portal.ts also calls makeShadow()), and the
    // shared wall-shadow Graphics (empty here — this fixture has no walls — but still added).
    expect(layers.shadow.children.length).toBe(3);
  });

  it('displaces the pillar\'s shadow away from the key light by its own drawn height', () => {
    // A pillar is drawn UPWARD from a grounded origin rather than lifted by the transform, so
    // Entity's own height-driven shadow offset sees z = 0 and RoomBuilder has to supply it —
    // otherwise a 70 px pillar casts straight down while a 70 px wall beside it casts sideways.
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle());
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    expect(pillar.shadowOffsetX).toBeCloseTo(WALL_H_INTERIOR * SHADOW_SLANT_X, 5);
    expect(pillar.shadowOffsetY).toBeCloseTo(WALL_H_INTERIOR * SHADOW_SLANT_Y, 5);
    // ...and it actually lands there, not just on the field. (Precision 1: the pillar's own
    // x is a px→fp→px round trip of 150, so it lands at 150.016.)
    expect(pillar.shadow!.x).toBeCloseTo(150 + WALL_H_INTERIOR * SHADOW_SLANT_X, 1);
  });

  it('rebuilds pillars fresh on a second build() call, not appended', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    const firstCount = layers.entities.children.length;
    rb.build(stateWithOneObstacle());
    expect(layers.entities.children.length).toBe(firstCount);
  });

  it('draws the body WIDER than the footprint you collide with, at every shipped pillar size', () => {
    // `roomDressing.buildPillarEntities` widens the drawn body past the collision circle
    // (`rad * 2 + 16`), and until a 2026-08-27 battery nothing read that: dropping the widening
    // so the art is exactly as wide as the footprint passed all 3,365 client tests. It is a look
    // decision, so no geometry assertion in this file could see it — the same shape as
    // `roomLight`'s `EDGE_ALPHA` survivor, and the same cure: gate the RELATIONSHIP to the other
    // quantity it is tuned against, never the constant.
    //
    // The relationship is that a character pressed against a pillar must not overlap its
    // silhouette, i.e. the drawn body clears the footprint on both sides. Bounded as a FRACTION of
    // the footprint because pillar radii vary across shipped content (1 and 1.5 grid = 32 and 48
    // px in `world/rooms/ember.ts`; the third radius here is deliberately below both). The gate
    // sits at 15% of the radius per side, well under today's clearance and well over the mutant's
    // widest reading — see the assertion's own margin check below.
    const s = createGameState({
      seed: 1, worldW: 1600, worldH: 1200, waves: [], walls: [],
      obstacles: [[200, 200, 32], [600, 200, 48], [1000, 200, 20]],
    });
    const rb = makeRoomBuilder();
    rb.build(s);
    const pillars = (rb as unknown as { pillars: Entity[] }).pillars;
    expect(pillars).toHaveLength(3);
    const clearanceFractions = [32, 48, 20].map((radiusPx, i) => {
      const body = pillars[i]!.children[0] as Graphics;
      return (body.getLocalBounds().maxX - radiusPx) / radiusPx;
    });
    for (const frac of clearanceFractions) expect(frac).toBeGreaterThan(0.15);
    // ...and the gate has real headroom, so nobody has to transcribe today's tuning to keep it
    // honest: the tightest of the three sits well clear of the bound.
    expect(Math.min(...clearanceFractions)).toBeGreaterThan(0.18);
  });

  it('clear() removes every pillar and its shadow', () => {
    // Also the PORTAL's shadow, which this fixture puts on the same layer (see the shadow-count
    // test above: 3 children, one of them the portal's). Nothing here calls `shadow.destroy()`
    // explicitly any more — `Entity.destroy` unparents and destroys it — so this assertion is
    // what stands behind that removal rather than the call that used to precede it.
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneObstacle());
    rb.clear();
    expect(layers.entities.children.length).toBe(0);
    expect(layers.shadow.children.length).toBe(0);
  });
});

describe('RoomBuilder — grid overlay and rebuild', () => {
  it('always draws the grid overlay regardless of whether biome art exists', () => {
    mocks.floorTex = fakeTexture(64, 64);
    mocks.wallTex = fakeTexture(32, 32);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    // The ground fill is Sprites (stamped tiles), so the Graphics here are exactly the four
    // overlays: the floor's own dark and additive variation layers (`floorRender`), the grid, and
    // the per-room light pool. Since 2026-08-18 the walls have left this layer entirely.
    expect(groundNodes(layers).filter((c) => c instanceof Graphics)).toHaveLength(4);
  });

  it('clears the previous room contents on a second build() call', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    const firstCount = layers.ground.children.length;
    rb.build(stateWithOneWall('ember'));
    expect(layers.ground.children.length).toBe(firstCount); // rebuilt fresh, not appended
  });
});

describe('RoomBuilder — doors (design/05 "Room & door model", 2026-08-04; standing 2026-08-20)', () => {
  // `mocks.curtainTex` is only ever set non-undefined by the one test below that needs it — every
  // other door test in this block (and `leafOf`, which cannot tell a curtain sprite from the leaf
  // once one exists) implicitly assumes it stays undefined. Reset here rather than at the top of
  // each test, since every OTHER field in `mocks` already follows that convention and this is the
  // one field that would otherwise leak forward across tests by declaration order.
  afterEach(() => {
    mocks.curtainTex = undefined;
  });

  it("excludes a locked door's passage rect from the generic wall loop", () => {
    mocks.wallTex = undefined;
    const s = stateWithOneWall('ember'); // one real wall at [100,100,64,64]
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    // With no floor swatch loaded: the flat palette fill, the floor's two variation layers, this
    // door's worn patch, the grid and the per-room light pool are the only ground Graphics now; the
    // real wall is a standing block on `entities`. If the locked door's passageAabb (also present
    // in s.walls, mirroring DoorSystem) weren't excluded, it would be built as a SECOND standing
    // block on `entities` — which is what the wallEntities count below catches.
    expect(groundNodes(layers).filter((c) => c instanceof Graphics).length).toBe(6);
    expect((rb as unknown as { wallEntities: Entity[] }).wallEntities).toHaveLength(1);
    expect(doorFixtures(rb)).toHaveLength(1);
  });

  // The whole point of the 2026-08-20 pass: a door is a STANDING fixture on the Y-sorted
  // `entities` layer, placed on its passage's south edge exactly like a wall block — not a flat
  // sprite stretched over the passage rect on `layers.ground`, which is what made a front
  // elevation read as a rug lying on the floor.
  it('builds one standing fixture per door on the entities layer, on the passage south edge', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const view = doorFixtures(rb)[0]!.view;
    expect(layers.entities.children).toContain(view);
    expect(layers.ground.children).not.toContain(view);
    expect(view.x).toBeCloseTo(300);
    expect(view.y).toBeCloseTo(164); // passage y + h — the ground line it Y-sorts on
    expect(view.zIndex).toBeCloseTo(164);
  });

  // `wallGeometry.DOOR_H`: ONE height for every door, whatever wall it is cut into (2026-09-03).
  // Both flank cases are asserted through a really-built fixture, because this pair is the only
  // place the production decision is observable — `doorStandCoverage.test.ts` sweeps the shipped
  // content for the shapes, but it cannot re-derive the height without restating the constant.
  // The KERB case is the one that changed: it used to come out at `WALL_H_KERB` (22 px), a
  // letterbox under its own lintel, which is the fixture the live report was circling.
  it('stands at DOOR_H beside a perimeter run', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      // Two stubs of a north-south perimeter run (they touch the world's west edge) with a
      // 64 px gap between them; the door fills the gap.
      walls: [[0, 0, 32, 64], [0, 128, 32, 64]],
      obstacles: [],
    });
    pushDoor(s, false, [0, 64, 32, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(doorHeightOf(rb, 0)).toBeCloseTo(DOOR_H);
    // ...and it KEEPS its cap here, because the runs either side of it stand at that same height:
    // the stone over this lintel really is the continuation of their crown. The kerb case below
    // is where that stops being true — see `wallRuns.doorFlankHeight`.
    expect(doorFixtures(rb)[0]!.capLayers.length).toBeGreaterThan(0);
  });

  it('...and at exactly the same DOOR_H in a 22 px kerb, where it used to be kerb-high', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      // An east-west wall on a room's own south boundary is a kerb (`framesFloorFromSouth`),
      // with a 64 px door gap in it.
      walls: [[0, 224, 96, 32], [160, 224, 96, 32]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({
      id: 'r',
      rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(256), h: pxToFp(256) },
    });
    pushDoor(s, false, [96, 224, 64, 32]);
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(doorHeightOf(rb, 0)).toBeCloseTo(DOOR_H);
    // The wall it is cut into is untouched by that — `DOOR_H` is a door constant, and no wall run
    // reads it. Without this the pair above is satisfied just as well by deleting the kerb tier.
    const kerbs = wallHeights(rb).filter((h) => Math.abs(h - WALL_H_KERB) < 0.01);
    expect(kerbs.length).toBeGreaterThan(0);

    // ...and standing that much taller than its own flanks is exactly why it must draw NO cap
    // (2026-09-03, the report after `DOOR_H` shipped: *"我希望门的位置只有门，不要在入口的两端有
    // 墙"*). A cap is the wall over the lintel and only reads as stone by continuing the flanking
    // runs' crown; 82 px above a 22 px kerb there is no crown to continue, so the tiled swatch
    // hung over the opening as a slab of wall with nothing under it. `capLayers` is precisely the
    // group `addCapLayers` fills, so an empty one is the absence of that slab, not a proxy for it.
    expect(doorFixtures(rb)[0]!.capLayers).toHaveLength(0);
    // The occluder agrees, which is what stops the x-ray reserving a band of floor for stone that
    // is no longer drawn: the fixture's topmost row is the top of its own arch.
    const box = occluders(rb).find((o) => o.box.left === 96 && o.box.sortY === 256)!.box;
    expect(box.top).toBeCloseTo(box.sortY - DOOR_H);
  });

  // A door gets its OWN `wallJoins` entry, and the only place that is observable from outside
  // `buildDoors` is a doorway whose cap the joins actually CLIP. Without a fixture that tucks,
  // every door's cap sits at the unclipped `-height - depth` whatever joins it was handed — which
  // is why the 2026-09-03 battery could hand the doors the WALLS' joins (`.slice(0, n)` instead of
  // `.slice(runs.length)`) and survive the whole scene suite. This is that fixture.
  it('a doorway whose north edge is buried tucks under that wall instead of climbing its crown', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      // A north-south boundary run in two pieces with a 128 px-deep gap between them. The gap is
      // DEEPER than a door stands tall, and the piece north of it spans the gap's full width at
      // perimeter height — `wallRuns.tucks`' two conditions, which is what a real 64x128 passage
      // through a room boundary looks like (13 of the 24 shipped doors).
      walls: [[100, 0, 64, 100], [100, 228, 64, 100]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({
      id: 'r',
      rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(800), h: pxToFp(600) },
    });
    pushDoor(s, false, [100, 100, 64, 128]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const box = occluders(rb).find((o) => o.box.left === 100 && o.box.sortY === 228)!.box;
    expect(doorHeightOf(rb, 0)).toBeCloseTo(DOOR_H); // still DOOR_H tall — the tuck clips the CAP
    // Unclipped, this door's art would reach `DOOR_H + 128` north of its own ground line. The
    // tuck stops it short, leaving the wall above holding its own crown course.
    const unclipped = box.sortY - DOOR_H - 128;
    expect(box.top).toBeGreaterThan(unclipped);
    expect(box.top).toBeLessThanOrEqual(box.sortY - DOOR_H); // ...but there is still a cap
  });

  it('a locked door uses the locked leaf texture when loaded, untinted', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const leaf = leafOf(rb, 0);
    expect(leaf.texture.source).toBe(mocks.doorLockedTex!.source);
    expect(leaf.tint).toBe(0xffffff);
  });

  it('an unlocked door renders the open leaf, not folded into s.walls at all', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, false, [300, 100, 20, 64]); // unlocked: never added to s.walls
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(leafOf(rb, 0).texture.source).toBe(mocks.doorOpenTex!.source);
  });

  /**
   * `doorRender.test.ts` builds a `DoorSkin` by hand and thoroughly pins what `buildDoorBlock`
   * does with `floor`/`curtain` once they arrive — but nothing there proves RoomBuilder actually
   * PASSES its own `getFloorTexture()`/`getDoorCurtainTexture()` results into that skin at all.
   * Confirmed by mutation before writing this pair: deleting `floor: floorTex` and
   * `curtain: getDoorCurtainTexture()` from `RoomBuilder.buildDoors`'s call site left the entire
   * suite green, because every other door test here runs with both left at their `undefined`
   * default, which is indistinguishable from "never wired at all".
   */
  it("wires the room's own floor swatch into an open door's recess", () => {
    mocks.floorTex = fakeTexture(64, 64);
    const s = stateWithOneWall('ember');
    pushDoor(s, false, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const tiles = doorFixtures(rb)[0]!.view.children.filter(
      (c): c is TilingSprite => c instanceof TilingSprite && c.texture.source === mocks.floorTex!.source,
    );
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('wires a loaded curtain texture into an open door, additive and visible', () => {
    mocks.curtainTex = fakeTexture(48, 96);
    const s = stateWithOneWall('ember');
    pushDoor(s, false, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    // Both the curtain and the leaf are plain `Sprite`s once curtain art is loaded — matched by
    // texture identity, not position, for the same reason `doorRender.test.ts`'s `curtainOf` is.
    const curtain = doorFixtures(rb)[0]!.view.children.find(
      (c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite) && c.texture.source === mocks.curtainTex!.source,
    );
    expect(curtain).toBeDefined();
    expect(curtain!.blendMode).toBe('add');
    expect(curtain!.visible).toBe(true);
  });

  it('falls back to a tinted rect (hazard-red locked / grey open) when no door art is loaded', () => {
    mocks.doorLockedTex = undefined;
    mocks.doorOpenTex = undefined;
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const leaf = leafOf(rb, 0);
    expect(leaf.texture).toBe(Texture.WHITE);
    expect(leaf.tint).toBe(0xe53e3e);
  });

  it('updateDoors() swaps the leaf and the hazard bloom in place, without rebuilding the fixture', () => {
    mocks.doorLockedTex = fakeTexture(32, 32);
    mocks.doorOpenTex = fakeTexture(32, 32);
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    const fixture = doorFixtures(rb)[0]!;
    const childCount = fixture.view.children.length;
    expect(leafOf(rb, 0).texture.source).toBe(mocks.doorLockedTex!.source);
    const beforeLights = stateLightsOf(rb, 0);
    expect(beforeLights.filter(Boolean)).toHaveLength(1); // the hazard bloom, alone

    // Mirror DoorSystem: the door unlocks, its passageAabb drops out of s.walls.
    s.dungeonDoors[0]!.locked = false;
    s.walls.length = 0;
    rb.updateDoors(s);

    expect(doorFixtures(rb)[0]).toBe(fixture); // same fixture instance, not rebuilt
    expect(fixture.view.children.length).toBe(childCount);
    expect(leafOf(rb, 0).texture.source).toBe(mocks.doorOpenTex!.source);
    // Mid-crossfade (2026-09-03): a flip mounts BOTH states and lets their alphas carry it, so the
    // settled invariant below is only reachable after the transition has run. That the transition
    // exists at all is asserted here rather than only in `doorFx.test.ts`, because this is the
    // call path a real unlock arrives on and an `updateDoors` that cut instantly would look
    // identical after the settle.
    expect(stateLightsOf(rb, 0).every(Boolean)).toBe(true);
    rb.tickFixtures(400, null, null);
    // Every state light flipped: the locked one off, the open ones on. Asserting only that the
    // bloom went dark would pass on a fixture whose open lights never came up — which is the
    // whole defect the 2026-08-30 pass fixed, arriving through this exact call path.
    expect(stateLightsOf(rb, 0)).toEqual(beforeLights.map((v) => !v));
  });

  it('updateDoors() is a no-op before any build() has populated the fixtures', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    expect(() => rb.updateDoors(s)).not.toThrow();
    expect(doorFixtures(rb)).toHaveLength(0);
  });

  it('clear() destroys the standing door fixtures along with the rest of the room', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const view = doorFixtures(rb)[0]!.view;
    rb.clear();
    expect(doorFixtures(rb)).toHaveLength(0);
    expect(layers.ground.children.length).toBe(0);
    expect(layers.entities.children).not.toContain(view);
    expect(view.destroyed).toBe(true);
  });

  // A rebuild must not leak: doors live on `entities`, which `build()` never sweeps wholesale
  // (actors live there too), so the fixtures have to be destroyed by hand — the same bug class
  // `clearWalls` exists for.
  it('rebuilding the room replaces the fixtures rather than stacking a second set', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const first = doorFixtures(rb)[0]!.view;
    rb.build(s);
    expect(doorFixtures(rb)).toHaveLength(1);
    expect(first.destroyed).toBe(true);
    expect(layers.entities.children.filter((c) => c === first)).toHaveLength(0);
  });

  // A door is a piece of the wall it is cut into, so the mass above its lintel throws the same
  // ground shadow a wall block does — onto the SAME shared Graphics, since a room's shadows are one
  // display object. Untested until a mutation battery deleted the call and nothing went red.
  it("throws the fixture's own cast shadow onto the shared wall-shadow Graphics", () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    pushDoor(s, true, [300, 100, 20, 64]); // the ONLY fixture in the room: no wall to borrow from
    const rb = makeRoomBuilder();
    rb.build(s);
    const shadows = (rb as unknown as { wallShadows: Graphics | null }).wallShadows!;
    expect(shadows.context.instructions.length).toBeGreaterThan(0);
  });

  // A character walking through a doorway stands inside the fixture's own art (the passage floor
  // is entirely within it), so a door has to be an x-ray occluder like every other standing
  // block — before this pass doors lived on `layers.ground` and could not participate at all.
  it('registers the door with the occlusion x-ray, with the same box a wall block gets', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, false, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    // By `left`, not by `sortY`: the room's own wall at [100,100,64,64] shares this door's
    // ground line, and picking the first match would silently assert against the wall instead.
    const box = occluders(rb).find((o) => o.box.left === 300)!.box;
    expect(box.sortY).toBeCloseTo(164);
    expect(box.right).toBeCloseTo(320);
    // Every door stands at `DOOR_H` (2026-09-03), including this one, whose passage abuts no wall
    // at all — the case that used to fall back to `wallTier` and come out interior-high.
    expect(box.foldY).toBeCloseTo(164 - DOOR_H);
    expect(box.top).toBeLessThan(box.foldY); // its cap reaches north of the fold, like a wall's
  });

  // Live report, screenshot attached: *"门不能被高墙挡住了。门应该是随时清晰可见的"* (a door must
  // not be blocked by a tall wall — it should be clearly visible at all times). Root cause was
  // exactly design/01's long-called-out, never-fixed case: a deep north-south run whose north
  // end is a door passage spills its cap one wall height past its own footprint, straight onto
  // the door sprite sitting there — and since doors live on `layers.ground` (always behind the
  // Y-sorted `entities` the run stands on), the run wins unconditionally, regardless of Y-order.
  // `occluders(rb)`'s `box.top` is the exact world-y the run's art reaches up to, so it doubles
  // as an end-to-end probe for the clip without needing a real GL context to sample pixels.
  it('clips a deep run\'s cap at a door directly north of it, instead of spilling onto it', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      walls: [[0, 64, 32, 200]], // a deep north-south run, tier 'perimeter' (touches the west edge)
      obstacles: [],
    });
    pushDoor(s, false, [0, 0, 32, 64]); // south edge (y=64) flush with the run's north edge
    const rb = makeRoomBuilder();
    rb.build(s);
    const box = (rb as unknown as { occluders: { box: { top: number; sortY: number } }[] })
      .occluders.find((o) => o.box.sortY === 264)!.box;
    expect(box.top).toBeCloseTo(64, 1); // the run's own north edge — zero spill onto the door
  });

  it('the same run spills WALL_H_PERIMETER px past its footprint with no door there', () => {
    // Confirms the fixture above actually exercises the clip, rather than one that never
    // spilled in the first place.
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      walls: [[0, 64, 32, 200]],
      obstacles: [],
    });
    const rb = makeRoomBuilder();
    rb.build(s);
    const box = (rb as unknown as { occluders: { box: { top: number; sortY: number } }[] })
      .occluders.find((o) => o.box.sortY === 264)!.box;
    expect(box.top).toBeCloseTo(64 - WALL_H_PERIMETER, 1);
  });

  // `doorSpillCoverage.test.ts` measured this SHALLOW shape — not the deep run above — as the
  // one that actually occurs on the shipped floors (12 times across all five). Clipping the cap
  // alone (`blockCapTop`'s own fix) was not enough here: a 32 px-deep footprint's FACE is drawn
  // at the full tier height regardless, so it alone reached WALL_H_PERIMETER - 32 = 72 px past
  // the run's own edge with nothing left for a cap-only clip to touch. `effectiveWallHeight`
  // shrinks the height fed to the face too — see its own doc comment.
  it('clips a SHALLOW run flush with its own footprint at a door too, not just a deep one', () => {
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      walls: [[0, 64, 32, 32]], // an ordinary-thickness perimeter stub, not a merged deep run
      obstacles: [],
    });
    pushDoor(s, false, [0, 32, 32, 32]); // south edge (y=64) flush with the run's north edge
    const rb = makeRoomBuilder();
    rb.build(s);
    const box = (rb as unknown as { occluders: { box: { top: number; sortY: number } }[] })
      .occluders.find((o) => o.box.sortY === 96)!.box;
    expect(box.top).toBeCloseTo(64, 1); // the run's own north edge — zero spill onto the door
  });

  it('the same shallow run spills 72px of pure FACE past its footprint with no door there', () => {
    // Confirms the fixture above actually exercises the fix, rather than one that never
    // spilled in the first place — the cap alone (already fixed) contributes none of this: a
    // 32 px-deep block's cap-only clip already zeroes the cap, so if this regressed to only the
    // cap-only fix, `box.top` would read 64 (flush) here too even with no door, silently masking
    // the face's own reach going untested.
    const s = createGameState({
      seed: 1, worldW: 800, worldH: 600, waves: [],
      walls: [[0, 64, 32, 32]],
      obstacles: [],
    });
    const rb = makeRoomBuilder();
    rb.build(s);
    const box = (rb as unknown as { occluders: { box: { top: number; sortY: number } }[] })
      .occluders.find((o) => o.box.sortY === 96)!.box;
    expect(box.top).toBeCloseTo(64 - WALL_H_PERIMETER, 1);
  });
});

describe('RoomBuilder — tickFixtures drives the animated fixtures (2026-09-03b)', () => {
  /** The two unlabelled containers `DoorFx` mounts into a fixture, and the scroll offsets inside
   *  them — the layer property the whole cue rests on, read off the assembled fixture rather than
   *  off the controller, so this asserts what actually reaches the screen. */
  function scrollsOf(rb: RoomBuilder, i: number): number[] {
    return doorFixtures(rb)[i]!
      .view.children.filter((c) => c.label === null && c.children.length > 0)
      .flatMap((c) => c.children)
      .filter((c): c is TilingSprite => c instanceof TilingSprite)
      .map((t) => t.tilePosition.y);
  }

  it('advances a door that is inside the view, and leaves one outside it untouched', () => {
    // The cull, through the real builder rather than through `tickDoors`' own unit test: a floor is
    // co-resident (all 24 of level 1's doors are built into one world) and each ticked door costs a
    // per-frame `Graphics` rebuild. A cull that lets everything through looks identical in play.
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    pushDoor(s, true, [9000, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);

    const before = [scrollsOf(rb, 0), scrollsOf(rb, 1)];
    rb.tickFixtures(200, { x: 0, y: 0, w: 800, h: 600 }, null);
    const after = [scrollsOf(rb, 0), scrollsOf(rb, 1)];

    expect(after[0]).not.toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
  });

  it('ticks everything when it has no camera rect yet', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [9000, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);

    const before = scrollsOf(rb, 0);
    rb.tickFixtures(200, null, null);

    expect(scrollsOf(rb, 0)).not.toEqual(before);
  });

  it('starts two doors of one room at different phases, so they do not breathe in unison', () => {
    // design/01 "Give co-located instances different start phases" — the rule `Pickup` had to learn
    // when a whole floor of loot rose and fell as one flash. `buildDoors` has to pass each door its
    // INDEX for that, and passing a constant (or nothing) is invisible on any single door.
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    pushDoor(s, true, [400, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    rb.tickFixtures(16, null, null);

    // The LIVE additive layer of the state each door is in — index 0 of the additive children is
    // `through`, which for a locked door is unmounted and still carrying its authored alpha.
    const alpha = (i: number): number =>
      doorFixtures(rb)[i]!.view.children.find((c) => c instanceof Graphics && c.blendMode === 'add' && c.visible)!.alpha;
    expect(alpha(0)).not.toBeCloseTo(alpha(1), 4);
  });

  it('drives the portal only while it is open — the animation that had no caller at all', () => {
    // `Portal.interpolate` (alpha pulse, two counter-rotating rings, ten infalling motes) was
    // written 2026-08-12 and NOTHING in the repo called it: `Scene.interpolate` walks
    // `Scene.views`, and a portal is added straight to `layers.entities` by this class. It drew one
    // frozen frame for three weeks. Nothing but this assertion notices if that regresses.
    const s = stateWithOneWall('ember');
    const rb = makeRoomBuilder();
    rb.build(s);
    const portal = (rb as unknown as { portal: { visible: boolean; rotation?: number; children: { rotation: number }[] } }).portal!;
    const spin = (): number[] =>
      (portal as unknown as { children: { children?: { rotation: number }[] }[] }).children
        .flatMap((c) => c.children ?? [])
        .map((c) => c.rotation);

    rb.setPortalOpen(false);
    const hidden = spin();
    rb.tickFixtures(500, null, null);
    expect(spin()).toEqual(hidden); // a hidden vortex advancing its own clock is pure cost

    rb.setPortalOpen(true);
    const shown = spin();
    rb.tickFixtures(500, null, null);
    expect(spin()).not.toEqual(shown);
  });

  it('reports each door’s drawn footprint and flashes the right one, index-aligned with dungeonDoors', () => {
    // Real leaf art, so the fixtures actually build a fire band and therefore a refusal flash — a
    // door with no art has no band, and this would then assert on whichever layer happened to be
    // first (which is exactly the way `stateLightsOf` above once became the wrong layer).
    mocks.doorLockedTex = fakeTexture(147, 217);
    // `GameLoop`'s refusal derivation addresses doors by their `state.dungeonDoors` index and needs
    // the DRAWN rect back (the sim carries only an Fp passage AABB). An off-by-one here flashes the
    // wrong door, which no visual check would ever attribute to an index.
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    pushDoor(s, true, [500, 200, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);

    expect(rb.doorFootprint(0)).toEqual({ x: 300, y: 100, w: 20, h: 64 });
    expect(rb.doorFootprint(1)).toEqual({ x: 500, y: 200, w: 20, h: 64 });
    expect(rb.doorFootprint(2)).toBeNull();

    // The refusal flash is the one Graphics in `over` that sits inside the fire band: it is built
    // only when there IS a band, and it is the layer `reject()` lights.
    const flashOf = (i: number): number => {
      const over = doorFixtures(rb)[i]!.view.children.filter((c) => c.label === null && c.children.length > 0)[1]!;
      const gfx = over.children.filter((c): c is Graphics => c instanceof Graphics);
      expect(gfx.length).toBeGreaterThan(3); // pulse + motes + burst + the flash the band adds
      return gfx[0]!.alpha;
    };
    rb.tickFixtures(16, null, null);
    expect(flashOf(0)).toBe(0);
    rb.rejectDoor(1);
    rb.tickFixtures(16, null, null);
    expect(flashOf(0)).toBe(0); // ...and only that one
    expect(flashOf(1)).toBeGreaterThan(0);
  });

  it('clears the footprints with the room, so a stale index cannot outlive its fixture', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(rb.doorFootprint(0)).not.toBeNull();

    rb.build(stateWithOneWall('ember')); // a floor with no doors at all
    expect(rb.doorFootprint(0)).toBeNull();
    expect(() => rb.rejectDoor(0)).not.toThrow();
  });
});

describe('RoomBuilder — portal placement (2026-08-12 fix: capstone room, not the floor bbox)', () => {
  it('with no dungeonRoomRects (flat mode), centers on the room itself — worldW/H, unchanged behavior', () => {
    const s = stateWithOneWall('ember'); // worldW: 800, worldH: 600
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(rb.portalPx).toEqual({ x: 400, y: 300 });
  });

  it('with dungeonRoomRects populated, centers on the LAST rect (the capstone room), not the floor bbox', () => {
    // A floor whose overall bounding box (worldW/H, set by buildFloorGeometry in real
    // play) is much bigger than any one room — this is what used to put the portal in
    // a corridor or on a wall on multi-room floors.
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1200, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push(
      { id: 'entry', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(400), h: pxToFp(300) } },
      { id: 'capstone', rect: { x: pxToFp(1600), y: pxToFp(900), w: pxToFp(400), h: pxToFp(300) } },
    );
    const rb = makeRoomBuilder();
    rb.build(s);
    // Capstone rect center = (1600 + 200, 900 + 150) = (1800, 1050) — nowhere near the
    // floor bbox's own center (1000, 600).
    expect(rb.portalPx!.x).toBeCloseTo(1800, 0);
    expect(rb.portalPx!.y).toBeCloseTo(1050, 0);
  });

  it('with a single-room dungeon floor (capstone == only entry), still centers on that room', () => {
    // A degenerate but real case: a one-room floor. dungeonRoomRects has exactly one
    // entry, which is trivially both "the last room" and "the only room" — the fix must
    // not assume there are at least two entries.
    const s = createGameState({ seed: 1, worldW: 500, worldH: 400, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push({
      id: 'capstone',
      rect: { x: pxToFp(50), y: pxToFp(50), w: pxToFp(300), h: pxToFp(200) },
    });
    const rb = makeRoomBuilder();
    rb.build(s);
    // (50+300/2, 50+200/2) — a fp round trip, not an exact float match (see the
    // dungeonRoomRects-populated case above).
    expect(rb.portalPx!.x).toBeCloseTo(200, 0);
    expect(rb.portalPx!.y).toBeCloseTo(150, 0);
  });

  it('re-centers on the NEW capstone after a floor transition (dungeonRoomRects reset + repopulated)', () => {
    // Mirrors ExtractionSystem.resolveDescend: dungeonRoomRects is cleared, then
    // SpawnSystem repopulates it for the freshly-generated next floor. A stale portalPx
    // from the previous floor's capstone must not survive the rebuild.
    const s = createGameState({ seed: 1, worldW: 2000, worldH: 1200, waves: [], walls: [], obstacles: [] });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    s.dungeonRoomRects.push({ id: 'floor1-capstone', rect: { x: pxToFp(1600), y: pxToFp(900), w: pxToFp(400), h: pxToFp(300) } });
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(rb.portalPx!.x).toBeCloseTo(1800, 0);
    expect(rb.portalPx!.y).toBeCloseTo(1050, 0);

    // Floor transition: old rects cleared, new floor's rects pushed (SpawnSystem).
    s.dungeonRoomRects.length = 0;
    s.dungeonRoomRects.push({ id: 'floor2-capstone', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(200), h: pxToFp(100) } });
    rb.build(s);
    expect(rb.portalPx!.x).toBeCloseTo(100, 0);
    expect(rb.portalPx!.y).toBeCloseTo(50, 0);
  });
});

describe('RoomBuilder — the floor grid steps back', () => {
  it('draws the grid faintly, not at full strength', () => {
    // A full-strength regular lattice across the whole floor is the loudest "this is a top-down
    // blueprint" cue available, and it fought every depth cue the 2026-08-18 pass added. It is
    // still drawn (it helps judge distance) but it must not assert that the world is flat.
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithOneWall('ember'));
    // One stroke instruction carries the whole lattice, which is what identifies the grid among
    // the ground Graphics — the palette floor fill has none, and the per-room light pool added
    // after it (see `roomLight.ts`) strokes one band per step.
    const strokeLists = groundNodes(layers)
      .filter((c): c is Graphics => c instanceof Graphics)
      .map((g) => (g.context.instructions as Array<{ action: string; data: { style: { alpha: number } } }>)
        .filter((i) => i.action === 'stroke'));
    const strokes = strokeLists.find((l) => l.length === 1)!;
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.data.style.alpha).toBeLessThan(0.2);
    expect(strokes[0]!.data.style.alpha).toBeGreaterThan(0); // still drawn, not deleted
  });
});

describe('RoomBuilder — a whole room of walls', () => {
  /** A room with one wall of each tier plus an interior block, i.e. every branch at once. */
  function stateWithFullPerimeter(): GameState {
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [
        [0, 0, 480, 32], // north  -> perimeter
        [0, 448, 480, 32], // south  -> kerb
        [0, 32, 32, 416], // west   -> perimeter
        [448, 32, 32, 416], // east   -> perimeter
        [128, 128, 64, 64], // block  -> interior
      ],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    return s;
  }

  it('stands every segment up, including the north-south sides the old rule flattened', () => {
    // The regression this whole pass exists for: with `wallRises`, this room produced ONE
    // standing segment (the north wall). Every other wall — both 1-cell-wide side runs and the
    // square interior block — failed `w > h` and was drawn flat on the ground.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithFullPerimeter());
    expect((rb as unknown as { wallEntities: Entity[] }).wallEntities).toHaveLength(5);
  });

  it('assigns the three tiers by position, in one build', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithFullPerimeter());
    const heights = (rb as unknown as { wallEntities: Entity[] }).wallEntities.map(faceHeight);
    expect(heights).toEqual([
      WALL_H_PERIMETER, // north
      WALL_H_KERB, // south — cannot be tall without hiding the player
      WALL_H_PERIMETER, // west
      WALL_H_PERIMETER, // east
      WALL_H_INTERIOR, // the block inside
    ]);
  });

  it('accumulates every wall\'s shadow into the ONE shared Graphics', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithFullPerimeter());
    const shadows = (rb as unknown as { wallShadows: Graphics | null }).wallShadows!;
    // Still exactly one display object for the whole room, and it spans the whole room.
    expect(layers.shadow.children.filter((c) => c === shadows)).toHaveLength(1);
    expect(shadows.bounds.minX).toBeLessThanOrEqual(0);
    expect(shadows.bounds.maxX).toBeGreaterThan(480); // past the east wall, away from the light
    expect(shadows.bounds.maxY).toBeGreaterThan(480);
  });

  it('sorts each segment by its own south edge, so an actor can stand between two of them', () => {
    // The whole reason the blocks are on the Y-sorted layer: a player between the north wall and
    // an interior block must draw in front of the first and behind the second.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithFullPerimeter());
    const ents = (rb as unknown as { wallEntities: Entity[] }).wallEntities;
    expect(ents[0]!.zIndex).toBe(32); // north wall's south edge
    expect(ents[4]!.zIndex).toBe(192); // the interior block's
    expect(ents[1]!.zIndex).toBe(480); // the south kerb's — furthest forward
  });
});

describe('RoomBuilder — which layers batch their Graphics (2026-08-24 draw-call pass)', () => {
  /** Every Graphics under `root`, with the layer it was found on. Swept from the built scene rather
   *  than from a hand-listed set of call sites, so a new pass that forgets the policy shows up. */
  function graphicsOn(root: { children: readonly unknown[] }): Graphics[] {
    const out: Graphics[] = [];
    const walk = (n: { children: readonly unknown[] }): void => {
      for (const c of n.children as Array<{ children: readonly unknown[] }>) {
        if (c instanceof Graphics) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  function builtRoom(): Layers {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const layers = new Layers();
    makeRoomBuilder(layers).build(fullPerimeter());
    return layers;
  }

  /** Same room as the "a whole room of walls" block above: one wall of every tier plus an
   *  interior block, so the sweep sees every branch of the wall/shadow pass at once. */
  function fullPerimeter(): GameState {
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [[0, 0, 480, 32], [0, 448, 480, 32], [0, 32, 32, 416], [448, 32, 32, 416], [128, 128, 64, 64]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    return s;
  }

  it('batches every Graphics on ground and shadow — the two layers with their own render group', () => {
    // Pixi only auto-batches a Graphics under 400 floats of geometry, and nothing here is remotely
    // that small: the shared wall shadow is ~24k floats and the floor's decal pass ~50k, so each
    // was costing a draw call (27 of a measured 161) plus, between sprites, two program switches.
    // Forcing `batch` is only affordable because `Layers` gives these two their own render groups —
    // see `render/staticGraphics.ts` for the measurement, and `layers.test.ts` for the other half.
    const layers = builtRoom();
    const statics = [...graphicsOn(layers.ground), ...graphicsOn(layers.shadow)];
    expect(statics.length).toBeGreaterThan(3); // the sweep found something to check
    for (const g of statics) expect(g.context.batchMode).toBe('batch');
  });

  it('leaves the Y-sorted entities layer on Pixi default — batching there measured SLOWER', () => {
    // Not an oversight: an actor writing its `zIndex` every frame invalidates the whole enclosing
    // render group, so a forced batch on the wall shading (~18k floats over 27 runs) is repacked
    // 60 times a second. Measured on the level-1 start room it bought -50 draw calls and -50
    // program switches for +0.7 ms of a 2.4 ms render — a net loss. If someone reaches for
    // `staticGraphics()` in the wall/pillar/door pass, this is the test that should stop them.
    const layers = builtRoom();
    const moving = graphicsOn(layers.entities);
    expect(moving.length).toBeGreaterThan(3);
    for (const g of moving) expect(g.context.batchMode).toBe('auto');
  });
});

// 2026-08-19 volume pass, end-to-end through `build()`. Both of these are pure modules with their
// own unit tests (`wallRuns.test.ts`, `roomLight.test.ts`); what these cover is the wiring —
// specifically that the tier is decided BEFORE the merge and that the room rects the light pool
// uses are the same ones the tiering uses, which is where a plausible-looking refactor would go
// wrong without either unit suite noticing.
describe('RoomBuilder — one boundary drawn twice becomes one block', () => {
  const wallEntities = (rb: RoomBuilder): Entity[] => (rb as unknown as { wallEntities: Entity[] }).wallEntities;

  /** Two rooms side by side, each authoring its own wall on the shared boundary — the shipped
   *  shape (`ember_l1_gallery` has five such pairs), and the source of the lit-edge/dark-band
   *  seam down the middle of what looks like one thick wall. */
  function stateWithDoubledBoundary(): GameState {
    const s = createGameState({
      seed: 1, worldW: 960, worldH: 480, waves: [],
      walls: [
        [448, 32, 32, 416], // room A's east side
        [480, 32, 32, 416], // room B's west side — flush against it
      ],
      obstacles: [],
    });
    s.dungeonRoomRects.push(
      { id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } },
      { id: 'b', rect: { x: pxToFp(480), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } },
    );
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    return s;
  }

  it('merges the pair into a single block of their combined width', () => {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(stateWithDoubledBoundary());
    const ents = wallEntities(rb);
    expect(ents).toHaveLength(1); // two rects in, one block out
    const cap = ents[0]!.children.filter((c): c is TilingSprite => c instanceof TilingSprite)[1]!;
    expect(cap.width).toBe(64); // and it is as wide as both, so no stone is lost or invented
  });

  it('leaves the engine\'s own wall list alone — this is a drawing change, not a collision one', () => {
    mocks.wallTex = fakeTexture(256, 256);
    const s = stateWithDoubledBoundary();
    const before = s.walls.length;
    makeRoomBuilder().build(s);
    expect(s.walls).toHaveLength(before);
  });

  it('draws a boundary between VERTICALLY stacked rooms as one low mass, not a kerb under a wall', () => {
    // Reversed 2026-08-20. This used to assert two blocks, 22 px and 104 px: the upper room's
    // south wall kerbed, the lower room's north wall standing at full height one grid row
    // further south. The second one is the bug — it stands on exactly the ground the kerb
    // leaves clear, and its art reached 72 px into the upper room's floor. `wallTier` now asks
    // "is a room's floor immediately north of me" of every room, so BOTH halves kerb, and
    // being the same tier they merge into one 64 px-deep mass with no seam down it.
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 960, waves: [],
      walls: [
        [0, 448, 480, 32], // room A's south
        [0, 480, 480, 32], // room B's north, flush against it
      ],
      obstacles: [],
    });
    s.dungeonRoomRects.push(
      { id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } },
      { id: 'b', rect: { x: pxToFp(0), y: pxToFp(480), w: pxToFp(480), h: pxToFp(480) } },
    );
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(s);
    const ents = wallEntities(rb);
    expect(ents).toHaveLength(1);
    const sprites = ents[0]!.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    expect(sprites[0]!.height).toBe(WALL_H_KERB); // the face, and nothing taller anywhere
    expect(sprites[1]!.height).toBe(64); // the cap covers both rows, so no stone is invented
  });

  it('still refuses to merge across tiers, so no block is ever two heights at once', () => {
    // The guard that made the case above two blocks for the right reason, kept on a pair that
    // really is cross-tier: a north perimeter wall with an interior block flush beneath it, same
    // x and width, so their union IS a rectangle and `mergeWallRuns`' tier check is the only
    // thing standing between them. One block cannot be both 104 px and 70 px tall.
    const s = createGameState({
      seed: 1, worldW: 480, worldH: 480, waves: [],
      walls: [
        [64, 0, 128, 32], // on the room's north edge -> perimeter
        [64, 32, 128, 32], // flush beneath it, touching no edge -> interior
      ],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const rb = makeRoomBuilder();
    rb.build(s);
    const heights = wallEntities(rb).map(faceHeight);
    expect(heights).toHaveLength(2);
    expect(heights).toContain(WALL_H_PERIMETER);
    expect(heights).toContain(WALL_H_INTERIOR);
  });

  it('rebuilds from scratch on a second build(), never accumulating merged blocks', () => {
    mocks.wallTex = fakeTexture(256, 256);
    const rb = makeRoomBuilder();
    rb.build(stateWithDoubledBoundary());
    rb.build(stateWithDoubledBoundary());
    expect(wallEntities(rb)).toHaveLength(1);
  });
});

describe('RoomBuilder — the per-room light pool', () => {
  function strokeCount(g: Graphics): number {
    return (g.context.instructions as Array<{ action: string }>).filter((i) => i.action === 'stroke').length;
  }
  /** Every light pool on `ground`, found by SHAPE rather than by position: `roomLight.ts` is the
   *  only thing on this layer that strokes more than once (the grid strokes its whole lattice in
   *  one call, and every other stage fills). Identified this way since 2026-08-26, when "the last
   *  Graphics on the layer" stopped meaning "the light pool" — there is now one pool per room, and
   *  a positional lookup would have quietly gone on passing while reading only the last room's. */
  function lightPools(rb: RoomBuilder): Graphics[] {
    const layers = (rb as unknown as { layers: Layers }).layers;
    return groundNodes(layers).filter((c): c is Graphics => c instanceof Graphics && strokeCount(c) > 1);
  }

  it('paints one falloff per room — one piece each, so the camera can cull them separately', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    rb.build(stateWithOneRoom(480, 480));
    const one = lightPools(rb);
    expect(one).toHaveLength(1);
    const rb2 = makeRoomBuilder();
    rb2.build(stateWithTwoRooms());
    const two = lightPools(rb2);
    // Two rooms, two pools, and between them exactly twice the bands — the same total the one
    // shared Graphics used to carry. What changed in 2026-08-26 is only which display object each
    // room's bands land on, and that is the whole point: a pool the camera cannot see is now a
    // piece it can switch off.
    expect(two).toHaveLength(2);
    expect(two.reduce((n, g) => n + strokeCount(g), 0)).toBe(strokeCount(one[0]!) * 2);
    // Each pool is tagged with what it paints, or the cull would leave it resident forever.
    for (const pool of two) expect(groundPieceBounds(pool)).toBeDefined();
  });

  it('spans both rooms, so neither is left unlit', () => {
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const rb = makeRoomBuilder();
    rb.build(stateWithTwoRooms());
    const pools = lightPools(rb);
    expect(Math.min(...pools.map((g) => g.bounds.minX))).toBeLessThan(480);
    expect(Math.max(...pools.map((g) => g.bounds.maxX))).toBeGreaterThan(480); // reaches into the second room
  });

  it('falls back to the whole world as one room in a mode with no room model', () => {
    // A flat `EngineConfig.floors` run and the PvP arena populate neither rect list; the world
    // itself stands in, exactly as it does for the wall-tier lookup.
    mocks.floorTex = undefined;
    mocks.wallTex = undefined;
    const s = createGameState({ seed: 1, worldW: 600, worldH: 600, waves: [], walls: [], obstacles: [] });
    const rb = makeRoomBuilder();
    rb.build(s);
    const pools = lightPools(rb);
    expect(pools).toHaveLength(1);
    expect(strokeCount(pools[0]!)).toBeGreaterThan(0);
    // Inside the world, to within a stroke's own antialiasing slack.
    expect(pools[0]!.bounds.maxX).toBeLessThanOrEqual(600.5);
  });

  function stateWithOneRoom(w: number, h: number): GameState {
    const s = createGameState({ seed: 1, worldW: w, worldH: h, waves: [], walls: [], obstacles: [] });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(w), h: pxToFp(h) } });
    return s;
  }

  function stateWithTwoRooms(): GameState {
    const s = createGameState({ seed: 1, worldW: 960, worldH: 480, waves: [], walls: [], obstacles: [] });
    s.dungeonRoomRects.push(
      { id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } },
      { id: 'b', rect: { x: pxToFp(480), y: pxToFp(0), w: pxToFp(480), h: pxToFp(480) } },
    );
    return s;
  }
});

/**
 * The occlusion x-ray, end to end (live report *"角色跑到墙下面去了"* — the character walked to the
 * north side of an interior block and was drawn entirely behind it). `occlusion.test.ts` owns the
 * rule and the geometry invariants; these pin the WIRING, which is the half a pure unit test
 * cannot see: that a built room hands the fader the block's real footprint and reach, that the
 * pillars are in the list too, and that what actually changes on screen is the cap and nothing
 * else.
 */
describe('RoomBuilder.updateOcclusion — a block that would hide the player gets out of the way', () => {
  const ROOM = 480;

  /** One room with a 2x2-grid interior block in the middle of it, plus a north perimeter run. */
  function stateWithInteriorBlock(): GameState {
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: ROOM, worldH: ROOM, waves: [],
      walls: [[0, 0, ROOM, 32], [128, 128, 64, 64]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(ROOM), h: pxToFp(ROOM) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    return s;
  }

  function blocks(rb: RoomBuilder): Entity[] {
    return (rb as unknown as { wallEntities: Entity[] }).wallEntities;
  }

  /** The player standing as far north of the interior block as the engine lets them. The block's
   *  footprint is y 128..192, so this is its NORTH edge minus one clearance — not `192 - r`, which
   *  is a point inside the stone (an earlier version of this fixture had exactly that bug, and it
   *  passed until `occlusionCoverage.test.ts` started sweeping only legal positions). */
  const behindBlock = { x: 160, y: 128 - fpToPx(PLAYER_BASE.solidRadius), halfW: 13, bodyH: 32 };
  const settle = (rb: RoomBuilder, focus: typeof behindBlock | null): void => {
    for (let i = 0; i < 30; i++) rb.updateOcclusion(focus ? [focus] : [], 16.67);
  };

  it('registers one occluder per standing block, walls and pillars alike', () => {
    const rb = makeRoomBuilder();
    const s = stateWithInteriorBlock();
    s.obstacles.push({ gx: pxToFp(300), gy: pxToFp(300), radius: pxToFp(20) });
    rb.build(s);
    expect(occluders(rb)).toHaveLength(blocks(rb).length + 1);
  });

  it('gives the interior block a box matching the art it actually draws', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    const box = occluders(rb).find((o) => o.box.sortY === 192)!.box;
    expect(box.left).toBeCloseTo(128, 1);
    expect(box.right).toBeCloseTo(192, 1);
    // A block paints from its cap's north edge down to its own south edge: one wall height plus
    // its footprint depth above `sortY`.
    expect(box.top).toBeCloseTo(192 - WALL_H_INTERIOR - 64, 1);
  });

  it('fades the interior block\'s CAP, and leaves its face and silhouette alone', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    const seg = blocks(rb).find((e) => e.zIndex === 192)!;
    const cap = seg.children.filter((c) => c.label === XRAY_LABEL);
    const rest = seg.children.filter((c) => c.label !== XRAY_LABEL);
    const restBefore = rest.map((c) => c.alpha);

    settle(rb, behindBlock);
    for (const c of cap) expect(c.alpha).toBeLessThan(0.5);
    expect(rest.map((c) => c.alpha)).toEqual(restBefore);
  });

  it('leaves every OTHER block in the room solid', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    settle(rb, behindBlock);
    const others = occluders(rb).filter((o) => o.box.sortY !== 192);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(o.cap.fade).toBe(1);
  });

  it('fades the block for a SECOND focus (a monster) even while the first (the player) stands clear of it — live report *"如果只有怪物在墙下面的话，就看不到怪物了"*', () => {
    // Wired end to end through the real footprint/geometry: `GameLoop.updateFx` now hands this
    // call the player AND every live enemy, and a block must fade if it hides ANY of them, not
    // just whichever focus happens to be first in the list.
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    const seg = blocks(rb).find((e) => e.zIndex === 192)!;
    const cap = seg.children.filter((c) => c.label === XRAY_LABEL);
    const playerElsewhere = { x: 400, y: 400, halfW: 13, bodyH: 32 }; // nowhere near the block

    for (let i = 0; i < 30; i++) rb.updateOcclusion([playerElsewhere, behindBlock], 16.67);
    for (const c of cap) expect(c.alpha).toBeLessThan(0.5);
  });

  it('and puts it back once the player steps out from behind it', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    const seg = blocks(rb).find((e) => e.zIndex === 192)!;
    const cap = seg.children.filter((c) => c.label === XRAY_LABEL);
    const before = cap.map((c) => c.alpha);
    settle(rb, behindBlock);
    settle(rb, { ...behindBlock, y: 300 }); // south of the block — the Y-sort has it covered
    expect(cap.map((c) => c.alpha)).toEqual(before);
  });

  it('takes the FACE too where a tall boundary run buries the whole body', () => {
    // The other half of the rule, wired end to end: a 104 px perimeter run over a 32 px footprint
    // can put the character entirely below its cap/face fold, where fading the cap alone changes
    // nothing on screen. `occlusionCoverage.test.ts` is what found this on the shipped floors;
    // this is the check that RoomBuilder actually hands the fader the layers it needs for it.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: ROOM, worldH: ROOM, waves: [],
      // A stub jutting east from the room's west wall — `ember_cross`'s own shape (a 5x2 grid
      // solid off the west edge). Touching an edge makes it a PERIMETER run, so it stands 104 px
      // over a 32 px footprint with open floor to its north for the player to stand on. Two
      // stacked rooms used to serve as this fixture, until the boundary between them became a
      // kerb on both sides (2026-08-20) and stopped being a tall run at all.
      walls: [[0, 200, 96, 32]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(ROOM), h: pxToFp(ROOM) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    const rb = makeRoomBuilder();
    rb.build(s);

    const boundary = occluders(rb).find((o) => o.box.sortY === 232)!;
    expect(boundary.box.sortY - boundary.box.foldY).toBe(WALL_H_PERIMETER); // it really is the tall tier
    const seg = blocks(rb).find((e) => e.zIndex === 232)!;
    const deepLayers = seg.children.filter((c) => c.label === XRAY_DEEP_LABEL);
    expect(deepLayers.length).toBe(2); // the face's BAND and the shading over it — not the whole
    // face: since 2026-08-27 only the rows a body can reach are in this group, and the base below
    // them is a separate piece in neither group (`occlusion.deepFadeReach`). Named here rather
    // than left to the `silhouette` filter below, which used to cover it by accident.
    const base = seg.children.filter((c) => c.label === FACE_BASE_LABEL);
    expect(base).toHaveLength(1);
    const silhouette = seg.children.filter(
      (c) => c.label !== XRAY_LABEL && c.label !== XRAY_DEEP_LABEL && c.label !== FACE_BASE_LABEL,
    );
    const silBefore = silhouette.map((c) => c.alpha);

    // stand one clearance north of the run's footprint: the whole body is below the fold
    settle(rb, { x: 48, y: 200 - fpToPx(PLAYER_BASE.solidRadius), halfW: 13, bodyH: 32 });
    expect(boundary.cap.fade).toBeLessThan(0.5);
    expect(boundary.deep.fade).toBeLessThan(0.5);
    for (const c of deepLayers) expect(c.alpha).toBeLessThan(0.5);
    // ...the block's BASE holds full strength through it, which is the whole point of the split
    expect(base[0]!.alpha).toBe(1);
    // ...and the silhouette still never moves, in either pass
    expect(silhouette.map((c) => c.alpha)).toEqual(silBefore);
  });

  it('splits the face on the same row the occluder box reports, so the two agree', () => {
    // Two derivations of one row: `RoomBuilder` computes the occluder's `foldY` from the height it
    // passes to `buildWallBlock`, and `addWallFace` splits the face from the same height and the
    // run's own depth. Nothing made them agree except being fed the same numbers — and this repo
    // has already shipped the failure that shape produces (`blockCapTop` was inlined at two call
    // sites, so a clip could land in one and not the other). Checked through the real builder,
    // on a run whose height is the DOOR-CLIPPED effective one where that applies.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: ROOM, worldH: ROOM, waves: [],
      // Four shapes on purpose, so both branches below are exercised: a north boundary and a west
      // stub (104 px over 32 -> split), a 2x2 interior block (70 over 64 -> a 6 px band), and the
      // south KERB (22 over 32 -> reach 0, one whole never-fading piece).
      walls: [[0, 0, ROOM, 32], [0, 200, 96, 32], [128, 128, 64, 64], [0, ROOM - 32, ROOM, 32]],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(ROOM), h: pxToFp(ROOM) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    // ...and a DOOR immediately north of the 2x2 block, which is the fifth shape and the reason
    // this fixture is not just the perimeter one: `bordersDoorNorth` fires, so that run is drawn at
    // `effectiveWallHeight` (min(70, 64) = 64) rather than at its tier height. A build that fed the
    // occluder box one of those and the block the other is behaviour-IDENTICAL on every fixture
    // without a door — which is exactly how a mutation battery found this hole on 2026-08-27.
    pushDoor(s, false, [128, 96, 64, 32]);
    const rb = makeRoomBuilder();
    rb.build(s);

    let split = 0;
    let whole = 0;
    for (const o of occluders(rb)) {
      const seg = blocks(rb).find((e) => e.zIndex === o.box.sortY);
      if (!seg) continue; // a pillar: no face, and no fold either (`foldY === sortY`)
      const pieces = seg.children.filter(
        (c): c is TilingSprite =>
          c instanceof TilingSprite && (c.label === XRAY_DEEP_LABEL || c.label === FACE_BASE_LABEL),
      );
      const height = o.box.sortY - o.box.foldY;
      // The elevation is whole however many pieces it takes, and it starts at the fold.
      expect(pieces.reduce((n, p) => n + p.height, 0)).toBeCloseTo(height, 6);
      expect(pieces[0]!.y).toBeCloseTo(-height, 6);
      if (pieces.length === 2) {
        expect(pieces[1]!.y).toBeCloseTo(-height + pieces[0]!.height, 6);
        expect(pieces[1]!.label).toBe(FACE_BASE_LABEL);
        // The join row, derived from the occluder box's THIRD number rather than from `foldY`
        // again. `reach = height - depth`, so the base's height IS the footprint depth — and the
        // box reports that depth independently as its cap's drawn depth, `foldY - top`. A build
        // that fed the two sides different heights would break this even where the sum above
        // still came out right.
        expect(pieces[1]!.height).toBeCloseTo(o.box.foldY - o.box.top, 6);
        expect(pieces[0]!.height).toBeCloseTo(deepFadeReach(height, pieces[1]!.height), 6);
        split++;
      } else {
        expect(pieces).toHaveLength(1);
        whole++;
      }
    }
    // The sweep has to be a sweep, and it has to contain BOTH shapes — a room of only-split or
    // only-whole blocks would let half of this pass vacuously. The kerb on the room's south edge
    // is the whole-face case (22 px of art over a 32 px footprint, reach 0).
    expect(split).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(0);
  });

  it('gives a KERB no deep group at all, and a tall run one — with the counts', () => {
    // The reach is 0 for 22 px of art over a 32 px footprint, so a kerb's whole face is tagged
    // never-fading and its deep group holds only the shading. That is the same thing
    // `needsDeepFade` already refuses to do there, said in geometry — and stating it with counts is
    // what stops "we never wired it" and "it can never come up" from looking identical in a diff.
    mocks.wallTex = fakeTexture(256, 256);
    mocks.wallFaceTex = fakeTexture(256, 128);
    const s = createGameState({
      seed: 1, worldW: ROOM, worldH: ROOM, waves: [],
      // A full perimeter: the south run is the kerb tier (it cannot be tall without hiding a
      // player walking along it), the other three are room boundaries.
      walls: [
        [0, 0, ROOM, 32], [0, ROOM - 32, ROOM, 32],
        [0, 0, 32, ROOM], [ROOM - 32, 0, 32, ROOM],
      ],
      obstacles: [],
    });
    s.dungeonRoomRects.push({ id: 'r1', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(ROOM), h: pxToFp(ROOM) } });
    (s as unknown as { dungeonConfig?: { biomeId: string } }).dungeonConfig = { biomeId: 'ember' };
    const rb = makeRoomBuilder();
    rb.build(s);
    let kerbs = 0;
    let tall = 0;
    for (const o of occluders(rb)) {
      const seg = blocks(rb).find((e) => e.zIndex === o.box.sortY);
      if (!seg) continue;
      const faces = seg.children.filter(
        (c): c is TilingSprite =>
          c instanceof TilingSprite && (c.label === XRAY_DEEP_LABEL || c.label === FACE_BASE_LABEL),
      );
      const fading = faces.filter((c) => c.label === XRAY_DEEP_LABEL);
      if (o.box.sortY - o.box.foldY === WALL_H_KERB) {
        expect(fading).toHaveLength(0); // nothing of a kerb's face can ever be reached
        expect(faces).toHaveLength(1);
        kerbs++;
      } else {
        expect(fading).toHaveLength(1);
        tall++;
      }
    }
    expect(kerbs).toBeGreaterThan(0); // the shipped south kerb
    expect(tall).toBeGreaterThan(0);
  });

  it('fades a pillar the player is standing behind, body and all', () => {
    // A pillar's occluder is its SHAFT, not a cap: it is drawn upward from its own ground point,
    // so the whole body goes translucent rather than one layer of it.
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle());
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    const body = pillar.children[0]!;
    settle(rb, { x: 150, y: 120 - 20 - fpToPx(PLAYER_BASE.solidRadius), halfW: 13, bodyH: 32 });
    expect(body.alpha).toBeLessThan(0.5);
  });

  it('drops the previous room\'s occluders on rebuild rather than appending', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithInteriorBlock());
    const first = occluders(rb).length;
    rb.build(stateWithInteriorBlock());
    expect(occluders(rb)).toHaveLength(first);
    rb.clear();
    expect(occluders(rb)).toHaveLength(0);
  });

  it('is a safe no-op before any room is built', () => {
    const rb = makeRoomBuilder();
    expect(() => rb.updateOcclusion([behindBlock], 16.67)).not.toThrow();
  });
});

/**
 * The textured pillar, end to end (2026-08-20). `pillarRender.test.ts` proves the sprite's own
 * geometry; what only RoomBuilder can prove is that the occluder it registers follows the body it
 * actually mounted — the x-ray reads that box and nothing else, so a sprite drawn to one shape
 * with an occluder describing the other is exactly the bug class this pass exists to avoid.
 */
describe('RoomBuilder — pillars from real art', () => {
  afterEach(() => {
    mocks.pillarTex = undefined;
  });

  it('mounts a Sprite body when the art is registered, and the Graphics cylinder when it is not', () => {
    mocks.pillarTex = fakeTexture(326, 384);
    const withArt = makeRoomBuilder();
    withArt.build(stateWithOneObstacle());
    const textured = (withArt as unknown as { pillars: Entity[] }).pillars[0]!;
    expect(textured.children[0]!.children.some((c) => c instanceof Sprite)).toBe(true);

    mocks.pillarTex = undefined;
    const noArt = makeRoomBuilder();
    noArt.build(stateWithOneObstacle());
    const fallback = (noArt as unknown as { pillars: Entity[] }).pillars[0]!;
    expect(fallback.children[0]).toBeInstanceOf(Graphics);
  });

  it('registers an occluder box that matches the sprite it actually drew', () => {
    mocks.pillarTex = fakeTexture(326, 384);
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle());
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    const sprite = pillar.children[0]!.children.find((c) => c instanceof Sprite) as Sprite;
    // This fixture has one obstacle and no walls, so the pillar is the only occluder.
    expect(occluders(rb)).toHaveLength(1);
    const occ = occluders(rb)[0]!;
    // The sprite is bottom-anchored at `PILLAR_BASE_PX` below the ground point, so its top edge
    // in world space is the occluder's `top`, and its half-width the occluder's own.
    expect(occ.box.top).toBeCloseTo(pillar.y + 10 - sprite.height, 1);
    expect(occ.box.right - occ.box.left).toBeCloseTo(sprite.width, 1);
  });

  it('a taller-than-shipped art file moves the occluder with it, rather than lying about the box', () => {
    // The regression this guards: hardcoding the extent off the hand-toned ellipse maths. Swap in
    // art twice as tall per unit width and the registered box has to grow — otherwise the x-ray
    // keeps testing a boundary the stone no longer stops at.
    mocks.pillarTex = fakeTexture(326, 384);
    const shipped = makeRoomBuilder();
    shipped.build(stateWithOneObstacle());
    const shippedTop = occluders(shipped)[0]!.box.top;

    mocks.pillarTex = fakeTexture(326, 768);
    const tall = makeRoomBuilder();
    tall.build(stateWithOneObstacle());
    expect(occluders(tall)[0]!.box.top).toBeLessThan(shippedTop - 50);
  });

  it("asks for the art and the tint of the room's OWN biome, not the neutral fallback", () => {
    // Two battery survivors in one: `getPillarTexture('neutral')` hardcoded, and the sprite tinted
    // from `biomePalette(undefined)`. Both leave every geometry assertion green and quietly drop
    // the biome — the one channel that distinguishes an ember room's pillar from an ice room's,
    // now that all four share a single file.
    mocks.pillarTex = fakeTexture(326, 384);
    mocks.pillarTexElement = undefined;
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle()); // fixture's dungeonConfig.biomeId is 'ember'
    expect(mocks.pillarTexElement).toBe('fire');
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    const sprite = pillar.children[0]!.children.find((c) => c instanceof Sprite) as Sprite;
    expect(sprite.tint).toBe(pillarTint(biomePalette('ember')));
    expect(sprite.tint).not.toBe(pillarTint(biomePalette(undefined)));
  });

  it('keeps the ground shadow at least as wide as the body standing on it', () => {
    // `makeShadow(rad + 12)` predates this pass but was never covered, and the drawn body got a
    // little wider with the art: a shadow narrower than the object it belongs to reads as the
    // pillar hovering. Measured off the drawn objects rather than restating the +12.
    mocks.pillarTex = fakeTexture(326, 384);
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle());
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    const sprite = pillar.children[0]!.children.find((c) => c instanceof Sprite) as Sprite;
    expect(pillar.shadow!.width).toBeGreaterThanOrEqual(sprite.width);
  });

  it('still throws the same cast shadow as the wall beside it', () => {
    // The shadow is displaced by WALL_HEIGHT, not by the art's own height — a pillar and a 70 px
    // interior wall share one key light (`Entity.SHADOW_SLANT_*`), which is the agreement the
    // whole volume pass rests on.
    mocks.pillarTex = fakeTexture(326, 384);
    const rb = makeRoomBuilder();
    rb.build(stateWithOneObstacle());
    const pillar = (rb as unknown as { pillars: Entity[] }).pillars[0]!;
    expect(pillar.shadowOffsetX).toBeCloseTo(WALL_H_INTERIOR * SHADOW_SLANT_X, 5);
    expect(pillar.shadowOffsetY).toBeCloseTo(WALL_H_INTERIOR * SHADOW_SLANT_Y, 5);
  });
});

/**
 * RoomBuilder — decorative props (`RoomPiece.props`, 2026-08-21). Read straight off
 * `s.dungeonRooms` (the `PlacedRoom[]` SpawnSystem already populates), not a new
 * engine-side field — these fixtures push directly onto it, the same "readonly is the
 * array reference, not its contents" convention `s.obstacles.push(...)` already uses
 * elsewhere in this file.
 */
function stateWithProps(props: PropPlacement[], offsetXGrid = 2, offsetYGrid = 3): GameState {
  const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
  const piece: RoomPiece = {
    id: 'test_room',
    sizeGrid: { w: 20, h: 20 },
    solids: [],
    spawns: { player: [], enemy: [] },
    exits: [],
    props,
  };
  const room: PlacedRoom = { id: 'r1', piece, offsetXGrid, offsetYGrid, entranceGrid: { x: 0, y: 0 } };
  s.dungeonRooms.push(room);
  return s;
}

function propEntities(rb: RoomBuilder): Entity[] {
  return (rb as unknown as { props: Entity[] }).props;
}

describe('RoomBuilder — decorative props (RoomPiece.props)', () => {
  it('creates one Entity per prop, positioned at (grid + room offset) * PX_PER_GRID', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([{ id: 'crate', x: 4, y: 5 }], 2, 3));
    const props = propEntities(rb);
    expect(props).toHaveLength(1);
    expect(props[0]!.curX).toBeCloseTo((4 + 2) * PX_PER_GRID, 5);
    expect(props[0]!.curY).toBeCloseTo((5 + 3) * PX_PER_GRID, 5);
  });

  it('lives on the Y-sorted entities layer, zIndex = its own ground y', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithProps([{ id: 'barrel', x: 1, y: 1 }], 0, 0));
    const [prop] = propEntities(rb);
    expect(layers.entities.children).toContain(prop);
    expect(prop!.zIndex).toBeCloseTo(1 * PX_PER_GRID, 5);
  });

  it('gets a ground shadow on the shadow layer, like every other static object in the room', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithProps([{ id: 'crate', x: 1, y: 1 }], 0, 0));
    const [prop] = propEntities(rb);
    expect(prop!.shadow).not.toBeNull();
    expect(layers.shadow.children).toContain(prop!.shadow);
  });

  it('draws one per prop across every co-resident room, in placement order', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    const pieceOf = (props: PropPlacement[]): RoomPiece => ({
      id: 'p', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [], enemy: [] }, exits: [], props,
    });
    s.dungeonRooms.push(
      { id: 'a', piece: pieceOf([{ id: 'crate', x: 1, y: 1 }]), offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } },
      { id: 'b', piece: pieceOf([{ id: 'barrel', x: 2, y: 2 }, { id: 'rubble', x: 3, y: 3 }]), offsetXGrid: 20, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } },
    );
    const rb = makeRoomBuilder();
    rb.build(s);
    expect(propEntities(rb)).toHaveLength(3);
  });

  it('never renders nothing for an unrecognized id — falls back to the default kind', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([{ id: 'some_future_kind_not_shipped_yet', x: 1, y: 1 }], 0, 0));
    const [prop] = propEntities(rb);
    expect(prop!.children.length).toBeGreaterThan(0);
  });

  it('actually resolves and draws the AUTHORED kind, not just "some body" regardless of id', () => {
    // A barrel's Graphics draws a top ellipse (`g.ellipse`); a crate's never does. Distinct
    // enough to catch RoomBuilder ignoring `prop.id` and always drawing one fixed kind — the
    // per-kind geometry itself is `propRender.test.ts`'s job, this is the WIRING between them.
    type Instr = { data?: { path?: { instructions?: Array<{ action: string }> } } };
    const drawsAnEllipse = (e: Entity): boolean => {
      const g = e.children[0]!.children.find((c) => c instanceof Graphics) as Graphics | undefined;
      const instructions = (g?.context.instructions ?? []) as unknown as Instr[];
      return instructions.some((i) => (i.data?.path?.instructions ?? []).some((pi) => pi.action === 'ellipse'));
    };
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([{ id: 'crate', x: 1, y: 1 }, { id: 'barrel', x: 5, y: 5 }], 0, 0));
    const [crate, barrel] = propEntities(rb);
    expect(drawsAnEllipse(crate!)).toBe(false);
    expect(drawsAnEllipse(barrel!)).toBe(true);
  });

  it("sizes each prop's shadow from the AUTHORED kind, not one fixed radius", () => {
    // The test above only asks that a shadow EXISTS and is on the layer, which is what let a
    // 2026-08-27 battery replace `propShadowRadius(kind)` with `0` and survive: `makeShadow(0)`
    // still builds a Graphics and still parents it, so a prop that floats with no shadow at all
    // passed every assertion in this file. `propRender.test.ts` pins the table's own values
    // (crate 9 / barrel 8 / rubble 11); what was missing is the WIRING between them, so this
    // reads the ratio through the real `propShadowRadius` rather than transcribing any of the
    // three — a re-tune of the table moves both sides together, and only a broken hand-off
    // (zero, or one fixed radius for every kind) breaks the ratio.
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([{ id: 'barrel', x: 1, y: 1 }, { id: 'rubble', x: 5, y: 5 }], 0, 0));
    const [barrel, rubble] = propEntities(rb);
    const spanOf = (e: Entity): number => e.shadow!.getLocalBounds().maxX;
    expect(spanOf(barrel!)).toBeGreaterThan(0);
    expect(spanOf(rubble!) / spanOf(barrel!)).toBeCloseTo(
      propShadowRadius('rubble') / propShadowRadius('barrel'),
      5,
    );
  });

  it('is not registered with the occlusion x-ray — props are short enough not to need it', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([{ id: 'crate', x: 1, y: 1 }], 0, 0));
    expect(occluders(rb)).toHaveLength(0); // no walls/pillars/doors in this fixture either
  });

  it('destroys the previous room\'s props on rebuild, no leak', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithProps([{ id: 'crate', x: 1, y: 1 }], 0, 0));
    const first = propEntities(rb)[0]!;
    rb.build(stateWithProps([{ id: 'barrel', x: 2, y: 2 }], 0, 0));
    expect(propEntities(rb)).toHaveLength(1);
    expect(propEntities(rb)[0]).not.toBe(first);
    expect(layers.entities.children).not.toContain(first);
    expect(first.destroyed).toBe(true);
  });

  it('destroys props on clear() too, and leaves none behind for the next build()', () => {
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(stateWithProps([{ id: 'crate', x: 1, y: 1 }], 0, 0));
    rb.clear();
    expect(propEntities(rb)).toHaveLength(0);
    expect(layers.entities.children.filter((c) => c instanceof Entity)).toHaveLength(0);
  });

  it('draws nothing for a room whose piece has no props at all', () => {
    const rb = makeRoomBuilder();
    rb.build(stateWithProps([], 0, 0));
    expect(propEntities(rb)).toHaveLength(0);
  });

  it('does not throw for a piece that OMITS props entirely, not just an empty array', () => {
    // Most of the shipped ember_l1 library predates this pass and has no `props` key at all —
    // `piece.props` is `undefined`, not `[]`, for those pieces.
    const s = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    const piece: RoomPiece = {
      id: 'no_props_key', sizeGrid: { w: 10, h: 10 }, solids: [], spawns: { player: [], enemy: [] }, exits: [],
    };
    s.dungeonRooms.push({ id: 'r1', piece, offsetXGrid: 0, offsetYGrid: 0, entranceGrid: { x: 0, y: 0 } });
    const rb = makeRoomBuilder();
    expect(() => rb.build(s)).not.toThrow();
    expect(propEntities(rb)).toHaveLength(0);
  });
});

describe('RoomBuilder — standing pieces are tagged for the camera cull (2026-09-28)', () => {
  // `FxController` culls `layers.entities` by the same tag as the ground: every block, door and
  // pillar must carry one covering what it draws, and the portal (which animates past its bounds)
  // and every actor must not — an untagged child is never culled, which is the safe direction.
  it('tags every wall block, door fixture and pillar with a rect around its drawn bounds', () => {
    const s = stateWithOneWall('ember');
    pushDoor(s, true, [300, 100, 20, 64]);
    const rb = makeRoomBuilder();
    const layers = (rb as unknown as { layers: Layers }).layers;
    rb.build(s);
    const pillars = makeRoomBuilder();
    pillars.build(stateWithOneObstacle());
    const pillarLayer = (pillars as unknown as { layers: Layers }).layers.entities;
    const standing = [
      ...(rb as unknown as { wallEntities: Container[] }).wallEntities,
      doorFixtures(rb)[0]!.view,
      pillarLayer.children[0]!,
    ];
    expect(standing).toHaveLength(3);
    for (const piece of standing) {
      const tag = groundPieceBounds(piece)!;
      expect(tag).toBeDefined();
      const b = piece.getLocalBounds();
      expect(tag.x).toBeLessThanOrEqual(piece.x + b.minX);
      expect(tag.y).toBeLessThanOrEqual(piece.y + b.minY);
      expect(tag.x + tag.w).toBeGreaterThanOrEqual(piece.x + b.maxX);
      expect(tag.y + tag.h).toBeGreaterThanOrEqual(piece.y + b.maxY);
    }
    const untagged = layers.entities.children.filter((c) => !groundPieceBounds(c));
    expect(untagged).toEqual([(rb as unknown as { portal: Container }).portal]);
  });
});
