// Split out of wallRender.ts (2026-08-19, 500-line convention): a pillar as a stone cylinder,
// in the same tonal language a standing wall is drawn in. Sibling of `wallRender.ts` — neither
// imports the other; both take their shared silhouette/crease/coping numbers from `wallTone.ts`,
// which is what keeps the split acyclic.
import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { mixHex, type BiomePalette } from '../theme';
import { linearRamp, rampFill } from '../../render/shadeRamp';
import {
  BASE_AO_FRACTION,
  BASE_AO_MAX,
  COPING_ALPHA,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_WIDTH,
} from './wallTone';

/** Cylinder proportions: how deep the top ellipse is relative to the shaft's width, how far
 *  it overhangs, how far the base extends past the ground point, and how round the shaft's
 *  bottom corners are (small — a cylinder's sides are straight; only the base curves). */
const PILLAR_CAP_RY_FRACTION = 0.22;
const PILLAR_CAP_OVERHANG_PX = 2;
export const PILLAR_BASE_PX = 10;
const PILLAR_CORNER_FRACTION = 0.12;

/**
 * Stone tones for a pillar, charcoal-navy per `art/biome/prompts.md`. Explicit rather than
 * derived, for the reason `buildPillarBody` documents: the biome palette's own pillar hues are
 * pre-art fallbacks that no longer describe the shipped swatches, and the swatches themselves
 * are too coarse to sample at pillar scale. `PILLAR_BIOME_MIX` folds a little of the biome's
 * wall colour back in so ice/lightning/fire rooms still differ from each other.
 *
 * Retuned 2026-08-19 against the same measured frame that set `wallRender`'s tonal hierarchy.
 * The top surface came out at luma 105 while the brightest stone anywhere else in the room —
 * a wall cap — was 44, so once the walls read as stone the pillars read as a different, paler
 * material lit by a different light: they were the brightest thing in frame by a factor of two.
 * The top is now ~92 on screen, the value a wall cap lands on, and BOTH limbs came down with
 * it — a top surface has to stay the brightest plane on the object (the texture-mapped attempt
 * failed exactly there and read as an open-topped well), so the lit limb had to drop below it
 * rather than the top alone dropping onto the limb.
 */
const PILLAR_LIT = 0x4e555f; // west limb, catching the key light
const PILLAR_MID = 0x424954; // the shaft's own local colour
const PILLAR_DARK = 0x141720; // east limb, turned away
const PILLAR_TOP = 0x5b6472; // the top surface — the most exposed plane on the object
const PILLAR_BIOME_MIX = 0.16;
/** Bands across the shaft. Each is filled with an INTERPOLATED COLOUR rather than stacked as an
 *  alpha overlay: a 4x render of the first attempt (9 alpha bands) showed nine hard vertical
 *  seams, because overlapping translucent rects step in opacity, not in tone. Interpolating the
 *  fill instead makes the step invisible at this count while staying pure Graphics — no
 *  gradient-fill API (Pixi 8's needs a canvas, which this repo's tests do not have), no
 *  per-pillar filter. */
const PILLAR_RAMP_STEPS = 22;
/** Where across the shaft the terminator sits (0 = west limb, 1 = east limb). */
const PILLAR_TERMINATOR = 0.36;

/** Faint stone mottling on the shaft, as `[x fraction, y fraction, radius fraction, alpha]` —
 *  a fixed table rather than noise so a pillar is deterministic and testable. New 2026-08-19:
 *  the colour-interpolated ramp alone is a mathematically perfect gradient, which is precisely
 *  what makes it read as moulded plastic next to a wall carrying a real stone swatch. Dark
 *  alphas only; a light speck on a curved surface reads as a hole. */
const PILLAR_MOTTLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.28, 0.22, 0.1, 0.1],
  [0.62, 0.36, 0.13, 0.08],
  [0.42, 0.55, 0.09, 0.11],
  [0.74, 0.68, 0.08, 0.07],
  [0.2, 0.74, 0.11, 0.09],
  [0.52, 0.86, 0.07, 0.08],
  [0.36, 0.12, 0.06, 0.07],
];

/** The top ellipse's radii, for a shaft `bodyW` px wide. Shared with `pillarArtExtent` so the
 *  occlusion x-ray measures the same overhang the cap is actually drawn at. */
