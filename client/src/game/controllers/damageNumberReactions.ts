/**
 * The `hit` → floating damage number reaction (design/10 "Damage numbers"), carved out of
 * `EventReactor` the way `pickupReactions.ts` is: which hits get a number, what colour, and where
 * it starts. Pure — the numbers themselves arrive as a one-method sink — so every rule here is
 * testable with plain objects (`pureLayerBoundary.test.ts` lists this file).
 *
 * The shrinking zone is covered by this and needs nothing of its own: `EnvironmentSystem` deals
 * a zone tick through `takeDamage`, which announces it as an ordinary `hit` with
 * `faction: 'environment'`, and only THEN pushes `zone_damage`. Numbering `zone_damage` as well
 * would print every tick twice, so that event stays unhandled on purpose; hazard tiles arrive the
 * same way and take the same colour.
 */
import type { DamageSrc, GameEvent, GameState } from '@dd/engine';
import { THEME, elementColor } from '../theme';
import { fpToPx } from '../coords';
import { byId } from './attackShapes';

type HitEvent = Extract<GameEvent, { type: 'hit' }>;

/** Where a number goes — `fx/DamageNumbers.ts`, narrowed to the one call this module makes. */
export interface DamageNumberSink {
  spawn(target: number, value: number, tint: number, x: number, y: number): void;
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
 * (it says "no health lost", which matters most on yourself); then damage to you is red; then the
 * environment's slate; then the weapon's element, with physical in design/13's locked neutral.
 */
export function hitNumberTint(e: Pick<HitEvent, 'faction' | 'damageType' | 'shieldRemaining'>, targetIsLocal: boolean): number {
  if ((e.shieldRemaining ?? 0) > 0) return THEME.colors.shield;
  if (targetIsLocal) return SELF_TINT;
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
  const body = player ?? byId(s?.enemies, e.target);
  const radius = body ? fpToPx(body.radius) : FALLBACK_RADIUS_PX;
  const view = host.actorAt(e.target);
  const x = view ? view.x : fpToPx(e.gx);
  const ground = view ? view.y : fpToPx(e.gy);
  numbers.spawn(e.target, e.damage, hitNumberTint(e, local), x, ground - radius * HEAD_LIFT_R);
}
