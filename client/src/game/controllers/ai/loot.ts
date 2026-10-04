// What the PvP bot walks to when nothing it aims at is in range (2026-10-03): an unopened crate,
// or a floor gun worth more than the one it holds. Moved here from the sim-only
// `ArenaBotController` (volume 117), which measured it, when the shipped bot took it up.
import { FP_SCALE, WEAPON_SPECS, weaponProfile, type GameState, type PlayerActor } from '@dd/engine';

/** How far off its path the bot walks for a crate or a better gun. */
export const LOOT_DETOUR_FP = 8 * FP_SCALE;

/**
 * How much a bot wants a gun: its authored dps (`weaponProfile`'s `dps` axis), -1 for an
 * unknown id. It was intrinsic RARITY until 2026-09-29, and that was the wrong ordering by
 * the repo's own account: `design/03` measures mean dps FALLING with rarity (rarity buys a
 * mechanic, not pace), and a bot can only use pace. Over 400 paired PvE seeds a rarity swap
 * left the run worse on 46 of the 67 seeds it happened on (avg floor 0.468 → 0.390); by dps
 * the same sweep reads 0.458, level with never swapping, on 39 swapping seeds.
 */
export function gunWorth(weaponId: string): number {
  const spec = WEAPON_SPECS[weaponId];
  return spec ? (weaponProfile(weaponId, spec).axes.dps ?? -1) : -1;
}

export interface LootTarget {
  id: number;
  kind: 'crate' | 'weapon';
  gx: number;
  gy: number;
}

/**
 * Where the loot rule walks: the nearest unopened crate (an arena crate only rolls its
 * contents once a seat is near it, `PickupSystem.resolveCrates`), or floor gun worth more than
 * the one held, within `LOOT_DETOUR_FP`. Strictly more, so the gun a pickup drops can never
 * lure the bot back.
 */
export function lootToSeek(s: GameState, me: PlayerActor): LootTarget | undefined {
  const held = me.weapons.find((w) => w.spec.kind === 'ranged');
  const heldWorth = held ? gunWorth(held.spec.name) : -1;
  let best: LootTarget | undefined;
  let d = LOOT_DETOUR_FP;
  for (const item of s.pickups) {
    if (!item.alive) continue;
    if (item.kind === 'weapon') {
      if (!item.weaponId || WEAPON_SPECS[item.weaponId]?.kind !== 'ranged' || gunWorth(item.weaponId) <= heldWorth) continue;
    } else if (item.kind !== 'crate') continue;
    const dd = Math.hypot(item.gx - me.gx, item.gy - me.gy);
    if (dd <= d) {
      d = dd;
      best = { id: item.id, kind: item.kind, gx: item.gx, gy: item.gy };
    }
  }
  return best;
}