export function pillarCapRadii(bodyW: number): { capRx: number; capRy: number } {
  return {
    capRx: bodyW / 2 + PILLAR_CAP_OVERHANG_PX,
    capRy: Math.max(8, bodyW * PILLAR_CAP_RY_FRACTION),
  };
}

/**
 * The biome's hue as a Sprite tint, for the textured pillar below. The hand-toned body mixes
 * `PILLAR_BIOME_MIX` of `palette.wall` into each of its own stone tones; a sprite cannot mix,
 * only multiply, so the same amount is mixed into WHITE instead and multiplied over the art —
 * which lands in the same place, because `palette.wall` is a dark near-neutral either way.
 * It also does the level correction the art happens to need: the shipped sprite's top surface
 * measures 101 and design/01's tonal hierarchy wants ~92, which is what this ~0.87 multiply
 * gets to, so the tint and the level fix are one operation rather than a baked-in edit.
 */
export function pillarTint(palette: BiomePalette): number {
  return mixHex(0xffffff, palette.wall, PILLAR_BIOME_MIX);
}

/**
 * The on-screen box of the pillar SPRITE, scaled by WIDTH: a pillar's width is the thing its
 * footprint has to agree with, and the art's own aspect ratio then sets how tall it stands.
 * Keyed off the texture rather than a constant on purpose — regenerating the art at a different
 * aspect must move the occluder box with it, not leave the x-ray testing a boundary that is no
 * longer where the stone is. `pillarSpriteHeight`'s agreement with `WALL_HEIGHT` is asserted in
 * `pillarRender.test.ts` instead of assumed here.
 */
export function pillarSpriteMetrics(bodyW: number, tex: Texture): { w: number; h: number } {
  const w = bodyW + PILLAR_CAP_OVERHANG_PX * 2;
  return { w, h: w * (tex.height / tex.width) };
}

/**
 * How far a pillar's art reaches from its own ground point, in local px: `halfW` to either side
 * and `top` northward (negative). Like a wall block, a pillar is drawn UPWARD from a grounded
 * origin, so its art covers a full `height` of walkable floor north of the footprint plus the
 * cap ellipse's own depth — that band is what `RoomBuilder` hands the occlusion x-ray
 * (`occlusion.Occluder`).
 *
 * With a texture, the same band is measured off the sprite's real drawn size instead of the
 * ellipse maths — the two paths draw different shapes, and an extent that described the other
 * one would fade the pillar for a character it does not actually cover (or worse, not fade it
 * for one it does).
 */
export function pillarArtExtent(
  bodyW: number,
  height: number,
  tex?: Texture,
): { halfW: number; top: number } {
  if (tex) {
    const { w, h } = pillarSpriteMetrics(bodyW, tex);
    return { halfW: w / 2, top: PILLAR_BASE_PX - h };
  }
  const { capRx, capRy } = pillarCapRadii(bodyW);
  return { halfW: capRx, top: -(height + capRy) };
}

/**
 * A pillar drawn from real art (`biome/pillar_neutral.png`, 2026-08-20) — the shape the
 * hand-toned cylinder below was standing in for. Bottom-anchored at the ground point and
 * scaled by width, so it occupies exactly the box `pillarArtExtent` reports.
 *
 * Two cues the art deliberately does NOT carry, and this function does not re-add:
 * a cast shadow (`RoomBuilder` throws it on `layers.shadow`, at the same slant as every other
 * object) and any base darkening — the art measures the same value at its foot as up its shaft,
 * so the contact crease below is the only thing grounding it. Everything the art DOES carry —
 * the closed top ellipse, the three shading bands, the curved course joints, the silhouette —
 * is left to the art: drawing the Graphics version's mottle or coping highlight over it would
 * double up cues that were measured on a frame where nothing else was drawing them.
 */
export function buildPillarSprite(
  bodyW: number,
  height: number,
  palette: BiomePalette,
  tex: Texture,
): Container {
  const c = new Container();
  const { w, h } = pillarSpriteMetrics(bodyW, tex);
  const s = new Sprite(tex);
  s.anchor.set(0.5, 1);
  s.setSize(w, h);
  s.y = PILLAR_BASE_PX;
  s.tint = pillarTint(palette);
  c.addChild(s);
  c.addChild(buildPillarBaseCrease(bodyW, height));
  return c;
}

