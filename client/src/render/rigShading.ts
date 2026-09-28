import { Graphics, type Container, type Texture } from 'pixi.js';
import { CLEAR, bakedField, over, premul, writeTexel, type Premul } from './shadeRamp';
import type { BoneDef, ResolvedBoneTransform, WorldPose, WorldPositions } from './types';

// Split out of RigSkin.ts (2026-08-18, 500-line convention): the DEPTH-CUE marks a rig
// draws on top of its own flat-cel art — the sphere shading over its body bone, and the
// tint/scale shade a far-side weapon module takes. Pure geometry and pure colour maths, no
// Pixi scene state and no dependency back on RigSkin (which imports this, never the
// reverse). Everything here is what makes a 2D rig read as a lit volume rather than a
// cut-out, so it is worth having one place to tune it.
/** Depth cues stacked on top of that z-flip (2026-08-18): a module on the FAR side of the
 *  core is further from the camera, so it is drawn smaller and darker as well as behind.
 *  The z-flip alone reads as "it changed layer"; all three together read as "it orbited
 *  around a sphere", which is the whole point of the orbiting-module body plan (design/13). */
export const MODULE_BEHIND_SCALE = 0.86;
export const MODULE_BEHIND_SHADE = 0.68;

// Sphere shading (2026-08-18 depth pass, user report *"希望能再强化一下立体效果"*). The eye
// now slides and the modules now orbit, but nothing in the assembled character said its
// SHELL was a sphere rather than a disc — the art is flat-cel by design (design/13) and the
// only lighting in the scene was `NormalLitFilter`'s luminance-derived relief, which
// sharpens edges without ever establishing a form.
//
// **Rebuilt 2026-08-19 after measuring the first version in a real frame** (an A/B extract
// of the shipped hero at 11x, `shade_on`/`shade_off`). It was three marks: a white specular
// toward the key light, four concentric dark ARCS as a terminator, and a faint
// full-perimeter rim ring. Measured, all three were wrong:
//
//   1. **The specular contributed exactly nothing.** design/13's shells are near-white
//      flat-cel art — the lit cap of the hero's shell reads 255 before any shading — and a
//      0.34-alpha WHITE ellipse over white is a no-op. Value can only travel one direction
//      on white art, so the light side has to be expressed as a HUE shift (a warm wash),
//      not as a value lift. The wash also does real work on the dark, re-tinted enemy
//      bodies the same code shades, where the old white blob was merely a pale spot.
//   2. **The terminator read as a smudge, not as a curve.** Four arcs at radii 0.58-0.91
//      put the darkest band right ON the rim, with visibly hard angular cut-offs at each
//      arc's ends, so the lower-right of the shell looked dirty rather than turned-away.
//      Replaced by a full linear ramp across the body (see `drawSphereShading`), which has
//      no ends to cut off, plus a REFLECTED-LIGHT rollback that keeps the outermost sliver
//      brighter than the shadow core — the single change that most restores the crisp
//      flat-cel silhouette design/13 asks for.
//   3. **The rim ring greyed the silhouette.** A faint dark circle just inside the edge, all
//      the way round, is indistinguishable from a muddy outline at play scale. Deleted; the
//      ramp already darkens the turning-away edge, which is the only place it belonged.
//
// **Rebuilt again 2026-08-24, this time as a sampled FIELD rather than as geometry** — the
// third draw-call pass. Every mark above is a function of one normalised position on the body,
// so the whole overlay is a 2-D image, and `sphereShadeField` bakes it once into a shared
// texture that every rig in the game samples from one quad.
//
// The version this replaced was 40 non-overlapping chord bands plus 3 nested ellipses: 55 fills
// and 710 floats of geometry per rig instance, which is over Pixi v8's 400-float auto-batch line
// (`render/staticGraphics.ts`), so every actor on screen cost a draw call and a program switch
// each way — 20 of the level-1 start room's 107, at 8 live enemies, and it scaled with the enemy
// count where a level-1 room holds 15-30. One quad is 8 floats, and the texture is normalised by
// radius, so it is ONE bake for every skin and every body size rather than one per (skin, radius).
//
// The band form existed because the obvious tool did not work: Pixi 8's `FillGradient` calls
// `DOMAdapter.createCanvas()` at `fill()` time, which throws in this repo's canvas-free test
// environment, and reading the retained Graphics instruction list was how this look was
// machine-checked. `render/shadeRamp.ts` gets the same smoothness from a `BufferImageSource`,
// which needs no canvas — so the field is testable by SAMPLING it, which is a stronger check
// than counting bands was. See that module's header.
//
// Two things the bands got right and this keeps. Each band's alpha WAS its ramp value (they never
// overlapped), so the steps could not compound into the opacity banding that stacked translucent
// arcs showed on the pillars — a texel is the same guarantee, made exact. And containment: a band
// was chord-limited so every corner provably sat inside the body circle, because nothing here is
// masked and a mark outside the art paints on transparent background. The field does it by
// construction — it is zero outside `dist > 1` — which is why the old `chordBand` helper and its
// containment proof are gone rather than ported.

