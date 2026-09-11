// Split out of doorRender.ts 2026-09-03 (500-line convention, CLAUDE.md form 1 — independent
// function modules): every LIGHT and SHADE layer a door is composited from, as free functions
// over one opening size. No shared private state with the assembly in doorRender.ts, which
// re-exports all of these so the pre-split import path (import { drawGlow } from './doorRender',
// used by four door test files) stays valid.
//
// These are the STILL layers — each is drawn once when a door is built and then only toggled by
// visible. What MOVES lives in doorFx.ts, which reads four of the colours/shapes below so the
// animated layers and the static ones stay one palette.
import { Graphics, Texture, TilingSprite } from 'pixi.js';
// The floor PLANE — where a door's floor-level decals lie and what shape they are — moved to
// `doorFloorPlane.ts` 2026-09-11 (500-line convention, CLAUDE.md form 1). Re-exported below so
// every pre-split import path stays valid, the same shell rule this file itself lives behind in
// `doorRender.ts`.
import { fillFloorPool, thresholdPlane, type DoorFloorPlane } from './doorFloorPlane';

export {
  doorFloorPlane,
  doorSpan,
  fillFloorPool,
  floorArcSpans,
  GLOW_POOL,
  GLOW_POOL_SQUASH,
  ringAspect,
  ringTravel,
  strokeFloorArc,
  thresholdPlane,
  type DoorFloorPlane,
} from './doorFloorPlane';
/**
 * The recess behind the leaf — what makes a doorway a hole rather than a panel.
 *
 * Bands from the top of the opening downward, so the passage is darkest where it is deepest. It
 * matters most for an OPEN door, whose art is a frame around a transparent middle: with no recess
 * you see the room's floor tiling straight through the arch and the wall stops reading as solid.
 *
 * It darkens the wall's own elevation swatch rather than replacing it (`addWallFace` runs first
 * over the whole face) — the first version filled the opening with flat near-black and, on a
 * 22 px kerb door where the leaf art crops to almost nothing, that was the entire fixture: a
 * black rectangle punched in the room. Stone in deep shade reads as a passage; a void reads as a
 * rendering bug. Hence also the ceiling on the top band's alpha.
 */
const RECESS_COLOR = 0x05070a;
const RECESS_BANDS = 8;
const RECESS_ALPHA_TOP = 0.72;
const RECESS_ALPHA_FLOOR = 0.34;

/**
 * The OPEN state's own recess alphas — the same band shape as a locked door's, over the room's own
 * floor swatch instead of over more wall stone (`buildOpenFloorTile`).
 *
 * **Why this exists (2026-08-30, second pass the same day as the through/spill/rim lighting
 * above).** That pass gave an open door light, but the base it sits on top of was left untouched:
 * `drawRecess`'s default alphas darken the SAME wall-stone elevation for both states, so a
 * passable door and a locked one differ only in how much light is added on top of an otherwise
 * identical dark tunnel. Live report, after the lighting pass had already shipped: *"可以通过时的门，
 * 好了一些，但离我想要的效果还差很远"* (better, but still far from the effect wanted) — circling the
 * opening itself, not the light. The tunnel needs to say "floor" before the light says "lit".
 *
 * Numbers are far lighter than the locked pair: the floor swatch is what has to read, and the
 * locked alphas (0.72/0.34) would bury it under almost the same near-black wash the flat colour
 * used to be. Kept as bands rather than one flat alpha for the same reason as every other ramp in
 * this file — a single value draws its own hard edge at the top of the opening.
 */
const OPEN_RECESS_ALPHA_TOP = 0.42;
const OPEN_RECESS_ALPHA_FLOOR = 0.04;

/** No-floor-art fallback for the open recess: a flat tone between the room floor and the near-black
 *  `RECESS_COLOR`, so degraded content (no swatches loaded at all) still tells a locked tunnel from
 *  an open one at the base layer, not only via the light layered on top of it. */
const OPEN_RECESS_FALLBACK_COLOR = 0x2a2f3a;

/** The sill: a hairline of lit stone along the opening's own floor line, the one cue that says
 *  the passage's floor is a step rather than a continuation of the room. Same white-coping trick
 *  `wallRender`'s silhouette uses on a cap's north edge. */
const SILL_ALPHA = 0.22;

