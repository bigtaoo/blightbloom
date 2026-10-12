// A warm-stone pillar, painted once per chapter out of that chapter's own WALL art (2026-10-12):
// the shaft from the wall face, the top from the wall top's stone laid as a ring of coping round a
// centre slab (`capMasonry`). Sibling of `pillarRender.ts`, which
// draws the result as an ordinary sprite.
//
// Why: the pillar sprite (`biome/pillar_neutral.png`, 2026-08-20) was authored for the first-
// generation charcoal walls. When every chapter moved to warm stone (2026-10-10) the walls, the
// floor and the face were all redrawn and the pillar was not, so a warm-stone room stood a smooth
// charcoal drum (median luma 43, almost no texture) beside a painted brick wall (92-100): two
// materials, one of them from the previous art direction, and the same file in all four chapters.
// Painting the pillar from the wall art makes the match true by construction, in every chapter,
// with no new art to generate.
//
// What the 2026-08-18 attempt at texturing pillars from the wall swatches got wrong, and what this
// does instead (`pillarRender.buildPillarBody`'s doc has that history):
//   * it windowed a 256 px swatch through a ~35 px TilingSprite, so the cap was one arbitrary dark
//     patch. Here the swatches are 512 px warm-stone art sampled at the scale the walls use.
//   * the brick ran straight across a round shaft, which read as a flat panel or an open-topped
//     well. Here every course follows the drum: the shaft is unrolled around the cylinder (a column
//     at angle θ samples arc length r·θ) and each column is dropped by `capRy·cos θ`, so the joints
//     sag toward the viewer exactly as the top ellipse does, and the bottom edge curves with them.
//
// The face is mapped onto the shaft at the same vertical scale a wall uses, its top course under
// the cap and its dark base at the foot, so a pillar's courses sit level with the wall beside it.
// The shading across the drum, the silhouette and the coping are the walls' own numbers
// (`wallTone.ts`), and the contact crease is painted into the art rather than drawn over it: a
// cylinder's foot curves, and the flat crease rect the sprite path draws would hang below it at
// both limbs.
import { CanvasSource, DOMAdapter, Texture } from 'pixi.js';
import type { ICanvasRenderingContext2D } from 'pixi.js';
import { BASE_AO_FRACTION, BASE_AO_MAX, COPING_ALPHA, EDGE_ALPHA, EDGE_COLOR, EDGE_WIDTH } from './wallTone';

/** Texels per world px. The camera reaches ~2.1x, and an object sprite wants headroom past that
 *  (the 2026-08-12 rig lesson): the shipped pillar sprite is 326 px for an ~84 px pillar, ~3.9. */
export const PILLAR_BAKE_SCALE = 4;

/** Brightness across the drum, as a multiply on the face's own painted value: lit at the west
 *  limb, the face's own value at the terminator, falling to `DARK_LIMB` at the east limb. The
 *  same terminator and the same lit-from-upper-left direction as the hand-toned cylinder
 *  (`pillarRender.PILLAR_TERMINATOR`), with the ratios its tones carry (lit/mid 1.17, dark/mid
 *  0.3) eased a little, because painted stone already carries its own shading. */
const LIT_LIMB = 1.12;
const TERMINATOR = 0.36;
const DARK_LIMB = 0.4;
/** The top, relative to the wall-top swatch. A wall cap reads against the face below it through
 *  the coping and the fold line; a round top has only its rim, so it is lifted slightly to stay a
 *  closed surface rather than a dark opening (the "open-topped well" of 2026-08-18). */
const TOP_LIFT = 1.15;

/** The top's own masonry (2026-10-12), in the top's PLAN (the circle before it is foreshortened):
 *  a ring of `CAP_STONES` wedge-shaped coping stones round one round centre slab, like the capital
 *  of a built column. Until then the top was the wall-top swatch squeezed into the ellipse, and
 *  its square blocks read as a patch of wall top cut out with a cookie cutter. The stones still
 *  carry the wall top's own paint (sampled as before), so the material stays the chapter's.
 *  Eight stones on a ~42 px top make each one about twice as long as the ring is wide: the
 *  proportions of the wall's blocks. */
const CAP_STONES = 8;
/** The centre slab's radius, as a fraction of the top's. */
const CAP_INNER = 0.56;
/** Half a joint's width, world px in plan. */
const CAP_JOINT = 0.55;
/** A joint's value, as a multiply on the stone either side: as soft as the calmer walls' joints
 *  (0.63-0.79 of their courses, `wallTone.FACE_CROWN_ROWS`). */
const CAP_JOINT_SHADE = 0.66;
/** Each stone's bevel: how far in from a joint it reaches (world px in plan) and how much it
 *  lifts the edge that faces the key light and drops the one facing away. */
