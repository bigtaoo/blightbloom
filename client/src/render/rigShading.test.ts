/**
 * `rigShading` — the depth-cue marks a rig draws on top of its own flat-cel art (2026-08-18,
 * user report *"希望能再强化一下立体效果"*). Split out of RigSkin.ts; `RigSkin.test.ts` covers
 * how they are wired into the rig, this file covers the geometry and colour maths.
 *
 * **Rewritten 2026-08-19** with the marks themselves (see `rigShading.ts`'s header for the
 * measured A/B that replaced a white specular + four dark arcs + a rim ring with a warm wash,
 * a smooth chord-band ramp and an underside occlusion). The properties worth machine-checking
 * are the ones a hand-tuned constant can silently break:
 *
 *   - every mark stays strictly INSIDE the body radius (nothing may spill onto the transparent
 *     background — which is what lets this work with no mask at all);
 *   - the light has ONE direction, and the warm side and the dark side oppose it;
 *   - the ramp is monotonic and its steps are small enough to be invisible;
 *   - the reflected-light rollback exists, i.e. the darkest point is NOT the outermost one. That
 *     is the difference between a body that reads as round and one that reads as smudged, and
 *     it is a single constant away from silently disappearing.
 *
 * **Re-pointed 2026-08-24** at the FIELD rather than at the geometry. The overlay used to be 40
 * chord bands and 3 ellipses, so every property above was asserted by reading the bands back off
 * `context.instructions` and comparing neighbours; it is now one quad sampling a baked texture
 * (`sphereShadeField`), so the same properties are asserted by SAMPLING — which is strictly more
 * direct, since a band comparison could only ever see band centres. Two of them get sharper as a
 * result: "steps too small to see" is now a bound on the texel-to-texel step of the shipped
 * texture, and "inside the body radius" is checked over every texel rather than over band corners.
 * The perf claim the rewrite was for has its own test at the bottom of the sphere section.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, type Graphics } from 'pixi.js';
import {
  drawModuleContacts,
  drawSphereShading,
  paintModuleContacts,
  placeSphereShade,
  shadeHex,
  sphereFormShadowAlpha,
  sphereShadeAt,
  sphereShadeField,
  sphereWarmAlpha,
  MODULE_BEHIND_SCALE,
  MODULE_BEHIND_SHADE,
  SHADE_FIELD_EXTENT,
  SHADE_FIELD_TEXELS,
  SHADE_FIT,
  SHADE_MAX_ALPHA,
  SHADE_MIN_BODY_R,
  SHADE_TERMINATOR_T,
  SHADE_UNDERSIDE,
} from './rigShading';
import { AUTO_BATCH_VERTEX_LIMIT } from '../perf/drawAttribution';
import { GraphicsContextSystem } from 'pixi.js';
import { BODY_FILL, RIG_DEFS } from './skinRegistry';
import type { BoneDef, ResolvedBoneTransform } from './types';

/**
 * Pixi's own batching decision, run for real against the smallest fake renderer
 * `GraphicsContextSystem` will accept. Duplicated from `staticGraphics.test.ts`, which is where the
 * 400-float rule itself is pinned — this file only asks the question of the shipped rigs.
 */
function contextSystem(): GraphicsContextSystem {
  const renderer = {
    uid: 1,
    limits: { maxBatchableTextures: 16 },
    gc: { addResourceHash: () => undefined, now: 0 },
  } as never;
  return new GraphicsContextSystem(renderer);
}

interface Instr {
  action: string;
  data: {
    style?: { color: number; alpha: number };
    path?: { instructions: Array<{ action: string; data: number[] }> };
  };
}

const instructions = (g: Graphics): Instr[] => g.context.instructions as Instr[];

/**
 * Every filled shape in `g`, as `{ color, alpha, kind, data }` where `data` is flattened x,y
 * pairs for a poly and `[cx, cy, rx, ry]` for an ellipse.
 *
 * Pixi's retained path instructions are not uniform: a `poly` carries `[points[], close, matrix]`
 * so its points are nested one level down, an `ellipse` carries `[cx, cy, rx, ry, matrix]` and is
 * preceded by a bookkeeping `moveTo`. Normalizing here is what lets the assertions below read as
 * geometry rather than as index arithmetic.
 */
function fills(g: Graphics): Array<{ color: number; alpha: number; kind: string; data: number[] }> {
  const out: Array<{ color: number; alpha: number; kind: string; data: number[] }> = [];
  for (const i of instructions(g)) {
    if (i.action !== 'fill') continue;
    for (const pi of i.data.path?.instructions ?? []) {
      const raw = pi.data as unknown[];
      if (pi.action === 'poly') {
        out.push({ color: i.data.style!.color, alpha: i.data.style!.alpha, kind: 'poly', data: raw[0] as number[] });
      } else if (pi.action === 'ellipse') {
        out.push({
          color: i.data.style!.color,
          alpha: i.data.style!.alpha,
          kind: 'ellipse',
          data: (raw as number[]).slice(0, 4),
        });
      }
    }
  }
  return out;
}

/** `fills`, over every showing contact Graphics of a `drawModuleContacts` layer, with each child's
 *  position folded into its ellipses' centres — i.e. the drawing in the layer's own space, which is
 *  what these assertions were written against before each mount got its own Graphics. */
function contactFills(layer: Container): Array<{ color: number; alpha: number; kind: string; data: number[] }> {
  return (layer.children as Graphics[])
    .filter((g) => g.visible)
    .flatMap((g) => fills(g).map((f) => ({ ...f, data: [f.data[0]! + g.x, f.data[1]! + g.y, ...f.data.slice(2)] })));
}

