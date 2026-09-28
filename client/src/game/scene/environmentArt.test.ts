/**
 * The SHIPPED drop/portal art itself (`client/public/environment/pickup_*.png`,
 * `portal_arch.png`), decoded and measured (2026-08-20). Sibling of `pillarArt.test.ts`,
 * for the same reason: every other test in this directory checks what the renderer does
 * with a texture, and these objects' whole look now lives in the files.
 *
 * This batch's own history is why each assertion below exists. Nine generations went into
 * six shipped files, and every rejection was a property no test of the CODE could see:
 *
 * 1. **The heal drop came back as a wide-lidded jar** whose top fifth measured luma 50 —
 *    inside the ember floor's own 39-49 band, so at 18 px the lid read as a hole in the
 *    floor rather than as part of an object.
 * 2. **The buff sigil's inner arrow was an outline, not a solid** — 5.8% of the object's
 *    width per stroke, i.e. ONE pixel at display size. It measured fine as a shape and
 *    disappeared completely in game.
 * 3. **The bandage came back as a circular end-on roll** with two concentric rings and a
 *    dark centre: a pale disc with a dark middle, in a game where the hero, every critter
 *    and the boss are all single-eyed. Its silhouette is what fixes that, so its silhouette
 *    is what this file pins.
 *
 * Each rejected attempt is kept in `art/environment/*_alt.png`, and the last describe block
 * runs the same measurements over them — so an assertion that stops discriminating
 * accepted from rejected art fails here rather than passing vacuously.
 *
 * Reference values are the live in-frame measurements these were tuned against (extract of
 * the real level 1 at zoom 1): floor 39-49, wall face 27.3-27.5, wall cap 72-88.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';

/** The floor these objects are read against. An in-world sprite that lands inside this band
 *  has no contrast with the ground it sits on, whatever it looks like in a preview. */
const FLOOR_LUMA_MAX = 49;

interface Img {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function load(rel: string): Img {
  return decodePNG(readFileSync(new URL(rel, import.meta.url))) as Img;
}

function alphaAt(img: Img, x: number, y: number): number {
  return img.data[(y * img.width + x) * 4 + 3]!;
}

function lumaAt(img: Img, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
}

/** The opaque bounding box, so every measurement below is relative to the OBJECT rather
 *  than to its canvas — the shipped files are trimmed and the `_alt` rejects are not, and
 *  the two have to be comparable for the last describe block to mean anything. */
function bbox(img: Img): { x: number; y: number; w: number; h: number } {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (alphaAt(img, x, y) <= 200) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  expect(maxX).toBeGreaterThanOrEqual(0); // a fully transparent file would make everything vacuous
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Mean luma of the opaque pixels in a band of the object's own height. */
function rowBand(img: Img, from: number, to: number): number {
  const b = bbox(img);
  let sum = 0;
  let n = 0;
  for (let y = b.y + Math.round(from * b.h); y < b.y + Math.round(to * b.h); y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      if (alphaAt(img, x, y) <= 200) continue;
      sum += lumaAt(img, x, y);
      n++;
    }
  }
  expect(n).toBeGreaterThan(0);
  return sum / n;
}

/** Mean luma of the opaque pixels in a third of the object's own width. */
function colBand(img: Img, from: number, to: number): number {
  const b = bbox(img);
  let sum = 0;
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x + Math.round(from * b.w); x < b.x + Math.round(to * b.w); x++) {
      if (alphaAt(img, x, y) <= 200) continue;
      sum += lumaAt(img, x, y);
      n++;
    }
  }
  expect(n).toBeGreaterThan(0);
  return sum / n;
}

function meanLuma(img: Img): number {
  return rowBand(img, 0, 1);
}

/** Widths of the opaque runs across one scanline, as fractions of the object's own width —
 *  how a solid mark inside a hollow ring is told apart from an outline of one. */
function runsAt(img: Img, fy: number): number[] {
  const b = bbox(img);
  const y = b.y + Math.round(fy * (b.h - 1));
  const out: number[] = [];
  let start = -1;
  for (let x = b.x; x < b.x + b.w; x++) {
    const opaque = alphaAt(img, x, y) > 200;
    if (opaque && start < 0) start = x;
    else if (!opaque && start >= 0) {
      out.push((x - start) / b.w);
      start = -1;
    }
  }
  if (start >= 0) out.push((b.x + b.w - start) / b.w);
  return out;
}

const PICKUPS = ['material', 'heal', 'buff', 'crate', 'bandage'] as const;
const pickup = (kind: string): Img => load(`../../../public/environment/pickup_${kind}.png`);
const arch = load('../../../public/environment/portal_arch.png');