/** Toward the upper-left key light, y-down screen space. Shared with `NormalLitFilter`'s
 *  KEY_DIR and the pillar/wall shading — the project has exactly one light direction. */
const SHADE_KEY_ANGLE = -Math.PI * 0.75;
/** Smallest bodyR (authoring px) worth shading — below this the marks would be sub-pixel
 *  noise on screen. Filters out an orb-core socket (13) and keeps shell (40) / critter body
 *  (50) / boss core (70). */
export const SHADE_MIN_BODY_R = 24;

/** Safety margin on the DRAWN body radius the caller passes in: just inside 1.0 so an
 *  antialiased band edge can never bleed past the art's own silhouette. That is what lets the
 *  whole thing work with no mask — a mask per actor would be 30 stencil passes in a busy room.
 *
 *  **The radius has to be the drawn one, and until 2026-08-19 it was not.** `RigSkin` passed the
 *  body bone's `bodyR`, i.e. the rig's DECLARED radius, on the assumption that the art fills it.
 *  Measuring the shipped PNGs' alpha bounding boxes (`skinRegistry.BODY_FILL`) showed they paint
 *  0.68-1.00 of it, so for `critter-core` (0.70) every band outside 0.70 landed on transparent
 *  background — and since nothing is masked, that painted a hard-edged dark DISC around the
 *  crystal, visible in any 4x render and easy to mistake for an over-large ground shadow (an
 *  earlier session did exactly that). The hero's 0.81 put a fainter dark halo just outside its
 *  white shell for the same reason. */
// 0.97 -> 0.92 (2026-08-19, third look): the drawn radius is a HALF-WIDTH, and none of this art
// is a circle — `critter-core`'s crystal cluster is 35.1 wide by 38.3 tall with pointed gaps at
// the corners, so a circular ramp sized flush to its width still showed a faint arc of shading on
// the background diagonally out from it. A few percent of margin costs nothing visually and covers
// every non-circular body the same way.
export const SHADE_FIT = 0.92;
/**
 * Texels across the baked field, per axis.
 *
 * Replaces a band count (was 40 bands along the light axis), and the reasoning carries over: the
 * number is set by the largest alpha STEP between neighbouring samples, because a step is a
 * contour the eye can find and on near-white art 0.025 alpha is already ~6/255. At 40 bands the
 * worst step was ~0.02, in the reflected-light rollback — the steepest part of the curve, not the
 * terminator. At 256 samples the same worst step is ~0.003, and the GPU's linear filter makes it
 * continuous rather than merely finer.
 *
 * The other constraint is the opposite one, and it is why this is not larger: the field is
 * MAGNIFIED on screen. The biggest body here is the boss core (`bodyR` 70), drawn at world scale
 * 4, so ~515 screen px across — about 2 screen px per texel. The field's sharpest feature is its
 * own silhouette, which `sphereShadeField` antialiases analytically for exactly that reason;
 * everything else is smooth by construction and survives the magnification.
 */
export const SHADE_FIELD_TEXELS = 256;

/**
 * How far past the body radius the field (and therefore the quad sampling it) reaches.
 *
 * Not 1.0, for two reasons. The silhouette needs a texel of room OUTSIDE the circle to
 * antialias into, and `textureSpace: 'local'` maps the quad's own bounds onto the texture's full
 * 0..1 — so with the circle inscribed exactly, the edge texels would sample at the uv boundary
 * where Pixi's forced `repeat` address mode wraps (see `shadeRamp.bakedField`). A transparent
 * margin makes both non-issues: nothing at the boundary, so nothing to wrap.
 */
export const SHADE_FIELD_EXTENT = 1.04;
/** Where the terminator sits along the light axis, as a 0..1 position from the lit pole to the
 *  dark limb, and how much of the body the transition is smeared across. 0.52/0.34 puts the
 *  ramp's HALF-darkness point just past the body's centre — which is what "terminator" means —
 *  with a long soft falloff either side of it: a sphere, not a cel-shaded step. The first
 *  attempt smeared it across 84% of the body, which is so soft that the lit hemisphere itself
 *  ends up carrying a fifth of the shadow and the contrast that reads as ROUND is spent. */
