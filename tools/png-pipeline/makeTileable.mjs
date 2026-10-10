#!/usr/bin/env node
/**
 * CLI: make a generated swatch tile seamlessly, by cutting each wrap seam along a minimum-error
 * path (Efros-Freeman image quilting, applied to an image against itself).
 *
 * Why this exists (2026-10-10, the warm-ember art direction). The image model has no seamless mode,
 * and the swatches it returns show a hard line at every tile edge. The two cheap fixes both fail on
 * this art: a crossfade across the edge ghosts the bold cel outlines into double lines, and
 * mirror-tiling (flip every other tile) turns irregular flagstones into a kaleidoscope. A CUT keeps
 * every pixel from one source or the other, and steering the cut along the dark mortar both sides
 * share hides it where the art already has a line.
 *
 * How one axis works (horizontal shown; the vertical pass is the same on the transpose). The output
 * drops the first `b` columns. Its last `b` columns are an overlap between two strips of the input:
 *   A = columns [W-b, W)  — continues naturally from the column to its left;
 *   B = columns [0, b)    — continues naturally into column b, which is the output's column 0,
 *                           i.e. the column it wraps onto.
 * Each row takes A left of a cut and B right of it. The cut is the cheapest top-to-bottom path
 * (shifting at most `jump` columns per row) through a small `|A-B|` term plus a penalty for
 * pixels that are bright in BOTH strips — stone spliced onto stone. Output: `(W-b) x (H-b)`.
 *
 * Usage:
 *   node tools/png-pipeline/makeTileable.mjs [--axes=xy|x] [--overlap=0.25] [--mortar=1] [--jump=2] in.png out.png
 *
 * Run on a square crop of the `_raw.png` (which stays the untouched source), before `compress.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './pngCodec.mjs';

/** Rec. 601 luma of the pixel at byte offset `o`. */
function luma(d, o) {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}

/** A copy of `img` with rows and columns swapped, so one horizontal pass serves both axes. */
export function transpose(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const t = (x * h + y) * 4;
      out[t] = data[s];
      out[t + 1] = data[s + 1];
      out[t + 2] = data[s + 2];
      out[t + 3] = data[s + 3];
    }
  }
  return { width: h, height: w, data: out };
}

/**
 * The cut column (0..b-1) for every row: cells `< cut` take strip A, cells `>= cut` take strip B.
 * Exported for the test, which checks the path is connected and lands on a planted seam.
 */
export function minCutColumns(img, b, mortar, jump = 1) {
  const { width: w, height: h, data } = img;
  const cost = new Float64Array(h * b);
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < b; k++) {
      const a = (y * w + (w - b + k)) * 4;
      const s = (y * w + k) * 4;
      const diff =
        Math.abs(data[a] - data[s]) + Math.abs(data[a + 1] - data[s + 1]) + Math.abs(data[a + 2] - data[s + 2]);
      // The cut only reads as a seam where it splices stone onto stone. Where EITHER strip has
      // mortar, the stone on the other side simply ends against it, which is what a stone edge
      // looks like anyway — so the penalty is the brighter-of-the-darker of the two pixels.
      const bothBright = Math.min(luma(data, a), luma(data, s));
      cost[y * b + k] = diff / 3 + mortar * bothBright;
    }
  }
  // Cumulative minimum, top to bottom. The path may shift up to `jump` columns per row: a
  // mortar run is often horizontal, and a path held to one column per row can only cross it,
  // which is what leaves a notched stone on the seam.
  const acc = Float64Array.from(cost);
  for (let y = 1; y < h; y++) {
    for (let k = 0; k < b; k++) {
      let best = Infinity;
      for (let c = Math.max(0, k - jump); c <= Math.min(b - 1, k + jump); c++) {
        best = Math.min(best, acc[(y - 1) * b + c]);
      }
      acc[y * b + k] += best;
    }
  }
  const cut = new Int32Array(h);
  let k = 0;
  for (let i = 1; i < b; i++) if (acc[(h - 1) * b + i] < acc[(h - 1) * b + k]) k = i;
  cut[h - 1] = k;
  for (let y = h - 2; y >= 0; y--) {
    const prev = cut[y + 1];
    let bestK = prev;
    for (let c = Math.max(0, prev - jump); c <= Math.min(b - 1, prev + jump); c++) {
      if (acc[y * b + c] < acc[y * b + bestK]) bestK = c;
    }
    cut[y] = bestK;
  }
  return cut;
}

