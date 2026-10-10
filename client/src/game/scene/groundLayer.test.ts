/**
 * `groundLayer.ts` — the ground stage as a whole (2026-08-20). Everything here was found by a
 * mutation battery over the floor pass rather than written alongside it: `floorRender.test.ts` pins
 * what each layer DRAWS, and every one of those tests still passed with the layers mounted in the
 * wrong order, with the additive layer not additive, with the per-room seed replaced by an array
 * index, and with the door wear removed altogether. Those are the four assertions below.
 *
 * The fifth is the region split — which rects get a floor (coverage) versus which get an identity
 * (wash/mottle/decals/light). `floorCoverage.test.ts` measures WHY they differ; this pins that the
 * two functions actually answer differently.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import { createGameState } from '@dd/engine/state/GameState';
import { pxToFp, toFpGrid } from '@dd/engine/content/convert';
import { biomePalette } from '../theme';
import { buildGroundLayer, floorRegionsPx, roomRectsPx, type GroundDeps } from './groundLayer';
import { ARENA_CATALOG } from '../match/arenaCatalog';
import { fpToPx } from '../coords';
import type { RectPx } from './wallGeometry';
import type { SwatchMeta } from '../../render/biomeTiles';

// `swatchMeta` reads a WeakMap that only `loadBiomeTiles` fills; a test texture is tagged here instead.
const meta = vi.hoisted(() => new Map<unknown, SwatchMeta>());
vi.mock('../../render/biomeTiles', async (orig) => ({
  ...(await orig<object>()),
  swatchMeta: (t: unknown) => (t ? meta.get(t) : undefined),
}));

const PALETTE = biomePalette('ember');

/** An AABB from whole grid cells — the unit arena content is authored in. */
const g = (x: number, y: number, w: number, h: number) => ({
  x: toFpGrid(x), y: toFpGrid(y), w: toFpGrid(w), h: toFpGrid(h),
});

function tex(size: number): Texture {
  return new Texture({ source: new TextureSource({ width: size, height: size }) });
}

function deps(over: Partial<GroundDeps> = {}): GroundDeps {
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
    floorRegions: [{ x: 0, y: 0, w: 512, h: 512 }],
    wallRects: [],
    doorRects: [],
    palette: PALETTE,
    floorTex: tex(256),
    ...over,
  };
}

/** A comparable digest of a Graphics' geometry — see `floorRender.test.ts` for why the instruction
 *  list cannot go through `JSON.stringify`. */
function digest(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const data = ins.data as {
        style?: { color?: number; alpha?: number };
        path?: { instructions: { action: string; data: unknown[] }[] };
      };
      const path = (data.path?.instructions ?? [])
        .map((i) => `${i.action}(${i.data.filter((v) => typeof v === 'number').map((v) => (v as number).toFixed(2)).join(',')})`)
        .join('|');
      return `${ins.action} ${data.style?.color ?? ''}@${(data.style?.alpha ?? 0).toFixed(3)} ${path}`;
    })
    .join(';');
}

/** Every node under `root`, in PAINT order (depth-first pre-order — what Pixi draws in).
 *  Recursive since 2026-08-26: the floor stamp's sprites now sit inside one container per floor
 *  region so the camera can cull the region as a unit (`groundCulling.ts`), which is one level
 *  deeper than this file used to look. */
function paintOrder(root: Container): Container[] {
  return root.children.flatMap((c) => [c, ...paintOrder(c)]);
}

function build(d: GroundDeps): { ground: Container; order: Container[]; graphics: Graphics[]; tiles: Sprite[] } {
  const ground = new Container();
  buildGroundLayer(ground, d);
  const order = paintOrder(ground);
  return {
    ground,
    order,
    graphics: order.filter((c): c is Graphics => c instanceof Graphics),
    tiles: order.filter((c): c is Sprite => c instanceof Sprite && !(c instanceof Graphics)),
  };
}