/**
 * A locked door's hazard bloom, additive, in two pieces: a pool on the floor immediately south
 * of the threshold, and a wash over the leaf itself.
 *
 * design/13 "environment desaturated, hazards saturated" — a locked door is the one fixture that
 * is allowed to shout, because "you cannot leave yet" is information the player needs from across
 * the room, and on a kerb-height opening the silhouette is only 22 px tall so colour has to carry
 * the whole read. Additive rather than a tint for the reason `wallTone.CAP_BOOST_ALPHA` documents:
 * a wash toward red would flatten the leaf's own contrast, an additive term lifts it and leaves
 * the stone frame's amplitude intact.
 *
 * Since 2026-09-03d "immediately south of the threshold" is only where a door in an EAST-WEST wall
 * puts its pool — `DoorFloorPlane` below decides, because for the other 13 shipped doors the ground
 * south of the threshold is more wall.
 */
export const GLOW_COLOR = 0xff3a1e;
const GLOW_RING_ALPHA = 0.035;
const GLOW_WASH_ALPHA = 0.1;

/**
 * A passable door's light from beyond — the open state's mirror of the hazard bloom above.
 *
 * **WHY.** Before this, "open" was defined only by SUBTRACTION: the locked state minus the red
 * pool, minus the hazard leaf. Everything with a positive signal in it was `visible = locked`, so
 * a passable door said "walk through me" by the ABSENCE of a cue — and what was left measured as
 * the darkest thing around: the arch's interior at luma 19 against a 37 floor (design/01), framed
 * by stone the same value as the wall it is cut into, sitting in the darkest band `roomLight`
 * paints (its falloff darkens toward a room's edge, and a door is always on one). A black
 * rectangle in a stone frame is what a WALL looks like. Live report, with a screenshot circling
 * one: the locked state reads well, but *"when it is passable it looks like a black wall — it is
 * hard to tell at once that this is a door you can walk through"*.
 *
 * **The cue is light, not a second saturated colour.** design/13 is "environment desaturated,
 * hazards saturated": a locked door is allowed to shout because "you cannot leave yet" is urgent,
 * a doorway is not. The passage leads to a lit room, so light comes OUT of it — one physical
 * claim, three pieces:
 *
 *   through — the passage's own floor, lit from beyond, ramped up from the threshold. Drawn
 *             BEHIND the leaf so the arch art's own stone masks it: the light shows through the
 *             transparent middle and nowhere else, with no inset constant keyed to where a
 *             particular PNG's jambs happen to sit. It is the exact inverse of `drawRecess`'s
 *             ramp, which stays — the recess is what makes the opening a hole, this is what puts
 *             a lit floor at the bottom of it.
 *   spill   — a pool on the room floor in front of the doorway (`DoorFloorPlane` says which side
 *             that is): the same nine graduated rings as
 *             `GLOW_POOL`, warm white, at two thirds the alpha. Deliberately the same SHAPE as the
 *             hazard pool so "a pool at the door" is ONE symbol the player learns once, with
 *             colour saying which state. This is also the piece that carries a KERB door, where a
 *             22 px opening leaves no room for the ramp above — 11 of the 24 shipped doors.
 *   rim     — the aperture's edge catching that light on its way out: warm bands up both jambs,
 *             brightest at the threshold, dying out going up. What stops the arch from reading as
 *             flush with the flat wall beside it. NOT across the lintel's underside: the top of
 *             the opening is where the recess is deliberately darkest, and a lit line up there
 *             would flatten the one depth cue the recess exists for.
 */
export const THROUGH_COLOR = 0xffd9a8;
const THROUGH_BANDS = 10;
/**
 * How far up the opening the floor light reaches, as a fraction of the opening's height, and its
 * alpha at the threshold — falling linearly to nothing at the top of the ramp. Banded rather than
 * one fill for the fourth time in this file's neighbourhood (`CAST_PASSES`, the nine bloom rings,
 * the mottle bands): a single alpha draws its own hard edge and reads as a painted panel.
 *
 * Both numbers were swept on a live frame of level 1's 64x92 perimeter door rather than reasoned
 * about, and the sweep is the argument for them. Reach 0.45 lit only the sill and left the fixture
 * still reading as mostly-dark; 0.75 climbed high enough to look like haze in the passage instead
 * of light on its floor; 0.60 puts the bright end on the floor and lets it die by mid-opening.
 * Alpha then set the value the floor lands at, everything else held: 0.15 → 61, 0.20 → 69,
 * 0.22 → 72, 0.26 → 78, against a room floor of 49 beside the door and 66 out in the open, and a
 * lit cap crown of 56. 0.26 made the doorway the brightest thing in the frame — brighter than the
 * crown, which design/01 calls what the eye reads a back wall by. 0.22 clears the near floor by
 * +23 and sits just above the open floor, which is the read wanted: the brightest thing in the
 * DOORWAY, not in the room. Top of the opening: 19.6 in both states, untouched.
 */
