import type { Graphics } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import { THEME } from '../theme';
import { drawElementBadge, elementBadgeRadius } from '../elementIcons';

// Split out of Actor.ts (2026-08-21, 500-line convention): the in-world floating health bar
// every actor carries above its head (design/10 legibility). A pure drawing function over a
// caller-owned Graphics — no state, no Pixi container of its own — so Actor keeps owning when
// to redraw and this file owns what the bar looks like.
//
// Procedural on purpose, not a texture: it is a HUD readout that has to resize per actor
// (a boss's is wider and taller than a mob's) and recolour per frame, which is exactly what
// Graphics is for.
//
// ── Why it looks like this (measured 2026-08-21, not styled by eye) ──────────────────────
//
// The previous bar was a near-black track at alpha 0.85 with a 1 px near-black stroke. Both
// halves of that failed the same way, and the failure only shows up in numbers: because the
// track was TRANSLUCENT, its rendered luma was a function of whatever the actor happened to
// be standing in front of. Sampled over 18 placements in a real room, the empty track came
// out anywhere from 25.6 to 57.1 luma, and its separation from the surface behind it
// collapsed as that surface darkened — down to 1.6-2.9 luma over the dark floors mobs
// actually stand on (measured backgrounds ran 27 to 75 luma in one room). At 1/3 HP the
// player therefore saw an amber stub with no visible remainder: no length to read the
// fraction against. The 1 px stroke drifted the same way, 17.5 to 61.9.
//
// The fix is not "pick a better single colour" — no single value can separate from both a
// 27-luma floor and an 88-luma wall cap. It is to give the bar its own two-tone frame and
// make every layer OPAQUE, so the whole thing renders at a constant value everywhere and
// carries a guaranteed cue in both directions:
//
//   - a near-black outer contour (~11 luma) reads against everything bright
//   - a light top bevel (~124 luma over the track) reads against everything dark
//
// Whichever surface the bar lands on, one of those two has >= 49 luma of separation from it,
// and neither moves when the background does. `healthBar.test.ts` pins that invariant against
// the real measured background range rather than against a screenshot.
//
// One extra opaque layer per bar, drawn only when the hp fraction actually changes
// (`Actor.setHealth` early-returns otherwise), so a room of full-health mobs costs nothing.

/** Outer contour of a non-local actor's bar. Near-black — the cue that carries against a
 *  bright wall cap (measured 72-88 luma) or pillar top (87). */
const CONTOUR = 0x0a0c12;
/** Opaque track ("empty") colour — the same value the HUD's own `widgets.Bar` uses for its
 *  track, so a mob's bar and the corner HUD read as one system. */
const TRACK = 0x1f2532;
/** Top-edge bevel: the cue that carries against a dark floor (measured 27-45 luma). Drawn
 *  over the fill as well as the track, so it reads as a gloss highlight on the bar rather
 *  than as height stolen from the fill. */
const BEVEL = 0xe2e8f0;
const BEVEL_ALPHA = 0.45;

/** hp fraction → fill colour. Green above half, amber below a half, red below a quarter. */
const FILL_HIGH = 0x66bb6a;
const FILL_MID = 0xffca28;
const FILL_LOW = 0xef5350;
const MID_AT = 0.5;
const LOW_AT = 0.25;

/** Thickness of the outer contour and of the bevel, in world px. */
const CONTOUR_W = 1;
const BEVEL_H = 1;

/** Element-badge glyph radius, as a multiple of the bar's track height. The badge rides at
 *  the bar's LEFT end because that is the one piece of an actor's on-screen furniture that
 *  is already guaranteed legible: `Actor` mounts the bar on `layers.hud`, so unlike anything
 *  parented to the body it is never behind a wall the occlusion x-ray only partially fades,
 *  and unlike a fixed offset on the body it is never covered by the orbiting weapon module
 *  (which sweeps a full circle around every actor, design/13's universal mount). Sized off
 *  `h` rather than off the actor's radius so a boss's badge scales with its bigger bar. */