/** One horizontal pass: returns a `(W-b) x H` image whose left and right edges wrap seamlessly. */
export function tileHorizontally(img, b, mortar, jump = 1) {
  const { width: w, height: h, data } = img;
  if (b < 2 || b * 2 >= w) throw new Error(`overlap ${b} does not fit a ${w}px-wide image`);
  const cut = minCutColumns(img, b, mortar, jump);
  const ow = w - b;
  const out = new Uint8Array(ow * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      // Output column x is input column x+b, except inside the overlap right of the cut, where
      // it is the strip that wraps onto output column 0.
      const k = x - (ow - b); // position inside the overlap, negative outside it
      const src = k >= cut[y] ? k : x + b;
      const s = (y * w + src) * 4;
      const t = (y * ow + x) * 4;
      out[t] = data[s];
      out[t + 1] = data[s + 1];
      out[t + 2] = data[s + 2];
      out[t + 3] = data[s + 3];
    }
  }
  return { width: ow, height: h, data: out };
}

/**
 * `axes: 'xy'` for a floor or a wall cap; `'x'` for a wall FACE, which tiles left-right only —
 * its top is a lit coping edge and its bottom meets the floor, so the two must never be made to
 * match. `overlap` is the fraction of each side spent on the cut band.
 */
export function makeTileable(img, { overlap = 0.25, mortar = 1, jump = 2, axes = 'xy' } = {}) {
  const bx = Math.round(img.width * overlap);
  const horiz = tileHorizontally(img, bx, mortar, jump);
  if (axes === 'x') return horiz;
  const by = Math.round(horiz.height * overlap);
  return transpose(tileHorizontally(transpose(horiz), by, mortar, jump));
}

/** Mean per-channel difference across the wrap edge, against the image's own adjacent-column
 *  baseline — the same measure `art/biome/prompts.md` used to accept the elevation batch. */
export function wrapMismatch(img) {
  const { width: w, height: h, data } = img;
  let wrap = 0;
  let inner = 0;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      wrap += Math.abs(data[(y * w + w - 1) * 4 + c] - data[y * w * 4 + c]);
      inner += Math.abs(data[(y * w + w / 2 - 1) * 4 + c] - data[(y * w + w / 2) * 4 + c]);
    }
  }
  return { wrap: wrap / (h * 3), inner: inner / (h * 3) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const a = args.find((s) => s.startsWith(`--${name}=`));
    return a ? Number(a.split('=')[1]) : dflt;
  };
  const files = args.filter((s) => !s.startsWith('--'));
  if (files.length !== 2) {
    console.error('usage: makeTileable.mjs [--axes=xy|x] [--overlap=0.25] [--mortar=1] [--jump=2] in.png out.png');
    process.exit(2);
  }
  const img = decodePNG(fs.readFileSync(files[0]));
  const axesArg = args.find((s) => s.startsWith('--axes='));
  const out = makeTileable(img, {
    overlap: opt('overlap', 0.25),
    mortar: opt('mortar', 1),
    jump: opt('jump', 2),
    axes: axesArg ? axesArg.split('=')[1] : 'xy',
  });
  fs.writeFileSync(files[1], encodePNG(out));
  const before = wrapMismatch(img);
  const afterX = wrapMismatch(out);
  const afterY = wrapMismatch(transpose(out));
  console.log(
    `${files[1]}: ${img.width}x${img.height} -> ${out.width}x${out.height}; ` +
      `wrap mismatch x ${before.wrap.toFixed(1)} -> ${afterX.wrap.toFixed(1)} ` +
      `(inner ${afterX.inner.toFixed(1)}), y ${wrapMismatch(transpose(img)).wrap.toFixed(1)} -> ${afterY.wrap.toFixed(1)} ` +
      `(inner ${afterY.inner.toFixed(1)})`,
  );
}