describe('every shipped environment sprite — the pipeline steps that leave no other trace', () => {
  const all: ReadonlyArray<[string, Img]> = [
    ...PICKUPS.map((k) => [`pickup_${k}`, pickup(k)] as [string, Img]),
    ['portal_arch', arch],
  ];

  it.each(all)('%s has a real alpha channel with transparent corners', (_name, img) => {
    // The 2026-08-20 pillar generation came back with the grey-and-white "transparency"
    // checkerboard drawn as OPAQUE pixels — a file that does not lack alpha but depicts it,
    // and looks correct in any preview. These are all lone objects in a rectangular frame,
    // so a real alpha channel means real transparent corners.
    for (const [x, y] of [
      [0, 0],
      [img.width - 1, 0],
      [0, img.height - 1],
    ] as const) {
      expect(alphaAt(img, x, y)).toBeLessThan(16);
    }
    let transparent = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! === 0) transparent++;
    expect(transparent).toBeGreaterThan(img.width * img.height * 0.02);
  });

  it.each(all)('%s carries no baked halo (the glow is a separate additive layer)', (_name, img) => {
    // A generated outer glow decodes as a large cloud of PARTIAL alpha. Antialiasing alone
    // stays well under a tenth of the file; every reject in this batch measured 0.3-2.2%.
    let partial = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      const a = img.data[i]!;
      if (a > 0 && a < 255) partial++;
    }
    expect(partial).toBeLessThan(img.width * img.height * 0.1);
  });

  it.each(all)('%s is trimmed to its own content', (_name, img) => {
    // `compress.mjs` trims the alpha bbox, and `Pickup`/`Portal` scale by the TEXTURE's
    // dimensions — so untrimmed margin silently shrinks the object on screen by however
    // much empty space the generator happened to leave (up to 44% on this batch's rejects).
    const b = bbox(img);
    expect(b.w).toBeGreaterThanOrEqual(img.width - 2);
    expect(b.h).toBeGreaterThanOrEqual(img.height - 2);
  });
});

describe('the shipped drop sprites — resolution, and contrast against the floor', () => {
  it.each(PICKUPS)('pickup_%s has resolution headroom for the camera zoom', (kind) => {
    // What got five of the six first-batch pillar generations rejected: art authored at the
    // size the game draws. A drop is drawn at ART_LONG_AXIS (18 px) while the camera's MAX_ZOOM
    // was 4.5 (3.5 since 2026-09-28 — the bar is kept at the old cap so the art does not have to
    // be regenerated if the cap goes back up) and the renderer runs at up to 2x device pixel
    // ratio, so the sprite is MAGNIFIED to ~162 device px in a small room. This is the one defect that cannot be
    // repaired at import.
    const img = pickup(kind);
    expect(Math.max(img.width, img.height)).toBeGreaterThanOrEqual(18 * 4.5 * 2);
  });

  it.each(PICKUPS)('pickup_%s reads clearly brighter than the floor it lies on', (kind) => {
    // design/13's "environment desaturated, hazards saturated": a drop is the one
    // interactive thing in the frame, so it may not share the floor's own value.
    expect(meanLuma(pickup(kind))).toBeGreaterThan(FLOOR_LUMA_MAX + 40);
  });

  it.each(PICKUPS)('pickup_%s has no band that sinks into the floor', (kind) => {
    // The heal reject's specific failure: its top fifth was a wide dark lid at luma 50,
    // inside the floor's own 39-49 band, so a quarter of the object stopped existing at
    // display size. Checked as bands rather than as a min, because one dark OUTLINE pixel
    // is fine and a dark fifth of the object is not.
    const img = pickup(kind);
    for (const [from, to] of [
      [0, 0.2],
      [0.4, 0.6],
      [0.8, 1],
    ] as const) {
      expect(rowBand(img, from, to)).toBeGreaterThan(FLOOR_LUMA_MAX + 20);
    }
  });

  it('the buff sigil holds a SOLID mark inside its ring, not an outline of one', () => {
    // The reject measured four runs of <=15.5% each (a nested outline); this measures three,
    // the middle one solid. At 18 px, 27% of the width is 5 px of arrowhead and 5.8% is one.
    const runs = runsAt(pickup('buff'), 0.5);
    expect(runs).toHaveLength(3);
    expect(runs[1]!).toBeGreaterThan(0.2);
  });

  it('the bandage reads as a roll on its side, never as an eye', () => {
    // The reject was a circular end-on face with concentric rings and a dark centre. In a
    // game whose hero, critters and boss are all single-eyed, a pale disc with a dark middle
    // on the floor is a fiction-breaking read, and the silhouette is what prevents it: an
    // eye needs a roundish outline, so a clearly elongated one cannot become one.
    const b = bbox(pickup('bandage'));
    expect(b.w / b.h).toBeGreaterThan(1.6);
  });

  it('the crate keeps its top the brightest plane on the object', () => {
    // Same sky-facing rule the pillar's cap follows, and the same defect that has now been
    // caught twice in this project: a raised surface that reads darker than the ground it
    // stands on, or darker than the vertical faces beside it, argues against the only cue
    // anyone has for height.
    const img = pickup('crate');
    expect(rowBand(img, 0, 0.2)).toBeGreaterThan(rowBand(img, 0.4, 0.6) + 20);
  });
});

