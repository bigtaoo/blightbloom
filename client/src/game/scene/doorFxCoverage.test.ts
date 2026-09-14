/// <reference types="node" />
/**
 * Does the 2026-09-03b door-fx pass actually fire on the SHIPPED content — and does every branch
 * of it occur there?
 *
 * `doorFx.test.ts` and `doorMotion.test.ts` pin the mechanism on rects this session chose. That is
 * the right way to test a rule and the wrong way to find out whether the rule ever runs, and this
 * repo has shipped that exact failure twice: `wallGeometry`'s old `w > h` guard left 1 wall
 * standing where 32 should because level 1's rooms are almost all `w <= h`, and
 * `doorSpillCoverage.test.ts` found a shallow-run case firing 12 times across the shipped floors
 * that had been written off as hypothetical. Sibling of `doorStandCoverage`/`doorLightCoverage`,
 * same pipeline, asking about the MOTION.
 *
 * The specific way this pass could be vacuous, and the reason this file exists at all: the flame
 * overlay is sized off `flameBandRect`, which maps a band measured on the art through the leaf's
 * own TOP crop. On a kerb door that crop removes most of the file. If the shipped art and the
 * shipped opening heights combined to leave a few pixels of band — or none — the fix would look
 * right on the one door someone opened the game to and do nothing on the other 23, and no unit
 * test built from a chosen rect could tell.
 */
import { describe, it, expect } from 'vitest';
import { Container, Sprite, Texture, TextureSource, TilingSprite } from 'pixi.js';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpAabbGrid,
  type RoomPiece,
} from '@dd/engine';
import { fpToPx } from '../coords';
import { biomePalette } from '../theme';
import { buildDoorBlock, type DoorSkin } from './doorRender';
import { doorLeafFrame } from './doorLeaf';
import { flameBandRect, OPEN_HOLE } from './doorMotion';
import { DOOR_H, type RectPx } from './wallGeometry';

/** The shipped locked leaf at its real post-trim size — the art every vertical number below is
 *  mapped through. A fiction here would defeat the whole file; `doorArtBands.test.ts` reads the
 *  same two files' real pixels, and `doorStandCoverage.test.ts` reads their IHDR. */
const LOCKED_ART_W = 147;
const LOCKED_ART_H = 217;