/**
 * A warm-stone pillar painted from the chapter's own wall art (`pillarBake.bakeStonePillar`,
 * 2026-10-12). The same sprite box as `buildPillarSprite`, with neither of its two additions: no
 * tint, because the art IS the chapter's stone already, and no crease, because the bake paints the
 * crease along the drum's curved foot, where the flat one would hang below both limbs.
 */
export function buildStonePillarSprite(bodyW: number, tex: Texture): Container {
  const c = new Container();
  const { w, h } = pillarSpriteMetrics(bodyW, tex);
  const s = new Sprite(tex);
  s.anchor.set(0.5, 1);
  s.setSize(w, h);
  s.y = PILLAR_BASE_PX;
  c.addChild(s);
  return c;
}

/** The base contact crease, shared by both bodies: the same smooth ramp a wall face gets, at
 *  the same constants, so a pillar and a wall meet the floor the same way. */
function buildPillarBaseCrease(bodyW: number, height: number): Graphics {
  return drawPillarBaseCrease(new Graphics(), bodyW, height);
}

/**
 * The contact crease, as TWO shapes sampling the wall's own ramp texture (2026-08-26) — it was
 * `BASE_AO_BANDS` stacked `roundRect`s, which is what made a pillar the most expensive object in
 * an arena frame: 12 rounded rects is 496 floats of geometry, over Pixi v8's 400-float
 * auto-batch line, so each of the launch map's 124 pillars cost a draw call and a program
 * switch each way (245 of a 278-draw frame). `wallShadingSurfaces.drawBaseContactCrease` had
 * already been converted; `wallTone`'s `BASE_AO_BANDS` doc named this as the outstanding half
 * and flagged the catch, which is why this is two shapes rather than one:
 *
 *  1. the GRADIENT, over the base fraction of the room height down to the ground line. Full
 *     width and unrounded, because the pillar is full width here — the stepped version rounded
 *     every band, including the ones far up the shaft where nothing curves, which pinched the
 *     crease inward slightly at each one.
 *  2. the SKIRT below the ground line, which the stepped version carried as extra height on its
 *     last band at that band's held alpha. This is the piece that needs the shaft's corner
 *     rounding, because the foot is where the silhouette actually curves.
 *
 * Two shapes rather than one roundRect under one ramp for a reason worth keeping: `rampFill`
 * only guarantees no wrapping while the filled shape is a SUBSET of its own ramp segment (see
 * its doc), and a shape reaching past the ground line would sample beyond the last texel of a
 * ramp anchored at it — a `repeat` wrap back to alpha 0, i.e. a crease that fades out at the
 * foot. The alternative is a custom baked field that rises then HOLDS, which works but keys a
 * bake per distinct pillar height and stops sharing the wall's texture. Sharing wins: this is
 * the same `linearRamp()` every wall face samples, so "a pillar and a wall meet the floor the
 * same way" is now true of the texture and not just of the constants.
 */
function drawPillarBaseCrease(g: Graphics, bodyW: number, height: number): Graphics {
  const corner = bodyW * PILLAR_CORNER_FRACTION;
  const aoH = height * BASE_AO_FRACTION;
  g.rect(-bodyW / 2, -aoH, bodyW, aoH)
    .fill(rampFill(linearRamp(), 0, -aoH, 0, 0, { color: 0x000000, alpha: BASE_AO_MAX }));
  g.roundRect(-bodyW / 2, 0, bodyW, PILLAR_BASE_PX, corner)
    .fill({ color: 0x000000, alpha: BASE_AO_MAX });
  return g;
}

