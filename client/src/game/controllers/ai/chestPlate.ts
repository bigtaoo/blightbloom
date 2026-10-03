// The co-op ally's half of a big chest (2026-10-03). A big chest has one plate per seat and
// opens only with every plate held on the same tick (`ChestSystem`), so an ally that stood on
// none left its player a chest that could never open (volume 124). The rule: once a squadmate
// stands on a plate of an unopened big chest, walk to the nearest free plate and hold it.
import { CHEST_MECHANISM_RADIUS_GRID, type GameState, type PlayerActor } from '@dd/engine';
import { toFpGrid } from '@dd/engine/content/convert';
import { walkTo } from './dungeonRoute';
import { HOLD, type Move } from './steer';

/** `ChestSystem`'s own reach: a seat this close to a plate's centre holds it. */
const PLATE_FP = toFpGrid(CHEST_MECHANISM_RADIUS_GRID);
/** How far inside that reach the ally walks before it stops, so a shove does not step it off. */
export const PLATE_SNUG_FP = toFpGrid(CHEST_MECHANISM_RADIUS_GRID / 3);

type Spot = { gx: number; gy: number };

/** This tick's move onto a free plate, or undefined when no squadmate is waiting on one. */
export function plateMove(s: GameState, me: PlayerActor): Move | undefined {
  // Held by a standing seat other than this one: the plate this ally would otherwise take.
  const held = (m: Spot) => s.players.some((p) => p !== me && p.alive && !p.downed && dist(p, m) <= PLATE_FP);
  for (const chest of s.chests) {
    if (chest.opened || chest.mechanisms.length < 2 || !chest.mechanisms.some(held)) continue;
    let best: Spot | undefined;
    let d = Infinity;
    for (const m of chest.mechanisms) {
      if (held(m)) continue;
      const dm = dist(me, m);
      if (dm < d) (d = dm), (best = m);
    }
    if (!best) continue; // every plate is held already
    return d <= PLATE_SNUG_FP ? HOLD : (walkTo(s, me, best) ?? HOLD);
  }
  return undefined;
}

function dist(a: Spot, b: Spot): number {
  return Math.hypot(a.gx - b.gx, a.gy - b.gy);
}
