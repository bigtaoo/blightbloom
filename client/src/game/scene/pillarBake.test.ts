/**
 * `pillarBake` — a warm-stone pillar painted from its chapter's own wall art (2026-10-12).
 *
 * The painter is pure, so these read its pixels directly: the box it fills is the sprite box the
 * occlusion x-ray measures, the courses follow the drum, the drum is lit from the west, the top is
 * the wall-top stone and closes the drum, and the foot carries the walls' contact crease. The
 * canvas plumbing is exercised through a fake `DOMAdapter` canvas, the way `capLight.test.ts` does
 * it, because this repo's vitest has no 2D canvas.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DOMAdapter, Texture, TextureSource } from 'pixi.js';
import {
  bakeStonePillar,
  drumShade,
  paintStonePillar,
  PILLAR_BAKE_SCALE,
  resetStonePillarCache,
  type PillarShape,
  type Swatch,
} from './pillarBake';
import { PILLAR_BASE_PX, pillarArtExtent, pillarCapRadii, pillarSpriteMetrics } from './pillarRender';
import { BASE_AO_MAX } from './wallTone';

const BODY_W = 80;
const HEIGHT = 70;
const { capRx, capRy } = pillarCapRadii(BODY_W);
const SHAPE: PillarShape = { bodyW: BODY_W, height: HEIGHT, capRx, capRy, basePx: PILLAR_BASE_PX };
const S = PILLAR_BAKE_SCALE;

/** A flat swatch of one colour, optionally with dark rows (a horizontal joint) at `darkRows`. */
function swatch(w: number, h: number, rgb: [number, number, number], texelsPerPx: number, darkRows: number[] = []): Swatch {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const dark = darkRows.includes(y);
      data[o] = dark ? 10 : rgb[0];
      data[o + 1] = dark ? 10 : rgb[1];
      data[o + 2] = dark ? 10 : rgb[2];
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h, texelsPerPx };
}

const FACE = swatch(64, 32, [120, 100, 80], 1);
const CAP = swatch(32, 32, [60, 70, 200], 4);

/** The painted pixel at world-local (x, y) — origin at the pillar's ground point. */
function at(img: { data: Uint8ClampedArray; width: number }, x: number, y: number): number[] {
  const i = Math.floor((x + capRx) * S);
  const j = Math.floor((y + HEIGHT + capRy) * S);
  const o = (j * img.width + i) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
}

describe('paintStonePillar — the box', () => {
  it('fills exactly the sprite box the x-ray measures a pillar texture by', () => {
    // `pillarArtExtent` reads the box off the texture's aspect, so a bake at a different aspect
    // would fade the pillar for a character it does not cover.
    const img = paintStonePillar(FACE, CAP, SHAPE);
    expect(img.width).toBe(Math.round(capRx * 2 * S));
    expect(img.height).toBe(Math.round((HEIGHT + capRy + PILLAR_BASE_PX) * S));
    const tex = new Texture({ source: new TextureSource({ width: img.width, height: img.height }) });
    const { w, h } = pillarSpriteMetrics(BODY_W, tex);
    expect(w).toBeCloseTo(capRx * 2, 6);
    expect(h).toBeCloseTo(HEIGHT + capRy + PILLAR_BASE_PX, 0);
    expect(pillarArtExtent(BODY_W, HEIGHT, tex).top).toBeCloseTo(-(HEIGHT + capRy), 0);
  });

  it('is transparent outside the drum: the corners, and past either limb', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    expect(img.data[3]).toBe(0);
    expect(img.data[(img.width - 1) * 4 + 3]).toBe(0);
    expect(img.data[((img.height - 1) * img.width) * 4 + 3]).toBe(0);
    // Mid-shaft, just past the shaft's own radius but inside the cap's overhang.
    expect(at(img, BODY_W / 2 + 1.5, -HEIGHT / 2)[3]).toBe(0);
    expect(at(img, -BODY_W / 2 - 1.5, -HEIGHT / 2)[3]).toBe(0);
    // ...and opaque on it.
    expect(at(img, 0, -HEIGHT / 2)[3]).toBe(255);
  });

  it('curves the foot with the drum: the limbs end higher than the centre', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const limbX = BODY_W / 2 - 2;
    expect(at(img, 0, PILLAR_BASE_PX - 1)[3]).toBe(255);
    // A flat foot (the sprite path's crease rect) would be opaque here too.
    expect(at(img, limbX, PILLAR_BASE_PX - 1)[3]).toBe(0);
  });
});

