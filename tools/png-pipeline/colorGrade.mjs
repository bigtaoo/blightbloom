#!/usr/bin/env node
/**
 * CLI: grade a generated swatch onto its tonal target — partial desaturation, a per-channel gain,
 * then one uniform scale that lands the image's MEDIAN luma on a number.
 *
 * Why this exists (2026-10-10, the warm-ember art direction). The image model takes a hex colour
 * in a prompt as a suggestion: a floor asked for at #B8A38C came back at a median luma of 187 and
 * twice the chroma. Regenerating until the colour is right costs a roll of the composition too, and
 * the composition is the hard part; the colour is three numbers. Grading the median rather than
 * the mean keeps the target about the STONE: a swatch is mostly stone face with a thin dark
 * mortar tail, and the mean moves with how much mortar the generator happened to draw.
 *
 * Usage:
 *   node tools/png-pipeline/colorGrade.mjs [--flatten=0.25] [--desat=0.2] [--gain=1,1,1] [--median=140] in.png out.png
 *
 * Order: optionally flatten low-frequency brightness drift (`--flatten`, see `flattenGains`),
 * desaturate toward each pixel's own luma, multiply by `gain`, then scale RGB so the median luma
 * equals `median` (omit `--median` to skip that step). Alpha is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './pngCodec.mjs';

const LUMA = [0.299, 0.587, 0.114];

/** Median Rec. 601 luma over the pixels that are not fully transparent. */
export function medianLuma(img) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let o = 0; o < img.data.length; o += 4) {
    if (img.data[o + 3] === 0) continue;
    const l = LUMA[0] * img.data[o] + LUMA[1] * img.data[o + 1] + LUMA[2] * img.data[o + 2];
    hist[Math.min(255, Math.round(l))]++;
    n++;
  }
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen * 2 >= n) return v;
  }
  return 0;
}

/**
 * Per-pixel gain that cancels low-frequency brightness drift: each pixel is scaled by
 * `mean / blurred`, where `blurred` is the luma box-blurred with WRAP-AROUND over a window of
 * `radius` (a fraction of the side) — wrap, because the input is already tileable and a clamped
 * blur would re-introduce a step at the edge. Stone-scale contrast survives; a lit patch the
 * generator painted in does not, and on a repeated swatch that patch is a stripe per tile.
 */
export function flattenGains(img, radius) {
  const { width: w, height: h, data: d } = img;
  const lum = new Float64Array(w * h);
  let mean = 0;
  for (let i = 0; i < w * h; i++) {
    lum[i] = LUMA[0] * d[i * 4] + LUMA[1] * d[i * 4 + 1] + LUMA[2] * d[i * 4 + 2];
    mean += lum[i];
  }
  mean /= w * h;
  const blur1d = (src, len, stride, count, step, r) => {
    const out = new Float64Array(src.length);
    for (let line = 0; line < count; line++) {
      const base = line * step;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[base + (((k % len) + len) % len) * stride];
      for (let i = 0; i < len; i++) {
        out[base + i * stride] = acc / (2 * r + 1);
        acc += src[base + ((i + r + 1) % len) * stride] - src[base + (((i - r) % len) + len) % len * stride];
      }
    }
    return out;
  };
  const rx = Math.max(1, Math.round(w * radius));
  const ry = Math.max(1, Math.round(h * radius));
  const blurred = blur1d(blur1d(lum, w, 1, h, w, rx), h, w, w, 1, ry);
  return blurred.map((b) => (b > 1 ? mean / b : 1));
}

/** Grade `img` in place (see the module header for the order) and return it. */
export function colorGrade(img, { desat = 0, gain = [1, 1, 1], median, flatten = 0 } = {}) {
  const d = img.data;
  const f = new Float32Array(d.length);
  const flat = flatten > 0 ? flattenGains(img, flatten) : undefined;
  for (let o = 0; o < d.length; o += 4) {
    const l = LUMA[0] * d[o] + LUMA[1] * d[o + 1] + LUMA[2] * d[o + 2];
    const g = flat ? flat[o / 4] : 1;
    for (let c = 0; c < 3; c++) f[o + c] = (l + (d[o + c] - l) * (1 - desat)) * gain[c] * g;
  }
  let scale = 1;
  if (median !== undefined) {
    const probe = { width: img.width, height: img.height, data: new Uint8Array(d.length) };
    for (let o = 0; o < d.length; o += 4) {
      for (let c = 0; c < 3; c++) probe.data[o + c] = Math.max(0, Math.min(255, Math.round(f[o + c])));
      probe.data[o + 3] = d[o + 3];
    }
    const m = medianLuma(probe);
    scale = m > 0 ? median / m : 1;
  }
  for (let o = 0; o < d.length; o += 4) {
    for (let c = 0; c < 3; c++) d[o + c] = Math.max(0, Math.min(255, Math.round(f[o + c] * scale)));
  }
  return img;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (name) => args.find((s) => s.startsWith(`--${name}=`))?.split('=')[1];
  const files = args.filter((s) => !s.startsWith('--'));
  if (files.length !== 2) {
    console.error('usage: colorGrade.mjs [--flatten=0.25] [--desat=0.2] [--gain=1,1,1] [--median=140] in.png out.png');
    process.exit(2);
  }
  const img = decodePNG(fs.readFileSync(files[0]));
  const before = medianLuma(img);
  const gain = val('gain')?.split(',').map(Number) ?? [1, 1, 1];
  const median = val('median') !== undefined ? Number(val('median')) : undefined;
  colorGrade(img, { desat: Number(val('desat') ?? 0), gain, median, flatten: Number(val('flatten') ?? 0) });
  fs.writeFileSync(files[1], encodePNG(img));
  console.log(`${files[1]}: median luma ${before} -> ${medianLuma(img)}`);
}
