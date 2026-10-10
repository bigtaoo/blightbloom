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
 * the wall top the darkest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { BIOME_TILE_ASSETS, SWATCH_META } from '../../render/biomeTiles';

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

describe('warm-stone swatches — the shipped JPEG is its master', () => {
  it('covers one whole element, all three kinds', () => {
    expect(WARM_KEYS.sort()).toEqual(['floor_fire', 'wall_fire', 'wallface_fire']);
  });

  it.each(WARM_KEYS)('%s ships as the JPEG its master encodes to, at the same size', (key) => {
    expect(BIOME_TILE_ASSETS[key]).toBe(`/biome/${key}.jpg`);
    const m = master(key);
    expect(jpegSize(key)).toEqual({ width: m.width, height: m.height });
  });

  it.each(WARM_KEYS)('%s stays inside the per-file package budget', (key) => {
    // These ride in the WeChat main package (`build/checkWeChatPackage.mjs`); the three together are
    // ~160 KB. Four times that is a PNG shipped by mistake, not a better JPEG.
    expect(statSync(new URL(BIOME_TILE_ASSETS[key]!.slice(1), PUBLIC)).size).toBeLessThan(96 * 1024);
  });
});

describe('warm-stone swatches — sized in world px by their density', () => {
  it('lays a floor tile over 200 world px, so a slab is about two hero-widths', () => {
    // The key frame's proportion: a slab ~2.1 hero-widths. Measured 2026-10-10: at 96 world px per
    // tile the slabs read as cobbles the hero's own size; at 245 as paving three heroes across.
    expect(master('floor_fire').width / SWATCH_META.floor_fire!.density).toBe(200);
  });

  it('lays the wall top over exactly one 64 px cap cell', () => {
    expect(master('wall_fire').width / SWATCH_META.wall_fire!.density).toBe(64);
  });

  it('stretches the face to the wall height, so its density is 1', () => {
    expect(SWATCH_META.wallface_fire!.density).toBe(1);
  });
});

describe("warm-stone swatches — the key frame's tonal rules", () => {
  it('has a light floor, the lightest stone in the room', () => {
    const floor = median(master('floor_fire'));
    expect(floor).toBeGreaterThan(150);
    expect(floor).toBeLessThan(195); // light, not the white of an unlit page
    expect(floor).toBeGreaterThan(median(master('wallface_fire')));
  });

  it('has a dark wall top under it — the inverse of the first-generation rule', () => {
    expect(median(master('wall_fire'))).toBeLessThan(median(master('floor_fire')) * 0.6);
  });

  it('keeps the floor a warm beige: red over green over blue, but not orange', () => {
    const m = means(master('floor_fire'));
    expect(m.r).toBeGreaterThan(m.g);
    expect(m.g).toBeGreaterThan(m.b);
    // The torches are the orange in the frame; a floor already this warm turns them into nothing.
    expect(m.r - m.b).toBeLessThan(60);
  });

  it('keeps the wall top a cool dark grey, so the warm floor and brick read against it', () => {
    const m = means(master('wall_fire'));
    expect(m.b).toBeGreaterThanOrEqual(m.r);
  });

  it('has warm brick on the face: red well over blue', () => {
    const m = means(master('wallface_fire'));
    expect(m.r - m.b).toBeGreaterThan(25);
  });
});

describe('warm-stone swatches — the seams', () => {
  it.each(['floor_fire', 'wall_fire'])('%s wraps on all four edges', (key) => {
    // Same ratio test as the first-generation family: the wrap difference against the adjacent
    // line's, because a busy swatch has a high baseline. 2.5 rather than 6: these are cut by
    // `makeTileable.mjs` to wrap EXACTLY, and the floor stamp no longer mirrors to hide a mismatch.
    const img = master(key);
    expect(lineDiff(img, 0, img.width - 1, 'col')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'col'), 1) * 2.5);
    expect(lineDiff(img, 0, img.height - 1, 'row')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'row'), 1) * 2.5);
  });

  it('wraps the face left-right only — its top and bottom are different courses', () => {
    const img = master('wallface_fire');
    expect(lineDiff(img, 0, img.width - 1, 'col')).toBeLessThan(Math.max(lineDiff(img, 0, 1, 'col'), 1) * 2.5);
    expect(lineDiff(img, 0, img.height - 1, 'row')).toBeGreaterThan(lineDiff(img, 0, 1, 'row') * 2.5);
  });

  it('would catch an unwrapped swatch — the ratio has teeth', () => {
    // Half a tile's offset is as far from wrapping as the same image gets.
    const img = master('floor_fire');
    expect(lineDiff(img, 0, img.width / 2, 'col')).toBeGreaterThan(lineDiff(img, 0, 1, 'col') * 2.5);
  });
});
