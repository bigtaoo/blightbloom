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
 * Poison additionally carries a HARD gameplay clause the other four do not, from design/13's
 * "environment desaturated, hazards saturated": *"the poison biome's ambient green must be dialled
 * down … or green FX/enemies camouflage against a green floor."* A green floor is not a style
 * miss here, it is the poison bullet and the poison-tinted mob becoming invisible. That clause is
 * asserted on the pixels, because it is exactly the kind of thing that looks fine in a preview.
 *
 * Since 2026-10-10 the chapters are moving, one at a time, to design/13's warm-stone direction —
 * light flagstone, dark wall tops, torch light — which is deliberately NOT this family: its floor is
 * brighter than its wall cap, which inverts the old rule below. An element whose swatches carry
 * `SWATCH_META` is measured by `warmStoneArt.test.ts` instead, and the family checks here run over
 * the first-generation elements that are left. Shipping, though, is still asserted for all five.
 *
 * Import steps this pins as having actually run (nothing else records them):
 *   - downsample to a 256 px long axis (`compress.mjs`)
 *   - the elevation's border crop + top-half crop + bottom re-darken, which is what makes
 *     `wallface_poison` 256x128 rather than the 1254x1254 the generator returned
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

function channelMeans(img: Img): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    r += img.data[i * 4]!;
    g += img.data[i * 4 + 1]!;
    b += img.data[i * 4 + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
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

describe('poison — design/13\'s hard "dial the green down" clause, on the pixels', () => {
  const POISON = ['floor_poison', 'wall_poison', 'wallface_poison'] as const;

  it.each(POISON)('%s still reads as charcoal-NAVY stone: blue is the highest channel', (name) => {
    const m = channelMeans(load(name));
    expect(m.b, `${name} blue vs red`).toBeGreaterThan(m.r);
    expect(m.b, `${name} blue vs green`).toBeGreaterThan(m.g);
  });

  it.each(POISON)('%s keeps its green tint under the 10/255 ceiling over red', (name) => {
    // The stated numeric spec in `art/biome/prompts.md`. Above this the stone starts reading as
    // green ground, and design/13's own words for that are "a gameplay defect": the saturated
    // #9CCC65 is reserved for poison bullets, auras and mob tint, which then camouflage.
    const m = channelMeans(load(name));
    expect(m.g - m.r, `${name} G-R`).toBeLessThanOrEqual(10);
    expect(m.g - m.r, `${name} G-R`).toBeGreaterThan(0); // …but there IS a tint; it is not neutral
  });

  it('is not MORE green than the elements whose hue is not reserved against the FX palette', () => {
    // A relative check, so it survives a future palette pass: poison's tint has to be the quiet
    // one, since it is the only element whose environment hue collides with its own combat FX.
    const greenness = (name: string) => {
      const m = channelMeans(load(name));
      return m.g - m.r;
    };
    for (const kind of ['floor', 'wall'] as const) {
      // Against the first-generation neighbours only: a warm-stone chapter is a different palette.
      const others = FIRST_GEN.filter((el) => el !== 'poison').map((el) => greenness(`${kind}_${el}`));
      expect(greenness(`${kind}_poison`), `${kind}_poison vs the loudest other`).toBeLessThanOrEqual(
        Math.max(...others) + 4,
      );
    }
  });

  it('no single pixel is a saturated green MARK (no slime, no glow, no vivid moss)', () => {
    // Per-pixel "green-ness" = how far green runs ahead of BOTH other channels. `#9CCC65` scores
    // 48 on it; the shipped poison swatches score 4-7, and the other four elements 0-1.
    //
    // Worth being precise about what this does and does not catch, because the mean-channel test
    // above is the one doing most of the work: the dull OLIVE residue in these seams reads olive
    // by having a LOW BLUE, not a high green, so it barely registers here. This assertion's job is
    // narrower — a patch of the reserved saturated hue painted into the stone.
    for (const name of POISON) {
      const img = load(name);
      let worst = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        const r = img.data[i * 4]!;
        const g = img.data[i * 4 + 1]!;
        const b = img.data[i * 4 + 2]!;
        worst = Math.max(worst, g - Math.max(r, b));
      }
      expect(worst, `${name} greenest pixel`).toBeLessThan(40);
    }
  });

  it('the FX green stays far brighter than any poison stone, which is what stops camouflage', () => {
    // The channel tests above are about hue; THIS is the one that actually answers design/13's
    // worry. A poison bullet, its trail and a poison-tinted mob are all drawn at `#9CCC65`, luma
    // ~186. Whatever the hue does, a saturated mark at 186 cannot hide on stone whose brightest
    // pixel is a fraction of that — the value gap is the guarantee, and it is the one that would
    // actually be lost if a future regeneration came back "prettier".
    const FX_GREEN_LUMA = luma(0x9c, 0xcc, 0x65);
    for (const name of POISON) {
      const q = quantiles(load(name));
      expect(q.max, `${name} brightest pixel vs FX green`).toBeLessThan(FX_GREEN_LUMA * 0.7);
    }
  });

  it('the elevation import ran: its base is re-darkened and its drawn border is gone', () => {
    // Two mechanical steps that leave no other trace. The generator returned a 1254x1254 image
    // with a near-black 1-2 px frame (row 0 measured 2.4) and a bright base band at the BOTTOM
    // that the top-half crop discards; the shipped file must show neither.
    const img = load('wallface_poison');
    expect(rowLuma(img, 0), 'top row is coping, not a black frame line').toBeGreaterThan(60);
    // The re-darkening ramp: the last row is well below the brick plateau above it.
    const brick = band(img, 0.35, 0.7);
    expect(rowLuma(img, img.height - 1), 'base shadow').toBeLessThan(brick * 0.7);
  });
});
