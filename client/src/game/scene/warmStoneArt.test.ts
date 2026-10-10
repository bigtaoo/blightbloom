/**
 * The warm-stone swatches (design/13 "Environment: warm stone, dark edges, light pools",
 * 2026-10-10), measured — the sibling of `biomeSwatchArt.test.ts`, which measures the
 * first-generation family these deliberately leave.
 *
 * What is measured, and off which file. The shipped swatches are JPEG (a 512 px painted stone
 * swatch is ~55 KB as JPEG and several times that as PNG, and they ride in the WeChat package), and
 * nothing in this environment decodes JPEG. So every pixel measurement reads the lossless MASTER in
 * `art/biome/<key>_master.png` that the JPEG is encoded from, and the first block below pins the
 * shipped file to its master: same dimensions, read off the JPEG's own frame header. A re-export at
 * a new size, or a JPEG nobody re-encoded from a new master, fails there.
 *
 * The rules are the key frame's (`art/concept/direction-2026-10-10/4_hybrid_a.png`), and two of them
 * are the INVERSE of the old family's, on purpose: the floor is the lightest stone in the room and
 * the wall top the darkest. Ember was the pilot; frost, storm and blight followed the same day, each
 * in its own stone. The tonal rules hold for every chapter, the hue rules are per chapter, and one
 * check keeps the four floors from collapsing into the same grey.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { BIOME_TILE_ASSETS, SWATCH_META } from '../../render/biomeTiles';
import { WARM_STONE_ELEMENTS } from '../theme';

interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

const PUBLIC = new URL('../../../public/', import.meta.url);
const ART = new URL('../../../../art/biome/', import.meta.url);
const WARM_KEYS = Object.keys(SWATCH_META);

function master(key: string): Img {
  return decodePNG(readFileSync(new URL(`${key}_master.png`, ART)));
}

/** A JPEG's dimensions, off its first start-of-frame marker. */
function jpegSize(key: string): { width: number; height: number } {
  const buf = readFileSync(new URL(BIOME_TILE_ASSETS[key]!.slice(1), PUBLIC));
  expect(buf.readUInt16BE(0), `${key} is a JPEG`).toBe(0xffd8);
  for (let o = 2; o < buf.length; o += 2 + buf.readUInt16BE(o + 2)) {
    const m = buf[o + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { width: buf.readUInt16BE(o + 7), height: buf.readUInt16BE(o + 5) };
    }
  }
  throw new Error(`${key}: no frame header`);
}

const luma = (d: Uint8Array, i: number): number => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

function median(img: Img): number {
  const l: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) l.push(luma(img.data, i * 4));
  l.sort((a, b) => a - b);
  return l[Math.floor(l.length / 2)]!;
}