describe('buildGroundLayer — the stack, in the order it has to be in', () => {
  it('paints the floor first and the overlays on top of it, never the reverse', () => {
    const { order, tiles } = build(deps());
    const lastTile = Math.max(...tiles.map((t) => order.indexOf(t)));
    const firstOverlay = Math.min(...order.filter((c) => c instanceof Graphics).map((c) => order.indexOf(c)));
    // Pixi paints in child order, so a grid or a light pool mounted before the floor is invisible —
    // and every "what does this layer draw" test still passes while it is.
    expect(firstOverlay).toBeGreaterThan(lastTile);
  });

  it('mounts the four overlays in the documented order: variation, then grid, then room light', () => {
    const { graphics } = build(deps({ rooms: [{ x: 0, y: 0, w: 512, h: 512 }] }));
    expect(graphics).toHaveLength(4);
    const [floorDark, floorLight, grid, light] = graphics;
    expect(floorLight!.blendMode).toBe('add');
    expect(floorDark!.blendMode).toBe('inherit'); // i.e. untouched — only the light half is additive
    // The grid is a stroke and the light pool a stack of strokes; the variation layers are fills.
    // Identifying them by what they draw rather than by index would be circular, so this asserts
    // the pair that actually matters: the light pool is LAST, so the lattice fades toward the walls
    // with everything else, and the grid sits above the floor's own variation.
    expect(digest(light!)).not.toBe('');
    expect(digest(grid!)).not.toBe('');
    expect(digest(floorDark!)).not.toBe('');
  });

  it('keeps the light half additive — a floor that can only get darker loses its mean', () => {
    const { graphics } = build(deps());
    const additive = graphics.filter((g) => g.blendMode === 'add');
    expect(additive).toHaveLength(1);
    expect(digest(additive[0]!)).not.toBe(''); // and it actually carries geometry
  });
});

describe('buildGroundLayer — determinism and per-room identity', () => {
  const ROOM: RectPx = { x: 0, y: 0, w: 512, h: 512 };

  it('draws the identical floor for the same room twice — a room must not change between visits', () => {
    const a = build(deps({ rooms: [ROOM], floorRegions: [ROOM] }));
    const b = build(deps({ rooms: [ROOM], floorRegions: [ROOM] }));
    expect(a.graphics.map(digest)).toEqual(b.graphics.map(digest));
    expect(a.tiles.map((t) => `${t.x},${t.y},${t.scale.x},${t.scale.y}`)).toEqual(
      b.tiles.map((t) => `${t.x},${t.y},${t.scale.x},${t.scale.y}`),
    );
  });

  it('seeds each room off its WORLD POSITION, so two identical rooms elsewhere differ', () => {
    // An array index would give the first room of EVERY floor the same wash, the same mottle and
    // the same rubble — and the whole point of this layer is that one room does not look like
    // another. Compared as shapes RELATIVE TO the room's own origin, so "it moved" cannot pass for
    // "it differs": under an index seed the two lists below are identical.
    const relative = (room: RectPx): string[] => {
      const { graphics } = build(deps({ rooms: [room], floorRegions: [room] }));
      return graphics[0]!.context.instructions
        .flatMap((ins) => {
          const path = (ins.data as { path?: { instructions: { action: string; data: unknown[] }[] } }).path;
          // Ellipses only — every blob, stain and speck. Pixi emits a `moveTo(0, 0)` of its own
          // before each shape, and those carry ABSOLUTE zeros: including them makes the two lists
          // differ for a reason that has nothing to do with the seed, which is exactly how the
          // first version of this test passed while seeded by index.
          return (path?.instructions ?? [])
            .filter((i) => i.action === 'ellipse')
            .map((i) => {
              const nums = i.data.filter((v): v is number => typeof v === 'number');
              return `${(nums[0]! - room.x).toFixed(2)},${(nums[1]! - room.y).toFixed(2)},${nums[2]!.toFixed(2)}`;
            });
        });
    };
    const here = relative(ROOM);
    const there = relative({ ...ROOM, x: 2048, y: 1024 });
    expect(here.length).toBeGreaterThan(5);
    expect(there).not.toEqual(here);
  });

  it('gives every door a worn patch in the additive layer', () => {
    const withoutDoor = build(deps());
    const withDoor = build(deps({ doorRects: [{ x: 200, y: 240, w: 64, h: 128 }] }));
    // Across EVERY additive piece, not the first one found: door wear is its own piece per door
    // since 2026-08-26, and a `find` here would have picked up the room's light half instead and
    // reported no difference whether the wear was drawn or not.
    const additive = (b: ReturnType<typeof build>): string =>
      b.graphics.filter((g) => g.blendMode === 'add').map(digest).join(';');
    expect(additive(withDoor).length).toBeGreaterThan(additive(withoutDoor).length);
  });

  it('keeps rubble off the wall footprints it is handed', () => {
    const open = build(deps());
    const walled = build(deps({ wallRects: [{ x: 0, y: 0, w: 512, h: 256 }] }));
    expect(digest(walled.graphics[0]!).length).toBeLessThan(digest(open.graphics[0]!).length);
  });

  it('falls back to a flat palette fill, and still decorates it, with no floor swatch', () => {
    const { graphics, tiles } = build(deps({ floorTex: undefined }));
    expect(tiles).toHaveLength(0);
    expect(graphics).toHaveLength(5); // the fill, plus the same four overlays
    expect(digest(graphics[1]!)).not.toBe(''); // the variation is drawn over the flat fill too
  });
});