/**
 * A pillar as a stone cylinder in the same tonal language as a standing wall — a lit top
 * ellipse, a shaft shaded across its curve, faint mottling, a base contact crease, and the same
 * dark silhouette. Local coords with the origin at the pillar's ground point, so `bodyW`/
 * `height` are what `RoomBuilder` already computes.
 *
 * Hand-toned rather than textured, after three attempts (2026-08-18):
 *
 *   1. **The original was pale mauve.** Pillars were flat `Graphics` filled from
 *      `palette.pillar`/`palette.pillarTop`, which mix the biome's ELEMENT hue into a slate
 *      base — on ember that lands on `0x564850`. Those are code-only FALLBACK hues chosen
 *      before any real biome art existed, and every shipped swatch is charcoal-navy stone. Once
 *      the walls read as real stone, four pale-mauve cylinders read as placeholder props
 *      someone forgot to replace: the worst thing left in the frame.
 *   2. **Texturing them from the wall swatches was worse.** A pillar's cap is a ~35 px ellipse
 *      and its shaft ~80 px, so a `TilingSprite` window that small lands on one arbitrary dark
 *      patch of a 256 px swatch — no legible stone pattern, just a dark blob, and with the
 *      brick elevation on the shaft the whole thing read as an open-topped well.
 *   3. **Hand-toned shading, drawn as a real cylinder, is what works** — and needs no mask, no
 *      texture and no filter. This is that.
 *   4. **Real pillar art, generated for this object (2026-08-20), is what finally beats it** —
 *      `buildPillarSprite` above. Not a contradiction of ②: what failed there was sampling a
 *      256 px WALL swatch through a pillar-sized window, and what works is art authored at
 *      pillar scale. This function stays as the fallback for a missing texture, exactly like
 *      every other biome swatch in `render/biomeTiles.ts`.
 *   5. **Painting the pillar FROM the wall art (2026-10-12) is what a warm-stone chapter gets**
 *      (`pillarBake.ts`): the sprite above was authored for the charcoal walls, and next to warm
 *      stone it read as another material. Not ② again: the bake unrolls the 512 px face around
 *      the drum with its courses curved, rather than windowing a swatch onto a flat box.
 */
export function buildPillarBody(bodyW: number, height: number, palette: BiomePalette): Graphics {
  const g = new Graphics();
  const { capRx, capRy } = pillarCapRadii(bodyW);
  const corner = bodyW * PILLAR_CORNER_FRACTION;
  const bodyH = height + PILLAR_BASE_PX;
  const stone = (base: number) => mixHex(base, palette.wall, PILLAR_BIOME_MIX);
  const lit = stone(PILLAR_LIT);
  const mid = stone(PILLAR_MID);
  const dark = stone(PILLAR_DARK);

  // Shaft, band by band across the curve. The bands are drawn on top of one solid rounded body
  // so the bottom corners stay round without a clip: each band is inset vertically by nothing
  // but its own overlap, and the rounded fill underneath is what the silhouette follows.
  g.roundRect(-bodyW / 2, -height, bodyW, bodyH, corner).fill({ color: mid });
  for (let i = 0; i < PILLAR_RAMP_STEPS; i++) {
    const t = (i + 0.5) / PILLAR_RAMP_STEPS;
    const color = t <= PILLAR_TERMINATOR
      ? mixHex(lit, mid, t / PILLAR_TERMINATOR)
      : mixHex(mid, dark, (t - PILLAR_TERMINATOR) / (1 - PILLAR_TERMINATOR));
    const x = -bodyW / 2 + bodyW * (i / PILLAR_RAMP_STEPS);
    const w = bodyW / PILLAR_RAMP_STEPS + 0.5; // overlap so no seam shows between bands
    // Inset from the very top/bottom so the rounded corners of the fill above stay visible.
    g.rect(x, -height + corner * 0.5, w, bodyH - corner).fill({ color });
  }

  // Stone mottling, so the shaft is not a mathematically clean gradient.
  for (const [fx, fy, fr, alpha] of PILLAR_MOTTLE) {
    g.ellipse(-bodyW / 2 + bodyW * fx, -height + height * fy, bodyW * fr, bodyW * fr * 1.3)
      .fill({ color: 0x000000, alpha });
  }

  // Base contact crease — the same smooth ramp a wall face gets, same constants, and the same
  // one the textured body above uses.
  drawPillarBaseCrease(g, bodyW, height);

  // Silhouette, then the top surface over it (the cap's near half is in front of the shaft),
  // then its lit coping.
  g.roundRect(-bodyW / 2, -height, bodyW, bodyH, corner)
    .stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  g.ellipse(0, -height, capRx, capRy).fill({ color: stone(PILLAR_TOP) });
  g.ellipse(0, -height, capRx, capRy)
    .stroke({ color: EDGE_COLOR, width: EDGE_WIDTH, alpha: EDGE_ALPHA });
  g.ellipse(0, -height, capRx * 0.94, capRy * 0.9)
    .stroke({ color: 0xffffff, width: 1.5, alpha: COPING_ALPHA });
  return g;
}