const CAP_BEVEL = 1.6;
const CAP_BEVEL_LIFT = 0.22;
/** How far one stone's tone may sit from another's, so the ring reads as separate stones. */
const CAP_TONE_SPREAD = 0.07;
/** The key light's direction in the top's plan: from the upper left, the walls' own (north-west,
 *  with north up the screen). */
const LIGHT_X = -Math.SQRT1_2;
const LIGHT_Z = -Math.SQRT1_2;

/** How much of the wall top's painted grain each top stone keeps, and the floor under it: a texel
 *  darker than `CAP_GRAIN_FLOOR` of the stone's value is one of the wall top's own joints, which
 *  would draw a second, square masonry through the ring's. */
const CAP_GRAIN = 0.5;
const CAP_GRAIN_FLOOR = 0.92;

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The wall top's STONE, without its joints: the mean colour of its texels at or above the median
 *  luma (the block faces; the joints are the dark tail), and that median. */
export function capStoneColour(cap: Swatch): { rgb: [number, number, number]; luma: number } {
  const n = cap.width * cap.height;
  const ls = new Float32Array(n);
  for (let i = 0; i < n; i++) ls[i] = luma(cap.data[i * 4]!, cap.data[i * 4 + 1]!, cap.data[i * 4 + 2]!);
  const median = Float32Array.from(ls).sort()[n >> 1]!;
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (ls[i]! < median) continue;
    for (let k = 0; k < 3; k++) sum[k]! += cap.data[i * 4 + k]!;
    count++;
  }
  const rgb = sum.map((v) => v / count) as [number, number, number];
  return { rgb, luma: luma(...rgb) };
}

/** A stable tone per stone, in [-1, 1]: a small integer hash, no `Math.random`. */
function stoneTone(k: number): number {
  const h = Math.imul(k + 1, 0x9e3779b1) >>> 0;
  return ((h >>> 8) % 1000) / 500 - 1;
}

/**
 * The top's masonry at one point of its plan: a multiply for the stone's paint there, combining
 * the joints, each stone's bevel and its own tone. `x`/`z` are world px from the top's centre in
 * plan (`z` positive toward the viewer), `radius` the top's. Exported for the test.
 */
export function capMasonry(x: number, z: number, radius: number, scale = PILLAR_BAKE_SCALE): number {
  const rho = Math.hypot(x, z);
  const inner = radius * CAP_INNER;
  // Toward the light is "lit": a bevel whose outward normal points at the light lifts.
  const bevel = (dist: number, nx: number, nz: number) =>
    CAP_BEVEL_LIFT * (nx * LIGHT_X + nz * LIGHT_Z) * clamp01(1 - dist / CAP_BEVEL);
  // Distance to the nearest joint, and the shade of the bevel beside it.
  let joint: number;
  let shade: number;
  let tone: number;
  if (rho < inner) {
    // The centre slab: one stone, its only edge the ring joint.
    joint = inner - rho;
    const n = rho > 1e-6 ? 1 / rho : 0;
    shade = bevel(joint, x * n, z * n);
    tone = stoneTone(CAP_STONES);
  } else {
    const phi = Math.atan2(z, x);
    const step = (Math.PI * 2) / CAP_STONES;
    // Rotated half a stone so no joint runs straight down the middle toward the viewer.
    const a = phi / step + 0.5;
    const k = ((Math.floor(a) % CAP_STONES) + CAP_STONES) % CAP_STONES;
    const f = a - Math.floor(a);
    // Arc distance to the two radial joints, and to the ring joint inside.
    const toPrev = f * step * rho;
    const toNext = (1 - f) * step * rho;
    const toRing = rho - inner;
    joint = Math.min(toPrev, toNext, toRing);
    // Outward normals of the stone's three inner edges, in plan.
    const t0 = (Math.floor(a) - 0.5) * step;
    const t1 = t0 + step;
    shade =
      bevel(toPrev, Math.sin(t0), -Math.cos(t0)) +
      bevel(toNext, -Math.sin(t1), Math.cos(t1)) +
      bevel(toRing, -x / rho, -z / rho);
    tone = stoneTone(k);
  }
  const line = clamp01((CAP_JOINT - joint) * scale + 0.5);
  const stone = (1 + shade) * (1 + CAP_TONE_SPREAD * tone);
  return stone + (CAP_JOINT_SHADE - stone) * line;
}

/** RGBA pixels of a swatch, plus how many of its texels make one world px. */
export interface Swatch {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly texelsPerPx: number;
}

/** The pillar's shape in world px, matching `pillarRender`'s sprite box: `capRx`/`capRy` are the
 *  top ellipse, `basePx` how far the art reaches below the ground point. */
export interface PillarShape {
  readonly bodyW: number;
  readonly height: number;
  readonly capRx: number;
  readonly capRy: number;
  readonly basePx: number;
}

