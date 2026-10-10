/**
 * The SHIPPED biome swatches themselves, decoded and measured — all five elements, all three
 * kinds (2026-08-25). Sibling to `pillarArt.test.ts`, and for the same reason it exists: every
 * other test in this directory checks what the renderer does with a texture, and the things that
 * go wrong with these files are invisible to any test of the code.
 *
 * Written when `poison` landed — the last element of design/13's LOCKED five-colour language with
 * no art of its own. It is a sweep over all five rather than a poison-specific check on purpose:
 * the properties below are what makes the set a SET (one tonal family, one camera, one seam rule),
 * and the recurring bug in this repo is a per-element file that satisfies its own spec and
 * disagrees with its neighbours — measured twice already, in the per-element pillar attempt
 * (`art/biome/prompts.md`) and in the four face swatches' crown rows (`wallTone.ts`).
 *
 * Since 2026-10-10 every chapter is drawn in design/13's warm-stone direction — light flagstone,
 * dark wall tops, torch light — which is deliberately NOT this family: its floor is brighter than
 * its wall cap, which inverts the old rule below. An element whose swatches carry `SWATCH_META` is
 * measured by `warmStoneArt.test.ts` instead, and the family checks here run over the
 * first-generation elements that are left: `neutral` alone, the PvP arena's stone. Shipping, though,
 * is still asserted for all five.
 *
 * Poison's hard clause moved with its art. The first-generation version held its dark stone to a
 * value gap under the bright #9CCC65; the warm-stone floor is light, so `warmStoneArt.test.ts` holds
 * it to a hue gap instead (green the lowest channel, no saturated green pixel).
 *
 * Import step this pins as having actually run (nothing else records it): the downsample to a
 * 256 px long axis (`compress.mjs`).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { BIOME_TILE_ASSETS, SWATCH_META } from '../../render/biomeTiles';

/** design/13's closed five. Listed, so a sixth element's art cannot land unmeasured. */
const ELEMENTS = ['fire', 'ice', 'lightning', 'neutral', 'poison'] as const;
type Element = (typeof ELEMENTS)[number];
const KINDS = ['floor', 'wall', 'wallface'] as const;

/** The elements still on the first-generation art — the ones this family's checks are about. */
const FIRST_GEN = ELEMENTS.filter((el) => KINDS.every((kind) => !SWATCH_META[`${kind}_${el}`]));

interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

function load(name: string): Img {
  return decodePNG(readFileSync(new URL(`../../../public/biome/${name}.png`, import.meta.url)));
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function quantiles(img: Img): { median: number; p95: number; max: number } {
  const l: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    l.push(luma(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!));
  }
  l.sort((a, b) => a - b);
  const q = (p: number) => l[Math.floor(p * (l.length - 1))]!;
  return { median: q(0.5), p95: q(0.95), max: q(1) };
}

function rowLuma(img: Img, y: number): number {
  let s = 0;
  for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    s += luma(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
  }
  return s / img.width;
}

function band(img: Img, from: number, to: number): number {
  const a = Math.floor(img.height * from);
  const b = Math.max(a + 1, Math.floor(img.height * to));
  let s = 0;
  for (let y = a; y < b; y++) s += rowLuma(img, y);
  return s / (b - a);
}

/** Mean per-channel difference between two columns — the seam measure the accepted batches used. */
function colDiff(img: Img, x1: number, x2: number): number {
  let s = 0;
  for (let y = 0; y < img.height; y++) {
    const a = (y * img.width + x1) * 4;
    const b = (y * img.width + x2) * 4;
    s += Math.abs(img.data[a]! - img.data[b]!) + Math.abs(img.data[a + 1]! - img.data[b + 1]!) + Math.abs(img.data[a + 2]! - img.data[b + 2]!);
  }
  return s / img.height / 3;
}

function rowDiff(img: Img, y1: number, y2: number): number {
  let s = 0;
  for (let x = 0; x < img.width; x++) {
    const a = (y1 * img.width + x) * 4;
    const b = (y2 * img.width + x) * 4;
    s += Math.abs(img.data[a]! - img.data[b]!) + Math.abs(img.data[a + 1]! - img.data[b + 1]!) + Math.abs(img.data[a + 2]! - img.data[b + 2]!);
  }
  return s / img.width / 3;
}