export const SHADE_TERMINATOR_T = 0.52;
const SHADE_SOFTNESS = 0.34;
/** Peak darkness at the shadow core. Roughly what the old 4-arc stack reached, kept because
 *  that strength WAS right — it was its distribution that read as dirt. */
export const SHADE_MAX_ALPHA = 0.34;
/** Reflected light: past this point along the axis the ramp rolls back DOWN to
 *  `SHADE_REFLECT_KEEP` of its peak by the limb. Physically the bounce off the floor and the
 *  surrounding walls; practically the difference between a round body and a smudged one,
 *  because it leaves a lit sliver tracing the silhouette on the shadow side. */
const SHADE_REFLECT_T = 0.68;
const SHADE_REFLECT_KEEP = 0.5;
const SHADE_DARK = 0x05080f;

/** The lit side's warm wash — see note 1 above for why the light mark is a hue, not a value.
 *  Peak alpha at the lit pole, falling to zero at `SHADE_WARM_T` along the axis. */
const SHADE_WARM = 0xffd9a8;
// 0.17 -> 0.28 (2026-08-19, second look): at 0.17 a warm wash over near-white art is still
// imperceptible, i.e. the light mark was doing nothing for the second time in this file's history
// — the first time in value, this time in hue. 0.28 actually tints: the lit cap of a white shell
// reads warm against the cool shadow side, which is the whole hue-not-value idea working.
const SHADE_WARM_MAX_ALPHA = 0.28;
const SHADE_WARM_T = 0.5;

/** Underside occlusion: nested ellipses low on the body, `[centre y, rx, ry, alpha]` as
 *  fractions of the shaded radius. Symmetric in x on purpose — the form ramp above only
 *  darkens the lower RIGHT, and the measured render showed the shell's lower LEFT staying
 *  pure white right down to the silhouette, which reads as a disc lit from the side rather
 *  than as a sphere over a floor. */
export const SHADE_UNDERSIDE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.44, 0.66, 0.3, 0.07],
  [0.5, 0.55, 0.24, 0.08],
  [0.56, 0.42, 0.17, 0.09],
];

/** Contact shade where an orbiting module meets the core (`drawModuleContacts`) —
 *  `[rx, ry]` as fractions of the shaded radius, then the alpha of each nested pass. The
 *  modules hang off tethers with nothing to seat them against the shell, so at play scale
 *  they read as decals floating in front of the body rather than as objects in orbit. */
const MODULE_CONTACT_RX = 0.3;
const MODULE_CONTACT_RY = 0.19;
const MODULE_CONTACT_ALPHAS: readonly number[] = [0.1, 0.12, 0.14];

/** Multiply a hex colour by a scalar, saturating per channel — how a Pixi tint darkens a
 *  sprite without a second filter (used for the far-side module's depth shade). Exported for
 *  `RigSkin.test.ts`, which asserts the behind-tint is strictly darker than the front one. */
export function shadeHex(hex: number, factor: number): number {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 0xff) * factor)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Smooth Hermite step, the standard shading falloff — 0 below `edge0`, 1 above `edge1`, and
 *  flat-tangented at both ends so a ramp built from it has no visible start or stop. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * The AXIS ramp at parameter `t` — 0 at the lit pole, 1 at the dark limb: the warm wash and the
 * form shadow, which are functions of nothing but position along the one light direction.
 *
 * Split out from `sphereShadeAt` because it is the part that has to be SMOOTH and MONOTONE (up to
 * the reflected-light rollback), and the underside occlusion below is neither — it is a hard-edged
 * blob that the light axis passes straight through, so a profile taken along the axis of the
 * combined field is not the ramp and must not be asserted as if it were. `rigShading.test.ts`
 * checks the two separately for that reason.
 *
 * Premultiplied, and composited in the order the marks were drawn in when they were geometry,
 * because source-over is only associative in the premultiplied form (see `shadeRamp.over`).
 */
export function sphereRampAt(t: number): Premul {
  let c = CLEAR;
  const warm = sphereWarmAlpha(t);
  if (warm > 0) c = over(c, premul(SHADE_WARM, warm));
  const dark = sphereFormShadowAlpha(t);
  if (dark > 0) c = over(c, premul(SHADE_DARK, dark));
  return c;
}