/** Unit vector toward the key light (upper-left, y-down screen space) — restated here rather
 *  than imported, so a sign flip in `SHADE_KEY_ANGLE` fails a test instead of moving it. */
const KEY = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

/**
 * The baked field's own texels, straight off the shipped texture — non-premultiplied back, so an
 * assertion can talk about "alpha" and "hue" the way the constants are written.
 *
 * Reading the TEXTURE rather than calling `sphereShadeAt` is deliberate for the properties that
 * are about what ships: it covers the sampling grid, the silhouette feather and the 8-bit
 * quantisation as well as the maths. `sphereShadeAt` is used where the assertion is about the
 * maths at an exact point.
 */
function fieldTexel(nx: number, ny: number): { r: number; g: number; b: number; a: number } {
  const N = SHADE_FIELD_TEXELS;
  const to = (n: number) => Math.min(N - 1, Math.max(0, Math.round(((n / SHADE_FIELD_EXTENT + 1) / 2) * N - 0.5)));
  const buf = sphereShadeField().source.resource as Uint8Array;
  const o = (to(ny) * N + to(nx)) * 4;
  const a = buf[o + 3]! / 255;
  const un = (v: number) => (a > 0 ? Math.min(1, v / 255 / a) : 0);
  return { r: un(buf[o]!), g: un(buf[o + 1]!), b: un(buf[o + 2]!), a };
}

/** The far end of the one light axis — where the ramp runs TO. */
const AWAY = { x: -KEY.x, y: -KEY.y };
/**
 * The FORM SHADOW's alpha at parameter `t` along the light axis: 0 is the lit pole, 1 the dark
 * limb. This is the "ramp" every assertion below about smoothness, monotonicity and the
 * reflected-light rollback is really about.
 *
 * Two things it deliberately is NOT. Not the shading at that point along the axis: the underside
 * occlusion is a hard-edged blob low on the body and this axis runs diagonally straight through
 * it, so the combined profile is a ramp with three steps cut into it. And not the composite of the
 * two washes: the warm one peaks at `t = 0` and the shadow past the terminator, so their combined
 * alpha is a U and "monotone" would be false of it by design. When these marks were geometry the
 * tests separated them by FILL COLOUR; picking the term is the same thing.
 */
const alphaAtT = (t: number) => sphereFormShadowAlpha(t);

