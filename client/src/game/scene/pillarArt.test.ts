/**
 * The SHIPPED pillar art itself (`client/public/biome/pillar_neutral.png`), decoded and measured
 * (2026-08-20). Every other test in this directory checks what the renderer does with a texture;
 * this one checks the texture, because the pillar's whole look now lives in the file and three of
 * the things that went wrong on the way here are invisible to any test of the code:
 *
 * 1. **The generation came back with a painted "transparency" checkerboard** — 3.46M opaque
 *    pixels, zero transparent ones, drawn to LOOK like an alpha channel. It had to be keyed out
 *    by hand. `alpha-audit.mjs` catches that repo-wide, but nothing stopped the file from being
 *    wired up before the audit ran.
 * 2. **The art's aspect ratio is what decides how tall a pillar stands** (`pillarSpriteMetrics`
 *    scales by width), so a regenerated file at a different aspect silently breaks the
 *    `WALL_HEIGHT` agreement every standing thing in a room shares (design/01).
 * 3. **Its tonal placement is the whole point of the pass.** The first accepted file measured a
 *    shaft twice as bright as the wall face beside it (lit limb 84 against a wall face's 31-41)
 *    while its top was already on target — the reason `tools/png-pipeline/lumaCurve.mjs` exists.
 *    Nothing but a measurement of the file can tell whether that step was run.
 *
 * The numbers below are the live in-frame measurements this pass was tuned against (extract of
 * the real level 1 gallery room at zoom 1, UI and actors hidden): pillar top 87.3, lit limb 50.4,
 * mid band 35.8, dark limb 16.7, against wall caps of 72-81 and wall faces of 27.3-27.5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Texture } from 'pixi.js';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { biomePalette } from '../theme';
import { pillarTint, pillarArtExtent } from './pillarRender';

const PATH = new URL('../../../public/biome/pillar_neutral.png', import.meta.url);

const img = decodePNG(readFileSync(PATH));

function px(x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

function luma(p: readonly number[]): number {
  return 0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!;
}

/** Mean luma of the opaque pixels in a fractional rect of the image. */
function patch(fx: number, fy: number, fw: number, fh: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(img.height * fy); y < Math.round(img.height * (fy + fh)); y++) {
    for (let x = Math.round(img.width * fx); x < Math.round(img.width * (fx + fw)); x++) {
      const p = px(x, y);
      if (p[3] < 200) continue;
      sum += luma(p);
      n++;
    }
  }
  expect(n).toBeGreaterThan(0); // an empty patch would make every assertion below vacuous
  return sum / n;
}

/** What the renderer's own tint multiplies the file by, so a file value can be compared to a
 *  number measured on screen. */
const TINT_GAIN = ((pillarTint(biomePalette('ember')) >> 16) & 0xff) / 255;

describe('the shipped pillar sprite — measured, not assumed', () => {
  it('has a real alpha channel (never a painted checkerboard)', () => {
    let transparent = 0;
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i]! === 0) transparent++;
      else if (img.data[i]! === 255) opaque++;
    }
    // A lone round object in a rectangular frame always has transparent corners; the file that
    // came back from the generator had NONE, and looked identical by eye.
    expect(transparent).toBeGreaterThan(img.width * img.height * 0.03);
    expect(opaque).toBeGreaterThan(img.width * img.height * 0.5);
    // ...and the corners specifically, which is where the fake checkerboard lived.
    for (const [x, y] of [[1, 1], [img.width - 2, 1]] as const) expect(px(x, y)[3]).toBe(0);
  });

  it('carries real resolution headroom for the camera zoom', () => {
    // What got the FIRST batch of pillar art rejected: it was generated at exactly the 84x98 the
    // game draws, while the camera's MAX_ZOOM was 4.5 (3.5 since 2026-09-28) and the renderer runs at up to 2x device
    // pixel ratio — so the sprite is MAGNIFIED in every real room (level 1's gallery renders at
    // zoom 4). A source at game size is a blurred pillar, and nothing else measured in this file
    // would notice. Survived the mutation battery until this was added.
    expect(img.height).toBeGreaterThanOrEqual(99 * 3);
    expect(img.width).toBeGreaterThanOrEqual(84 * 3);
  });

  it('keeps the aspect a pillar has to stand at (the WALL_HEIGHT agreement)', () => {
    // `pillarSpriteMetrics` fits the art by WIDTH, so this ratio is what sets the drawn height.
    // Compared against the hand-toned cylinder's own extent rather than a bare number, so the
    // thing being protected is legible: a pillar as tall as an interior wall.
    const asTexture = { width: img.width, height: img.height } as unknown as Texture;
    const drawn = pillarArtExtent(80, 70, asTexture);
    const handToned = pillarArtExtent(80, 70);
    expect(Math.abs(drawn.top - handToned.top)).toBeLessThanOrEqual(4);
  });

  it('has a top surface that is the brightest plane on the object', () => {
    const top = patch(0.42, 0.05, 0.16, 0.06);
    for (const [fx, fy] of [[0.08, 0.6], [0.45, 0.6], [0.9, 0.6], [0.45, 0.95]] as const) {
      expect(top).toBeGreaterThan(patch(fx, fy, 0.06, 0.05) + 20);
    }
    // On screen, after the tint: the ~92 design/01 asks for, and above a wall cap's 76-88.
    expect(top * TINT_GAIN).toBeGreaterThan(82);
    expect(top * TINT_GAIN).toBeLessThan(96);
  });

  it('has a shaft in the same tonal family as a WALL FACE, not twice its value', () => {
    // The defect `lumaCurve.mjs` was written for. Measured on screen: wall faces 27.3-27.5,
    // wall base band 14-25 — a pillar's lit limb may sit above a flat face (it is a curved
    // surface turned into the key light) but nowhere near double it, and its dark limb belongs
    // in the wall's own base band.
    const lit = patch(0.06, 0.55, 0.08, 0.14) * TINT_GAIN;
    const mid = patch(0.44, 0.55, 0.08, 0.14) * TINT_GAIN;
    const dark = patch(0.9, 0.55, 0.05, 0.14) * TINT_GAIN;
    expect(lit).toBeGreaterThan(40);
    expect(lit).toBeLessThan(60);
    expect(mid).toBeGreaterThan(30);
    expect(mid).toBeLessThan(45);
    expect(dark).toBeGreaterThan(10);
    expect(dark).toBeLessThan(24);
    // A real cylinder, not a flat panel: lit > mid > dark, with a spread worth having.
    expect(lit).toBeGreaterThan(mid + 8);
    expect(mid).toBeGreaterThan(dark + 8);
  });

  it('carries no base darkening of its own (the renderer draws the contact crease)', () => {
    // Measured 58 vs a 59 shaft on the accepted file: the foot is the same value as the stone
    // above it. If a future file bakes in its own shadow, `buildPillarSprite`'s crease doubles up
    // and the pillar sinks into the floor.
    const foot = patch(0.42, 0.9, 0.16, 0.05);
    const shaftAbove = patch(0.42, 0.55, 0.16, 0.14);
    expect(Math.abs(foot - shaftAbove)).toBeLessThan(8);
  });
});
