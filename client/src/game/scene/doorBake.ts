// A warm-stone door surround, painted once per chapter out of that chapter's own WALL FACE
// (2026-10-13). Sibling of `pillarBake.ts`, which did the same for pillars a day earlier, and of
// `doorRender.ts`, which draws the result as the leaf sprite it already drew.
//
// Why: `door_locked_raw.png` / `door_open_raw.png` (2026-08-20) were drawn for the first-generation
// charcoal walls: a frame of small navy bricks with a black cartoon outline, and hazard stripes
// across the locked slab. When every chapter moved to warm stone (2026-10-10) and the faces to four
// even courses of ashlar (2026-10-12), the door kept its frame, so a doorway stood a blue toy brick
// arch inside a brown painted wall (live report, 2026-10-13: *"按照目前的美术设定，这个门就显得很
// 不协调了"*). Painting the surround from the face makes the match true in every chapter, with no
// new art to generate — the pillar's argument, word for word.
//
// What is kept from the shipped art, and why it can be: only what the frame SURROUNDS. A locked
// door's fire panel is copied from `door_locked_raw.png` inside `FLAME_BAND` (the hazard is the
// one thing on a door the player has to read at a glance, and `doorFx`'s flame overlay is fitted
// to that band); an open door's middle is left transparent so the curtain of light and the recess
// behind the leaf show through, exactly as the arch art's hole let them. Both states are baked at
// ONE size (the locked art's aspect, doubled), so the frame no longer changes shape when a door
// unlocks — the two source arts disagreed on their lintel by 5 px and on their jambs by 2.
//
// The surround is real masonry rather than the wall face cut to shape: a flat arch of three stones
// (two voussoirs and a keystone, the joints radiating from a point under the opening), two jambs of
// five square ashlar blocks, and on a locked door a sill stone under the fire. Each stone carries
// the face's own paint without its joints (`capStoneColour` + the grain floor, the pillar top's
// recipe), its own tone, and a bevel lit from the walls' north-west key light.
import type { Texture } from 'pixi.js';
import { swatchMeta } from '../../render/biomeTiles';
import { FLAME_BAND, OPEN_HOLE } from './doorMotion';
import { capStoneColour, pixelsToTexture, readSwatch, sample, type Swatch } from './pillarBake';
import { DOOR_H } from './wallGeometry';
import { EDGE_ALPHA, EDGE_COLOR } from './wallTone';

/** The bake's size in texels: `door_locked_raw.png`'s 147 x 217, doubled. Both states use it, and
 *  `doorLeaf.doorLeafFrame` reads only the aspect, so every crop and band rule is unchanged. */
export const DOOR_BAKE_W = 294;
export const DOOR_BAKE_H = 434;

/** The opening the surround is designed at, world px: a door through a room boundary. A kerb door
 *  (128 wide) shows the same stones at twice the size, cropped to their bottom half. */
const DESIGN_W = 64;

/** The surround's plan, as fractions of the leaf. The jambs' inner edges sit just outside
 *  `OPEN_HOLE`, so a mote drifting at the edge of the hole still clears the stone; the lintel and
 *  the sill are the fire band's own top and bottom, so a locked door's panel is the band exactly. */
const JAMB_IN = 0.23;
const LINTEL = FLAME_BAND.y0;
const SILL = FLAME_BAND.y1;
/** Ashlar blocks per jamb: five makes them about square at the design width (15 x 15 px). */
const JAMB_BLOCKS = 5;
/** The keystone's half-width at the lintel's underside, and how far below it its joints meet. */
const KEY_HALF = 0.11;
const KEY_FOCUS = 0.6;

/** Joints and bevels, world px. The bevel, tone and grain are the pillar top's numbers
 *  (`pillarBake.capMasonry`); the joint is wider and darker than its, because a surround stands
 *  in the wall face and has to read as the same mortar as the face's own courses beside it. */
const JOINT = 0.85;
const JOINT_SHADE = 0.5;
const BEVEL = 1.6;
const BEVEL_LIFT = 0.22;
const TONE_SPREAD = 0.07;
const GRAIN = 0.5;
const GRAIN_FLOOR = 0.92;
/** Dressed stone round an opening reads a shade lighter than the coursed wall it is set into. */
const FRAME_LIFT = 1.02;
/** The dark line where stone meets the opening, world px — the walls' silhouette colour. */
const OPEN_EDGE = 1.1;