/**
 * The WARM wash's alpha at `t` — the lit side's mark, and a hue rather than a value because value
 * has nowhere to go on near-white art (see note 1 in the file header). Peaks at the lit pole and
 * is gone by `SHADE_WARM_T`.
 *
 * Exported separately from `sphereFormShadowAlpha` because the two terms overlap in `t` and every
 * property worth asserting belongs to one or the other: the composite alpha of the pair is a U —
 * 0.28 of warm at the lit pole, near nothing at the terminator, 0.34 of shadow past it — so a
 * "monotone" or "largest step" assertion on the composite is asserting the wrong function. When
 * these marks were geometry the tests separated them by FILL COLOUR; this is that split, made
 * explicit.
 */
export function sphereWarmAlpha(t: number): number {
  if (t >= SHADE_WARM_T) return 0;
  return (1 - t / SHADE_WARM_T) * SHADE_WARM_MAX_ALPHA;
}

/**
 * The FORM SHADOW's alpha at `t`, with the reflected-light rollback at the limb.
 *
 * Both curves are smoothstepped, including the rollback: a LINEAR rollback over the last sliver of
 * the body is by far the steepest thing in the ramp and would read as a hard contour parallel to
 * the rim — the exact defect the 2026-08-19 rebuild exists to remove.
 */
export function sphereFormShadowAlpha(t: number): number {
  const dark = smoothstep(SHADE_TERMINATOR_T - SHADE_SOFTNESS, SHADE_TERMINATOR_T + SHADE_SOFTNESS, t)
    * (1 - (1 - SHADE_REFLECT_KEEP) * smoothstep(SHADE_REFLECT_T, 1, t));
  return dark > 0.001 ? dark * SHADE_MAX_ALPHA : 0;
}

/**
 * The shading value at one normalised point on the body — `(nx, ny)` in units of the shaded
 * radius, so the body circle is `hypot(nx, ny) <= 1` and the key light comes from the upper left.
 *
 * **Deliberately UNMASKED**: it answers "what is the shading here" for any point, including
 * outside the circle, and `sphereShadeField` is what multiplies in the silhouette. Keeping the
 * mask out of here is not a detail — it is what lets the field antialias the rim across a texel in
 * BOTH directions. An early version returned transparent outside the circle, which cut the feather
 * off at its own midpoint (the outer half of every straddling texel went to zero regardless of
 * coverage) and, worse, made the containment test below pass for the wrong reason: there was
 * nothing outside the circle to contain.
 *
 * Exported because it IS the look: a test can ask what the shading does at any point on the body
 * instead of counting the bands some implementation happened to split it into.
 */
export function sphereShadeAt(nx: number, ny: number): Premul {
  // Position along the light axis, 0 at the lit pole and 1 at the dark limb. The ramp runs AWAY
  // from the key light, which is what makes the terminator a position on that axis rather than an
  // arc with ends that can be seen cutting off.
  const away = SHADE_KEY_ANGLE + Math.PI;
  const t = 0.5 + (nx * Math.cos(away) + ny * Math.sin(away)) / 2;
  let c = sphereRampAt(t);
  // Underside occlusion, nested and symmetric in x. Still hard-edged, as it was when these were
  // three `ellipse` fills — at alpha 0.07-0.09 the edges are well under the visible threshold, and
  // sampling actually softens them by a texel rather than sharpening them.
  for (const [cy, rx, ry, alpha] of SHADE_UNDERSIDE) {
    const ex = nx / rx;
    const ey = (ny - cy) / ry;
    if (ex * ex + ey * ey <= 1) c = over(c, premul(SHADE_DARK, alpha));
  }
  return c;
}

/**
 * The whole sphere overlay as one shared texture: `sphereShadeAt` sampled over the body's
 * bounding square and multiplied by the silhouette's own antialiased coverage.
 *
 * Normalised by radius, so there is exactly one of these for the entire game however many skins
 * and body sizes exist — which is the difference between this and baking per (skin, radius), and
 * the reason it needs no renderer and works in a test. The cache key is a constant for the same
 * reason: every input is a module constant, so there is only ever one field to build.
 */