const THROUGH_REACH = 0.6;
const THROUGH_ALPHA = 0.22;
/**
 * The floor pool: `GLOW_POOL`'s rings verbatim, so the two states differ in colour and strength
 * and in nothing else.
 *
 * NOT the hazard pool's alpha, because alpha is not the comparable quantity: `GLOW_COLOR` is a
 * saturated red at luma 98 and `THROUGH_COLOR` a warm white at luma 221, so ring for ring this
 * pool lands 2.3x harder at the same number. Measured on the same door with the layer hidden and
 * shown, over the same 200x90 region the hazard pool was measured on: at 0.024 the open lights
 * moved a KERB doorway by a mean of +22.5 luma against the hazard bloom's +14.8 on the same
 * fixture, i.e. the state that is not allowed to shout was shouting 1.5x louder, and the floor
 * around it went visibly tan. 0.018 lands at +14.4 — the same magnitude as the hazard, carried by
 * warmth instead of red, with the floor keeping its own colour.
 */
const SPILL_RING_ALPHA = 0.018;
/** The lit reveal up each jamb: how far up, how wide (world px, clamped on a narrow opening), and
 *  the alpha at the threshold. `t * t` rather than `t` so it dies out fast — a rim carried at even
 *  strength up a 92 px opening outlines the doorway like a wireframe, which is the mistake the
 *  2026-08-18 wall pass made with a salmon outline on a standing block. Swept the same way as the
 *  ramp above and the weakest of the three pieces by some distance: at 0.2 it is not visible on a
 *  live frame at 6x, at 0.6 it stops being a lit edge and becomes a bright bar with its own hard
 *  side running down the flanking wall. 0.34 separates the arch from the wall next to it and does
 *  not draw a line. */
const RIM_BANDS = 6;
const RIM_REACH = 0.6;
const RIM_WIDTH = 3;
const RIM_ALPHA = 0.34;
/** The sill: one lit hairline along the opening's own floor line. Its own function so the assembly
 *  test can look for exactly this geometry among the fixture's children — the silhouette
 *  (`addBlockEdge`) also strokes along y = 0, so "is there a line at the threshold" cannot tell the
 *  two apart. Exported for tests. */
export function drawSill(g: Graphics, openingW: number): void {
  g.moveTo(0, 0).lineTo(openingW, 0).stroke({ color: 0xffffff, width: 1, alpha: SILL_ALPHA });
}

/**
 * The tunnel behind the leaf: bands darkening upward over the opening, from `alphaFloor` at the
 * threshold to `alphaTop` at the lintel. Defaults are the LOCKED pair; the open state calls this
 * with the far lighter `OPEN_RECESS_ALPHA_*` pair instead, over the floor tile rather than more
 * wall stone (`buildOpenFloorTile`) — same shape, so the two states share one ramp function and
 * differ only in what they darken and by how much. Exported for tests.
 */
export function drawRecess(
  g: Graphics,
  openingW: number,
  openingH: number,
  alphaTop: number = RECESS_ALPHA_TOP,
  alphaFloor: number = RECESS_ALPHA_FLOOR,
): void {
  if (openingH <= 0) return;
  const bandH = openingH / RECESS_BANDS;
  for (let i = 0; i < RECESS_BANDS; i++) {
    // t: 1 at the top of the opening (deepest), → 0 at the floor.
    const t = 1 - (i + 0.5) / RECESS_BANDS;
    const alpha = alphaFloor + (alphaTop - alphaFloor) * t;
    g.rect(0, -openingH + i * bandH, openingW, bandH).fill({ color: RECESS_COLOR, alpha });
  }
}

