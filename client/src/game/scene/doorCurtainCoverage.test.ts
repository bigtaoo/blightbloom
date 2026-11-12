/// <reference types="node" />
/**
 * Does the 2026-08-30b curtain-of-light actually stand where it should on the SHIPPED content?
 *
 * Sibling of `doorLightCoverage.test.ts` (same lineage as `doorStandCoverage`/`doorSpillCoverage`):
 * same pipeline (`placeAuthoredFloor` → `buildFloorGeometry` → `wallTier` → `mergeWallRuns` →
 * `doorFlankTier`), same five floors, but asking about the curtain sprite specifically.
 *
 * The reason this file exists rather than trusting `doorRender.test.ts`'s hand-built PASSAGE rect:
 * that suite caught the curtain's SIZE and VISIBILITY being right while its POSITION defaulted to
 * (0, 0) and drew below the threshold into the room floor instead of up into the opening — found
 * live, not by any test, because nothing there checked where the sprite actually stood. A single
 * hand-built fixture proves the bug is fixed on THAT shape; this sweep is what stops a
 * shape-dependent variant of the same mistake (say, one that only shows up when `drawH` rounds a
 * particular way) from shipping unnoticed on the other 23 doors nobody looked at.
 */
import { describe, it, expect } from 'vitest';
import { Sprite, Texture, TextureSource, TilingSprite } from 'pixi.js';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpAabbGrid,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { biomePalette } from '../theme';
import { buildDoorBlock, doorLeafFrame, type DoorSkin } from './doorRender';
import { DOOR_H, wallTier, type RectPx } from './wallGeometry';
import { mergeWallRuns, type WallRun } from './wallRuns';

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

/** The shipped open-arch elevation's real size after the alpha trim (design/01: 215x320 → 156x224).
 *  The leaf art is what sets the curtain's height too (same `doorLeafFrame` call), so a fiction
 *  here would defeat the file the same way it would in `doorLightCoverage.test.ts`. */
const OPEN_ART_W = 156;
const OPEN_ART_H = 224;
/** The shipped curtain's own real size (client/public/environment/door_curtain_raw.png).
 *  Halved from 468x832 on 2026-11-12 (design/12 "the curtain re-encode"), which is why these are
 *  constants rather than literals: the fit is by WIDTH, so every number this file asserts is a
 *  RATIO and survives the halving unchanged -- the one thing that would not survive is a
 *  fiction here, which would let the art and the test drift apart silently. */
const CURTAIN_ART_W = 234;
const CURTAIN_ART_H = 416;

