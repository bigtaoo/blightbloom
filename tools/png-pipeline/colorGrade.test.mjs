import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorGrade, flattenGains, medianLuma } from './colorGrade.mjs';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/**
 * `colorGrade` — landing a generated swatch on its tonal target (2026-10-10, the warm-stone
 * swatches). Synthetic fixtures only. What it protects: the image model treats a hex colour as a
 * suggestion, so the shipped tone is set HERE, by the numbers `art/biome/prompts.md` records — and
 * the one that matters most is the median, because that is what `warmStoneArt.test.ts` gates.
 */
function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const px = (img, x, y = 0) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

describe('medianLuma', () => {
  it('is the median, not the mean — a thin dark mortar tail does not move it', () => {
    // Seven stone pixels at 180, three mortar at 0: the mean is 126, the stone is 180.
    const img = image(10, 1, (x) => (x < 7 ? [180, 180, 180, 255] : [0, 0, 0, 255]));
    expect(medianLuma(img)).toBe(180);
  });

  it('ignores fully transparent pixels', () => {
    const img = image(5, 1, (x) => (x < 2 ? [100, 100, 100, 255] : [0, 0, 0, 0]));
    expect(medianLuma(img)).toBe(100);
  });
});

describe('colorGrade — desaturate, gain, then land the median', () => {
  it('is the identity with no options', () => {
    const img = image(4, 1, (x) => [10 + x * 50, 200 - x * 30, 77, 255]);
    const before = Array.from(img.data);
    colorGrade(img);
    expect(Array.from(img.data)).toEqual(before);
  });

  it('pulls each pixel toward its own luma by `desat`, keeping the luma', () => {
    const l = luma([200, 100, 50]);
    const grey = image(1, 1, () => [200, 100, 50, 255]);
    colorGrade(grey, { desat: 1 });
    for (const c of px(grey, 0).slice(0, 3)) expect(Math.abs(c - l)).toBeLessThanOrEqual(0.5);
    const half = image(1, 1, () => [200, 100, 50, 255]);
    colorGrade(half, { desat: 0.5 });
    expect(px(half, 0)[0]).toBe(Math.round(l + (200 - l) * 0.5));
  });

  it('multiplies each channel by its gain', () => {
    const img = image(1, 1, () => [100, 100, 100, 255]);
    colorGrade(img, { gain: [1.1, 1, 0.9] });
    expect(px(img, 0)).toEqual([110, 100, 90, 255]);
  });

  it('lands the median luma on the target, and keeps the stone-to-mortar ratio', () => {
    const img = image(10, 1, (x) => (x < 7 ? [120, 110, 100, 255] : [30, 28, 25, 255]));
    colorGrade(img, { median: 170 });
    expect(Math.abs(medianLuma(img) - 170)).toBeLessThanOrEqual(1);
    expect(px(img, 0)[0] / px(img, 9)[0]).toBeCloseTo(120 / 30, 1);
  });

  it('leaves an all-black image alone rather than dividing by its zero median', () => {
    const img = image(2, 1, () => [0, 0, 0, 255]);
    colorGrade(img, { median: 150 });
    expect(px(img, 0)).toEqual([0, 0, 0, 255]);
  });

  it('clamps to the byte range and never touches alpha', () => {
    const img = image(2, 1, (x) => [250, 5, 128, x ? 77 : 255]);
    colorGrade(img, { gain: [2, 0, 1] });
    expect(px(img, 0)).toEqual([255, 0, 128, 255]);
    expect(px(img, 1)[3]).toBe(77);
  });
});

describe('flattenGains — the lit patch goes, the stone stays', () => {
  it('is all ones on an image with no drift', () => {
    for (const g of flattenGains(image(16, 16, () => [120, 120, 120, 255]), 0.25)) expect(g).toBeCloseTo(1, 6);
  });

  it('cancels a slow lit drift while the stone-scale contrast survives', () => {
    // One slow swell of light across the tile (a stripe per tile once repeated), over a 1 px
    // checker standing in for the stone's own texture.
    const lit = () =>
      image(64, 8, (x, y) => {
        const v = 140 + 40 * Math.sin((2 * Math.PI * x) / 64) + ((x + y) % 2 ? 20 : -20);
        return [v, v, v, 255];
      });
    /** The drift: the 2x2 mean at the swell's peak against its trough, which cancels the checker. */
    const drift = (img) => {
      const m = (x) => (px(img, x, 0)[0] + px(img, x + 1, 0)[0] + px(img, x, 1)[0] + px(img, x + 1, 1)[0]) / 4;
      return m(15) - m(47);
    };
    const checker = (img) => Math.abs(px(img, 31, 0)[0] - px(img, 32, 0)[0]);
    const flat = colorGrade(lit(), { flatten: 0.25 });
    expect(drift(flat)).toBeLessThan(drift(lit()) * 0.5);
    expect(checker(flat)).toBeGreaterThan(checker(lit()) * 0.7);
  });

  it('wraps at the edges — a tileable input stays tileable', () => {
    // A bright band straddling the wrap (columns 0-3 and 28-31): mirrored columns get the same gain.
    const band = image(32, 1, (x) => (x < 4 || x >= 28 ? [200, 200, 200, 255] : [100, 100, 100, 255]));
    const gains = flattenGains(band, 0.1);
    expect(gains[0]).toBeCloseTo(gains[31], 6);
    expect(gains[2]).toBeCloseTo(gains[29], 6);
  });

  it('leaves a black pixel at gain 1 rather than dividing by nothing', () => {
    expect(Array.from(flattenGains(image(8, 8, () => [0, 0, 0, 255]), 0.25))).toEqual(new Array(64).fill(1));
  });
});

describe('colorGrade.mjs — the CLI', () => {
  const script = fileURLToPath(new URL('./colorGrade.mjs', import.meta.url));

  function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colorgrade-'));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('grades the file and reports the median it landed', () => {
    withDir((dir) => {
      const input = path.join(dir, 'in.png');
      const output = path.join(dir, 'out.png');
      fs.writeFileSync(input, encodePNG(image(8, 8, (x, y) => [100 + x, 90 + y, 80, 255])));
      const args = [script, '--flatten=0.25', '--desat=0.2', '--gain=1.02,0.98,1', '--median=150', input, output];
      expect(execFileSync(process.execPath, args, { encoding: 'utf8' })).toMatch(/-> 15[01]\b/);
      expect(Math.abs(medianLuma(decodePNG(fs.readFileSync(output))) - 150)).toBeLessThanOrEqual(1);
    });
  });

  it('runs with no grading options at all', () => {
    withDir((dir) => {
      const input = path.join(dir, 'in.png');
      fs.writeFileSync(input, encodePNG(image(2, 2, () => [50, 60, 70, 255])));
      const log = execFileSync(process.execPath, [script, input, path.join(dir, 'o.png')], { encoding: 'utf8' });
      expect(log).toMatch(/median luma/);
    });
  });

  it('fails loudly without its two files', () => {
    expect(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