describe('drawSphereShading — the marks that make a flat-cel body read as a sphere', () => {
  it('keeps every mark strictly inside the body radius, so none can spill past the silhouette', () => {
    // The whole reason no mask/clip is needed (a mask per actor would be 30 stencil passes in
    // a busy room). If a tuning change pushed the ramp or the underside occlusion past the rim,
    // it would render as a grey/warm blob on transparent background outside the character.
    for (const bodyR of [24, 40, 50, 70]) {
      const b = drawSphereShading(bodyR).bounds;
      const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
      expect(reach).toBeLessThanOrEqual(bodyR);
    }
  });

  it('paints nothing at all outside the body circle, over every texel of the field', () => {
    // The containment guarantee, checked exhaustively rather than at the corners of 40 bands,
    // which is all the geometry version could do. The quad the field is sampled through is
    // SQUARE, so its corners reach 1.41x the radius: everything out there has to be transparent,
    // or the overlay paints on the transparent background diagonally out from the body — the
    // exact defect `SHADE_FIT` exists for.
    const N = SHADE_FIELD_TEXELS;
    const buf = sphereShadeField().source.resource as Uint8Array;
    const texel = (2 * SHADE_FIELD_EXTENT) / N; // one texel, in units of the body radius
    let outsideLit = 0;
    let insideLit = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const nx = ((i + 0.5) / N) * 2 * SHADE_FIELD_EXTENT - SHADE_FIELD_EXTENT;
        const ny = ((j + 0.5) / N) * 2 * SHADE_FIELD_EXTENT - SHADE_FIELD_EXTENT;
        const a = buf[(j * N + i) * 4 + 3]!;
        // A texel STRADDLING the rim is legitimately part-covered — that is the antialias.
        if (Math.hypot(nx, ny) > 1 + texel) {
          if (a > 0) outsideLit++;
        } else if (a > 0) insideLit++;
      }
    }
    expect(outsideLit).toBe(0);
    expect(insideLit).toBeGreaterThan(N * N * 0.5); // ...and the body itself is not blank
  });

  it('leaves a real margin at the rim rather than sitting flush against it', () => {
    // The caller passes the DRAWN radius, which is a half-WIDTH, and none of this art is a circle:
    // `critter-core`'s crystal cluster is 35 wide by 38 tall with gaps at its corners, so a ramp
    // flush to that width still showed a faint arc of shading on the background diagonally out
    // from it. A margin here is what covers every non-circular body at once.
    const bodyR = 40;
    const b = drawSphereShading(bodyR).bounds;
    const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
    expect(reach).toBeLessThan(bodyR * 0.98);
    expect(reach).toBeGreaterThan(bodyR * 0.85); // ...and not so shy that the limb stops reading
    // The margin is SHADE_FIT, widened by the field's own transparent border — which must not be
    // allowed to eat into it, hence both bounds above and not just the upper one.
    expect(reach).toBeCloseTo(bodyR * SHADE_FIT * SHADE_FIELD_EXTENT, 6);
  });

  it('draws real geometry, scaled with the body it is given', () => {
    const small = drawSphereShading(24).bounds;
    const big = drawSphereShading(70).bounds;
    expect(small.width).toBeGreaterThan(0);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(70 / 24, 1);
  });

  it('batches for every body in the shipped roster, per real Pixi', () => {
    // The perf claim, asked of the actual content rather than of a radius someone typed into a
    // test: every skin's drawn body radius is its rig's own `bodyR` times the share of it the
    // bundle really paints (`BODY_FILL`, measured off the PNGs). Seven skins across three rigs,
    // 27.2 to 50 authoring px. The 40-band form was 710 floats at every one of them — a draw call
    // and two program switches per actor on screen, scaling with the enemy count.
    const sys = contextSystem();
    const names = Object.keys(BODY_FILL);
    expect(names.length).toBeGreaterThanOrEqual(7); // the sweep is a sweep
    for (const name of names) {
      const rig = RIG_DEFS[name];
      expect(rig, `${name} resolves to a rig`).toBeDefined();
      const drawnR = rig!.referenceRadius * BODY_FILL[name]!;
      const gpu = sys.updateGpuContext(drawSphereShading(drawnR).context);
      const floats = gpu.geometryData.vertices.length;
      expect(gpu.isBatchable, `${name} (drawnR ${drawnR.toFixed(1)}, ${floats} floats)`).toBe(true);
      // One quad, and the same quad regardless of radius — the field is normalised, so a bigger
      // body costs no more geometry. That is what makes the boss affordable.
      expect(floats).toBe(8);
    }
    // ...and all of them share the one bake, which is what puts them in the same batch.
    expect(sphereShadeField()).toBe(sphereShadeField());
  });

  it('paints the POLES of the light axis, which the chord-band form left bare', () => {
    // Found by diffing this against the 40-band version it replaced (2026-08-24): every pixel that
    // changed by more than 20/255 sat at 0.8-1.0 of the radius and at one of the two POLES of the
    // light axis — 537 at the lit one, 474 at the dark one, 38 anywhere else.
    //
    // The cause is in the bands' own construction. A chord band spanning [d0, d1] took its
    // half-width from whichever edge was FURTHER from the centre, so that every corner provably
    // sat inside the circle — correct, and increasingly conservative toward a pole, where the chord
    // shrinks fastest. The two outermost bands of 40 had a half-width of EXACTLY ZERO: 3.6% of
    // every body circle, in two crescents at the poles, was never painted at all. At the lit pole
    // that is where the warm wash peaks and at the dark limb it is the reflected-light sliver — the
    // two marks whose whole job is to trace the silhouette.
    //
    // A sampled field has no such construction, so this is a property to keep rather than a bug to
    // remember: shading must reach all the way to the rim at both ends of the axis.
    const nearPole = 0.95;
    for (const k of [KEY, AWAY]) {
      const at = fieldTexel(k.x * nearPole, k.y * nearPole);
      expect(at.a).toBeGreaterThan(0.05);
    }
  });

  it("keeps a transparent border around the field, so the quad's own edge is never sampled", () => {
    // Reaching the rim at the poles (above) and mapping the quad's bounds to the texture's full
    // 0..1 (`textureSpace: 'local'`) are in tension: with the circle inscribed EXACTLY, the shading
    // would be non-zero at the uv boundary, where Pixi's forced `repeat` address mode wraps a
    // linear sample onto the opposite edge. `SHADE_FIELD_EXTENT` buys the margin that makes both
    // safe, and neither symptom would look like a wrapped texture — it would look like a faint
    // stray arc beside the character.
    expect(SHADE_FIELD_EXTENT).toBeGreaterThan(1);
    const N = SHADE_FIELD_TEXELS;
    const buf = sphereShadeField().source.resource as Uint8Array;
    const alphaAt = (i: number, j: number) => buf[(j * N + i) * 4 + 3]!;
    for (let i = 0; i < N; i++) {
      expect(alphaAt(i, 0)).toBe(0); // top row
      expect(alphaAt(i, N - 1)).toBe(0); // bottom row
      expect(alphaAt(0, i)).toBe(0); // left column
      expect(alphaAt(N - 1, i)).toBe(0); // right column
    }
  });

  it('is ONE batchable quad per rig, sharing a single field texture with every other rig', () => {
    // The reason for the 2026-08-24 rewrite, stated as the thing that would silently regress.
    // Pixi v8 auto-batches a Graphics only under AUTO_BATCH_VERTEX_LIMIT floats; the 40-band
    // version was 710, so every actor on screen cost a draw call plus a program switch each way
    // — and it scaled with the enemy count, which a level-1 room puts at 15-30.
    const g = drawSphereShading(40);
    const fillInstrs = instructions(g).filter((i) => i.action === 'fill');
    expect(fillInstrs).toHaveLength(1);
    const rects = fillInstrs[0]!.data.path!.instructions.filter((p) => p.action === 'rect');
    expect(rects).toHaveLength(1); // one quad: 4 corners, 8 floats
    expect(8).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT);
    // 'local', so the field is mapped onto the quad's own bounds and therefore scales with the
    // body. 'global' would map it in world texels — one fixed-size patch wherever the actor
    // happens to stand, which is a different bug at every position on the map.
    const style = fillInstrs[0]!.data.style as unknown as { textureSpace?: string };
    expect(style.textureSpace).toBe('local');
    // Normalised by radius, so it is one bake for the whole game — not one per (skin, radius),
    // which is what makes it shareable across every actor in the room and hence batchable.
    expect(sphereShadeField()).toBe(sphereShadeField());
    const texOf = (r: number) =>
      (instructions(drawSphereShading(r))[0]!.data.style as unknown as { texture: unknown }).texture;
    expect(texOf(24)).toBe(texOf(70));
  });
});

