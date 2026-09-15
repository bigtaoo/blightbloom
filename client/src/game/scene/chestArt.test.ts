/**
 * The SHIPPED chest art itself (`client/public/environment/chest_{small,big}[_open].png`),
 * decoded and measured (2026-09-15). Sibling of `propArt.test.ts`/`npcArt.test.ts`, for the
 * same reason: every other test in this directory checks what the renderer does with a texture,
 * and a chest's whole look now lives in these four files.
 *
 * Four things can go wrong here that no test of the CODE can see, and this batch met two of
 * them on the way in:
 *
 * 1. **The alpha plateau, again.** All four generations arrived with a body at 250-254 rather
 *    than 255 inside a veil of 1-8 (`alphaClamp.mjs`'s whole reason for existing). Unclamped,
 *    the small closed chest's trimmed aspect read **1.17 against its real 1.39** — and a chest
 *    is scaled by WIDTH with the art's aspect setting its height, so it would have stood 19%
 *    too short, on a file that `alpha-audit.mjs` calls clean.
 * 2. **The open/closed pair has to be the same OBJECT.** The two sprites swap in place on one
 *    ground point, so if the box's share of the frame differs between them, the chest visibly
 *    grows or shrinks at the moment it pays out. Measured as the footprint width at the ground
 *    line over the file width — see `footprintShare`.
 *
 * The other two are the value separations design/13 asks for and `propRender.ts` documents for
 * the crate: a chest must not read as the scenery crate it sits beside (median luma 53), and
 * the two kinds must differ in more than hue.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { chestFootprintWidth } from './ChestLayer';

interface Img {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function load(rel: string): Img {
  return decodePNG(readFileSync(new URL(rel, import.meta.url))) as Img;
}

/** Alpha 25 rather than 0, the same line `propArt.test.ts` measures on, so a number here means
 *  what it means there. */
const OPAQUE = 25;

const FILES = {
  smallClosed: '../../../public/environment/chest_small.png',
  smallOpen: '../../../public/environment/chest_small_open.png',
  bigClosed: '../../../public/environment/chest_big.png',
  bigOpen: '../../../public/environment/chest_big_open.png',
} as const;
type Which = keyof typeof FILES;
const ALL = Object.keys(FILES) as Which[];

function bbox(img: Img) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** The widest opaque run in the bottom tenth of the file, over the file width — "how much of
 *  this picture is the box standing on the floor". The number that decides whether an
 *  open/closed pair look like one object when scaled to the same drawn width. */
function footprintShare(img: Img): number {
  let widest = 0;
  for (let y = Math.floor(img.height * 0.9); y < img.height; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! <= OPAQUE) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (hi >= 0) widest = Math.max(widest, hi - lo + 1);
  }
  return widest / img.width;
}

function medianLuma(img: Img): number {
  const v: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    v.push(0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!);
  }
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
}

describe('the shipped chest art — geometry the renderer reads off the file', () => {
  it('is trimmed tight, so a bottom-anchored sprite sits ON the floor rather than above it', () => {
    // The BOTTOM edge is the load-bearing one: any transparent row left under the object
    // becomes clearance between the art and its own ground point, and the chest hovers. The
    // other three edges are allowed one row of slack, because `trimAlphaBoundingBox` cuts at
    // `alpha !== 0` while this measures at 25 — an antialiased outermost row legitimately sits
    // between the two.
    for (const which of ALL) {
      const img = load(FILES[which]);
      const b = bbox(img);
      expect(b.y + b.h, `${which}: rows under the object`).toBe(img.height);
      expect(b.y, `${which}: slack above`).toBeLessThanOrEqual(1);
      expect(b.x, `${which}: slack left`).toBeLessThanOrEqual(1);
      expect(img.width - (b.x + b.w), `${which}: slack right`).toBeLessThanOrEqual(1);
    }
  });

  it('has genuinely opaque pixels, not a 99%-opaque plateau', () => {
    for (const which of ALL) {
      const img = load(FILES[which]);
      let solid = 0;
      let midtone = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] === 255) solid++;
        else if (img.data[i]! >= 10 && img.data[i]! <= 245) midtone++;
      }
      const total = img.width * img.height;
      expect(solid / total, `${which}: opaque share`).toBeGreaterThan(0.25);
      // Antialiasing only — the veil this batch arrived with sat far above this.
      expect(midtone / total, `${which}: midtone haze`).toBeLessThan(0.15);
    }
  });

  it('keeps the open state on the same footprint as its closed twin', () => {
    // The pair swaps in place on one ground point. Scaling is by WIDTH, so what has to match is
    // each file's own footprint SHARE — if the open file gave the box a smaller share of the
    // frame, the chest would shrink at the moment it paid out.
    for (const [closed, open] of [
      ['smallClosed', 'smallOpen'],
      ['bigClosed', 'bigOpen'],
    ] as Array<[Which, Which]>) {
      const a = footprintShare(load(FILES[closed]));
      const b = footprintShare(load(FILES[open]));
      expect(Math.abs(a - b), `${closed} vs ${open}: footprint share`).toBeLessThan(0.05);
    }
  });

  it('gives each OPEN state a taller drawn silhouette than its closed twin', () => {
    // The lid is thrown back, so the art is taller — this is the one dimension that SHOULD
    // differ, and stating it is what keeps a mixed-up pair of files from passing everything.
    for (const [closed, open, kind] of [
      ['smallClosed', 'smallOpen', 'small'],
      ['bigClosed', 'bigOpen', 'big'],
    ] as Array<[Which, Which, 'small' | 'big']>) {
      const w = chestFootprintWidth(kind);
      const drawnH = (which: Which) => {
        const img = load(FILES[which]);
        return w * (img.height / img.width);
      };
      expect(drawnH(open), `${open} vs ${closed}`).toBeGreaterThan(drawnH(closed));
    }
  });
});

describe('the shipped chest art — the value separations design/13 asks for', () => {
  it('reads brighter than the scenery crate it sits beside, in both CLOSED states', () => {
    // `propRender.ts` records the crate's median luma of 53 as the thing that separates it from
    // the loot crate's 167; a chest is the object the crate's own prompt spent a paragraph
    // saying it must not look like. Closed only: an emptied chest is mostly dark cavity, which
    // is the point of it.
    const crate = medianLuma(load('../../../public/environment/prop_crate.png'));
    expect(medianLuma(load(FILES.smallClosed))).toBeGreaterThan(crate * 1.3);
    expect(medianLuma(load(FILES.bigClosed))).toBeGreaterThan(crate * 0.8);
  });

  it('separates the two kinds by SIZE, not only by hue', () => {
    // The dual-channel rule, in the one channel the files can carry: a big chest ships at more
    // pixels because it is drawn wider, and `chestFootprintWidth` is where that lands in world
    // units. A colourblind player reads the size.
    expect(chestFootprintWidth('big')).toBeGreaterThan(chestFootprintWidth('small'));
    expect(load(FILES.bigClosed).width).toBeGreaterThan(load(FILES.smallClosed).width);
  });

  it('draws the emptied chest darker than the closed one — it reads as spent', () => {
    expect(medianLuma(load(FILES.smallOpen))).toBeLessThan(medianLuma(load(FILES.smallClosed)));
    expect(medianLuma(load(FILES.bigOpen))).toBeLessThan(medianLuma(load(FILES.bigClosed)));
  });
});
