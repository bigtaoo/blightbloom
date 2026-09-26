/**
 * The `hit` / `heal` → floating number reactions (design/10 "Damage numbers"), carved out of
 * `EventReactor` the way `pickupReactions.ts` is: which hits get a number, what colour, and where
 * it starts. Pure — the numbers themselves arrive as a one-method sink — so every rule here is
 * testable with plain objects (`pureLayerBoundary.test.ts` lists this file).
 *
 * The shrinking zone is covered by this and needs nothing of its own: `EnvironmentSystem` deals
 * a zone tick through `takeDamage`, which announces it as an ordinary `hit` with
 * `faction: 'environment'`, and only THEN pushes `zone_damage`. Numbering `zone_damage` as well
 * would print every tick twice, so that event stays unhandled on purpose; hazard tiles arrive the
 * same way and take the same colour.
 *
 * A crit (`hit.crit`, 2026-09-26) is gold, bigger and ends in "!"; a heal (`heal`) is "+N" in the
 * restored pool's colour — the HUD's heal green for health, shield cyan for a battery.
 */
import type { DamageSrc, Fp, GameEvent, GameState } from '@dd/engine';
import { THEME, elementColor } from '../theme';
import { fpToPx } from '../coords';
import { byId } from './attackShapes';
import type { NumberStyle } from '../fx/damageNumberModel';

type HitEvent = Extract<GameEvent, { type: 'hit' }>;
type HealEvent = Extract<GameEvent, { type: 'heal' }>;

/** Where a number goes — `fx/DamageNumbers.ts`, narrowed to the one call this module makes. */
export interface DamageNumberSink {
  spawn(target: number, value: number, tint: number, x: number, y: number, style?: NumberStyle): void;
}

/** The two host reads the reaction needs: the state (who the target is, how big) and the target's
 *  interpolated view position, which is where the player sees it, not where the sim last put it. */
export interface DamageNumberHost {
  activeState(): GameState | null;
  actorAt(id: number): { x: number; y: number } | undefined;
}

/** Damage the local seat TOOK: the one colour on screen that means "you". */
export const SELF_TINT = THEME.colors.enemy;
/** The zone and hazard tiles — nobody's weapon, so no element's hue. Slate, neutral against the
 *  element palette and against `SELF_TINT`. */
export const ENVIRONMENT_TINT = 0xa0aec0;
/** A crit. Warm gold: apart from lightning's pale yellow and fire's orange, the two element hues
 *  near it, and the size and the "!" carry it even where the hues sit close. */
export const CRIT_TINT = 0xffb020;
/** Health restored — the same green as the heal pickup it usually comes from. */
export const HEAL_TINT = THEME.colors.pickupHeal;
/** Where a number starts, in multiples of the target's body radius above its ground point:
 *  about the top of the head, just under the health bar it then rises past. */
export const HEAD_LIFT_R = 2.2;
/** A target with no state entry left (it died on the tick that hit it) still gets its number, at
 *  a player-sized lift. */
const FALLBACK_RADIUS_PX = 16;

/**
 * Whether a hit gets a number at all. Every hit on a non-player (the enemies, which is the whole
 * point) and every hit on this seat. Another PLAYER only when a player hit them — a PvP rival
 * taking your fire — and not when an enemy or the zone did: in co-op that would be a column of
 * numbers over each teammate reporting a fight that is not yours, which the ally row already
 * summarises.
 */
export function showsHitNumber(targetIsPlayer: boolean, targetIsLocal: boolean, faction: DamageSrc): boolean {
  if (targetIsLocal || !targetIsPlayer) return true;
  return faction === 'player';
}

/**
 * The colour, in priority order: a hit the shield swallowed whole is shield cyan whoever took it
 * (it says "no health lost", which matters most on yourself); then damage to you is red; then a
 * crit's gold; then the environment's slate; then the weapon's element, with physical in
 * design/13's locked neutral. A crit that lands on you or on a shield keeps that colour and still
 * prints big with its "!" — which pool it hit is the more urgent half of the news.
 */
export function hitNumberTint(e: Pick<HitEvent, 'faction' | 'damageType' | 'shieldRemaining' | 'crit'>, targetIsLocal: boolean): number {
  if ((e.shieldRemaining ?? 0) > 0) return THEME.colors.shield;
  if (targetIsLocal) return SELF_TINT;
  if (e.crit) return CRIT_TINT;
  if (e.faction === 'environment') return ENVIRONMENT_TINT;
  return elementColor(e.damageType);
}

export function reactToHitNumber(
  e: HitEvent,
  numbers: DamageNumberSink,
  host: DamageNumberHost,
  isLocalSeat: (id: number) => boolean,
): void {
  const s = host.activeState();
  const player = byId(s?.players, e.target);
  const local = isLocalSeat(e.target);
  if (!showsHitNumber(player !== undefined, local, e.faction)) return;
  const at = headAnchor(e, host, s, player);
  numbers.spawn(e.target, e.damage, hitNumberTint(e, local), at.x, at.y, e.crit ? 'crit' : 'hit');
}

/** A heal's colour: the pool it went into. */
export function healNumberTint(pool: HealEvent['pool']): number {
  return pool === 'shield' ? THEME.colors.shield : HEAL_TINT;
}

/**
 * A heal gets a number over the LOCAL seat only. It is news to the one whose bar moved; a
 * teammate's potion or lifesteal trickle is already on the ally row, and printing it would bring
 * back the column of someone else's numbers `showsHitNumber` keeps off co-op teammates. The
 * engine only ever heals players, so there is no enemy case to decide.
 */
export function reactToHealNumber(
  e: HealEvent,
  numbers: DamageNumberSink,
  host: DamageNumberHost,
  isLocalSeat: (id: number) => boolean,
): void {
  if (!isLocalSeat(e.target)) return;
  const s = host.activeState();
  const at = headAnchor(e, host, s, byId(s?.players, e.target));
  numbers.spawn(e.target, e.amount, healNumberTint(e.pool), at.x, at.y, 'heal');
}

/** Where a number over `e.target` starts: its interpolated view, lifted to about the top of the
 *  head, falling back to the event's own position and a player-sized body. */
function headAnchor(
  e: { target: number; gx: Fp; gy: Fp },
  host: DamageNumberHost,
  s: GameState | null,
  player: { radius: Fp } | undefined,
): { x: number; y: number } {
  const body = player ?? byId(s?.enemies, e.target);
  const radius = body ? fpToPx(body.radius) : FALLBACK_RADIUS_PX;
  const view = host.actorAt(e.target);
  const x = view ? view.x : fpToPx(e.gx);
  const ground = view ? view.y : fpToPx(e.gy);
  return { x, y: ground - radius * HEAD_LIFT_R };
}