function tex(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

const skin = (): DoorSkin => ({
  palette: biomePalette('ember'),
  cap: tex(256, 256),
  face: tex(256, 128),
  floor: tex(64, 64),
  curtain: tex(CURTAIN_ART_W, CURTAIN_ART_H),
  leaf: tex(OPEN_ART_W, OPEN_ART_H),
});

interface FloorGeo {
  runs: WallRun[];
  doorRects: RectPx[];
}

/** One shipped floor converted exactly the way `RoomBuilder.build` converts it at runtime — lifted
 *  from `doorStandCoverage.test.ts`, which established this conversion is the real one. */
function floorGeo(index: number): FloorGeo {
  const map = EMBER_L1_FLOORS[index]!;
  const { placed, doors } = placeAuthoredFloor(map, EMBER_L1_ROOMS as readonly RoomPiece[]);
  const geo = buildFloorGeometry(placed, doors);
  const roomsPx: RectPx[] = placed.map((r) => ({
    x: fpToPx(toFpGrid(r.offsetXGrid)),
    y: fpToPx(toFpGrid(r.offsetYGrid)),
    w: fpToPx(toFpGrid(r.piece.sizeGrid.w)),
    h: fpToPx(toFpGrid(r.piece.sizeGrid.h)),
  }));
  const doorRects: RectPx[] = doors.map((d) => {
    const aabb = toFpAabbGrid(d.passageGrid);
    return { x: fpToPx(aabb.x), y: fpToPx(aabb.y), w: fpToPx(aabb.w), h: fpToPx(aabb.h) };
  });
  const runs = mergeWallRuns(
    geo.walls.map((wall) => {
      const rect: RectPx = { x: fpToPx(wall.x), y: fpToPx(wall.y), w: fpToPx(wall.w), h: fpToPx(wall.h) };
      return { rect, tier: wallTier(rect, roomsPx) };
    }),
  );
  return { runs, doorRects };
}

/** Every shipped door as `(rect, height)` — the two arguments `buildDoorBlock` is called with —
 *  plus the passage SHAPE, which is what still varies now that the height does not (2026-09-03,
 *  `wallGeometry.DOOR_H`). The shape is the axis these sweeps care about anyway: it sets the
 *  opening's WIDTH, and every leaf/curtain/light layer here is fit by width. */
function shippedDoors(): { rect: RectPx; height: number; shape: string }[] {
  const out: { rect: RectPx; height: number; shape: string }[] = [];
  for (const index of FLOOR_INDICES) {
    const { doorRects } = floorGeo(index);
    for (const rect of doorRects) out.push({ rect, height: DOOR_H, shape: `${rect.w}x${rect.h}` });
  }
  return out;
}

/** The curtain sprite: the plain `Sprite` whose texture is the curtain art specifically — the leaf
 *  is also a plain `Sprite` once both are loaded, so position in the child list cannot tell them
 *  apart (the exact ambiguity `doorRender.test.ts`'s `curtainOf` exists to route around). */
function curtainOf(fixture: ReturnType<typeof buildDoorBlock>, curtainArt: Texture): Sprite | undefined {
  return fixture.view.children.find(
    (c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite) && c.texture.source === curtainArt.source,
  );
}

describe('the open-door curtain-of-light on the real shipped floors', () => {
  it('sweeps every shipped door and finds a correctly-placed curtain sprite on each', () => {
    const doors = shippedDoors();
    expect(doors.length).toBeGreaterThan(0); // the sweep means nothing over an empty list

    const curtainArt = tex(CURTAIN_ART_W, CURTAIN_ART_H);
    const shapes = new Map<string, number>();
    for (const { rect, height, shape } of doors) {
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      const fixture = buildDoorBlock(rect, height, { ...skin(), curtain: curtainArt }, false);
      const curtain = curtainOf(fixture, curtainArt);
      expect(curtain, `curtain on ${rect.w}x${rect.h} @${height}`).toBeDefined();
      expect(curtain!.visible).toBe(true);
      expect(curtain!.blendMode).toBe('add');

      // The bug this file exists to keep dead: `fitArtToOpening` sets texture/width/height only,
      // so the sprite must be explicitly positioned to reach UP into the opening. `x` stays 0 on
      // every shipped door (a door's local origin is already at its own west edge); `y` has to be
      // the negative of whatever height the leaf itself draws at on THIS opening, which varies
      // door to door — recomputed per door rather than assumed constant.
      const drawH = doorLeafFrame(rect.w, height, OPEN_ART_W, OPEN_ART_H).drawH;
      expect(curtain!.x).toBeCloseTo(0);
      expect(curtain!.y).toBeCloseTo(-drawH);
      expect(curtain!.y).toBeLessThan(0); // the direct regression check: never (0, 0)
    }
    // Both passage shapes occur, so the position rule is checked on the WIDE crop (a 128 px
    // opening, where the curtain art overflows and is cropped to its bottom) AND the narrow one
    // (64 px, where it fits under a band of lintel) — not just whichever came first.
    expect(shapes.get('64x128') ?? 0).toBeGreaterThan(0);
    expect(shapes.get('128x64') ?? 0).toBeGreaterThan(0);
  });

  it('hides the curtain and shows nothing in its place while locked, on every shipped door', () => {
    const curtainArt = tex(CURTAIN_ART_W, CURTAIN_ART_H);
    for (const { rect, height } of shippedDoors()) {
      const fixture = buildDoorBlock(rect, height, { ...skin(), curtain: curtainArt }, true);
      const curtain = curtainOf(fixture, curtainArt);
      expect(curtain).toBeDefined();
      expect(curtain!.visible).toBe(false);
    }
  });
});
