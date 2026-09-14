/**
 * Chest content rules (design/05 "Chest rooms") — the two pure decisions a chest needs,
 * kept out of the system that applies them so both can be tested without a GameState and
 * neither can be re-derived slightly differently at a second call site.
 *
 * Split as CLAUDE.md form ① (independent function module): two free functions, no shared
 * state, no class. They answer:
 *
 *   - **Where do a big chest's mechanisms sit?** Derived, never authored. The count is the
 *     run's SEAT count, which no room piece can know at authoring time, so authoring the
 *     positions would be authoring a number that is wrong for every party size but one.
 *   - **How much does a chest pay?** One weapon for a small chest whatever the party size;
 *     one weapon PER SEAT for a big one. That is design/05's flat-per-capita rule stated as
 *     arithmetic: what scales with the party is the coordination cost, never the return.
 *
 * No GameState import (same shape as `content/rooms.ts`/`content/ballistics.ts`), so the
 * state layer can depend on this without a cycle.
 */
import { CHEST_MECHANISM_RING_GRID, CHEST_SMALL_WEAPONS } from '../config';
import { toFpGrid } from './convert';
import { BRAD_FULL, cosFp, sinFp } from '../math/trig';
import { mulFp, type Fp } from '../math/fixed';
import type { ChestKind, ChestMechanism } from '../state/entities';

const RING_FP = toFpGrid(CHEST_MECHANISM_RING_GRID);

/**
 * The mechanism ring for a big chest centred at `(gx, gy)` with `seats` players.
 *
 * Evenly spaced on a circle, first plate due east (brad 0) and the rest anticlockwise by
 * `BRAD_FULL / seats`. Three properties this shape is chosen for, in the order they matter:
 *
 *   - **No PRNG.** A chest's plates are geometry, not a roll. Drawing them would put chest
 *     placement into `dropPrng`'s stream, so how many chests a floor has would silently
 *     shift every later loot roll on that floor (design/06 — a stream is a shared resource).
 *   - **Integer division, evaluated per index.** `i * BRAD_FULL / seats` is computed as
 *     `Math.floor` of the product so three seats land on 0 / 21845 / 43690 rather than
 *     accumulating a rounding error around the ring; every client computes the same integers
 *     from the same two inputs.
 *   - **Rotationally symmetric.** No seat is handed the near plate or the far one, which is
 *     the property that keeps a big chest from favouring whoever walked in first.
 *
 * `seats <= 0` returns an empty ring rather than throwing: a chest with no plates can never
 * be opened by `ChestSystem`'s all-occupied test (it requires at least one), so a degenerate
 * config gets an unopenable chest instead of a crash mid-match.
 *
 * The caller is responsible for clamping each point to walkable ground — this function knows
 * nothing about the floor's geometry, deliberately, so it stays pure.
 */
export function mechanismRing(gx: Fp, gy: Fp, seats: number): ChestMechanism[] {
  if (seats <= 0) return [];
  const out: ChestMechanism[] = [];
  for (let i = 0; i < seats; i++) {
    const brad = Math.floor((i * BRAD_FULL) / seats);
    out.push({
      gx: ((gx as number) + (mulFp(RING_FP, cosFp(brad)) as number)) as Fp,
      gy: ((gy as number) + (mulFp(RING_FP, sinFp(brad)) as number)) as Fp,
      occupied: false,
    });
  }
  return out;
}

/**
 * How many weapons a chest of `kind` pays to a party of `seats`.
 *
 * A small chest pays `CHEST_SMALL_WEAPONS` (1) whatever the party size — it is a find, not a
 * distribution, and first-come-first-served is the point of it being small. A big chest pays
 * one per seat, which is design/05's flat per-capita rule; `seats` is floored at 1 so a
 * malformed zero-seat config cannot make a chest that opens and pays nothing.
 */
export function chestWeaponCount(kind: ChestKind, seats: number): number {
  return kind === 'small' ? CHEST_SMALL_WEAPONS : Math.max(1, seats);
}
