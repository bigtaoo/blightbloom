/**
 * Floating damage numbers, the renderer-free half (design/10 "Damage numbers"): which live
 * number a hit joins, which one a full screen gives up, and where a number is in its short life.
 * `fx/DamageNumbers.ts` owns the sprites and reads every answer from here, so all of it is
 * testable without Pixi (`pureLayerBoundary.test.ts` lists this file).
 *
 * Three styles share the machinery (2026-09-26): a plain hit, a crit (gold, bigger, with a
 * trailing "!"), and a heal ("+N" in the restored pool's colour). A style is part of what a
 * merge must match, so a crit never folds into the plain stream beside it.
 *
 * Numbers are measured in SCREEN px, not world px: the world is zoomed up to 4.5x
 * (`FxController.updateCamera`), and a number that grew with the camera would be a quarter of the
 * screen tall in a small room. The view divides by the zoom when it places one.
 */

/** A second hit on the same target, in the same colour, inside this window is added into the
 *  number already rising rather than stacking a new one on it. 150 ms is two or three shots of a
 *  fast gun: a stream reads as a running total that ticks up, a slow weapon as separate hits. */
export const MERGE_MS = 150;
/** How long one number is on screen. */
export const LIFE_MS = 750;
/** The closing stretch of `LIFE_MS` over which it fades out. */
export const FADE_MS = 250;
/** The pop when a number appears or a merged hit bumps it. */
export const POP_MS = 90;
export const POP_SCALE = 0.4;
/** How far a number rises over its life, screen px. */
export const RISE_PX = 26;
/** A one-digit number's height, screen px, before the magnitude scale. */
export const NUMBER_PX = 22;
/** Side offsets, screen px, cycled through by successive NEW numbers so two hits on one target
 *  just outside the merge window do not print on top of each other. Deterministic on purpose:
 *  a test can name the offset a spawn gets. */
export const DRIFT_PX: readonly number[] = [0, 9, -9, 16, -16];

/** What a number is: an ordinary hit, a crit, or a heal. */
export type NumberStyle = 'hit' | 'crit' | 'heal';

/** A crit prints this much bigger than a plain hit of the same value. */
export const CRIT_SCALE = 1.4;

/** Glyph indices past the digits in the atlas — mirrored from `render/damageDigitAtlas.ts`
 *  (`plus` / `bang`), which this pure module does not import; a test holds the two equal. */
export const PLUS_GLYPH = 10;
export const BANG_GLYPH = 11;

/** One live number. `V` is whatever the view hangs off it (a Pixi container, or a stub). */
export interface DamageNumber<V> {
  target: number;
  tint: number;
  style: NumberStyle;
  value: number;
  /** World px, fixed at spawn: the number stays where the hit was rather than riding the actor. */
  x: number;
  y: number;
  drift: number;
  age: number;
  /** Time since it last popped — reset by a merge, so a running total visibly ticks. */
  popAge: number;
  /** Set when `value` changed and the view has to re-lay its digits. */
  dirty: boolean;
  readonly view: V;
}

/** The base-10 digits of a hit, most significant first. A hit that rounds to nothing, or a value
 *  that is not a finite positive number, has no digits and draws nothing. */
export function digitsOf(value: number): number[] {
  const n = Math.round(value);
  if (!Number.isFinite(n) || n <= 0) return [];
  return String(n).split('').map(Number);
}

/** The glyphs a number draws: its digits, led by "+" for a heal and closed by "!" for a crit.
 *  Empty whenever `digitsOf` is, so a hit that rounds to nothing still draws nothing at all. */
export function glyphsOf(value: number, style: NumberStyle): number[] {
  const digits = digitsOf(value);
  if (digits.length === 0) return digits;
  if (style === 'heal') return [PLUS_GLYPH, ...digits];
  if (style === 'crit') return [...digits, BANG_GLYPH];
  return digits;
}

/**
 * Each glyph's centre, in atlas px, so the whole number is centred on its anchor. A digit or
 * "+" takes `advance`; the narrow "!" takes `bangAdvance`, and two neighbours sit half of each
 * one's share apart — for digits alone that is the plain tabular `advance` spacing.
 */
