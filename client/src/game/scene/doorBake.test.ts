/**
 * `doorBake` — a door surround painted in stone from its chapter's own wall face (2026-10-13).
 *
 * The painter is pure, so these read its pixels directly: the bake keeps the locked art's aspect
 * (the only thing `doorLeaf` reads off a leaf), the stones tile the frame round an opening that is
 * the fire band exactly, the stone is the face's colour with dark joints, an open door's middle is
 * transparent and a locked door's is the shipped fire. The canvas plumbing and the fallbacks to the
 * shipped art go through a fake `DOMAdapter` canvas, as `pillarBake.test.ts` does.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DOMAdapter, Texture, TextureSource } from 'pixi.js';
import type { SwatchMeta } from '../../render/biomeTiles';
import type { Swatch } from './pillarBake';
import {
  DOOR_BAKE_H,
  DOOR_BAKE_PLAN,
  DOOR_BAKE_W,
  doorStones,
  paintStoneDoor,
  resetStoneDoorCache,
  stoneDoorLeaf,
} from './doorBake';
import { FLAME_BAND, OPEN_HOLE } from './doorMotion';

// `swatchMeta` reads a WeakMap that only `loadBiomeTiles` fills; a test texture is tagged here instead.
const meta = vi.hoisted(() => new Map<unknown, SwatchMeta>());
vi.mock('../../render/biomeTiles', async (orig) => ({
  ...(await orig<object>()),
  swatchMeta: (t: unknown) => (t ? meta.get(t) : undefined),
}));

const W = 64;
const SCALE = DOOR_BAKE_W / W;
const H = DOOR_BAKE_H / SCALE;

function swatch(w: number, h: number, rgb: [number, number, number]): Swatch {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
  }
  return { data, width: w, height: h, texelsPerPx: 1 };
}

const FACE = swatch(64, 32, [150, 120, 90]);
const FIRE = swatch(147, 217, [230, 40, 20]);

/** The painted pixel at leaf-local world px (x, y). */
function at(img: { data: Uint8ClampedArray; width: number }, x: number, y: number): number[] {
  const o = (Math.floor(y * SCALE) * img.width + Math.floor(x * SCALE)) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!, img.data[o + 3]!];
}

const inside = (stone: ReturnType<typeof doorStones>[number], x: number, y: number) =>
  stone.every((e) => e.nx * x + e.ny * y <= e.c + 1e-6);

const xl = DOOR_BAKE_PLAN.jambIn * W;
const yl = DOOR_BAKE_PLAN.lintel * H;
const ys = DOOR_BAKE_PLAN.sill * H;
const inOpening = (x: number, y: number, locked: boolean) => x > xl && x < W - xl && y > yl && (!locked || y < ys);