const BADGE_GLYPH_R = 0.85;
/** Gap between the bar's outer contour and the badge's chip. */
const BADGE_GAP = 1;

export interface HealthBarStyle {
  /** Track width in world px (the full bar, i.e. hp = max). */
  w: number;
  /** Track height in world px, excluding the contour drawn outside it. */
  h: number;
  /** hp fraction in [0, 1]. */
  ratio: number;
  /** True for the seat THIS client drives — recolours the contour to the player teal
   *  (design/10's "which one is me" cue, chosen 2026-08-14 over a ground ring because a bar
   *  above the head never shares screen space with the shield rim-glow). */
  local: boolean;
  /** Which of design/13's five elements this actor IS, if it is one of the five locked
   *  elemental variants (`EnemyActor.element`). Draws the ICON half of that doc's locked
   *  dual-channel law at the bar's left end. Undefined draws no badge at all and leaves the
   *  bar byte-identical to what it was before badges existed — which is every player, every
   *  un-elemental mob, and the boss (whose toxic-purple is its own flavour colour, explicitly
   *  not the poison element hue; see `content/enemies.ts`). */
  element?: DamageType;
}

/** Fill colour for an hp fraction. Exported so the test can assert the ramp without
 *  re-deriving the thresholds. */
export function healthFillColor(ratio: number): number {
  return ratio > MID_AT ? FILL_HIGH : ratio > LOW_AT ? FILL_MID : FILL_LOW;
}

/**
 * Repaint `g` as a health bar centred on its own origin. Clears first, so this is the whole
 * of the bar's appearance.
 *
 * The fill's minimum width is one full pill (`h`): below that the rounded cap collapses to a
 * sub-pixel sliver at gameplay zoom, so an actor one hit from death rendered as an apparently
 * EMPTY bar — indistinguishable from a dead one, on the frame where that distinction matters
 * most. A non-zero hp always draws at least a visible dot.
 */
export function drawHealthBar(g: Graphics, style: HealthBarStyle): void {
  const { w, h, local } = style;
  const ratio = Math.max(0, Math.min(1, style.ratio));
  const r = h / 2; // full-pill rounding, matching the HUD's own `widgets.Bar`
  const x = -w / 2;
  const y = -h / 2;
  g.clear();

  // Outer contour, drawn as a filled rounded rect one CONTOUR_W bigger on every side rather
  // than as a stroke — a stroke straddles the edge it is drawn on (and Pixi's alignment
  // default would eat into the track), while an inflated fill is unambiguously OUTSIDE the
  // bar and so never costs the fill any height.
  g.roundRect(x - CONTOUR_W, y - CONTOUR_W, w + CONTOUR_W * 2, h + CONTOUR_W * 2, r + CONTOUR_W)
    .fill({ color: local ? THEME.colors.player : CONTOUR });

  // Opaque track. Opaque is the point: see the header.
  g.roundRect(x, y, w, h, r).fill({ color: TRACK });

  if (ratio > 0) {
    g.roundRect(x, y, Math.max(h, w * ratio), h, r).fill({ color: healthFillColor(ratio) });
  }

  // Top bevel, over both track and fill.
  g.roundRect(x + r * 0.5, y, w - r, BEVEL_H, BEVEL_H / 2).fill({ color: BEVEL, alpha: BEVEL_ALPHA });

  // The element badge, outside the contour on the left. Drawn last so it is never clipped by
  // the fill, and left of the track rather than on it so it never eats bar length — the whole
  // point of `healthBar.ts`'s 2026-08-21 measurement pass was that the player has to be able
  // to read the REMAINING fraction, and an icon sitting on the track would take that back.
  if (style.element) {
    const glyphR = h * BADGE_GLYPH_R;
    const cx = x - CONTOUR_W - BADGE_GAP - elementBadgeRadius(glyphR);
    drawElementBadge(g, style.element, cx, 0, glyphR);
  }
}