export function glyphOffsets(glyphs: readonly number[], advance: number, bangAdvance: number): number[] {
  const widths = glyphs.map((g) => (g === BANG_GLYPH ? bangAdvance : advance));
  const total = widths.reduce((a, w) => a + w, 0);
  let x = -total / 2;
  return widths.map((w) => {
    const centre = x + w / 2;
    x += w;
    return centre;
  });
}

/** How much bigger a style prints than a plain hit — only a crit differs. */
export function styleScale(style: NumberStyle): number {
  return style === 'crit' ? CRIT_SCALE : 1;
}

/** Bigger hits print bigger: 1 up to 10, rising to 1.35 at 1000 and capped there. */
export function magnitudeScale(value: number): number {
  const t = Math.min(1, Math.max(0, (Math.log10(Math.max(1, value)) - 1) / 2));
  return 1 + 0.35 * t;
}

export interface NumberPose {
  /** Screen px risen so far. */
  rise: number;
  alpha: number;
  /** The pop multiplier, 1 once it has settled. */
  pop: number;
}

/** Where a number is at `age`: an ease-out rise, full alpha until the fade, and a pop that
 *  settles back to 1 over `POP_MS` after it appears or is bumped. */
export function poseAt(age: number, popAge: number): NumberPose {
  const t = Math.min(1, Math.max(0, age / LIFE_MS));
  const rise = (1 - (1 - t) ** 3) * RISE_PX;
  const alpha = Math.min(1, Math.max(0, (LIFE_MS - age) / FADE_MS));
  const pop = popAge < POP_MS ? 1 + POP_SCALE * (1 - Math.max(0, popAge) / POP_MS) : 1;
  return { rise, alpha, pop };
}

/**
 * The live set. Ordered oldest first, which is what makes the cap cheap: a full screen gives up
 * `live[0]`, the number closest to fading anyway, and hands its view to the new hit. The newest
 * hit is never the one dropped — it is the one the player is looking for.
 */
export class DamageNumberBook<V> {
  readonly live: DamageNumber<V>[] = [];
  private spawned = 0;

  /**
   * Add a hit. Joins a number already rising over the same target in the same colour and style if
   * it is younger than `MERGE_MS`; otherwise starts a new one, reusing the oldest when `cap` numbers are
   * already up. Returns the number that now carries the hit, or undefined when `cap` is 0 or the
   * hit has no digits.
   */
  add(
    target: number,
    tint: number,
    value: number,
    x: number,
    y: number,
    cap: number,
    makeView: () => V,
    style: NumberStyle = 'hit',
  ): DamageNumber<V> | undefined {
    if (digitsOf(value).length === 0) return undefined;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i]!;
      if (n.target === target && n.tint === tint && n.style === style && n.age < MERGE_MS) {
        n.value += value;
        n.popAge = 0;
        n.dirty = true;
        return n;
      }
    }
    if (cap <= 0) return undefined;
    const drift = DRIFT_PX[this.spawned++ % DRIFT_PX.length]!;
    const reused = this.live.length >= cap ? this.live.shift() : undefined;
    const n: DamageNumber<V> = { target, tint, style, value, x, y, drift, age: 0, popAge: 0, dirty: true, view: reused ? reused.view : makeView() };
    this.live.push(n);
    return n;
  }

  /** Drop the oldest numbers until at most `cap` remain, returning them so their views can be
   *  released. For a cap lowered mid-fight (the quality watchdog stepping down): the excess goes
   *  at once rather than waiting to fade. */
  trimTo(cap: number): DamageNumber<V>[] {
    const excess = this.live.length - Math.max(0, cap);
    return excess > 0 ? this.live.splice(0, excess) : [];
  }

  /** Age every number by `dt` ms and return the ones whose life ran out, removed. */
  step(dt: number): DamageNumber<V>[] {
    const done: DamageNumber<V>[] = [];
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i]!;
      n.age += dt;
      n.popAge += dt;
      if (n.age >= LIFE_MS) done.push(...this.live.splice(i, 1));
    }
    return done;
  }

  /** Remove everything (a run boundary), returning what was live. */
  clear(): DamageNumber<V>[] {
    return this.live.splice(0);
  }
}