/** Bilinear sample, wrapping horizontally; `wrapY` wraps vertically too, else clamps. */
function sample(s: Swatch, u: number, v: number, wrapY: boolean, out: number[]): void {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const wx = (x: number) => ((x % s.width) + s.width) % s.width;
  const wy = (y: number) => (wrapY ? ((y % s.height) + s.height) % s.height : Math.min(s.height - 1, Math.max(0, y)));
  const a = (wy(y0) * s.width + wx(x0)) * 4;
  const b = (wy(y0) * s.width + wx(x0 + 1)) * 4;
  const c = (wy(y0 + 1) * s.width + wx(x0)) * 4;
  const d = (wy(y0 + 1) * s.width + wx(x0 + 1)) * 4;
  for (let k = 0; k < 3; k++) {
    const top = s.data[a + k]! * (1 - fx) + s.data[b + k]! * fx;
    const bot = s.data[c + k]! * (1 - fx) + s.data[d + k]! * fx;
    out[k] = top * (1 - fy) + bot * fy;
  }
}

/** Brightness multiplier at `t` across the shaft (0 = west limb, 1 = east limb). */
export function drumShade(t: number): number {
  if (t <= TERMINATOR) return LIT_LIMB + (1 - LIT_LIMB) * (t / TERMINATOR);
  const k = (t - TERMINATOR) / (1 - TERMINATOR);
  const eased = k * k * (3 - 2 * k);
  return 1 + (DARK_LIMB - 1) * eased;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const EDGE: readonly number[] = [(EDGE_COLOR >> 16) & 0xff, (EDGE_COLOR >> 8) & 0xff, EDGE_COLOR & 0xff];

/**
 * Paint the pillar into premultiplied-free RGBA bytes, `width x height` at `scale` texels per
 * world px. Pure: no canvas, so the geometry is testable headless. The canvas row 0 is world
 * `-(height + capRy)` above the ground point and the last row is `basePx` below it — the box
 * `pillarRender.pillarSpriteMetrics` reports for a texture of this aspect.
 */
export function paintStonePillar(
  face: Swatch,
  cap: Swatch,
  p: PillarShape,
  scale = PILLAR_BAKE_SCALE,
): { data: Uint8ClampedArray; width: number; height: number } {
  const width = Math.round(p.capRx * 2 * scale);
  const height = Math.round((p.height + p.capRy + p.basePx) * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  const r = p.bodyW / 2;
  // The face spans the shaft's full column, top course to dark base, at the wall's vertical scale
  // (`wallRender.addFacePiece`: the face's height is the wall's height). A column of the drum is
  // `height + basePx - capRy` tall at every angle (see the module header), so this is ~5% taller
  // than a wall: the same courses, a hair larger.
  const colH = p.height + p.basePx - p.capRy;
  const faceTexelsPerPx = face.height / colH;
  // Start the unrolled face part-way along, so the drum's centre line is not a tile seam.
  const uOffset = face.width * 0.37;
  const aoH = p.height * BASE_AO_FRACTION;
  const stone = capStoneColour(cap);
  const px: number[] = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    const ly = (j + 0.5) / scale - (p.height + p.capRy);
    for (let i = 0; i < width; i++) {
      const lx = (i + 0.5) / scale - p.capRx;
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;

      // The shaft.
      if (Math.abs(lx) < r + 1 / scale) {
        const sx = Math.max(-1, Math.min(1, lx / r));
        const theta = Math.asin(sx);
        const cos = Math.cos(theta);
        const topY = -p.height + p.capRy * cos;
        const botY = p.basePx - p.capRy * (1 - cos);
        const cover = clamp01((r - Math.abs(lx)) * scale + 0.5) * clamp01((botY - ly) * scale + 0.5);
        if (cover > 0 && ly >= topY - 1) {
          const v = clamp01((ly - topY) / colH) * face.height;
          sample(face, uOffset + r * theta * faceTexelsPerPx, v, false, px);
          const lift = drumShade((sx + 1) / 2);
          const ao = 1 - BASE_AO_MAX * clamp01(1 - (botY - ly) / aoH);
          // Silhouette: the walls' dark outline, along both limbs.
          const edge = EDGE_ALPHA * clamp01(1 - (r - Math.abs(lx)) / EDGE_WIDTH);
          for (let k = 0; k < 3; k++) {
            const lit = px[k]! * lift * ao;
            const c = lit + (EDGE[k]! - lit) * edge;
            if (k === 0) rr = c;
            else if (k === 1) gg = c;
            else bb = c;
          }
          aa = cover;
        }
      }

      // The top, over the shaft's upper edge (its front rim sits below the shaft's top curve at
      // every column, so it hides that edge entirely).
      const ey = ly + p.height;
      const e = Math.sqrt((lx / p.capRx) ** 2 + (ey / p.capRy) ** 2);
      // Distance inside the rim, in world px, measured along the ellipse's short axis: a cheap,
      // monotone stand-in for the true distance that is exact at the front and back.
      const inside = (1 - e) * p.capRy;
      const capCover = clamp01(inside * scale + 0.5);
      if (capCover > 0) {
        // Foreshortened: the top is a circle seen from above at an angle, so the swatch is squeezed
        // vertically by the ellipse's own ratio.
        const z = ey * (p.capRx / p.capRy);
        sample(cap, lx * cap.texelsPerPx, z * cap.texelsPerPx, true, px);
        const masonry = capMasonry(lx, z, p.capRx, scale);
        // The wall top's grain, with its joints lifted out and its amplitude halved, over its
        // stone colour: the top's only joints are its own (`capMasonry`).
        const l = luma(px[0]!, px[1]!, px[2]!) / stone.luma;
        const grain = 1 + CAP_GRAIN * (Math.max(l, CAP_GRAIN_FLOOR) - 1);
        for (let k = 0; k < 3; k++) px[k] = stone.rgb[k]! * grain;
        // The walls' coping is lit along the edges that face the key light, the far ones: here the
        // back half of the rim, faded out toward the sides.
        const back = clamp01(-ey / p.capRy);
        const coping = COPING_ALPHA * back * clamp01(1 - Math.abs(inside - 1.25) / 0.75);
        const edge = EDGE_ALPHA * clamp01(1 - inside / EDGE_WIDTH);
        const cs: number[] = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          let c = Math.min(255, px[k]! * TOP_LIFT * masonry);
          c += (255 - c) * coping;
          c += (EDGE[k]! - c) * edge;
          cs[k] = c;
        }
        // `over`, straight alpha.
        const outA = capCover + aa * (1 - capCover);
        const mix = (top: number, under: number) =>
          outA > 0 ? (top * capCover + under * aa * (1 - capCover)) / outA : 0;
        rr = mix(cs[0]!, rr);
        gg = mix(cs[1]!, gg);
        bb = mix(cs[2]!, bb);
        aa = outA;
      }

      const o = (j * width + i) * 4;
      data[o] = Math.round(rr);
      data[o + 1] = Math.round(gg);
      data[o + 2] = Math.round(bb);
      data[o + 3] = Math.round(aa * 255);
    }
  }
  return { data, width, height };
}