export function sphereShadeField(): Texture {
  return bakedField('rig-sphere', SHADE_FIELD_TEXELS, SHADE_FIELD_TEXELS, (rgba, w, h) => {
    // Texels per unit of normalised radius — i.e. the width of one texel at the silhouette, which
    // is what the edge is feathered over.
    const perUnit = w / (2 * SHADE_FIELD_EXTENT);
    for (let j = 0; j < h; j++) {
      const ny = ((j + 0.5) / h * 2 - 1) * SHADE_FIELD_EXTENT;
      for (let i = 0; i < w; i++) {
        const nx = ((i + 0.5) / w * 2 - 1) * SHADE_FIELD_EXTENT;
        // Analytic coverage across the silhouette, centred ON the circle so it feathers equally
        // either side of it. Vector fills got this from the rasteriser; a sampled field has to say
        // it, and it matters here because the outermost ramp value is NOT zero — the
        // reflected-light sliver is the brightest thing on the shadow side — so the circle's edge
        // is a real alpha step, and an un-feathered one reads as a chunky rim at 4x world scale.
        const cover = Math.max(0, Math.min(1, (1 - Math.hypot(nx, ny)) * perUnit + 0.5));
        if (cover <= 0) continue;
        const c = sphereShadeAt(nx, ny);
        writeTexel(rgba, j * w + i, { r: c.r * cover, g: c.g * cover, b: c.b * cover, a: c.a * cover });
      }
    }
  });
}

/**
 * The static sphere-shading overlay for a body whose ART is drawn out to `drawnR` (authoring
 * px — the body bone's `bodyR` times how much of it the bundle actually paints), centred on
 * (0,0) — a warm wash on the lit side, a smooth form-shadow ramp falling away from the key
 * light with a reflected-light sliver at the limb, and an underside occlusion.
 *
 * One quad sampling `sphereShadeField`. See the file header for why each mark is the shape it is,
 * `SHADE_*` for the tuning, and `sphereShadeAt` for the marks themselves.
 *
 * Still a `Graphics` rather than a `Sprite`, deliberately: `RigSkin` counter-flips this against
 * the rig's own mirror by writing `scale.x = flipX`, and on a Graphics that mirrors the quad's
 * local geometry while leaving its size alone. A Sprite sized by `width`/`height` would have that
 * write throw the size away.
 */
export function drawSphereShading(drawnR: number): Graphics {
  const g = new Graphics();
  const q = drawnR * SHADE_FIT * SHADE_FIELD_EXTENT;
  g.rect(-q, -q, 2 * q, 2 * q).fill({ texture: sphereShadeField(), textureSpace: 'local' });
  return g;
}

/**
 * Repaint `g` with one contact shade per orbiting module mount — `mounts` are the module
 * positions in the same body-centred space `drawSphereShading` draws in, i.e. the socket
 * bone tips relative to the body bone's tip.
 *
 * Each mount gets nested ellipses squashed toward the body's surface and pulled back TOWARD
 * the core, so the dark side of the blob is the side the module overlaps.
 *
 * **Geometry once, position per frame (2026-09-28).** A contact's ellipses depend only on the
 * body's drawn radius; what the orbiting module changes every frame is where they sit. So each
 * mount owns one child Graphics of `layer`, built once around its own origin and then only
 * moved. The version before cleared and refilled every ellipse of every mount per frame — the
 * mounts orbit, so that was every frame — and a refilled Graphics is re-triangulated on its next
 * render: ~32 KB of garbage a frame for one player, the second-largest source in a run.
 */
/**
 * Repaint one rig's module contact shades from this frame's posed bones — the GATHERING half of
 * `drawModuleContacts` below, which only knows how to paint a list of mount points.
 *
 * Everything is computed in the BODY BONE's own space (the same space `drawSphereShading` draws
 * in) and the whole overlay is then positioned at that bone, so it rides the body's hover bob
 * exactly as the sphere shading does instead of sliding against it.
 *
 * Moved out of `RigSkin.updateModuleContacts` (2026-09-02, 500-line convention) as form (1): it
 * is pure geometry over a posed rig plus a caller-owned `Graphics`, the same shape as
 * `rigTethers.drawTethers` and as the painter it delegates to, and it never needed anything
 * from `RigSkin` beyond the six values it is now handed.
 */