/** The open recess's own darkening ramp — `drawRecess` at the far lighter `OPEN_RECESS_ALPHA_*`
 *  pair, over the floor tile rather than more wall stone. Its own function, same pattern as every
 *  other composited layer in this file (`drawGlow`/`drawThroughLight`/`drawSpill`), so a test can
 *  match it by digest rather than re-deriving the constants. Exported for tests. */
export function drawOpenRecessShade(g: Graphics, openingW: number, openingH: number): void {
  drawRecess(g, openingW, openingH, OPEN_RECESS_ALPHA_TOP, OPEN_RECESS_ALPHA_FLOOR);
}

/**
 * The open state's own floor: the room's floor swatch tiled across the opening, bottom-anchored at
 * the threshold. No swatch loaded falls back to `OPEN_RECESS_FALLBACK_COLOR`, the same
 * optional-swatch contract as every other field on `DoorSkin`. A zero-height opening (the
 * `drawRecess` guard's own case) returns an empty, harmless Graphics rather than a degenerate
 * zero-size `TilingSprite`.
 */
export function buildOpenFloorTile(
  openingW: number,
  openingH: number,
  floorTex: Texture | undefined,
): TilingSprite | Graphics {
  if (openingH <= 0) return new Graphics();
  if (floorTex) {
    const tile = new TilingSprite({ texture: floorTex, width: openingW, height: openingH });
    tile.position.set(0, -openingH);
    return tile;
  }
  const g = new Graphics();
  g.rect(0, -openingH, openingW, openingH).fill({ color: OPEN_RECESS_FALLBACK_COLOR });
  return g;
}

/** A locked door's bloom: a graduated pool on the floor around the doorway plus a wash over the
 *  leaf. Exported for tests. */
export function drawGlow(
  g: Graphics,
  openingW: number,
  openingH: number,
  plane: DoorFloorPlane = thresholdPlane(openingW),
): void {
  fillFloorPool(g, plane, GLOW_COLOR, GLOW_RING_ALPHA);
  g.rect(0, -openingH, openingW, openingH).fill({ color: GLOW_COLOR, alpha: GLOW_WASH_ALPHA });
}

/**
 * An open door's light from the room beyond: bands brightening DOWNWARD to the threshold, over
 * the bottom `THROUGH_REACH` of the opening. The mirror image of `drawRecess`'s ramp, and drawn
 * on top of it — the recess makes the opening a hole, this puts a lit floor at the bottom of it.
 *
 * Belongs behind the leaf: the arch elevation is opaque stone with a transparent middle, so
 * letting it mask this layer confines the light to the opening for free. Exported for tests.
 */
export function drawThroughLight(g: Graphics, openingW: number, openingH: number): void {
  if (openingH <= 0) return;
  const bandH = (openingH * THROUGH_REACH) / THROUGH_BANDS;
  for (let i = 0; i < THROUGH_BANDS; i++) {
    // t: 1 at the threshold (brightest), → 0 at the top of the ramp.
    const t = 1 - (i + 0.5) / THROUGH_BANDS;
    g.rect(0, -(i + 1) * bandH, openingW, bandH).fill({ color: THROUGH_COLOR, alpha: t * THROUGH_ALPHA });
  }
}

/**
 * An open door's spill: the floor pool south of the threshold, plus the lit reveal up each jamb.
 *
 * The pool is `drawGlow`'s rings verbatim in warm white — one shape for both states, colour
 * carrying which — and it is what a kerb door's 22 px opening has instead of the ramp above.
 * The rim is what separates the arch from the flat wall next to it. Exported for tests.
 */
export function drawSpill(
  g: Graphics,
  openingW: number,
  openingH: number,
  plane: DoorFloorPlane = thresholdPlane(openingW),
): void {
  fillFloorPool(g, plane, THROUGH_COLOR, SPILL_RING_ALPHA);
  if (openingH <= 0) return;
  const bandH = (openingH * RIM_REACH) / RIM_BANDS;
  const w = Math.min(RIM_WIDTH, openingW / 2);
  for (let i = 0; i < RIM_BANDS; i++) {
    const t = 1 - (i + 0.5) / RIM_BANDS;
    const alpha = t * t * RIM_ALPHA;
    const y = -(i + 1) * bandH;
    g.rect(0, y, w, bandH).fill({ color: THROUGH_COLOR, alpha });
    g.rect(openingW - w, y, w, bandH).fill({ color: THROUGH_COLOR, alpha });
  }
}