describe('the shipped portal arch — stone, opening, and the aspect the code depends on', () => {
  const ARCH_W = 26 * 1.15;
  const ARCH_H = 26 * 2.15;

  it('has resolution headroom for the camera zoom', () => {
    expect(Math.max(arch.width, arch.height)).toBeGreaterThanOrEqual(ARCH_W * 2 * 4.5 * 2);
  });

  it('keeps the aspect the gate stands at', () => {
    // `Portal` fits the sprite by WIDTH and lets the file's aspect set the drawn height —
    // the pillar's rule, for the pillar's reason. So this ratio is what keeps the gate the
    // height the rest of the object (its ground bloom, its shadow) was tuned against.
    const drawnH = ARCH_W * 2 / (arch.width / arch.height);
    expect(Math.abs(drawnH - ARCH_H)).toBeLessThan(1);
  });

  it('is the same stone as a dungeon wall, not light concrete', () => {
    // The generation arrived with its whole mass at 2.4x a wall face (mid band 65 against
    // 27.3), which is exactly the fold `tools/png-pipeline/lumaCurve.mjs` exists to make —
    // and nothing but a measurement of the file can tell whether that step was run. Its
    // legs land on the wall face's own value; its lit crown may sit above that (a curved,
    // key-lit surface) but nowhere near double it.
    expect(rowBand(arch, 0.8, 1)).toBeLessThan(32);
    expect(rowBand(arch, 0.4, 0.6)).toBeLessThan(56);
    expect(meanLuma(arch)).toBeLessThan(50);
    // ...and it is still lit from the upper left like everything else in the scene.
    expect(colBand(arch, 0, 1 / 3)).toBeGreaterThan(colBand(arch, 2 / 3, 1) + 6);
  });

  it('keeps its crystal shards out of the curve (they are the accent, not the stone)', () => {
    // The curve above is luma-KEYED precisely so it can pull the masonry down and leave
    // these alone. A uniform multiply would have dragged them down with it, and the arch
    // would have lost the one bright note that makes it read as more than a doorway.
    let shards = 0;
    let sum = 0;
    for (let i = 0; i < arch.data.length; i += 4) {
      if (arch.data[i + 3]! <= 200) continue;
      const l = 0.299 * arch.data[i]! + 0.587 * arch.data[i + 1]! + 0.114 * arch.data[i + 2]!;
      if (l < 150) continue;
      shards++;
      sum += l;
    }
    expect(shards).toBeGreaterThan(1000);
    expect(sum / shards).toBeGreaterThan(180);
  });

  it('has an opening the vortex actually fits in, at the height the vortex is drawn', () => {
    // The load-bearing measurement behind `VORTEX_CENTER_OF_ARCH_H`/`VORTEX_MAX_R_OF_ARCH_W`.
    // Re-derived here from the file's own alpha rather than restated: the largest ellipse
    // (squashed the way `Portal` squashes it) centred where `Portal` centres it, that touches
    // no masonry. If a regenerated arch has thicker legs or a lower crown, the vortex starts
    // being drawn on the stone and this is what says so.
    const squash = ARCH_H / 2 / ARCH_W;
    const ppu = arch.width / (ARCH_W * 2);
    const cx = arch.width / 2;
    const cy = arch.height * (1 - 0.25); // VORTEX_CENTER_OF_ARCH_H, measured from the top
    const clears = (rOfArchW: number): boolean => {
      const rx = rOfArchW * ARCH_W * ppu;
      const ry = rx * squash;
      for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(arch.height, Math.ceil(cy + ry)); y++) {
        for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(arch.width, Math.ceil(cx + rx)); x++) {
          const dx = (x - cx) / rx;
          const dy = (y - cy) / ry;
          if (dx * dx + dy * dy > 1) continue;
          if (alphaAt(arch, x, y) > 200) return false;
        }
      }
      return true;
    };
    expect(clears(0.56)).toBe(true);
    // ...and it is not wastefully small either: the constant should be near the real limit,
    // so a future arch with a bigger hole gets noticed rather than silently under-used.
    expect(clears(0.62)).toBe(false);
  });
});

describe('the rejected attempts — proof the assertions above still discriminate', () => {
  const alt = (kind: string): Img => load(`../../../../art/environment/pickup_${kind}_alt.png`);

  it('the heal jar would have failed the sinks-into-the-floor band check', () => {
    // Measured 50.1 against the accepted flask's 145.6.
    expect(rowBand(alt('heal'), 0, 0.2)).toBeLessThan(FLOOR_LUMA_MAX + 20);
  });

  it('the outlined buff sigil would have failed the solid-mark check', () => {
    const runs = runsAt(alt('buff'), 0.5);
    // Four runs, not three — and no run anywhere near a solid 20% of the width.
    expect(runs).toHaveLength(4);
    expect(Math.max(...runs)).toBeLessThan(0.2);
  });

  it('the end-on bandage would have failed the silhouette check', () => {
    const b = bbox(alt('bandage'));
    expect(b.w / b.h).toBeLessThan(1.6);
  });
});