/** A texture's pixels through a 2D canvas, or `undefined` where there is none (headless tests, a
 *  tainted source) — the caller keeps the shipped pillar sprite. Through `DOMAdapter` for the
 *  reason `capLight.ts` documents: the WeChat runtime has no `document`. */
function readSwatch(tex: Texture, texelsPerPx: number): Swatch | undefined {
  const src = tex.source;
  const w = src.pixelWidth;
  const h = src.pixelHeight;
  if (!(w > 0 && h > 0) || !src.resource) return undefined;
  try {
    const canvas = DOMAdapter.get().createCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as ICanvasRenderingContext2D | null;
    if (!ctx) return undefined;
    ctx.drawImage(src.resource as CanvasImageSource, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, texelsPerPx };
  } catch {
    return undefined;
  }
}

/** Memoised per (face, cap, shape), including the failures, so a canvas-free host probes once. */
const baked = new Map<string, Texture | undefined>();

/**
 * The pillar painted from `face` and `cap`, as a texture laid out for `pillarRender`'s sprite box,
 * or `undefined` where it cannot be painted. `capTexelsPerPx` is the wall top's density
 * (`biomeTiles.SWATCH_META`); the face needs none, because it is fitted to the shaft's height.
 */
export function bakeStonePillar(
  face: Texture,
  cap: Texture,
  capTexelsPerPx: number,
  shape: PillarShape,
): Texture | undefined {
  const key = `${face.uid}:${cap.uid}:${shape.bodyW}:${shape.height}`;
  if (baked.has(key)) return baked.get(key);
  let out: Texture | undefined;
  const f = readSwatch(face, 1);
  const c = f && readSwatch(cap, capTexelsPerPx);
  if (f && c) {
    try {
      const img = paintStonePillar(f, c, shape);
      const canvas = DOMAdapter.get().createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d') as ICanvasRenderingContext2D | null;
      if (ctx) {
        const id = ctx.createImageData(img.width, img.height);
        id.data.set(img.data);
        ctx.putImageData(id, 0, 0);
        // Minified ~2x on screen, like the shipped sprite, so it needs the same mip chain.
        out = new Texture({ source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }) });
        out.label = `stone-pillar:${key}`;
      }
    } catch {
      out = undefined;
    }
  }
  baked.set(key, out);
  return out;
}

/** Drop every cached bake. Tests only. */
export function resetStonePillarCache(): void {
  baked.clear();
}