describe('drawSphereShading — the light has one direction, and the two washes oppose it', () => {
  it("puts the WARM wash on the key-light side — upper left, the project's one direction", () => {
    // Shared with NormalLitFilter's KEY_DIR and the pillar/wall shading. The light mark is warm
    // rather than white because design/13's shells are near-white flat-cel art: measured at 255
    // before any shading, so a white specular over them is arithmetically a no-op. Hue is the
    // only channel left, and it also does real work on the dark re-tinted enemy bodies.
    const lit = fieldTexel(KEY.x * 0.7, KEY.y * 0.7);
    expect(lit.a).toBeGreaterThan(0.1);
    expect(lit.r).toBeGreaterThan(lit.b + 0.1); // warm: red over blue, i.e. a hue and not a value
    // ...and the far side carries no warmth at all.
    const dark = fieldTexel(AWAY.x * 0.7, AWAY.y * 0.7);
    expect(dark.r).toBeLessThan(dark.b);
  });

  it('puts the form shadow on the diametrically OPPOSITE side, toward the lower right', () => {
    // A smooth ramp deliberately starts before the terminator, so faint darkening DOES reach the
    // lit side. What must hold is that HALF-DARKNESS sits past the body's centre — that is what
    // the word terminator means, and `SHADE_TERMINATOR_T` is where it is put.
    expect(SHADE_TERMINATOR_T).toBeGreaterThan(0.5);
    expect(alphaAtT(SHADE_TERMINATOR_T)).toBeCloseTo(SHADE_MAX_ALPHA / 2, 3);
    // Half-darkness is crossed ONCE, and past the centre — the ramp climbs monotonically to it.
    const crossings = Array.from({ length: 1000 }, (_, i) => i / 999)
      .filter((t, i, all) => i > 0 && alphaAtT(t) >= SHADE_MAX_ALPHA / 2 && alphaAtT(all[i - 1]!) < SHADE_MAX_ALPHA / 2);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!).toBeGreaterThan(0.5);
    // ...and nothing SUBSTANTIAL lands on the light's own side. The previous form of this check
    // compared "over half the peak" against t > 0.5 and passed only because its 40-band grid
    // never sampled t = 0.5: the rollback pulls the peak down to ~0.297, so half of THAT is
    // crossed at t = 0.487, marginally on the lit side. Half of the ramp's own scale is the
    // number the terminator is defined against, and it lands where the constant says.
    expect(alphaAtT(0.25)).toBeLessThan(SHADE_MAX_ALPHA * 0.15);
    expect(alphaAtT(0.85)).toBeGreaterThan(alphaAtT(0.15)); // and the shadow side is the darker one
    // The warm wash is the mirror statement, on the other term: it exists only on the lit side.
    expect(sphereWarmAlpha(0.15)).toBeGreaterThan(0);
    expect(sphereWarmAlpha(0.85)).toBe(0);
  });

  it('holds the two washes a full 180° apart, not merely on different sides', () => {
    // A single sign error in SHADE_KEY_ANGLE would stack both on one side, which reads as a
    // smudge rather than as a lit form — and would still pass a looser "opposite sides" check.
    // Read as the alpha-weighted centroid of the warm mark and of the dark one over the field.
    const N = 64;
    const wc = { x: 0, y: 0, m: 0 };
    const dc = { x: 0, y: 0, m: 0 };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const nx = ((i + 0.5) / N) * 2 - 1;
        const ny = ((j + 0.5) / N) * 2 - 1;
        if (Math.hypot(nx, ny) > 1) continue;
        // Weighted by each TERM rather than by the composite: where the shadow overlays the
        // wash, the blend's own hue no longer says which mark put it there, and the underside
        // occlusion (symmetric, low on the body) is not part of the directional lighting at all.
        const t = 0.5 + (nx * AWAY.x + ny * AWAY.y) / 2;
        const warm = sphereWarmAlpha(t);
        const dark = sphereFormShadowAlpha(t);
        wc.x += nx * warm; wc.y += ny * warm; wc.m += warm;
        dc.x += nx * dark; dc.y += ny * dark; dc.m += dark;
      }
    }
    expect(wc.m).toBeGreaterThan(0);
    expect(dc.m).toBeGreaterThan(0);
    const dot = (wc.x * dc.x + wc.y * dc.y) / (Math.hypot(wc.x, wc.y) * Math.hypot(dc.x, dc.y));
    expect(dot).toBeCloseTo(-1, 6);
  });
});