/**
 * Seat the sphere-shading quad on the body bone it shades, for this frame (`RigSkin.update`).
 * Split out here beside `paintModuleContacts` for the same reason that one is here: it is a mark
 * the rig DRAWS over its authored art, and placing it is pure geometry over one bone's pose.
 *
 * All four properties come off that ONE bone, which is the point — the quad is a mark on the
 * body, so anything the body's clip does to itself it has to do too:
 *
 *   - position: the bone's TIP plus the clip's translate (`computeFK` folds a clip's rotation
 *     into a tip but not its translation, so the idle hover bob has to be re-added here);
 *   - alpha: the bone's own, so the shade fades out with the art it sits on;
 *   - scale: the bone's own squash, times `flipX`. The flip is the ONE thing that must NOT come
 *     from the body: the key light is fixed in SCREEN space, so counter-flipping cancels
 *     `RigSkin.view.scale.x` exactly and leaves the highlight upper-left whichever way the
 *     character faces. The squash half of it landed with the `death` clip (2026-09-02), which
 *     collapses the body to 0.4x0.3 and holds it there for the whole dissolve — a fixed-size
 *     shade over that read as a dark plate beside a shrinking corpse.
 *
 * An unposed bone hides the quad rather than leaving it at last frame's place.
 */
export function placeSphereShade(
  g: Graphics,
  pose: WorldPose | undefined,
  transform: ResolvedBoneTransform | undefined,
  flipX: 1 | -1,
): void {
  if (!pose) {
    g.visible = false;
    return;
  }
  g.visible = true;
  g.x = pose.ex + (transform?.translateX ?? 0);
  g.y = pose.ey + (transform?.translateY ?? 0);
  g.alpha = transform?.alpha ?? 1;
  g.scale.set(flipX * (transform?.scaleX ?? 1), transform?.scaleY ?? 1);
}

export function paintModuleContacts(
  g: Container,
  shadeBoneId: string,
  boneDefs: readonly BoneDef[],
  worldPose: WorldPositions,
  transforms: ReadonlyMap<string, ResolvedBoneTransform>,
  drawnR: number,
): void {
  const body = worldPose.get(shadeBoneId);
  if (!body) {
    g.visible = false;
    return;
  }
  const bodyTransform = transforms.get(shadeBoneId);
  const bx = body.ex + (bodyTransform?.translateX ?? 0);
  const by = body.ey + (bodyTransform?.translateY ?? 0);
  const mounts: Array<{ x: number; y: number }> = [];
  for (const bone of boneDefs) {
    if (!bone.outerW || !bone.innerW) continue;
    const pose = worldPose.get(bone.id);
    const t = transforms.get(bone.id);
    if (!pose || (t?.alpha ?? 1) <= 0) continue;
    // `+ translate` for the same reason RigSkin's sprite loop does it: `computeFK` folds a
    // clip's ROTATION into a bone's tip but not its translation, so a module the attack clip
    // slides would otherwise leave its contact shade behind.
    mounts.push({ x: pose.ex + (t?.translateX ?? 0) - bx, y: pose.ey + (t?.translateY ?? 0) - by });
  }
  g.visible = true;
  g.position.set(bx, by);
  g.alpha = bodyTransform?.alpha ?? 1;
  drawModuleContacts(g, mounts, drawnR);
}

/** The drawn radius each contact Graphics was last BUILT for — see `drawModuleContacts`. */
const builtFor = new WeakMap<Graphics, number>();

export function drawModuleContacts(layer: Container, mounts: ReadonlyArray<{ x: number; y: number }>, drawnR: number): void {
  const r = drawnR * SHADE_FIT;
  const rx = r * MODULE_CONTACT_RX;
  while (layer.children.length < mounts.length) layer.addChild(new Graphics());
  layer.children.forEach((child, i) => {
    const g = child as Graphics;
    const m = mounts[i];
    const len = m ? Math.hypot(m.x, m.y) : 0;
    if (!m || len < 0.001) {
      g.visible = false;
      return;
    }
    if (builtFor.get(g) !== drawnR) {
      builtFor.set(g, drawnR);
      g.clear();
      for (let k = 0; k < MODULE_CONTACT_ALPHAS.length; k++) {
        const scale = 1 - k * 0.28;
        g.ellipse(0, 0, rx * scale, r * MODULE_CONTACT_RY * scale).fill({ color: SHADE_DARK, alpha: MODULE_CONTACT_ALPHAS[k]! });
      }
    }
    // Clamp the centre so the whole ellipse stays inside the body — a module hangs off a socket
    // bone whose TIP is well outside the shell (orb-core: socket len 52 vs shell bodyR 40), so
    // an unclamped blob would sit mostly on transparent background and paint a dark smudge
    // beside the character instead of a contact shade on it. Same invariant the ramp above
    // holds, and `rigShading.test.ts` checks both the same way.
    const reach = Math.min(len, Math.max(0, r - rx));
    g.visible = true;
    g.position.set((m.x / len) * reach, (m.y / len) * reach);
  });
}
