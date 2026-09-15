import { CHEST_MECHANISM_RADIUS_GRID, CHEST_MECHANISM_RING_GRID } from '@dd/engine';
import type { Chest, Fp } from '@dd/engine';

/**
 * Which BIG chest, if any, a seat is close enough to be told about (design/05 "Chest rooms").
 *
 * **Only the big one, as of `ENGINE_VERSION` 66.** A small chest opens on approach now — no
 * button, no hold — so a caption for it could only ever appear on the frame it opened and
 * vanish on the next. The prompt that was written for it on 2026-09-15 (*"Press E to open"*)
 * outlived its mechanic by a few hours: the owner's answer to *"the chest cannot be opened"*
 * was to delete the step rather than to explain it, which is the better fix and leaves nothing
 * to say. See `ChestSystem`'s own header for the rule and what it replaced.
 *
 * A big chest still has something to say, and more than the small one ever did: it opens only
 * while **every** mechanism plate is occupied at once, which is a rule a player standing on one
 * plate in an empty room cannot possibly infer.
 *
 * ## The range is about the plates, not about a reach
 *
 * Standing on a plate puts a player `CHEST_MECHANISM_RING_GRID` from the chest's centre. Any
 * tighter range would hide the panel at the exact moment it is explaining something — the
 * player would walk out to the plate and lose the count they were following. So the range is
 * the ring plus a plate's own radius: the whole area from which the plates are workable.
 */
export const CHEST_PLATE_PROMPT_RANGE_GRID = CHEST_MECHANISM_RING_GRID + CHEST_MECHANISM_RADIUS_GRID;

/**
 * The nearest unopened big chest within `rangeFp` of `(px, py)`, or `undefined`.
 *
 * An OPENED chest is never returned: it stays in the world as a landmark (`scene/ChestLayer`
 * draws it as an emptied box) and there is nothing left to coordinate about it. Small chests
 * are skipped for the reason in the module note — nothing about one is worth a caption.
 *
 * Nearest rather than first: two chests could in principle overlap range, and a panel that
 * picked by array order would flicker between them as the player walked.
 */
export function nearbyBigChest(chests: readonly Chest[], px: Fp, py: Fp, rangeFp: number): Chest | undefined {
  const r2 = rangeFp * rangeFp;
  let best: Chest | undefined;
  let bestD2 = Infinity;
  for (const chest of chests) {
    if (chest.opened || chest.kind !== 'big') continue;
    const dx = (chest.gx as number) - (px as number);
    const dy = (chest.gy as number) - (py as number);
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      best = chest;
      bestD2 = d2;
    }
  }
  return best;
}