describe('drawSphereShading — the ramp is smooth, and it rolls back at the limb', () => {
  it('steps the form shadow up in alpha by amounts too small to see', () => {
    // A step is a contour the eye can find, and on near-white art 0.025 alpha is already ~6/255.
    // The 40-band version's worst step was ~0.02, in the reflected-light rollback; sampling at
    // SHADE_FIELD_TEXELS puts the same worst step an order of magnitude lower. This is the
    // assertion that pins the resolution constant.
    const N = SHADE_FIELD_TEXELS;
    let worst = 0;
    for (let i = 1; i < N; i++) {
      worst = Math.max(worst, Math.abs(alphaAtT(i / (N - 1)) - alphaAtT((i - 1) / (N - 1))));
    }
    expect(worst).toBeLessThan(0.005);
  });

  it('ramps UP monotonically until the reflected-light rollback, then back DOWN', () => {
    const N = 200;
    const alphas = Array.from({ length: N }, (_, i) => alphaAtT(i / (N - 1)));
    const peak = alphas.indexOf(Math.max(...alphas));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(N - 1); // NOT the limb — that is the point
    for (let i = 1; i <= peak; i++) expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]! - 1e-12);
    for (let i = peak + 1; i < N; i++) expect(alphas[i]!).toBeLessThan(alphas[i - 1]! + 1e-12);
  });

  it('leaves the outermost sliver of the shadow side visibly lighter than the shadow core', () => {
    // Reflected light. Physically the bounce off the floor and the walls; practically the
    // difference between a round body and a smudged one, because it leaves a lit edge tracing
    // the silhouette. The old version put its DARKEST arc at 0.91 of the radius — right on the
    // rim — and measured as a dirty outline.
    const alphas = Array.from({ length: 200 }, (_, i) => alphaAtT(i / 199));
    const last = alphas.at(-1)!;
    expect(last).toBeLessThan(Math.max(...alphas) * 0.75);
    expect(last).toBeGreaterThan(0); // still in shadow, just not the darkest part of it
  });

  it('strengthens the shadow enough to survive near-white flat-cel art', () => {
    // design/13's shells are near-white, and the first tuning (terminator alphas 0.20 down to
    // 0.08) was invisible over them in a 7x render. This is a floor on that lesson.
    const alphas = Array.from({ length: 200 }, (_, i) => alphaAtT(i / 199));
    expect(Math.max(...alphas)).toBeGreaterThan(0.25);
  });

  it('adds an underside occlusion, symmetric in x and low on the body', () => {
    // The form ramp only darkens the lower RIGHT. Measured, the shell's lower LEFT stayed pure
    // white right down to the silhouette, which reads as a disc lit from the side rather than as
    // a sphere sitting over a floor. This occlusion is the other half of that.
    expect(SHADE_UNDERSIDE.length).toBeGreaterThanOrEqual(3);
    for (const [cy, rx, ry] of SHADE_UNDERSIDE) {
      expect(cy).toBeGreaterThan(0); // y-down: low on the body
      expect(rx).toBeGreaterThan(ry); // squashed, like every other round thing in this tilted view
    }
    // ...and its EFFECT, which is the half a constant table cannot show: the lower LEFT — the
    // quadrant the directional ramp does not touch — comes out darker than the upper left.
    expect(sphereShadeAt(-0.4, 0.45).a).toBeGreaterThan(sphereShadeAt(-0.4, -0.45).a);
    // Symmetric in x: mirroring a point about the body's vertical axis must not change how much
    // of THIS mark it gets. Checked as the difference from the mirrored point's ramp value, since
    // the directional ramp itself is deliberately not symmetric.
    const under = (nx: number, ny: number) => sphereShadeAt(nx, ny).a - sphereShadeAt(nx, -ny).a;
    expect(under(0.35, 0.5)).toBeGreaterThan(0);
    expect(under(-0.35, 0.5)).toBeGreaterThan(0);
  });

  it('draws no pure-white mark at all, since white over near-white art is a no-op', () => {
    // Value has nowhere to go on art that already reads 255, so every mark has to be a hue shift
    // or a darkening. A NEUTRAL texel anywhere would be the old white-specular bug returning.
    const pts: Array<[number, number]> = [
      [KEY.x * 0.9, KEY.y * 0.9],
      [KEY.x * 0.4, KEY.y * 0.4],
      [AWAY.x * 0.5, AWAY.y * 0.5],
      [AWAY.x * 0.9, AWAY.y * 0.9],
    ];
    for (const [nx, ny] of pts) {
      const c = sphereShadeAt(nx, ny);
      if (c.a <= 0.001) continue;
      expect(Math.abs(c.r / c.a - c.b / c.a)).toBeGreaterThan(0.02);
    }
  });
});

