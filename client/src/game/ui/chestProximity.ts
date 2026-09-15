import { CHEST_INTERACT_RANGE_GRID, CHEST_MECHANISM_RADIUS_GRID, CHEST_MECHANISM_RING_GRID } from '@dd/engine';
import type { Chest, Fp } from '@dd/engine';

/**
 * Which chest, if any, a seat is close enough to be told about (design/05 "Chest rooms").
 *
 * Same module shape and same reasoning as `shopProximity.ts` next door: the agreement between
 * what the HUD SHOWS and what the sim ACCEPTS is the one *"stood on it and nothing happened"*
 * failure neither package's suite can see on its own, so the range lives here as the sim's own
 * constants rather than as a number restated in a Pixi file.
 *
 * **Why this exists at all.** A chest is silent — no art, no cue, no prompt — and nothing in
 * the game ever taught INTERACT: the tutorial's hint list covers move, attack, swap and
 * deflect, and stops. Verified 2026-09-15 in the running client: a small chest opens exactly
 * as `ChestSystem` says it does the moment a `KeyE` reaches `WebInput`, so what was missing
 * was never the mechanic, only any way to find out the mechanic was there.
 *
 * ## Two kinds, two ranges, and the reason they differ
 *
 * A SMALL chest's range is the sim's own gate (`CHEST_INTERACT_RANGE_GRID`), the same
 * show-exactly-what-is-accepted rule the shop panel follows: a prompt that appeared a step
 * before the button worked would teach the wrong distance.
 *
 * A BIG chest has no button at all — it opens when every mechanism plate is occupied — so its
 * prompt has to survive the player doing the right thing. Standing on a plate puts you
 * `CHEST_MECHANISM_RING_GRID` from the chest's centre, well outside the small chest's reach,
 * so the interact range would hide the panel at the exact moment it is explaining something.
 * Its range is therefore the ring plus a plate's own radius: the whole area from which the
 * plates are workable.
 */
export const CHEST_PROMPT_RANGE_GRID = CHEST_INTERACT_RANGE_GRID;
export const CHEST_BIG_PROMPT_RANGE_GRID = CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID;

/**
 * The nearest chest worth prompting about for a seat at `(px, py)`, or `undefined`.
 *
 * `smallRangeFp` is passed in rather than derived here because the sim's reach test adds the
 * PLAYER'S OWN body radius to it (`ChestSystem.openWanted`), and this module knows nothing
 * about actors — the caller, which has the seat in hand, does that sum. The big-chest range is
 * geometry about the plates rather than about a reach, so it is not given the same treatment.
 *
 * An OPENED chest is never returned: it stays in the world as a landmark (`scene/ChestLayer`
 * draws it as an emptied box) and there is nothing left to tell anybody about it.
 */
export function nearbyChest(
  chests: readonly Chest[],
  px: Fp,
  py: Fp,
  smallRangeFp: number,
  bigRangeFp: number,
): Chest | undefined {
  let best: Chest | undefined;
  let bestD2 = Infinity;
  for (const chest of chests) {
    if (chest.opened) continue;
    const reach = chest.kind === 'big' ? bigRangeFp : smallRangeFp;
    const dx = (chest.gx as number) - (px as number);
    const dy = (chest.gy as number) - (py as number);
    const d2 = dx * dx + dy * dy;
    if (d2 <= reach * reach && d2 < bestD2) {
      best = chest;
      bestD2 = d2;
    }
  }
  return best;
}
