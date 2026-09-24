// Debug-only overlay (`?pickupDebug=1`) for the "掉落物品无法拾取" investigation
// (see memory daydayup-unpickable-loot-investigation). Draws the SIM's own collect
// geometry straight from GameState — each player's ground point (`gx`/`gy`, the value
// PickupSystem actually compares against, not wherever the drawn body's hover/rig lift
// happens to put its silhouette on screen) and the exact radius each pickup kind is
// gated on — so "am I standing on it" is a ring on screen instead of a guess from where
// the art floats.
//
// World-space (added to `layers.hud` — per layers.ts: "always-on-top, never blurred,
// pans/zooms with the camera like everything else in `world`"), so a screenshot at any
// camera zoom shows the real geometry without any coordinate conversion by the reader.
//
// Debug-only: rebuilding a Text per pickup every frame is deliberate churn this tool
// accepts (unlike PerfOverlay's "no per-frame allocation" rule) because it only runs
// behind the query flag — never in a normal session.

import { Container, Graphics, Text } from 'pixi.js';
import { SIM, pickupWouldApply, type Fp, type GameState, type PickupItem } from '@dd/engine';
import { fpToPx } from '../coords';

// SIM.pickupRadius + a player's own solidRadius — the exact threshold PickupSystem's
// `circlesOverlap` checks for every auto-collect kind (heal/material/buff/bandage).
const RING_AUTO = 0x60a5fa; // blue
// SIM.lootRevealRadius, unpadded — the weapon-pickup PANEL's own ring
// (`pickupProximity.ts`'s WEAPON_PROMPT_RADIUS_FP), which is the binding constraint for
// a weapon drop: nothing is clickable until the panel lists it, and the sim's own accept
// radius for a click (`lootRevealRadius + p.radius`) is strictly wider, so the panel ring
// is the one worth drawing.
const RING_WEAPON = 0xfbbf24; // amber
const DOT_OK = 0x4ade80; // green — this pickup is inside its governing ring right now
const DOT_MISS = 0xf87171; // red — it is not

/**
 * Pure per-pickup readout — pulled out of `update()` so `PickupDebugOverlay.test.ts` can
 * pin it against the real `PickupSystem`/`nearbyWeaponPickups` behaviour without any
 * Pixi object. Mirrors `PickupSystem.tick`'s own gate exactly: a `weapon` is gated on the
 * panel's ring (`SIM.lootRevealRadius`, unpadded — see `RING_WEAPON`'s doc comment above
 * for why that is the one worth reading as "collectible" rather than the sim's own wider
 * accept radius), everything else on `SIM.pickupRadius + the nearest player's own radius`,
 * the same `circlesOverlap` call `PickupSystem` makes. Assumes `item` is alive and not a
 * `crate` — `update()` filters both before calling this.
 */
export function pickupDebugGate(state: GameState, item: PickupItem): { nearestPx: number; collectible: boolean } {
  let nearestPx = Infinity;
  let collectible = false;
  for (const p of state.players) {
    if (!p.alive) continue;
    const d = Math.hypot(fpToPx((item.gx - p.gx) as Fp), fpToPx((item.gy - p.gy) as Fp));
    if (d < nearestPx) nearestPx = d;
    // Distance is not the only gate: design/05's "only when useful" rule leaves a no-op
    // consumable on the floor even at zero distance (`ENGINE_VERSION` 54), so a heal
    // standing under a full-HP player is genuinely NOT collectible and must not draw green.
    // Asking the engine's own predicate rather than restating it is the point — this file's
    // parity test runs the real PickupSystem beside this readout, and caught the gap the
    // day the rule landed.
    if (d <= pickupGatePx(item, p) && pickupWouldApply(p, item, state)) collectible = true;
  }
  return { nearestPx, collectible };
}

/**
 * The collect distance, world px, for one drop against one player — the single
 * definition of the threshold, so nothing anywhere re-derives it (design/18 G6). A
 * `weapon` is gated on the panel's ring; every auto-collect kind on the player's OWN
 * radius plus the sim's padding, which is why this takes the player rather than a
 * constant. Read by `pickupDebugGate` above, by `update()`'s drawn rings below, and by
 * `sim/replay/inspect.ts`.
 *
 * Takes only `kind` off the item so `update()` can ask it for each RING (a threshold with
 * no item behind it yet) through the same function that answers for a real drop.
 */
export function pickupGatePx(item: Pick<PickupItem, 'kind'>, player: { radius: Fp }): number {
  return fpToPx(
    (item.kind === 'weapon' ? SIM.lootRevealRadius : SIM.pickupRadius + player.radius) as Fp,
  );
}

// The two rings `update()` draws are exactly the two branches of `pickupGatePx`, asked for
// by the cheapest item shape that selects each one. Drawing them through the function
// instead of re-deriving the arithmetic is the point: a ring that disagrees with the dot
// colour beside it makes this tool lie about the very thing it was built to measure.
const AUTO_RING_PROBE: Pick<PickupItem, 'kind'> = { kind: 'heal' };
const WEAPON_RING_PROBE: Pick<PickupItem, 'kind'> = { kind: 'weapon' };

export class PickupDebugOverlay {
  readonly view = new Container();
  private readonly rings = new Graphics();
  private readonly labels = new Container();

  constructor() {
    this.view.eventMode = 'none'; // never swallow a tap meant for the game underneath
    this.view.zIndex = 20_000; // over the floating health bars this same layer draws
    this.view.addChild(this.rings, this.labels);
  }

  update(state: GameState): void {
    this.rings.clear();
    this.labels.removeChildren();

    for (const p of state.players) {
      if (!p.alive) continue;
      const px = fpToPx(p.gx);
      const py = fpToPx(p.gy);
      this.rings.circle(px, py, 3).fill({ color: 0xffffff }); // the ground point itself
      this.rings
        .circle(px, py, pickupGatePx(AUTO_RING_PROBE, p))
        .stroke({ color: RING_AUTO, width: 1.5, alpha: 0.9 });
      this.rings
        .circle(px, py, pickupGatePx(WEAPON_RING_PROBE, p))
        .stroke({ color: RING_WEAPON, width: 1.5, alpha: 0.6 });
    }

    for (const item of state.pickups) {
      if (!item.alive || item.kind === 'crate') continue; // crate has no collect gate of its own
      const ix = fpToPx(item.gx);
      const iy = fpToPx(item.gy);
      const { nearestPx, collectible } = pickupDebugGate(state, item);
      const color = collectible ? DOT_OK : DOT_MISS;
      this.rings.circle(ix, iy, 4).fill({ color });
      const label = new Text({
        text: `${item.kind} ${Math.round(nearestPx)}px`,
        style: { fontFamily: 'monospace', fontSize: 10, fill: color },
      });
      label.anchor.set(0.5, 0);
      label.x = ix;
      label.y = iy + 8;
      this.labels.addChild(label);
    }
  }
}