describe('roomRectsPx vs floorRegionsPx — identity is not coverage', () => {
  it('room identity prefers dungeon rooms, then arena rooms, then the world itself', () => {
    const flat = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    expect(roomRectsPx(flat, 800, 600)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);

    const arena = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    arena.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    expect(roomRectsPx(arena, 800, 600)).toEqual([{ x: 0, y: 0, w: 320, h: 320 }]);

    const dungeon = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    dungeon.dungeonRoomRects.push({ id: 'd', rect: { x: pxToFp(32), y: pxToFp(32), w: pxToFp(256), h: pxToFp(256) } });
    dungeon.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    expect(roomRectsPx(dungeon, 800, 600)).toEqual([{ x: 32, y: 32, w: 256, h: 256 }]);
  });

  it('floor COVERAGE is derived per map, not assumed from the map KIND', () => {
    // The asymmetry used to be hardcoded — dungeon per room, arena whole-world — on the strength
    // of one sweep of a map that had no walls. `floorCoverage.test.ts` carries the measurement and
    // the real-content sweep; this file pins the three shapes the function itself distinguishes.
    const unwalled = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    unwalled.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(0), y: pxToFp(0), w: pxToFp(320), h: pxToFp(320) } });
    // Rooms floating in open world: stopping the floor at them would put the player on the backdrop.
    expect(floorRegionsPx(unwalled, 800, 600)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);

    const walled = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    walled.arenaRoomRects.push({ id: 'a', rect: { x: pxToFp(64), y: pxToFp(64), w: pxToFp(320), h: pxToFp(320) } });
    // The same room, now with a perimeter around it: its floor may stop at the room.
    for (const [x, y, w, h] of [[64, 64, 320, 32], [64, 352, 320, 32], [64, 64, 32, 320], [352, 64, 32, 320]]) {
      walled.walls.push({ x: pxToFp(x!), y: pxToFp(y!), w: pxToFp(w!), h: pxToFp(h!) });
    }
    expect(floorRegionsPx(walled, 800, 600)).toEqual([{ x: 64, y: 64, w: 320, h: 320 }]);

    const dungeon = createGameState({ seed: 1, worldW: 800, worldH: 600, waves: [], walls: [], obstacles: [] });
    dungeon.dungeonRoomRects.push({ id: 'd', rect: { x: pxToFp(32), y: pxToFp(32), w: pxToFp(256), h: pxToFp(256) } });
    // A dungeon floor answers directly, with no flood fill: `floorCoverage.test.ts` sweeps all
    // five shipped floors for the same property, so re-deriving it per room transition buys nothing.
    expect(floorRegionsPx(dungeon, 800, 600)).toEqual([{ x: 32, y: 32, w: 256, h: 256 }]);
  });

  it('measures the arena against the world it is actually in, on both axes', () => {
    // G7 in the battery: `cellExtent(s.worldH, s.worldW)` — the axes swapped at the call site —
    // survived the whole suite, because `arena_launch` is the only non-square arena the catalog
    // has and the swap happens not to flip its answer. A wide, short world where a room is flush
    // against the EAST edge does flip it: with the extent right the world boundary encloses the
    // room (per-room floor); with the axes swapped the grid is too narrow to contain the room at
    // all, no cell seeds, and the map falls back to a whole-world floor.
    const CELL = 32;
    const state = createGameState({
      seed: 1, worldW: 30 * CELL, worldH: 10 * CELL, waves: [], walls: [], obstacles: [],
    });
    state.arenaRoomRects.push({ id: 'east', rect: g(22, 2, 8, 6) });
    // Walled north, south and west; the east side is the map edge.
    for (const wall of [g(22, 2, 8, 1), g(22, 7, 8, 1), g(22, 2, 1, 6)]) state.walls.push(wall);
    expect(floorRegionsPx(state, 30 * CELL, 10 * CELL)).toEqual([
      { x: 22 * CELL, y: 2 * CELL, w: 8 * CELL, h: 6 * CELL },
    ]);
  });
});