const LIGHT_X = -Math.SQRT1_2;
const LIGHT_Y = -Math.SQRT1_2;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const EDGE: readonly number[] = [(EDGE_COLOR >> 16) & 0xff, (EDGE_COLOR >> 8) & 0xff, EDGE_COLOR & 0xff];

/** One side of a stone: inside where `nx * x + ny * y <= c` (outward normal `n`, world px).
 *  `outer` sides are the fixture's own silhouette, which `wallRender.addBlockEdge` draws; every
 *  other side is a joint, cut and bevelled. */
interface Side {
  nx: number;
  ny: number;
  c: number;
  outer: boolean;
}

function side(nx: number, ny: number, c: number, outer = false): Side {
  const l = Math.hypot(nx, ny);
  return { nx: nx / l, ny: ny / l, c: c / l, outer };
}

/** The line through `(x0, y0)` and `(x1, y1)`, as a side whose inside is the half containing
 *  `(ix, iy)`. */
function sideThrough(x0: number, y0: number, x1: number, y1: number, ix: number, iy: number): Side {
  let nx = y1 - y0;
  let ny = -(x1 - x0);
  let c = nx * x0 + ny * y0;
  if (nx * ix + ny * iy > c) {
    nx = -nx;
    ny = -ny;
    c = -c;
  }
  return side(nx, ny, c);
}

/**
 * The surround's stones, each a convex polygon of sides, in world px of a `DESIGN_W`-wide leaf
 * `h` tall. The opening between them is not a stone. Exported for the test.
 */
export function doorStones(h: number, locked: boolean): Side[][] {
  const w = DESIGN_W;
  const xl = JAMB_IN * w;
  const xr = w - xl;
  const yl = LINTEL * h;
  const ys = SILL * h;
  const top = side(0, -1, 0, true);
  const left = side(-1, 0, 0, true);
  const right = side(1, 0, w, true);
  const bottom = side(0, 1, h, true);
  // The flat arch: both keystone joints run through a focus below the opening's middle.
  const fy = yl + KEY_FOCUS * w;
  const kl = sideThrough(w / 2 - KEY_HALF * w, yl, w / 2, fy, 0, yl);
  const kr = sideThrough(w / 2 + KEY_HALF * w, yl, w / 2, fy, w, yl);
  const flip = (s: Side): Side => ({ nx: -s.nx, ny: -s.ny, c: -s.c, outer: false });
  const underLintel = side(0, 1, yl);
  const stones: Side[][] = [
    [top, left, underLintel, kl],
    [top, flip(kl), flip(kr), underLintel],
    [top, right, underLintel, kr],
  ];
  const bh = (h - yl) / JAMB_BLOCKS;
  for (let j = 0; j < JAMB_BLOCKS; j++) {
    const y0 = side(0, -1, -(yl + j * bh));
    const y1 = j === JAMB_BLOCKS - 1 ? bottom : side(0, 1, yl + (j + 1) * bh);
    stones.push([left, side(1, 0, xl), y0, y1]);
    stones.push([side(-1, 0, -xr), right, y0, y1]);
  }
  if (locked) stones.push([side(-1, 0, -xl), side(1, 0, xr), side(0, -1, -ys), bottom]);
  return stones;
}

/** A stable tone per stone, in [-1, 1]: the pillar top's hash, offset so the two never agree. */
function stoneTone(k: number): number {
  const h = Math.imul(k + 17, 0x9e3779b1) >>> 0;
  return ((h >>> 8) % 1000) / 500 - 1;
}

/** Signed distance into the opening, world px: positive inside it, negative in the stone. */
function intoOpening(x: number, y: number, h: number, locked: boolean): number {
  const xl = JAMB_IN * DESIGN_W;
  const yl = LINTEL * h;
  const yb = locked ? SILL * h : h + 1e3;
  return Math.min(x - xl, DESIGN_W - xl - x, y - yl, yb - y);
}

/**
 * Paint the leaf, `DOOR_BAKE_W x DOOR_BAKE_H` straight-alpha RGBA. Pure: no canvas. `face` is the
 * chapter's wall face; `panel` is the locked art whose fire fills the opening (ignored, and the
 * opening left transparent, for an open door).
 */
