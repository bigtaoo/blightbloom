// Why a drop the local player is standing on stays on the floor — the readable half of
// design/05's "consumables auto-apply, but only when useful" rule (`pickupWouldApply`).
//
// Live report 2026-10-13, *"玩家靠近物品却无法拾取，感觉非常奇怪。要么给个提示，要么直接拾取"*:
// a full-energy player standing on an energy cell. The engine is right to leave it (there is no
// item bag, so collecting it at the cap destroys it for nothing — the v54 fix), but nothing on
// screen said so: the head shows only the health bar, and the drop drew the same full or not.
// This module answers "would it be refused, and why"; `scene/PickupRefusalLayer.ts` draws it.
//
// Pure — no Pixi, no browser global (`pureLayerBoundary.test.ts` lists it).
import { SIM, TICK_RATE, pickupWouldApply, type Fp, type GameState, type PickupItem, type PickupKind, type PlayerActor } from '@dd/engine';
import { fpToPx } from '../coords';

/** Why the engine is leaving a drop where it is. One per conditional kind in `pickupWouldApply`. */
export type PickupRefusal = 'hpFull' | 'energyFull' | 'shieldFull' | 'noTarget';

/**
 * The kinds `pickupWouldApply` can refuse, and the reason each one is refused for. Looked up
 * BEFORE the engine's predicate is asked, so a kind with no entry can never report a reason —
 * and `pickupRefusal.test.ts` sweeps every kind against `pickupWouldApply` so a future
 * conditional kind that lands without an entry here fails a test instead of going silent.
 */
const REFUSAL_BY_KIND: Partial<Record<PickupKind, PickupRefusal>> = {
  heal: 'hpFull',
  energy: 'energyFull',
  shield: 'shieldFull',
  emp: 'noTarget',
};

/** The reason `p` would leave `item` on the floor right now, or null if it would take it (or the
 *  kind is never conditional). Distance is NOT part of this — see `withinRefusalHintRange`. */
export function pickupRefusalReason(p: PlayerActor, item: PickupItem, state: GameState): PickupRefusal | null {
  const reason = REFUSAL_BY_KIND[item.kind];
  if (!reason) return null;
  return pickupWouldApply(p, item, state) ? null : reason;
}

/**
 * Extra px beyond the sim's own collect gate (`SIM.pickupRadius + p.radius`, 31 px for the shipped
 * body) inside which a refusal is announced. The character's body is drawn floating up to ~48 px
 * above its ground point, so "I am standing on it" by eye can be a few px outside the gate by sim
 * (memory: the unpickable-loot investigation). Announcing from a ring that reaches the drawn
 * body's height means a player who THINKS they are on the drop always gets the explanation.
 */
export const REFUSAL_HINT_SLACK_PX = 17;

/** Is `p`'s ground point close enough to `item` that a refusal should be explained? */
export function withinRefusalHintRange(p: PlayerActor, item: PickupItem): boolean {
  const r = fpToPx((SIM.pickupRadius + p.radius) as Fp) + REFUSAL_HINT_SLACK_PX;
  const dx = fpToPx((item.gx - p.gx) as Fp);
  const dy = fpToPx((item.gy - p.gy) as Fp);
  return dx * dx + dy * dy <= r * r;
}

/** Minimum gap between two announcements for the SAME drop — walking back and forth across one
 *  must not stack labels on it. */
export const REFUSAL_HINT_COOLDOWN_TICKS = 3 * TICK_RATE;

/** One drop to announce this tick. */
export interface RefusalHint {
  item: PickupItem;
  reason: PickupRefusal;
}

/**
 * Edge-triggered announcer: a drop is announced on the tick the local player comes into range of
 * it while it would be refused (or, already in range, on the tick it turns refused), never again
 * until they leave and come back, and never twice inside `REFUSAL_HINT_COOLDOWN_TICKS`. Keyed by
 * engine id, pruned of ids that left the state so a long run does not accumulate them.
 */
export class RefusalHintTracker {
  private inRange = new Set<number>();
  private readonly lastShown = new Map<number, number>();

  update(state: GameState, local: PlayerActor | undefined): RefusalHint[] {
    const out: RefusalHint[] = [];
    const now = new Set<number>();
    if (local?.alive) {
      for (const item of state.pickups) {
        if (!item.alive || !withinRefusalHintRange(local, item)) continue;
        const reason = pickupRefusalReason(local, item, state);
        if (!reason) continue;
        now.add(item.id);
        if (this.inRange.has(item.id)) continue;
        const last = this.lastShown.get(item.id);
        if (last !== undefined && state.tick - last < REFUSAL_HINT_COOLDOWN_TICKS) continue;
        this.lastShown.set(item.id, state.tick);
        out.push({ item, reason });
      }
    }
    this.inRange = now;
    if (this.lastShown.size > 0) {
      const alive = new Set(state.pickups.map((i) => i.id));
      for (const id of this.lastShown.keys()) if (!alive.has(id)) this.lastShown.delete(id);
    }
    return out;
  }

  clear(): void {
    this.inRange.clear();
    this.lastShown.clear();
  }
}