describe('drawModuleContacts — seating an orbiting module against the core', () => {
  /** A throwaway Graphics with the same instruction-list shape the others read. */
  function contacts(mounts: Array<{ x: number; y: number }>, bodyR = 40): Container {
    const layer = new Container();
    drawModuleContacts(layer, mounts, bodyR);
    return layer;
  }


  it('never accumulates: repainting the same mounts leaves the same drawing', () => {
    const layer = contacts([{ x: 30, y: 0 }, { x: -30, y: 4 }]);
    const once = contactFills(layer);
    for (let i = 0; i < 5; i++) drawModuleContacts(layer, [{ x: 30, y: 0 }, { x: -30, y: 4 }], 40);
    expect(contactFills(layer)).toEqual(once);
  });

  it('hides the contact of a mount that went away, rather than leaving it where it was', () => {
    const layer = contacts([{ x: 30, y: 0 }, { x: -30, y: 4 }]);
    const one = contactFills(contacts([{ x: 30, y: 0 }]));
    drawModuleContacts(layer, [{ x: 30, y: 0 }], 40);
    expect(contactFills(layer)).toEqual(one);
  });

  it('an orbiting mount only MOVES its contact — the geometry is built once (2026-09-28)', () => {
    // The whole point of the rewrite: the mounts orbit every frame, and a refilled Graphics is
    // re-triangulated on its next render. Detected by spying on `clear`, which a rebuild starts with.
    const layer = contacts([{ x: 30, y: 0 }]);
    const g = layer.children[0] as Graphics;
    const clear = vi.spyOn(g, 'clear');
    const xs: number[] = [];
    for (let deg = 10; deg <= 90; deg += 10) {
      const a = (deg * Math.PI) / 180;
      drawModuleContacts(layer, [{ x: 30 * Math.cos(a), y: 30 * Math.sin(a) }], 40);
      xs.push(g.x);
    }
    expect(clear).not.toHaveBeenCalled();
    expect(new Set(xs).size).toBe(xs.length); // ...while it really did follow the mount
  });

  it('DOES rebuild when the body radius changes, since the ellipses are sized off it', () => {
    const layer = contacts([{ x: 30, y: 0 }], 40);
    drawModuleContacts(layer, [{ x: 30, y: 0 }], 20);
    expect(contactFills(layer)).toEqual(contactFills(contacts([{ x: 30, y: 0 }], 20)));
  });

  it('draws nested ellipses per mount, pulled back from the mount TOWARD the core', () => {
    const mount = { x: 30, y: 0 };
    const drawn = contactFills(contacts([mount]));
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (const f of drawn) {
      expect(f.kind).toBe('ellipse');
      expect(f.data[0]!).toBeLessThan(mount.x); // pulled inward
      expect(f.data[0]!).toBeGreaterThan(0); // ...but still on the mount's side
    }
  });

  it('shrinks each nested pass and keeps every one of them faint', () => {
    const drawn = contactFills(contacts([{ x: 30, y: 0 }]));
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!.data[2]!).toBeLessThan(drawn[i - 1]!.data[2]!);
    for (const f of drawn) expect(f.alpha).toBeLessThan(0.2);
  });

  it('squashes the contact vertically, like every other round thing in this tilted view', () => {
    for (const f of contactFills(contacts([{ x: 30, y: 0 }]))) expect(f.data[3]!).toBeLessThan(f.data[2]!);
  });

  it('clamps a FAR mount onto the body, and every ellipse with it', () => {
    // A socket bone's tip is well outside the body it hangs off (orb-core: len 52 vs bodyR 40),
    // so this is the normal case, not the edge case. Nothing here is masked, so an unclamped
    // blob would paint a dark smudge on the transparent background beside the character.
    const bodyR = 40;
    for (const f of contactFills(contacts([{ x: 200, y: 0 }], bodyR))) {
      expect(f.data[0]! + f.data[2]!).toBeLessThanOrEqual(bodyR); // centre + rx, inside the body
    }
  });

  it('leaves a NEAR mount where it is, rather than pushing it out to the clamp circle', () => {
    // The clamp is a ceiling, not a target: a module that a clip has pulled in close should have
    // its contact follow it in, or the shade detaches from the thing casting it.
    const near = contactFills(contacts([{ x: 6, y: 0 }]))[0]!;
    const far = contactFills(contacts([{ x: 200, y: 0 }]))[0]!;
    expect(near.data[0]!).toBeLessThan(far.data[0]!);
    expect(near.data[0]!).toBeGreaterThan(0);
  });

  it('places a contact on the same side as its mount, for a mount in any direction', () => {
    for (const [mx, my] of [[40, 0], [-40, 0], [0, 40], [0, -40], [-30, 30]]) {
      const c = contactFills(contacts([{ x: mx, y: my }]))[0]!;
      expect(Math.sign(c.data[0]!)).toBe(Math.sign(mx));
      expect(Math.sign(c.data[1]!)).toBe(Math.sign(my));
    }
  });

  it('skips a mount sitting exactly on the core, which has no direction to pull along', () => {
    expect(contactFills(contacts([{ x: 0, y: 0 }]))).toHaveLength(0);
  });

  it('handles two mounts independently — one contact per orbiting module', () => {
    const one = contactFills(contacts([{ x: 30, y: 0 }])).length;
    expect(contactFills(contacts([{ x: 30, y: 0 }, { x: -30, y: 4 }]))).toHaveLength(one * 2);
  });
});

/**
 * ## Mutation battery (`paintModuleContacts`)
 *
 * Recorded 2026-09-02, against the full client suite. 6 mutants, 6 killed — but only after the
 * body-relative row was rewritten: its first version bounded the drawn x (`< 30` for a mount 30 px
 * out) and the mutant SURVIVED, because `drawModuleContacts` pulls each ellipse so far in from its
 * mount that a rig-space 40 still cleared the bar. Restated as an invariance — same relative
 * geometry at a different absolute position must draw identically — it kills.
 *
 *   KILLED   body position ignores the clip translate ..................... 1 failing test
 *   KILLED   mounts stated in rig space, not body-relative ................ 1  (after the rewrite)
 *   KILLED   gathers every bone, module or not ............................ 1
 *   KILLED   shades a module the clip faded out ............................ 1
 *   KILLED   overlay ignores the body alpha ................................ 2
 *   KILLED   a module the clip slid leaves its shade behind ............... 2
 *
 * `paintModuleContacts` — the GATHERING half, moved out of `RigSkin.updateModuleContacts`
 * (2026-09-02, 500-line convention). It had no test of its own before the move, because as a
 * private on `RigSkin` the only way to reach it was through a fully-assembled Pixi rig; what
 * `RigSkin.test.ts` asserted about it was the one thing visible from outside (that `moduleAO`
 * exists at all). These pin the selection and space conversion it actually performs, which is
 * where its two real failure modes live: picking the wrong bones, and forgetting that
 * `computeFK` folds a clip's ROTATION into a bone tip but not its TRANSLATION.
 */
