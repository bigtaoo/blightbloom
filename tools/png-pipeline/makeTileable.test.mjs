import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTileable, minCutColumns, tileHorizontally, transpose, wrapMismatch } from './makeTileable.mjs';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/**
 * `makeTileable` — the min-cut seam that makes a generated swatch wrap (2026-10-10, the warm-stone
 * floor). Synthetic fixtures only, like the rest of this package's tests.
 *
 * The property everything rests on: the output's wrap edge is NOT a seam at all. Its last column is
 * the input column that naturally precedes its first one, so the step a raw swatch has at its edge
 * moves inside the overlap, onto a cut chosen to run where both strips are already dark mortar.
 */
function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** A deterministic pseudo-random channel value, so a fixture has texture everywhere. */
const noise = (x, y, c = 0) => ((((x * 73856093) ^ (y * 19349663) ^ (c * 83492791)) >>> 0) % 200) + 40;
const rgbNoise = (x, y) => [noise(x, y, 0), noise(x, y, 1), noise(x, y, 2)];

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const column = (img, x) => Array.from({ length: img.height }, (_, y) => px(img, x, y));

describe('transpose', () => {
  it('swaps the axes, and twice is the identity', () => {
    const img = image(5, 3, rgbNoise);
    const t = transpose(img);
    expect([t.width, t.height]).toEqual([3, 5]);
    expect(px(t, 2, 4)).toEqual(px(img, 4, 2));
    expect(transpose(t)).toEqual(img);
  });
});

describe('tileHorizontally — the wrap edge becomes a natural continuation', () => {
  const W = 40;
  const B = 10;
  const img = image(W, 24, rgbNoise);
  const out = tileHorizontally(img, B, 1, 2);

  it('drops the overlap from the width and keeps the height', () => {
    expect([out.width, out.height]).toEqual([W - B, 24]);
  });

  it('starts on input column b and ends on input column b-1 — the two are neighbours', () => {
    expect(column(out, 0)).toEqual(column(img, B));
    expect(column(out, out.width - 1)).toEqual(column(img, B - 1));
  });

  it('takes every pixel from the input unchanged, either side of the cut', () => {
    const cut = minCutColumns(img, B, 1, 2);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const k = x - (out.width - B);
        expect(px(out, x, y)).toEqual(px(img, k >= cut[y] ? k : x + B, y));
      }
    }
  });

  it('refuses an overlap that does not fit', () => {
    expect(() => tileHorizontally(img, 1, 1)).toThrow(/does not fit/);
    expect(() => tileHorizontally(img, W / 2, 1)).toThrow(/does not fit/);
  });
});

describe('minCutColumns — the cut runs where it hides', () => {
  const W = 40;
  const B = 12;
  /** Noise, except overlap column `k0` is black in BOTH strips: mortar the two sides share. */
  const planted = (k0) => image(W, 30, (x, y) => (x === k0 || x === W - B + k0 ? [0, 0, 0] : rgbNoise(x, y)));

  it('lands on a line of mortar both strips share', () => {
    expect(Array.from(minCutColumns(planted(5), B, 1, 2))).toEqual(new Array(30).fill(5));
    expect(Array.from(minCutColumns(planted(9), B, 1, 2))).toEqual(new Array(30).fill(9));
  });

  it('is a connected path: it moves at most `jump` columns per row', () => {
    const img = image(W, 60, rgbNoise);
    for (const jump of [1, 2, 3]) {
      const cut = minCutColumns(img, B, 1, jump);
      for (let y = 1; y < cut.length; y++) expect(Math.abs(cut[y] - cut[y - 1])).toBeLessThanOrEqual(jump);
      for (const k of cut) expect(k >= 0 && k < B).toBe(true);
    }
  });

  it('follows a diagonal mortar line when the jump allows it', () => {
    // Mortar stepping two columns per row. With `jump` 2 the path can stay on it all the way down.
    const img = image(W, 5, (x, y) => {
      const k = x >= W - B ? x - (W - B) : x;
      return k === 1 + 2 * y ? [0, 0, 0] : rgbNoise(x, y);
    });
    expect(Array.from(minCutColumns(img, B, 1, 2))).toEqual([1, 3, 5, 7, 9]);
  });
});

describe('makeTileable — both axes, or one', () => {
  // A ramp in each axis: the raw image's wrap step is the whole ramp, far over its inner step.
  const ramp = image(64, 64, (x, y) => [x * 3 + 20, y * 3 + 20, 100]);

  it('fixes the wrap on both axes for a floor', () => {
    const out = makeTileable(ramp, { overlap: 0.25 });
    expect([out.width, out.height]).toEqual([48, 48]);
    for (const img of [out, transpose(out)]) {
      const m = wrapMismatch(img);
      expect(m.wrap).toBeLessThanOrEqual(Math.max(m.inner, 1) * 2);
    }
    expect(wrapMismatch(ramp).wrap).toBeGreaterThan(Math.max(wrapMismatch(ramp).inner, 1) * 20); // the control
  });

  it("leaves a wall face's top and bottom alone — they are different courses", () => {
    const out = makeTileable(ramp, { overlap: 0.25, axes: 'x' });
    expect([out.width, out.height]).toEqual([48, 64]);
    expect(wrapMismatch(transpose(out)).wrap).toBeGreaterThan(50);
  });
});

describe('makeTileable.mjs — the CLI', () => {
  const script = fileURLToPath(new URL('./makeTileable.mjs', import.meta.url));

  it('writes the tiled PNG and reports the before/after mismatch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maketileable-'));
    try {
      const input = path.join(dir, 'in.png');
      const output = path.join(dir, 'out.png');
      fs.writeFileSync(input, encodePNG(image(40, 40, rgbNoise)));
      const log = execFileSync(process.execPath, [script, '--overlap=0.25', '--axes=x', input, output], {
        encoding: 'utf8',
      });
      expect(log).toMatch(/40x40 -> 30x40/);
      const out = decodePNG(fs.readFileSync(output));
      expect([out.width, out.height]).toEqual([30, 40]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly without its two files', () => {
    expect(() => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });
});