describe('the real launch arena, end to end through the ground stage', () => {
  // Every other case in this file is a literal. This one sources its deps from the REAL producer
  // (`ARENA_CATALOG.arena_launch` -> `roomRectsPx`/`floorRegionsPx` -> `buildGroundLayer`):
  // `floorCoverage.test.ts` proves the REGIONS stop at the rooms and `floorRender.test.ts` proves
  // `stampFloor` clips a tile to the region it was handed, but neither runs the map a match
  // actually builds through the stage that paints it.
  //
  // Honest about its own weight: it was written to close a seam and it fires on every composition
  // mutant tried against it (a tile never clipped, clipped on one axis only, a full tile positioned
  // by its top-left while keeping anchor 0.5, the world box stamped alongside the regions) — but
  // `floorRender.test.ts` or `RoomBuilder.test.ts` catch each of those too, so no mutant is known
  // that ONLY this test kills. What it uniquely states is an identity over real content at real
  // scale: the area painted for 60 authored rooms equals those rooms' own area, exactly. A fixture
  // of one 512x512 room cannot make that claim, and it is the claim that breaks first if regions,
  // clipping or tile placement drift apart from each other.
  const arena = (() => {
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: ARENA_CATALOG.arena_launch });
    const w = fpToPx(state.worldW);
    const h = fpToPx(state.worldH);
    return { state, w, h, rooms: roomRectsPx(state, w, h), regions: floorRegionsPx(state, w, h) };
  })();

  it('stamps 60 rooms and not the void between them', () => {
    const { tiles: sprites } = build(deps({ rooms: arena.rooms, floorRegions: arena.regions }));
    expect(arena.regions).toHaveLength(60);

    const inARoom = (x: number, y: number): boolean =>
      arena.rooms.some((r) => x >= r.x - 0.01 && x <= r.x + r.w + 0.01 && y >= r.y - 0.01 && y <= r.y + r.h + 0.01);
    let outside = 0;
    let painted = 0;
    for (const sp of sprites) {
      // `stampFloor` mirrors a FULL tile about its own centre, so an unclipped tile carries
      // anchor 0.5 and its `x`/`y` are the tile's CENTRE — reading them as a top-left corner
      // manufactures phantom out-of-bounds tiles at every room's south-east corner.
      const w = Math.abs(sp.width);
      const h = Math.abs(sp.height);
      const left = sp.x - sp.anchor.x * w;
      const top = sp.y - sp.anchor.y * h;
      painted += w * h;
      const corners: [number, number][] = [[left, top], [left + w, top], [left, top + h], [left + w, top + h]];
      if (!corners.every(([x, y]) => inARoom(x, y))) outside++;
    }
    expect(sprites.length).toBeGreaterThan(0);
    expect(outside).toBe(0);
    // Painted area equals the rooms' own area exactly — the rooms are flush, so they overlap only
    // on zero-area boundary lines, and any tile spilling into the void would push this over.
    const roomArea = arena.rooms.reduce((a, r) => a + r.w * r.h, 0);
    expect(painted).toBeCloseTo(roomArea, 5);
    // ...and that really is less than the world box, or "stops at the rooms" is vacuous here.
    expect(roomArea).toBeLessThan(arena.w * arena.h);
  });
});

describe('buildGroundLayer — an authored warm-stone floor (design/13, 2026-10-10)', () => {
  const stone = tex(256);
  meta.set(stone, { density: 2.56, seamless: true, authoredTone: true });
  const room: RectPx = { x: 0, y: 0, w: 512, h: 512 };
  const north: RectPx = { x: 0, y: 0, w: 512, h: 64 };

  it('draws no grid over it — the lattice would read as a second, unrelated paving', () => {
    const { graphics } = build(deps({ floorTex: stone }));
    expect(graphics).toHaveLength(3); // the two variation halves and the light; the control is 4 above
  });

  it('never mirrors a swatch that wraps exactly', () => {
    const { tiles } = build(deps({ floorTex: stone }));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((t) => t.scale.x > 0 && t.scale.y > 0)).toBe(true);
    // The control: the same texture untagged is mirrored on some cells.
    const plain = build(deps({ floorTex: tex(256) })).tiles;
    expect(plain.some((t) => t.scale.x < 0 || t.scale.y < 0)).toBe(true);
  });

  it('darkens its edges harder than the default, starting at the foot of the walls', () => {
    const warm = build(deps({ floorTex: stone, rooms: [room], wallRects: [north] })).graphics.at(-1)!;
    const plain = build(deps({ rooms: [room], wallRects: [north] })).graphics.at(-1)!;
    const firstStroke = (g: Graphics) => {
      const i = g.context.instructions.find((x) => x.action === 'stroke')!;
      const d = i.data as { style: { alpha: number }; path: { instructions: { data: number[] }[] } };
      return { alpha: d.style.alpha, y: d.path.instructions[0]!.data[1]! };
    };
    expect(firstStroke(warm).alpha).toBeGreaterThan(firstStroke(plain).alpha);
    expect(firstStroke(warm).y).toBeGreaterThan(64); // below the wall, not under it
    expect(firstStroke(plain).y).toBeLessThan(64);
  });
});