describe('paintStonePillar — the courses follow the drum', () => {
  it('drops a joint by capRy * cos(theta): lowest at the centre, rising toward the limbs', () => {
    // A single dark course joint across the whole face. On a straight-across mapping it would sit
    // on one canvas row at every column — the flat panel the 2026-08-18 attempt read as.
    const face = swatch(64, 32, [120, 100, 80], 1, [16]);
    const img = paintStonePillar(face, CAP, SHAPE);
    const jointRow = (lx: number): number => {
      const i = Math.floor((lx + capRx) * S);
      let best = -1;
      let bestL = Infinity;
      for (let j = Math.floor((capRy * 2) * S); j < img.height; j++) {
        const o = (j * img.width + i) * 4;
        if (img.data[o + 3]! < 255) continue;
        const l = img.data[o]! + img.data[o + 1]! + img.data[o + 2]!;
        if (l < bestL) { bestL = l; best = j; }
      }
      return best / S;
    };
    const centre = jointRow(0);
    const side = jointRow(BODY_W * 0.4);
    const theta = Math.asin(0.8);
    expect(centre - side).toBeCloseTo(capRy * (1 - Math.cos(theta)), 0);
    expect(centre).toBeGreaterThan(side);
  });

  it('unrolls the face around the drum rather than squeezing it: the face repeats by arc length', () => {
    // Vertical stripes in RED only, every 8 texels, over a constant green: red/green is then the
    // face's own pattern with the drum's shading divided out. Equal arc steps project to screen
    // steps of r·Δθ·cos θ, so the stripes crowd toward the limbs — and a half drum shows π/2 times
    // more of the face than its width would.
    const data = new Uint8ClampedArray(64 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      data[o] = x % 8 < 2 ? 0 : 200; data[o + 1] = 200; data[o + 2] = 200; data[o + 3] = 255;
    }
    const img = paintStonePillar({ data, width: 64, height: 32, texelsPerPx: 1 }, CAP, SHAPE);
    const y = -HEIGHT * 0.4;
    const dips: number[] = [];
    let prev = 1;
    for (let x = -BODY_W / 2 + 3; x < BODY_W / 2 - 3; x += 1 / S) {
      const p = at(img, x, y);
      const ratio = p[0]! / Math.max(1, p[1]!);
      if (ratio < 0.6 && prev >= 0.6) dips.push(x);
      prev = ratio;
    }
    const gaps = dips.slice(1).map((d, k) => d - dips[k]!);
    const central = gaps[Math.floor(gaps.length / 2)]!;
    expect(gaps.length).toBeGreaterThan(3);
    expect(central).toBeGreaterThan(gaps[0]! * 1.3);
    expect(central).toBeGreaterThan(gaps[gaps.length - 1]! * 1.3);
  });
});

describe('paintStonePillar — the light', () => {
  it('lights the west limb, keeps the face value at the terminator and darkens the east limb', () => {
    expect(drumShade(0)).toBeGreaterThan(1);
    expect(drumShade(0.36)).toBeCloseTo(1, 9);
    expect(drumShade(1)).toBeLessThan(0.5);
    for (let t = 0.02; t <= 1; t += 0.02) expect(drumShade(t)).toBeLessThanOrEqual(drumShade(t - 0.02) + 1e-12);
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const y = -HEIGHT * 0.5;
    const west = at(img, -BODY_W * 0.3, y)[1]!;
    const mid = at(img, -BODY_W * 0.1, y)[1]!;
    const east = at(img, BODY_W * 0.4, y)[1]!;
    expect(west).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(east);
  });

  it('carries the walls\' contact crease along the curved foot', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const shaft = at(img, -BODY_W * 0.1, -HEIGHT * 0.6)[1]!;
    const foot = at(img, -BODY_W * 0.1, PILLAR_BASE_PX - 2)[1]!;
    expect(foot).toBeLessThan(shaft);
    expect(foot).toBeGreaterThan(shaft * (1 - BASE_AO_MAX) - 6);
  });

  it('darkens both silhouette limbs toward the walls\' edge colour', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const y = -HEIGHT * 0.5;
    expect(at(img, -BODY_W / 2 + 0.3, y)[1]!).toBeLessThan(at(img, -BODY_W / 2 + 3, y)[1]!);
  });
});

describe('paintStonePillar — the top', () => {
  it('is the wall-top stone, lifted a little, and covers the shaft\'s upper edge', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const centre = at(img, 0, -HEIGHT);
    // The cap swatch is blue, the face warm: the top is the cap's colour, not the face's.
    expect(centre[2]!).toBeGreaterThan(centre[0]! * 2);
    expect(centre[2]!).toBeGreaterThan(200);
    // Just inside the front rim, where the shaft's top course would show on a drum without a lid.
    const front = at(img, 0, -HEIGHT + capRy - 3);
    expect(front[2]!).toBeGreaterThan(front[0]!);
  });

  it('lights the back rim (the coping) and leaves the front rim dark', () => {
    const img = paintStonePillar(FACE, CAP, SHAPE);
    const back = at(img, 0, -HEIGHT - capRy + 1.25);
    const front = at(img, 0, -HEIGHT + capRy - 1.25);
    const centre = at(img, 0, -HEIGHT);
    expect(back[0]!).toBeGreaterThan(centre[0]!);
    expect(front[0]!).toBeLessThanOrEqual(centre[0]!);
  });
});