function means(img: Img): { r: number; g: number; b: number } {
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

/** Mean per-channel difference between column `x1` and `x2` (or rows, transposed). */
function lineDiff(img: Img, a: number, b: number, axis: 'col' | 'row'): number {
  const len = axis === 'col' ? img.height : img.width;
  let s = 0;
  for (let k = 0; k < len; k++) {
    const i = axis === 'col' ? (k * img.width + a) * 4 : (a * img.width + k) * 4;
    const j = axis === 'col' ? (k * img.width + b) * 4 : (b * img.width + k) * 4;
    for (let c = 0; c < 3; c++) s += Math.abs(img.data[i + c]! - img.data[j + c]!);
  }
  return s / len / 3;
}

const ELEMENTS = WARM_STONE_ELEMENTS;

describe('warm-stone swatches — the shipped JPEG is its master', () => {
  it('covers every chapter, all three kinds', () => {
    expect([...ELEMENTS].sort()).toEqual(['fire', 'ice', 'lightning', 'poison']);
    expect(WARM_KEYS.sort()).toEqual(ELEMENTS.flatMap((el) => [`floor_${el}`, `wall_${el}`, `wallface_${el}`]).sort());
  });

  it.each(WARM_KEYS)('%s ships as the JPEG its master encodes to, at the same size', (key) => {
    expect(BIOME_TILE_ASSETS[key]).toBe(`/biome/${key}.jpg`);
    const m = master(key);
    expect(jpegSize(key)).toEqual({ width: m.width, height: m.height });
  });

  it.each(WARM_KEYS)('%s stays inside the per-file package budget', (key) => {
    // Ember's ride in the `run` pack and the other chapters' in their own biome pack
    // (`build/checkWeChatPackage.mjs`); a chapter's three are ~150-190 KB together. Four times
    // that is a PNG shipped by mistake, not a better JPEG.
    expect(statSync(new URL(BIOME_TILE_ASSETS[key]!.slice(1), PUBLIC)).size).toBeLessThan(96 * 1024);
  });
});

describe('warm-stone swatches — sized in world px by their density', () => {
  it.each(ELEMENTS)('lays a %s floor tile over 200 world px, so a slab is about two hero-widths', (el) => {
    // The key frame's proportion: a slab ~2.1 hero-widths. Measured 2026-10-10: at 96 world px per
    // tile the slabs read as cobbles the hero's own size; at 245 as paving three heroes across.
    expect(master(`floor_${el}`).width / SWATCH_META[`floor_${el}`]!.density).toBe(200);
  });

  it.each(ELEMENTS)('lays the %s wall top over exactly one 64 px cap cell', (el) => {
    expect(master(`wall_${el}`).width / SWATCH_META[`wall_${el}`]!.density).toBe(64);
  });

  it.each(ELEMENTS)('stretches the %s face to the wall height, so its density is 1', (el) => {
    expect(SWATCH_META[`wallface_${el}`]!.density).toBe(1);
  });
});

describe("warm-stone swatches — the key frame's tonal rules, in every chapter", () => {
  it.each(ELEMENTS)('%s has a light floor, the lightest stone in the room', (el) => {
    const floor = median(master(`floor_${el}`));
    expect(floor).toBeGreaterThan(150);
    expect(floor).toBeLessThan(195); // light, not the white of an unlit page
    expect(floor).toBeGreaterThan(median(master(`wallface_${el}`)));
  });

  it.each(ELEMENTS)('%s has a dark wall top under it — the inverse of the first-generation rule', (el) => {
    expect(median(master(`wall_${el}`))).toBeLessThan(median(master(`floor_${el}`)) * 0.6);
  });

  it.each(ELEMENTS)('%s keeps its wall top a cool dark grey, so the floor and the face read against it', (el) => {
    const m = means(master(`wall_${el}`));
    expect(m.b).toBeGreaterThanOrEqual(m.r);
  });

  it.each(ELEMENTS)('%s floor is not green — green is the poison FX colour, in every chapter', (el) => {
    const m = means(master(`floor_${el}`));
    expect(m.g - Math.max(m.r, m.b)).toBeLessThan(2);
  });

  it('keeps the four floors apart: no two chapters share one grey', () => {
    // The hue rules below each pass on their own and could still land two chapters on the same
    // stone. The closest pair at the time of writing is storm and blight, ~14 apart.
    for (let i = 0; i < ELEMENTS.length; i++) {
      for (let j = i + 1; j < ELEMENTS.length; j++) {
        const a = means(master(`floor_${ELEMENTS[i]}`));
        const b = means(master(`floor_${ELEMENTS[j]}`));
        const d = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
        expect(d, `${ELEMENTS[i]} vs ${ELEMENTS[j]}`).toBeGreaterThan(12);
      }
    }
  });
});

describe('warm-stone swatches — each chapter in its own stone', () => {
  it('ember: a warm beige floor, red over green over blue, but not orange', () => {
    const m = means(master('floor_fire'));
    expect(m.r).toBeGreaterThan(m.g);
    expect(m.g).toBeGreaterThan(m.b);
    // The torches are the orange in the frame; a floor already this warm turns them into nothing.
    expect(m.r - m.b).toBeLessThan(60);
  });

  it('ember: warm brick on the face, red well over blue', () => {
    const m = means(master('wallface_fire'));
    expect(m.r - m.b).toBeGreaterThan(25);
  });

  it('frost: cold stone, blue over red on the floor and the face — but grey, not the chill blue', () => {
    for (const key of ['floor_ice', 'wallface_ice']) {
      const m = means(master(key));
      expect(m.b, key).toBeGreaterThan(m.r + 10);
      // `statusChill` (#81D4FA) runs blue 121 over red. The floor is a cold grey a chill aura still
      // reads against, not a field of the aura's own colour.
      expect(m.b - m.r, key).toBeLessThan(45);
    }
  });

  it('storm: a neutral granite floor — not yellow, the shock colour, and not warm like ember', () => {
    const m = means(master('floor_lightning'));
    expect(Math.abs(m.r - m.b)).toBeLessThan(12);
    // `statusShock` (#FFF176) is red and green far over blue; the floor holds them level.
    expect((m.r + m.g) / 2 - m.b).toBeLessThan(10);
  });

  it('blight: green is the lowest channel in all three — design/13 keeps the stone off the poison hue', () => {
    // The first-generation clause (2026-08-25) held poison's stone to a VALUE gap: dark stone under
    // a bright #9CCC65. A light floor cannot keep that gap, so the hue carries it now: the stone is
    // mauve, the opposite side of the wheel from the poison bullet, aura and blightling it has to
    // show.
    for (const kind of ['floor', 'wall', 'wallface']) {
      const m = means(master(`${kind}_poison`));
      expect(m.g, `${kind}_poison`).toBeLessThan(m.r);
      expect(m.g, `${kind}_poison`).toBeLessThan(m.b);
    }
  });

  it('blight: no single pixel is a saturated green mark (no slime, no glow, no moss)', () => {
    // `#9CCC65` scores 48 on this (green ahead of both other channels).
    for (const kind of ['floor', 'wall', 'wallface']) {
      const img = master(`${kind}_poison`);
      const d = img.data;
      let worst = 0;
      for (let i = 0; i < img.width * img.height; i++) {
        worst = Math.max(worst, d[i * 4 + 1]! - Math.max(d[i * 4]!, d[i * 4 + 2]!));
      }
      expect(worst, `${kind}_poison greenest pixel`).toBeLessThan(20);
    }
  });
});

describe('warm-stone swatches — the seams', () => {
  const TILED = ELEMENTS.flatMap((el) => [`floor_${el}`, `wall_${el}`]);

  it.each(TILED)('%s wraps on all four edges', (key) => {
    // Same ratio test as the first-generation family: the wrap difference against the adjacent
    // line's, because a busy swatch has a high baseline. 2.5 rather than 6: these are cut by
    // `makeTileable.mjs` to wrap EXACTLY, and the floor stamp no longer mirrors to hide a mismatch.
    const img = master(key);
    expect(lineDiff(img, 0, img.width - 1, 'col')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'col'), 1) * 2.5);
    expect(lineDiff(img, 0, img.height - 1, 'row')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'row'), 1) * 2.5);
  });

  it.each(ELEMENTS)('wraps the %s face left-right only — its top and bottom are different courses', (el) => {
    const img = master(`wallface_${el}`);
    expect(lineDiff(img, 0, img.width - 1, 'col')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'col'), 1) * 2.5);
    // Against the face's typical adjacent-row step, not the top edge's own: a top course's lit bevel
    // makes row 0 to row 1 one of the largest steps in the image (storm's measures 39).
    let step = 0;
    for (let y = 0; y < img.height - 1; y++) step += lineDiff(img, y, y + 1, 'row');
    expect(lineDiff(img, 0, img.height - 1, 'row')).toBeGreaterThan((step / (img.height - 1)) * 2.5);
  });

  it('would catch an unwrapped swatch — the ratio has teeth', () => {
    // Half a tile's offset is as far from wrapping as the same image gets.
    const img = master('floor_fire');
    expect(lineDiff(img, 0, img.width / 2, 'col')).toBeGreaterThan(lineDiff(img, 0, 1, 'col') * 2.5);
  });
});