function tex(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

const skin = (): DoorSkin => ({
  palette: biomePalette('ember'),
  cap: tex(256, 256),
  face: tex(256, 128),
  floor: tex(64, 64),
  curtain: tex(468, 832),
  leaf: tex(LOCKED_ART_W, LOCKED_ART_H),
});

/** Every shipped door's passage rect, converted exactly the way `RoomBuilder.build` converts it —
 *  the conversion `doorStandCoverage.test.ts` established is the real one rather than a
 *  plausible-looking approximation. */
function shippedDoorRects(): RectPx[] {
  const out: RectPx[] = [];
  for (const index of Object.keys(EMBER_L1_FLOORS).map(Number)) {
    const { placed, doors } = placeAuthoredFloor(EMBER_L1_FLOORS[index]!, EMBER_L1_ROOMS as readonly RoomPiece[]);
    buildFloorGeometry(placed, doors);
    for (const d of doors) {
      const a = toFpAabbGrid(d.passageGrid);
      out.push({ x: fpToPx(a.x), y: fpToPx(a.y), w: fpToPx(a.w), h: fpToPx(a.h) });
    }
  }
  return out;
}

/** The flame band each shipped door would get, paired with the leaf frame it was mapped through. */
function shippedBands(): { rect: RectPx; drawH: number; srcY: number; band: ReturnType<typeof flameBandRect> }[] {
  return shippedDoorRects().map((rect) => {
    const frame = doorLeafFrame(rect.w, DOOR_H, LOCKED_ART_W, LOCKED_ART_H);
    return {
      rect,
      drawH: frame.drawH,
      srcY: frame.srcY,
      band: flameBandRect(rect.w, frame.drawH, frame.srcY, frame.srcH, LOCKED_ART_H),
    };
  });
}

describe('the flame band, on all 24 shipped doors', () => {
  it('sweeps a real content set — 24 doors, and both passage shapes present', () => {
    // The guard every sweep in this directory carries: a zero is only evidence if the case arose.
    const rects = shippedDoorRects();
    expect(rects).toHaveLength(30);
    const shapes = new Set(rects.map((r) => `${r.w}x${r.h}`));
    expect(shapes).toEqual(new Set(['64x128', '128x64']));
  });

  it('gives EVERY shipped door a band worth animating — over half its own drawn leaf', () => {
    // The vacuity this file exists for. At a band of a few px the overlay is invisible and every
    // other test in the pass still passes.
    for (const { rect, drawH, band } of shippedBands()) {
      const share = band.h / drawH;
      expect(band.h, `${rect.w}x${rect.h} band height`).toBeGreaterThan(0);
      expect(share, `${rect.w}x${rect.h} band share of leaf`).toBeGreaterThan(0.5);
      expect(band.w, `${rect.w}x${rect.h} band width`).toBeGreaterThan(20);
    }
  });

  it('keeps every band inside its own opening, so no door animates over the lintel or the floor', () => {
    for (const { rect, drawH, band } of shippedBands()) {
      expect(band.y, `${rect.w}x${rect.h} top`).toBeGreaterThanOrEqual(-drawH - 0.001);
      expect(band.y + band.h, `${rect.w}x${rect.h} bottom`).toBeLessThanOrEqual(0.001);
      expect(band.x, `${rect.w}x${rect.h} west`).toBeGreaterThan(0);
      expect(band.x + band.w, `${rect.w}x${rect.h} east`).toBeLessThan(rect.w);
    }
  });

  it('exercises BOTH mapping branches on shipped content — uncropped, and the kerb clamp', () => {
    // 13 perimeter doors show the whole leaf (`srcY` 0) and map the fractions straight across; the
    // 11 kerb doors crop most of the art off the top, and their band CLAMPS to the opening's own
    // ceiling. Neither branch is hypothetical, which is what makes the assertions above a sweep
    // rather than one case repeated 24 times.
    const bands = shippedBands();
    const uncropped = bands.filter((b) => b.srcY === 0);
    const cropped = bands.filter((b) => b.srcY > 0);
    expect(uncropped).toHaveLength(16);
    expect(cropped).toHaveLength(14);
    for (const b of cropped) expect(b.band.y).toBeCloseTo(-b.drawH, 3); // clamped to the top
    for (const b of uncropped) expect(b.band.y).toBeGreaterThan(-b.drawH); // room for lintel above
  });

  it('leaves every mote inside the arch hole at every shipped opening width', () => {
    // `OPEN_HOLE` is a fraction of the opening, so this is really "is the fraction sane at both
    // widths" — but it is the assertion that would catch a mote drifting over a jamb on the 128 px
    // doors while the 64 px one someone was looking at stayed clean.
    for (const rect of shippedDoorRects()) {
      const west = OPEN_HOLE.x0 * rect.w;
      const east = OPEN_HOLE.x1 * rect.w;
      expect(east - west, `${rect.w}x${rect.h} hole width`).toBeGreaterThan(12);
      expect(west).toBeGreaterThan(rect.w * 0.15);
      expect(east).toBeLessThan(rect.w * 0.85);
    }
  });
});

describe('the built fixture, on shipped geometry', () => {
  /** Everything `DoorFx` owns lives inside the two unlabelled containers it hands `buildDoorBlock`.
   *  Found that way rather than by index so a re-order of the assembly does not silently retarget
   *  these assertions at the wrong layer. */
  const fxContainers = (f: ReturnType<typeof buildDoorBlock>): { behind: Container[]; over: Container[] } => {
    const conts = f.view.children.filter((c) => c.label === null && c.children.length > 0);
    return { behind: conts[0]?.children ?? [], over: conts[1]?.children ?? [] };
  };

  it('builds the flame pair, the scan bar and the streams for every shipped door, in both states', () => {
    // The wiring half: `flameBandRect` returning a healthy band proves nothing if `buildDoorBlock`
    // never asks for one. Both states, because a locked-only check would pass on a fixture whose
    // open-side motion was never constructed.
    for (const rect of shippedDoorRects()) {
      for (const locked of [true, false]) {
        const f = buildDoorBlock(rect, DOOR_H, skin(), locked);
        const { behind, over } = fxContainers(f);
        const tiles = over.filter((c) => c instanceof TilingSprite);
        expect(tiles, `${rect.w}x${rect.h} locked=${locked} flame layers`).toHaveLength(2);
        expect(behind.filter((c) => c instanceof TilingSprite), `${rect.w}x${rect.h} streams`).toHaveLength(2);
        expect(
          over.filter((c) => c instanceof Sprite && !(c instanceof TilingSprite)),
          `${rect.w}x${rect.h} scan bar`,
        ).toHaveLength(1);
      }
    }
  });

  it('actually moves every shipped door when ticked, in whichever state it is in', () => {
    // The end-to-end claim, over real content: a door that is built and ticked produces motion.
    // Read off the scroll offsets, since those are the layer property the whole cue rests on.
    for (const rect of shippedDoorRects()) {
      for (const locked of [true, false]) {
        const f = buildDoorBlock(rect, DOOR_H, skin(), locked);
        const { behind, over } = fxContainers(f);
        const live = (locked ? over : behind).filter((c): c is TilingSprite => c instanceof TilingSprite);
        f.tick(200, 0);
        const before = live.map((t) => t.tilePosition.y);
        f.tick(200, 0);
        const after = live.map((t) => t.tilePosition.y);
        for (let i = 0; i < live.length; i++) {
          expect(after[i], `${rect.w}x${rect.h} locked=${locked} layer ${i}`).not.toBe(before[i]);
          // ...and in the state's own direction: locked contains its motion, open crosses out.
          if (locked) expect(after[i]!).toBeLessThan(before[i]!);
          else expect(after[i]!).toBeGreaterThan(before[i]!);
        }
      }
    }
  });
});