export function paintStoneDoor(
  face: Swatch,
  panel: Swatch | undefined,
  locked: boolean,
): { data: Uint8ClampedArray; width: number; height: number } {
  const width = DOOR_BAKE_W;
  const height = DOOR_BAKE_H;
  const scale = width / DESIGN_W;
  const h = height / scale;
  const data = new Uint8ClampedArray(width * height * 4);
  const stones = doorStones(h, locked);
  const stone = capStoneColour(face);
  // The face is mapped at the wall's own vertical scale: its height is a wall's height.
  const faceTexelsPerPx = face.height / DOOR_H;
  const px: number[] = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    const y = (j + 0.5) / scale;
    for (let i = 0; i < width; i++) {
      const x = (i + 0.5) / scale;
      const o = (j * width + i) * 4;
      const d = intoOpening(x, y, h, locked);
      // How much of this texel is stone, antialiased across the opening's edge.
      const cover = clamp01(0.5 - d * scale);
      let r = 0;
      let g = 0;
      let b = 0;
      if (cover > 0) {
        let k = stones.findIndex((s) => s.every((e) => e.nx * x + e.ny * y <= e.c + 1e-6));
        if (k < 0) k = 0;
        const tone = stoneTone(k);
        // Each stone samples the face from its own offset, so no painted course runs across a joint.
        const u = (x + (tone + 1) * 97) * faceTexelsPerPx;
        const v = (y + (tone + 1) * 41) * faceTexelsPerPx;
        sample(face, u, v, true, px);
        const l = luma(px[0]!, px[1]!, px[2]!) / stone.luma;
        const grain = 1 + GRAIN * (Math.max(l, GRAIN_FLOOR) - 1);
        let joint = Infinity;
        let shade = 0;
        for (const e of stones[k]!) {
          if (e.outer) continue;
          const dist = e.c - (e.nx * x + e.ny * y);
          joint = Math.min(joint, dist);
          shade += BEVEL_LIFT * (e.nx * LIGHT_X + e.ny * LIGHT_Y) * clamp01(1 - dist / BEVEL);
        }
        const line = clamp01((JOINT - joint) * scale + 0.5);
        const lit = FRAME_LIFT * grain * (1 + shade) * (1 + TONE_SPREAD * tone);
        const m = lit + (JOINT_SHADE - lit) * line;
        const edge = EDGE_ALPHA * clamp01(1 + d / OPEN_EDGE);
        const c = [0, 1, 2].map((q) => {
          const s = Math.min(255, stone.rgb[q]! * m);
          return s + (EDGE[q]! - s) * edge;
        });
        r = c[0]!;
        g = c[1]!;
        b = c[2]!;
      }
      let a = cover;
      if (locked && panel && cover < 1) {
        // The fire, from the shipped art at the same fraction of the leaf.
        sample(panel, (x / DESIGN_W) * panel.width, (y / h) * panel.height, false, px);
        r = r * cover + px[0]! * (1 - cover);
        g = g * cover + px[1]! * (1 - cover);
        b = b * cover + px[2]! * (1 - cover);
        a = 1;
      }
      data[o] = Math.round(r);
      data[o + 1] = Math.round(g);
      data[o + 2] = Math.round(b);
      data[o + 3] = Math.round(a * 255);
    }
  }
  return { data, width, height };
}

/** Memoised per (face, panel, state), including the failures, so a canvas-free host probes once. */
const baked = new Map<string, Texture | undefined>();

/**
 * The door leaf for a room whose wall face is `face`: the stone surround painted from it, or the
 * shipped elevation `shipped` where it cannot be painted — first-generation art (no authored tone),
 * no face loaded, or a host with no canvas. `shipped` undefined for a LOCKED door means there is no
 * fire to fill it with, so that falls back too.
 */
export function stoneDoorLeaf(face: Texture | undefined, shipped: Texture | undefined, locked: boolean): Texture | undefined {
  if (!face || !swatchMeta(face)?.authoredTone || (locked && !shipped)) return shipped;
  const key = `${face.uid}:${locked ? shipped!.uid : 'open'}`;
  if (!baked.has(key)) {
    let out: Texture | undefined;
    const f = readSwatch(face, 1);
    const p = locked ? readSwatch(shipped!, 1) : undefined;
    if (f && (!locked || p)) {
      try {
        out = pixelsToTexture(paintStoneDoor(f, p, locked), `stone-door:${key}`);
      } catch {
        out = undefined;
      }
    }
    baked.set(key, out);
  }
  return baked.get(key) ?? shipped;
}

/** Drop every cached bake. Tests only. */
export function resetStoneDoorCache(): void {
  baked.clear();
}

// `OPEN_HOLE` is imported for the contract the jamb constant states, checked in the test.
export const DOOR_BAKE_PLAN = { jambIn: JAMB_IN, lintel: LINTEL, sill: SILL, hole: OPEN_HOLE } as const;