describe('doorBake — the plan', () => {
  it('bakes at the locked art aspect, so the leaf crop and every band rule are unchanged', () => {
    // `door_locked_raw.png` is 147 x 217; `doorLeafFrame` reads only width / height.
    expect(DOOR_BAKE_W / DOOR_BAKE_H).toBeCloseTo(147 / 217, 6);
    const img = paintStoneDoor(FACE, FIRE, true);
    expect([img.width, img.height]).toEqual([DOOR_BAKE_W, DOOR_BAKE_H]);
    expect(paintStoneDoor(FACE, undefined, false).width).toBe(DOOR_BAKE_W);
  });

  it('opens exactly the fire band, and the jambs stand clear of the open hole', () => {
    expect(DOOR_BAKE_PLAN.lintel).toBe(FLAME_BAND.y0);
    expect(DOOR_BAKE_PLAN.sill).toBe(FLAME_BAND.y1);
    expect(DOOR_BAKE_PLAN.jambIn).toBeLessThanOrEqual(OPEN_HOLE.x0);
    expect(1 - DOOR_BAKE_PLAN.jambIn).toBeGreaterThanOrEqual(OPEN_HOLE.x1);
    // The flame overlay is fitted to the band, so the opening must not be narrower than it either.
    expect(DOOR_BAKE_PLAN.jambIn).toBeGreaterThanOrEqual(FLAME_BAND.x0);
  });

  for (const locked of [false, true]) {
    it(`tiles the frame with stones and leaves the opening empty (${locked ? 'locked' : 'open'})`, () => {
      const stones = doorStones(H, locked);
      // Three arch stones, five blocks a jamb, and the sill under a locked slab.
      expect(stones.length).toBe(3 + 10 + (locked ? 1 : 0));
      let checked = 0;
      for (let y = 0.37; y < H; y += 1.13) {
        for (let x = 0.29; x < W; x += 1.07) {
          const n = stones.filter((s) => inside(s, x, y)).length;
          expect(n, `(${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(inOpening(x, y, locked) ? 0 : 1);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(3000);
    });
  }

  it('sets a keystone over the middle of the opening, its joints leaning outward going up', () => {
    const stones = doorStones(H, false);
    expect(inside(stones[1]!, W / 2, yl / 2)).toBe(true);
    // Wider at the top than at the lintel's underside: a flat arch, not a slot.
    const span = (y: number) => {
      let n = 0;
      for (let x = 0; x < W; x += 0.05) if (inside(stones[1]!, x, y)) n++;
      return n;
    };
    expect(span(0.5)).toBeGreaterThan(span(yl - 0.5));
  });
});

describe('paintStoneDoor — the pixels', () => {
  it('paints the stone in the face colour, with dark joints between the jamb blocks', () => {
    const img = paintStoneDoor(FACE, undefined, false);
    const bh = (H - yl) / 5;
    const mid = at(img, xl / 2, yl + bh / 2);
    expect(mid[3]).toBe(255);
    for (let q = 0; q < 3; q++) expect(Math.abs(mid[q]! / FACE.data[q]! - 1)).toBeLessThan(0.15);
    // On the joint between the first and second blocks: mortar, like the face's own courses.
    const joint = at(img, xl / 2, yl + bh);
    expect(joint[0]!).toBeLessThan(mid[0]! * 0.7);
  });

  it('leaves an open door transparent in the middle, with a dark line where stone meets it', () => {
    const img = paintStoneDoor(FACE, undefined, false);
    expect(at(img, W / 2, H * 0.5)[3]).toBe(0);
    expect(at(img, W / 2, H - 0.5)[3]).toBe(0);
    // Stone right at the opening's edge carries the walls' silhouette colour, deeper in it does not.
    const edge = at(img, xl - 0.2, H * 0.5);
    const deep = at(img, xl - 3, H * 0.5);
    expect(edge[3]).toBe(255);
    expect(edge[0]!).toBeLessThan(deep[0]! * 0.7);
    // Darker than the joint alone makes it (`JOINT_SHADE`, half the stone): the silhouette line.
    expect(edge[0]!).toBeLessThan(FACE.data[0]! * 0.4);
    // The frame's own corners are solid: the fixture's silhouette is the whole leaf.
    expect(at(img, 0.1, 0.1)[3]).toBe(255);
    expect(at(img, W - 0.1, H - 0.1)[3]).toBe(255);
  });

  it('fills a locked door with the shipped fire and closes it with a sill stone', () => {
    const img = paintStoneDoor(FACE, FIRE, true);
    expect(at(img, W / 2, H * 0.5)).toEqual([230, 40, 20, 255]);
    const sill = at(img, W / 2, (ys + H) / 2);
    expect(sill[3]).toBe(255);
    expect(sill[0]!).toBeLessThan(200);
    expect(sill[1]!).toBeGreaterThan(80);
  });

  it('fills only a locked door: no panel leaves it open, and an open door ignores its panel', () => {
    expect(at(paintStoneDoor(FACE, undefined, true), W / 2, H * 0.5)[3]).toBe(0);
    expect(at(paintStoneDoor(FACE, FIRE, false), W / 2, H * 0.5)[3]).toBe(0);
  });
});

describe('stoneDoorLeaf — fallbacks and the canvas plumbing', () => {
  afterEach(() => {
    resetStoneDoorCache();
    meta.clear();
  });

  function textureWithResource(w: number, h: number): Texture {
    const t = new Texture({ source: new TextureSource({ width: w, height: h }) });
    (t.source as unknown as { resource: unknown }).resource = { width: w, height: h };
    return t;
  }

  function stoneFace(): Texture {
    const t = textureWithResource(64, 32);
    meta.set(t, { density: 1, seamless: true, authoredTone: true });
    return t;
  }

  function withFakeCanvas<T>(fn: (made: Array<{ width: number; height: number }>) => T, ctxOk = true): T {
    const made: Array<{ width: number; height: number }> = [];
    const adapter = DOMAdapter.get();
    DOMAdapter.set({
      ...adapter,
      createCanvas: (w = 0, h = 0) => {
        made.push({ width: w, height: h });
        return {
          width: w,
          height: h,
          getContext: () => (ctxOk
            ? {
                drawImage: () => undefined,
                getImageData: (_x: number, _y: number, cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4).fill(128) }),
                createImageData: (cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }),
                putImageData: () => undefined,
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

  it('keeps the shipped art with no face, a first-generation face, or a locked door with no fire', () => {
    const shipped = textureWithResource(147, 217);
    const plain = textureWithResource(64, 32);
    withFakeCanvas((made) => {
      expect(stoneDoorLeaf(undefined, shipped, true)).toBe(shipped);
      expect(stoneDoorLeaf(plain, shipped, false)).toBe(shipped);
      expect(stoneDoorLeaf(stoneFace(), undefined, true)).toBeUndefined();
      expect(made.length).toBe(0);
    });
  });

  it('bakes one leaf per face and state, at the bake size, and memoises it', () => {
    const face = stoneFace();
    const locked = textureWithResource(147, 217);
    const open = textureWithResource(156, 224);
    withFakeCanvas((made) => {
      const a = stoneDoorLeaf(face, locked, true)!;
      expect(a).not.toBe(locked);
      expect(a.label).toBe(`stone-door:${face.uid}:${locked.uid}`);
      expect(a.source.autoGenerateMipmaps).toBe(true);
      expect(made.at(-1)).toEqual({ width: DOOR_BAKE_W, height: DOOR_BAKE_H });
      const n = made.length;
      expect(stoneDoorLeaf(face, locked, true)).toBe(a);
      expect(made.length).toBe(n);
      // The open leaf ignores its shipped art (the opening is transparent), so it is one bake per face.
      const b = stoneDoorLeaf(face, open, false)!;
      expect(b).not.toBe(a);
      expect(b.label).toBe(`stone-door:${face.uid}:open`);
      expect(stoneDoorLeaf(face, undefined, false)).toBe(b);
    });
  });

  it('keeps the shipped art, and probes once, where there is no 2D context', () => {
    const face = stoneFace();
    const shipped = textureWithResource(147, 217);
    withFakeCanvas((made) => {
      expect(stoneDoorLeaf(face, shipped, true)).toBe(shipped);
      const probes = made.length;
      expect(stoneDoorLeaf(face, shipped, true)).toBe(shipped);
      expect(made.length).toBe(probes);
    }, false);
  });

  it('keeps the shipped art where the face reads but the fire does not, or the canvas throws', () => {
    const face = stoneFace();
    const empty = new Texture({ source: new TextureSource({ width: 147, height: 217 }) });
    withFakeCanvas(() => expect(stoneDoorLeaf(face, empty, true)).toBe(empty));
    resetStoneDoorCache();
    const shipped = textureWithResource(147, 217);
    const adapter = DOMAdapter.get();
    let calls = 0;
    withFakeCanvas(() => {
      const fake = DOMAdapter.get();
      DOMAdapter.set({
        ...fake,
        createCanvas: (w?: number, h?: number) => {
          // The two swatch reads succeed; the bake's own canvas throws.
          if (++calls > 2) throw new Error('canvas lost');
          return fake.createCanvas(w, h);
        },
      });
      expect(stoneDoorLeaf(face, shipped, true)).toBe(shipped);
    });
    expect(DOMAdapter.get()).toBe(adapter);
  });
});