describe('bakeStonePillar — the canvas plumbing', () => {
  afterEach(() => resetStonePillarCache());

  function textureWithResource(w: number, h: number): Texture {
    const t = new Texture({ source: new TextureSource({ width: w, height: h }) });
    (t.source as unknown as { resource: unknown }).resource = { width: w, height: h };
    return t;
  }

  /** A fake 2D canvas behind `DOMAdapter`, as on the WeChat runtime. Returns the canvases made. */
  function withFakeCanvas<T>(fn: (made: Array<{ width: number; height: number; put: number }>) => T, ctxOk = true): T {
    const made: Array<{ width: number; height: number; put: number }> = [];
    const adapter = DOMAdapter.get();
    DOMAdapter.set({
      ...adapter,
      createCanvas: (w = 0, h = 0) => {
        const rec = { width: w, height: h, put: 0 };
        made.push(rec);
        return {
          width: w,
          height: h,
          getContext: () => (ctxOk
            ? {
                drawImage: () => undefined,
                getImageData: (_x: number, _y: number, cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4).fill(128) }),
                createImageData: (cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }),
                putImageData: () => { rec.put++; },
              }
            : null),
        } as unknown as HTMLCanvasElement;
      },
    });
    try {
      return fn(made);
    } finally {
      DOMAdapter.set(adapter);
    }
  }

  it('reads both swatches, paints the pillar onto a canvas the size of the sprite box, and memoises it', () => {
    const face = textureWithResource(64, 32);
    const cap = textureWithResource(32, 32);
    withFakeCanvas((made) => {
      const a = bakeStonePillar(face, cap, 4, SHAPE)!;
      expect(a).toBeDefined();
      expect(made.map((m) => [m.width, m.height])).toEqual([
        [64, 32],
        [32, 32],
        [Math.round(capRx * 2 * S), Math.round((HEIGHT + capRy + PILLAR_BASE_PX) * S)],
      ]);
      expect(made[2]!.put).toBe(1);
      // A sprite minified ~2x on screen needs its mips, like the shipped pillar sprite.
      expect(a.source.autoGenerateMipmaps).toBe(true);
      expect(a.label).toContain('stone-pillar:');
      // One bake per (face, cap, shape), however many pillars and rooms use it.
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBe(a);
      expect(made.length).toBe(3);
      // A different shape is a different bake.
      expect(bakeStonePillar(face, cap, 4, { ...SHAPE, height: 50 })).not.toBe(a);
    });
  });

  it('returns undefined, and remembers it, where there is no 2D context', () => {
    const face = textureWithResource(64, 32);
    const cap = textureWithResource(32, 32);
    withFakeCanvas((made) => {
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBeUndefined();
      const probes = made.length;
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBeUndefined();
      expect(made.length).toBe(probes);
    }, false);
  });

  it('returns undefined for a texture with no pixels behind it, without touching a canvas', () => {
    const empty = new Texture({ source: new TextureSource({ width: 64, height: 32 }) });
    const cap = textureWithResource(32, 32);
    withFakeCanvas((made) => {
      expect(bakeStonePillar(empty, cap, 4, SHAPE)).toBeUndefined();
      expect(made.length).toBe(0);
    });
  });

  it('returns undefined where the canvas throws (a tainted source, a canvas-free host)', () => {
    const face = textureWithResource(64, 32);
    const cap = textureWithResource(32, 32);
    const adapter = DOMAdapter.get();
    DOMAdapter.set({ ...adapter, createCanvas: () => { throw new Error('no canvas'); } });
    try {
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBeUndefined();
    } finally {
      DOMAdapter.set(adapter);
    }
  });

  it('returns undefined where the output canvas has no context though the reads succeeded', () => {
    const face = textureWithResource(64, 32);
    const cap = textureWithResource(32, 32);
    const adapter = DOMAdapter.get();
    let n = 0;
    DOMAdapter.set({
      ...adapter,
      createCanvas: (w = 0, h = 0) => ({
        width: w,
        height: h,
        getContext: () => (n++ < 2
          ? { drawImage: () => undefined, getImageData: (_x: number, _y: number, cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }) }
          : null),
      }) as unknown as HTMLCanvasElement,
    });
    try {
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBeUndefined();
      expect(n).toBe(3);
    } finally {
      DOMAdapter.set(adapter);
    }
  });

  it('returns undefined where writing the painted pixels throws', () => {
    const face = textureWithResource(64, 32);
    const cap = textureWithResource(32, 32);
    const adapter = DOMAdapter.get();
    DOMAdapter.set({
      ...adapter,
      createCanvas: (w = 0, h = 0) => ({
        width: w,
        height: h,
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: (_x: number, _y: number, cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }),
          createImageData: () => { throw new Error('out of memory'); },
        }),
      }) as unknown as HTMLCanvasElement,
    });
    try {
      expect(bakeStonePillar(face, cap, 4, SHAPE)).toBeUndefined();
    } finally {
      DOMAdapter.set(adapter);
    }
  });
});