describe('paintModuleContacts — gathering this frame\'s mounts from a posed rig', () => {
  const BODY = 'body';
  const pose = (id: string, ex: number, ey: number) => [id, { sx: 0, sy: 0, ex, ey, wa: 0 }] as const;
  const rest: ResolvedBoneTransform = { rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 };
  const bone = (id: string, orbiting: boolean): BoneDef => ({
    id, parent: 'root', len: 10, rwa: 0, rla: 0, label: id,
    ...(orbiting ? { outerW: 4, innerW: 2 } : {}),
  });

  function paint(
    bones: BoneDef[],
    poses: ReadonlyArray<readonly [string, { sx: number; sy: number; ex: number; ey: number; wa: number }]>,
    transforms: Array<[string, ResolvedBoneTransform]> = [],
  ): Container {
    const g = new Container();
    paintModuleContacts(g, BODY, bones, new Map(poses), new Map(transforms), 40);
    return g;
  }

  it('parks the whole overlay on the body bone, so it rides the hover bob', () => {
    const g = paint([bone(BODY, false), bone('socket_r', true)], [pose(BODY, 0, -12), pose('socket_r', 30, -12)]);
    expect(g.visible).toBe(true);
    expect({ x: g.x, y: g.y }).toEqual({ x: 0, y: -12 });
  });

  it("includes the body bone's own clip translation in that position", () => {
    // `computeFK` does not fold translation into a tip, so the sphere shading and these contact
    // shades would drift off the art by exactly the idle bob if this were dropped.
    const g = paint(
      [bone(BODY, false), bone('socket_r', true)],
      [pose(BODY, 0, 0), pose('socket_r', 30, 0)],
      [[BODY, { ...rest, translateY: -6 }]],
    );
    expect(g.y).toBe(-6);
  });

  it('states each mount RELATIVE to the body, not in rig space', () => {
    // The overlay is POSITIONED at the body, so a mount left in rig space is painted at the sum
    // of the two — the shade drifts off the module by however far the body is from the origin.
    //
    // Asserted by invariance rather than by a bound, which the first version of this test got
    // wrong and a mutation battery caught: `drawModuleContacts` pulls each ellipse a long way in
    // from its mount, so a rig-space 40 still landed under a naive `< 30` check and the mutant
    // survived. Same relative geometry, different absolute position => identical drawing is the
    // claim itself, and it cannot be satisfied by an accident of the pull-in factor.
    const bones = [bone(BODY, false), bone('socket_r', true)];
    const atOrigin = contactFills(paint(bones, [pose(BODY, 0, 0), pose('socket_r', 30, 0)]));
    const shifted = contactFills(paint(bones, [pose(BODY, 10, -4), pose('socket_r', 40, -4)]));
    expect(atOrigin.length).toBeGreaterThan(0);
    expect(shifted).toEqual(atOrigin);
  });

  it('follows a mount bone the attack clip has slid, not just one FK moved', () => {
    const still = contactFills(paint([bone(BODY, false), bone('socket_r', true)], [pose(BODY, 0, 0), pose('socket_r', 30, 0)]));
    const slid = contactFills(paint(
      [bone(BODY, false), bone('socket_r', true)],
      [pose(BODY, 0, 0), pose('socket_r', 30, 0)],
      [['socket_r', { ...rest, translateX: -10 }]],
    ));
    expect(slid[0]!.data[0]!).toBeLessThan(still[0]!.data[0]!);
  });

  it('only gathers bones that actually carry a module', () => {
    // `outerW`/`innerW` is the marker for an orbiting mount (`rigTethers` uses the same one).
    // A rig whose bones are all plain body parts must paint nothing at all.
    expect(contactFills(paint([bone(BODY, false), bone('eye', false)], [pose(BODY, 0, 0), pose('eye', 8, 2)]))).toHaveLength(0);
  });

  it('drops a mount the clip has faded out, rather than shading an invisible module', () => {
    const bones = [bone(BODY, false), bone('socket_r', true)];
    const poses = [pose(BODY, 0, 0), pose('socket_r', 30, 0)];
    expect(contactFills(paint(bones, poses)).length).toBeGreaterThan(0);
    expect(contactFills(paint(bones, poses, [['socket_r', { ...rest, alpha: 0 }]]))).toHaveLength(0);
  });

  it('hides itself when the body bone is missing from this frame\'s pose', () => {
    const g = paint([bone(BODY, false), bone('socket_r', true)], [pose('socket_r', 30, 0)]);
    expect(g.visible).toBe(false);
  });

  it("takes the body's own alpha, so it fades with a death dissolve instead of floating", () => {
    const g = paint(
      [bone(BODY, false), bone('socket_r', true)],
      [pose(BODY, 0, 0), pose('socket_r', 30, 0)],
      [[BODY, { ...rest, alpha: 0.25 }]],
    );
    expect(g.alpha).toBe(0.25);
  });
});

