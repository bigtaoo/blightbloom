/**
 * Which shipped textures survive a WebGL1 context, and which quietly do not.
 *
 * design/04's verification checklist item 4 ("Verify WebGL2 availability; define a fallback
 * path if unavailable") has always been phrased as a device question. It is not only that:
 * Pixi already HAS the fallback, it just applies it silently, and what it costs depends
 * entirely on the shipped art's dimensions. Two rules in
 * pixi.js/lib/rendering/renderers/gl/texture/GlTextureSystem.mjs:
 *
 *   - line 148: `autoGenerateMipmaps && (context.supports.nonPowOf2mipmaps || isPowerOfTwo)`
 *   - line 180: `forceClamp = !context.supports.nonPowOf2wrapping && !isPowerOfTwo`
 *
 * and GlContextSystem.mjs:228 sets BOTH `nonPowOf2*` flags to `isWebGl2`. So on a WebGL1
 * device every non-power-of-two texture silently loses the mip chain it asked for, and every
 * non-power-of-two texture that asked to WRAP is clamped instead.
 *
 * Neither failure throws, logs, or shows up in any existing test. The first one reproduces
 * the 2026-08-12 "can't tell what this character is" colour-noise bug (design/12); the second
 * turns a tiling swatch into one tile plus a smear of its last column.
 *
 * This file pins the wrapping half, which is small, stable, and where a regression would be
 * most visible. The mipmap half is deliberately NOT pinned by a count — essentially all sprite
 * art is non-power-of-two today and making it otherwise means padding every file and moving
 * every anchor with it, which is an art pass, not a test. It is written down in design/04
 * instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BIOME_TILE_ASSETS } from './biomeTiles';

const PUBLIC = new URL('../../public/', import.meta.url);

/** A PNG's IHDR, or a JPEG's first start-of-frame marker (the warm-stone swatches are JPEG). */
function dimensions(webPath: string): { width: number; height: number } {
  const buf = readFileSync(new URL(webPath.slice(1), PUBLIC));
  if (!webPath.endsWith('.jpg')) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  let o = 2;
  while (o < buf.length) {
    const marker = buf[o + 1]!;
    // SOF0-SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(o + 7), height: buf.readUInt16BE(o + 5) };
    }
    o += 2 + buf.readUInt16BE(o + 2);
  }
  throw new Error(`${webPath}: no JPEG frame header`);
}

const isPot = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/** The keys biomeTiles.ts gives `addressMode: 'repeat'` — everything except its `SPRITE_KEYS`.
 *  Derived from the shipped table rather than re-listed, so a new swatch is covered the day
 *  it is added. */
const TILED_KEYS = Object.keys(BIOME_TILE_ASSETS).filter((k) => !k.startsWith('pillar_'));

describe('WebGL1 fallback — a wrapping texture must be power-of-two', () => {
  it('found the tiled swatches, and they are the only textures asking to wrap', () => {
    // 5 elements x floor/wall/wallface. A regression that stopped tagging swatches as
    // tileable would leave this list short and every assertion below vacuous.
    expect(TILED_KEYS.length).toBe(15);
  });

  it('every floor and wall swatch is power-of-two on both axes', () => {
    for (const key of TILED_KEYS.filter((k) => !k.startsWith('wallface_'))) {
      const { width, height } = dimensions(BIOME_TILE_ASSETS[key]);
      expect(isPot(width), `${key} is ${width}px wide`).toBe(true);
      expect(isPot(height), `${key} is ${height}px tall`).toBe(true);
    }
  });

  it('names exactly the wall faces that would stop tiling on WebGL1', () => {
    // A KNOWN GAP, pinned rather than fixed. These four were authored at 125-127 px tall and
    // their crown rows are measured against that exact height (wallTone.ts's
    // FACE_CROWN_ROWS), so padding them to 128 is an art change with a measured table behind
    // it — not something to do as a side effect of a packaging pass. `wallface_poison` is
    // already 256x128 and shows the fix is only ever one row.
    //
    // Shrinking this list is the fix. Growing it means a new swatch shipped non-power-of-two
    // without anyone deciding to, which is the whole point of asserting the exact set.
    const broken = TILED_KEYS.filter((k) => k.startsWith('wallface_')).filter((k) => {
      const { width, height } = dimensions(BIOME_TILE_ASSETS[k]);
      return !isPot(width) || !isPot(height);
    });
    // `wallface_fire` left the list on 2026-10-10 (the warm-stone face shipped at 512x256), and
    // ice and lightning the same day, when their chapters moved to warm stone too.
    expect(broken.sort()).toEqual(['wallface_neutral']);
  });

  it('wall faces tile horizontally, so their WIDTH is the axis that matters, and it is clean', () => {
    // The height is used at exactly one value (WALL_HEIGHT) and never repeated vertically
    // (biomeTiles.ts), so the horizontal repeat is the one the gap above actually costs —
    // and WebGL1's clamp applies to both axes regardless of which one we meant to wrap.
    for (const key of TILED_KEYS.filter((k) => k.startsWith('wallface_'))) {
      expect(isPot(dimensions(BIOME_TILE_ASSETS[key]).width), `${key} width`).toBe(true);
    }
  });
});