describe('biome swatches — the set is complete', () => {
  it('every element has all three kinds shipped', () => {
    for (const el of ELEMENTS) {
      for (const kind of KINDS) {
        const path = BIOME_TILE_ASSETS[`${kind}_${el}`];
        expect(path, `${kind}_${el} registered`).toBeDefined();
        expect(existsSync(new URL(`../../../public${path}`, import.meta.url)), `${kind}_${el} shipped`).toBe(true);
      }
    }
  });

  it('every element is wholly in one generation or the other, never a mix of the two', () => {
    // A warm floor under a first-generation wall would pass every per-file check in both files and
    // still be the outlier neighbour this file exists to catch.
    for (const el of ELEMENTS) {
      const warm = KINDS.filter((kind) => SWATCH_META[`${kind}_${el}`]).length;
      expect([0, KINDS.length], `${el} warm-stone kinds`).toContain(warm);
    }
    expect(FIRST_GEN.length).toBeGreaterThan(0); // or everything below is vacuous
  });

  it('every swatch was downsampled to the shared 256 px long axis', () => {
    for (const el of FIRST_GEN) {
      for (const kind of ['floor', 'wall', 'wallface'] as const) {
        const img = load(`${kind}_${el}`);
        expect(Math.max(img.width, img.height), `${kind}_${el}`).toBe(256);
      }
    }
  });

  it('floor and wall swatches are square; an elevation is used at one height and is not', () => {
    for (const el of FIRST_GEN) {
      expect(load(`floor_${el}`).width, `floor_${el}`).toBe(load(`floor_${el}`).height);
      expect(load(`wall_${el}`).width, `wall_${el}`).toBe(load(`wall_${el}`).height);
      const face = load(`wallface_${el}`);
      // ~2:1. The generator returns a square; this ratio only exists because the import cropped
      // to the top half — the step that makes ~4 brick courses fill a 70 px wall instead of ~9.
      expect(face.width / face.height, `wallface_${el} aspect`).toBeGreaterThan(1.8);
      expect(face.width / face.height, `wallface_${el} aspect`).toBeLessThan(2.2);
    }
  });
});

describe('biome swatches — one tonal family', () => {
  // Ranges from the four that shipped before poison, widened only by poison's own measured values.
  // Deliberately not per-element constants: the claim is that no swatch is an outlier, and a table
  // of exact numbers would restate the files rather than constrain them.
  const RANGE = {
    floor: { median: [28, 48], p95: [30, 56] },
    wall: { median: [38, 52], p95: [40, 70] },
    wallface: { median: [40, 56], p95: [60, 175] },
  } as const;

  for (const kind of ['floor', 'wall', 'wallface'] as const) {
    it.each(FIRST_GEN)(`${kind}_%s sits inside the family's tonal range`, (el: Element) => {
      const q = quantiles(load(`${kind}_${el}`));
      expect(q.median, `${kind}_${el} median`).toBeGreaterThanOrEqual(RANGE[kind].median[0]);
      expect(q.median, `${kind}_${el} median`).toBeLessThanOrEqual(RANGE[kind].median[1]);
      expect(q.p95, `${kind}_${el} p95`).toBeGreaterThanOrEqual(RANGE[kind].p95[0]);
      expect(q.p95, `${kind}_${el} p95`).toBeLessThanOrEqual(RANGE[kind].p95[1]);
    });
  }

  it('a floor is always darker than the wall cap above it', () => {
    // The tilted view's most basic light rule: the wall's top surface faces the sky more squarely
    // than the floor does. It held across the original four by construction (#161A24 vs #2A3140)
    // and is the cheapest single check that a new element's pair was authored from the same brief.
    for (const el of FIRST_GEN) {
      expect(quantiles(load(`floor_${el}`)).median, el).toBeLessThan(quantiles(load(`wall_${el}`)).median);
    }
  });
});

describe('biome swatches — the seam rules, which differ by kind', () => {
  it.each(FIRST_GEN)('floor_%s and wall_%s tile on all four edges', (el: Element) => {
    for (const kind of ['floor', 'wall'] as const) {
      const img = load(`${kind}_${el}`);
      // The wrap difference is compared against the ADJACENT-column difference in the same image,
      // not against an absolute threshold: a busy swatch has a high baseline and a flat one a low
      // baseline, so only the ratio says whether the edges actually match.
      const wrapX = colDiff(img, 0, img.width - 1);
      const wrapY = rowDiff(img, 0, img.height - 1);
      const baseX = colDiff(img, 0, 1);
      const baseY = rowDiff(img, 0, 1);
      expect(wrapX, `${kind}_${el} L/R`).toBeLessThan(Math.max(baseX, 1) * 6);
      expect(wrapY, `${kind}_${el} top/bottom`).toBeLessThan(Math.max(baseY, 1) * 6);
    }
  });

  it.each(FIRST_GEN)('wallface_%s tiles LEFT-RIGHT only, and is lit top / dark bottom', (el: Element) => {
    const img = load(`wallface_${el}`);
    expect(colDiff(img, 0, img.width - 1), `${el} L/R`).toBeLessThan(Math.max(colDiff(img, 0, 1), 1) * 6);
    // …and vertically it must NOT match, because the top is a lit coping and the bottom meets the
    // floor. This is the seam rule that differs from every other swatch in the set.
    const coping = band(img, 0, 0.12);
    const base = band(img, 0.85, 1);
    expect(coping, `${el} coping vs base`).toBeGreaterThan(base * 1.5);
  });
});