describe('placeSphereShade — seating the quad on the body bone it shades', () => {
  // Split out of `RigSkin.update` with the `death` clip (2026-09-02) and tested directly here for
  // the same reason `paintModuleContacts` is: the sphere overlay is a mark the rig DRAWS over its
  // authored art, and everything about placing it is pure geometry over ONE bone's pose. Through
  // `RigSkin` these four properties can only be read together on a real rig; here each is one
  // argument, so a test can move one channel at a time — including the two that have no shipped
  // clip moving them alone.
  const rest: ResolvedBoneTransform = { rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 };
  const at = (ex: number, ey: number) => ({ sx: 0, sy: 0, ex, ey, wa: -90 });
  const quad = (): Graphics => drawSphereShading(40);

  it('parks the quad on the bone TIP, which is where that bone\'s art is drawn', () => {
    const g = quad();
    placeSphereShade(g, at(3, -40), undefined, 1);
    expect(g.visible).toBe(true);
    expect({ x: g.x, y: g.y }).toEqual({ x: 3, y: -40 });
  });

  it('adds the clip translation, because computeFK does not fold it into a tip', () => {
    // Same rule the sprite loop and the contact shades follow. Without it the shading rides
    // still while the body it sits on bobs — measurable as the full amplitude of the idle hover.
    const g = quad();
    placeSphereShade(g, at(0, -40), { ...rest, translateX: 2, translateY: -6 }, 1);
    expect({ x: g.x, y: g.y }).toEqual({ x: 2, y: -46 });
  });

  it('takes the bone\'s alpha, so it fades out with the art it sits on', () => {
    const g = quad();
    placeSphereShade(g, at(0, -40), { ...rest, alpha: 0.25 }, 1);
    expect(g.alpha).toBe(0.25);
  });

  it('takes the bone\'s SQUASH, which is what the death collapse needs', () => {
    // The channel this function was extracted to add. `death` collapses the body to 0.4x0.3 and
    // the corpse HOLDS there for the whole dissolve, so a fixed-size quad reads as a dark plate
    // lying beside a shrinking body — 700 ms of it, not a 60 ms accent nobody resolves.
    const g = quad();
    placeSphereShade(g, at(0, -40), { ...rest, scaleX: 0.4, scaleY: 0.3 }, 1);
    expect(g.scale.x).toBeCloseTo(0.4, 10);
    expect(g.scale.y).toBeCloseTo(0.3, 10);
  });

  it('counter-flips on X and NEVER on Y — the key light is fixed in screen space', () => {
    // The one property that deliberately does not come from the bone. `flipX` cancels
    // `RigSkin.view.scale.x` exactly, so the highlight stays upper-left whichever way the
    // character faces; mirroring with the body would read as the light source teleporting.
    // Composed WITH the squash, which is the combination `RigSkin` could not express while the
    // flip was written in `setBodyFacing` and the squash would have been written in `update`.
    const left = quad();
    placeSphereShade(left, at(0, -40), { ...rest, scaleX: 0.5, scaleY: 0.3 }, -1);
    expect(left.scale.x).toBeCloseTo(-0.5, 10);
    expect(left.scale.y).toBeCloseTo(0.3, 10); // the sign never reaches Y
    const right = quad();
    placeSphereShade(right, at(0, -40), { ...rest, scaleX: 0.5, scaleY: 0.3 }, 1);
    expect(right.scale.x).toBeCloseTo(0.5, 10);
    // Same magnitude both ways: the flip is a mirror, not a resize.
    expect(Math.abs(left.scale.x)).toBeCloseTo(Math.abs(right.scale.x), 10);
  });

  it('treats a missing transform as identity rather than blanking the quad', () => {
    // The common case: no clip names the body bone this frame (a bundle with no `move`, or a
    // rig posed at rest for a measurement). It must draw normally, not vanish or collapse to 0.
    const g = quad();
    placeSphereShade(g, at(0, -40), undefined, 1);
    expect(g.visible).toBe(true);
    expect(g.alpha).toBe(1);
    expect({ x: g.scale.x, y: g.scale.y }).toEqual({ x: 1, y: 1 });
  });

  it('hides the quad for an unposed bone instead of leaving it at last frame\'s place', () => {
    // Reachable through `RigSkin.update` whenever FK returns no pose for the shade bone. Left
    // visible, the overlay would sit as a dark blob wherever the body last was — the same class
    // of stale-position bug `paintModuleContacts` hides for.
    const g = quad();
    placeSphereShade(g, at(0, -40), undefined, 1);
    placeSphereShade(g, undefined, undefined, 1);
    expect(g.visible).toBe(false);
  });

  it('brings a hidden quad back the frame its bone is posed again', () => {
    // `visible` is set on BOTH paths on purpose. A one-way hide would make a single unposed frame
    // permanent, which is worse than the stale position it was avoiding.
    const g = quad();
    placeSphereShade(g, undefined, undefined, 1);
    expect(g.visible).toBe(false);
    placeSphereShade(g, at(1, -30), { ...rest, alpha: 0.5 }, 1);
    expect(g.visible).toBe(true);
    expect({ x: g.x, y: g.y, a: g.alpha }).toEqual({ x: 1, y: -30, a: 0.5 });
  });
});

describe('shadeHex — the far-side module\'s depth tint', () => {
  it('darkens every channel without changing hue', () => {
    expect(shadeHex(0xffffff, 0.5)).toBe(0x808080);
    expect(shadeHex(0x8040c0, 0.5)).toBe(0x402060);
  });

  it('is the identity at factor 1, so a front-facing module is never re-tinted', () => {
    expect(shadeHex(0x66e0ff, 1)).toBe(0x66e0ff);
    expect(shadeHex(0xffffff, 1)).toBe(0xffffff);
  });

  it('saturates rather than wrapping — a factor over 1 can never roll a channel to black', () => {
    // A wrap would flip a bright element colour to a dark one, which is exactly the kind of
    // bug a bit-shifted colour helper invites.
    expect(shadeHex(0xffffff, 2)).toBe(0xffffff);
    expect(shadeHex(0x80ff40, 4)).toBe(0xffffff);
  });

  it('clamps at black, never below', () => {
    expect(shadeHex(0x102030, 0)).toBe(0x000000);
  });
});

describe('the module depth-cue constants', () => {
  it('make a far-side module both smaller and darker, but still clearly visible', () => {
    // The z-flip alone reads as "it changed layer"; scale + shade turn it into an orbit.
    // Neither may be so aggressive that the module disappears while the player is aiming
    // north, which is a third of the time in a twin-stick game.
    expect(MODULE_BEHIND_SCALE).toBeGreaterThan(0.7);
    expect(MODULE_BEHIND_SCALE).toBeLessThan(1);
    expect(MODULE_BEHIND_SHADE).toBeGreaterThan(0.5);
    expect(MODULE_BEHIND_SHADE).toBeLessThan(1);
  });

  it('sets the shading threshold above a decorative bone\'s radius and below a body\'s', () => {
    // orb-core: shell 40 (shaded), socket 13 (not); critter-core body 50; boss-core core 70.
    expect(SHADE_MIN_BODY_R).toBeGreaterThan(13);
    expect(SHADE_MIN_BODY_R).toBeLessThan(40);
  });
});
