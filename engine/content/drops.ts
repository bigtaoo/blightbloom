/**
 * Drop tables (design/05/09) — what a dead enemy leaves behind, rolled from the
 * injected dropPrng so every client / headless re-judge produces the same drops
 * from seed + input stream (design/06). This is the content that turns kills into
 * the roguelite power ramp: materials, health, weapons and run buffs (design/05). (This line
 * said "coins (score)" until 2026-09-03 — the coin kind was replaced by `material` at ROADMAP
 * 0.6's pickup-vocabulary sync, and score comes off kills, not off a drop.)
 *
 * Plain data + one roll function; no Pixi, no closures (design/09 "content is plain
 * data"). All weights are integers → weightedIndex is a single deterministic draw.
 * Superseded sim.config.ts SIM.drop from Stage E; changing any weight/pool changes
 * the dropPrng draw sequence → bumps ENGINE_VERSION.
 */
/**
 * The slice of `Prng` a drop roll actually needs. Narrowed to these two methods for
 * the same reason `balance/runbuffs.ts#rollCrit` narrows to `{ nextInt }`: a test can
 * then hand `rollDrop` a recording stub and assert the exact weight array it draws
 * from, instead of inferring the table from thousands of samples. A real `Prng`
 * satisfies it structurally, so no call site changes. */
export interface DropPrng {
  weightedIndex(weights: readonly number[]): number;
  nextInt(max: number): number;
}
import { MATERIAL_DROP_POOL } from './materials';

/** What one enemy death yields (design/09 vocabulary). weapon/buff/material carry payload.
 * `tier` (material only) is the ROLLED instance quality, distinct from the static
 * `MaterialDef.tier` catalog base — see rollDrop's `tier` param (ROADMAP 1.5). */
export type DropResult =
  | { kind: 'material'; materialId: string; qty: number; tier: number }
  | { kind: 'heal' }
  | { kind: 'weapon'; weaponId: string }
  | { kind: 'buff'; buffId: string }
  // Weapon-energy refill (design/03/05, ENGINE_VERSION 59) — the ammo economy's drop.
  // Payload-free: the amount is the constant ENERGY_PICKUP_AMOUNT, not a per-drop roll,
  // so this branch costs the SAME single table draw `heal` does and adds no new PRNG
  // consumption to the stream.
  | { kind: 'energy' }
  // PvP-only (design/05/15's squad follow-up) — spent by ReviveSystem to revive a
  // downed squadmate. Never rolled by PvE's `rollDrop`/`DROP_TABLE`.
  | { kind: 'bandage' };

/** How much a heal pickup restores (design/05 MVP loop, flat +1 HP). */
export const HEAL_PICKUP_AMOUNT = 1;

/** Material quantity per drop (design/09; depth-scaled amounts are 1.5 to-come). */
export const MATERIAL_DROP_QTY = 1;

// ── The table ─────────────────────────────────────────────────────────────────
// Frequent materials keep the carry-out economy ticking; weapons are the "swap your
// gun" moment; health is deliberately SCARCE.
//
// Re-weighted 2026-09-05, on a design call from the game's owner: a health potion
// should be RARE, because the core loop this game wants is "clear the floor without
// getting hit" — a flood of potions replaces that goal with attrition. `heal` went
// 18 -> 2, i.e. 21.4% of kills -> 2.4%. Sustain comes from the shield's idle regen
// (`SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`, design/07's two-pool health) instead
// of from drinking. The baseline that motivated the number is measurable rather than
// asserted: `client/sim/pveLevelSim.sim.ts`'s loot table read 0.21 potions per kill,
// 7-10 per floor, over 16 real bot runs of the shipped level.
//
// The 16 points came OUT of `material`, not off the total: the total stays 84, so
// `weapon` and `buff` keep the exact per-kill odds they had before this pass. That is
// deliberate — weapon COUNT is governed by the per-floor allowance
// (`GameState.floorWeaponQuota`, design/05), and mixing a weight change into the same
// pass would have made the two impossible to read apart. `effectiveWeights` keeps the
// same invariant when a floor card multiplies the heal weight.

type DropTableEntry = { kind: DropResult['kind']; weight: number };

/** Index into DROP_TABLE. `effectiveWeights` moves weight between exactly these two. */
const MATERIAL_ENTRY = 0;
const HEAL_ENTRY = 1;

export const DROP_TABLE: readonly DropTableEntry[] = [
  { kind: 'material', weight: 55 }, // the run's carry-out currency (design/05/14)
  { kind: 'heal', weight: 2 },
  { kind: 'weapon', weight: 5 },
  { kind: 'buff', weight: 6 }, // run-scoped power buffs (design/14) — the affix replacement
  // Weapon-energy refill (ENGINE_VERSION 59) — the second design call of the ammo pass:
  // *"能解决怪物掉落的问题。毕竟降低了掉率之后打完地图空空如也也不好"*. The 16 points come
  // out of `material` and NOT off the total, exactly as the 2026-09-05 heal re-weight
  // did and for the same reason: `weapon` and `buff` keep the per-kill odds they have,
  // so the weapon allowance and the buff ramp stay readable independently of this pass.
  //
  // 16/84 = 19% of kills. Sized off the measured floor: the sweep reads 34.6 kills on
  // floor 0 and 52 on floor 2, so a floor produces roughly 6-10 of these — enough to
  // read as loot rather than as a rounding error, and (at ENERGY_PICKUP_AMOUNT 30) worth
  // ~200-300 energy a floor on top of regen, i.e. real fuel for an expensive frame
  // without funding one outright. It replaces material COUNT, not material value: the
  // carry-out that actually leaves a run is unchanged in kind, only rarer per kill.
  { kind: 'energy', weight: 16 },
];

/**
 * Ceiling on the heal-weight multiplier a stack of `heal_drop_x2` floor cards can
 * reach (design/05, 2026-09-05). Each card doubles, so this is three picks. The
 * number is chosen for what it lands ON rather than for its own sake: 2×8 = 16 of 84
 * is 19%, just under the 21.4% this table shipped with before the same pass made
 * potions scarce — so a fully-stacked run gets back roughly the old flood, and it
 * takes spending three of the run's floor picks to do it.
 */
export const HEAL_DROP_MULT_CAP = 8;

/** Options a caller layers onto one roll. Both default to "the plain table". */
export interface DropOpts {
  /** Multiplier on the heal weight (the `heal_drop_x2` floor card). Clamped to
   *  [1, HEAL_DROP_MULT_CAP] and rounded — an integer keeps `weightedIndex`'s draw a
   *  single deterministic integer comparison (design/06). */
  healMult?: number;
  /** May this kill yield a weapon at all? `false` once the floor's allowance is spent
   *  or this room already handed one out (design/05, `DeathDropsSystem.weaponAllowed`).
   *  A rolled-but-disallowed weapon becomes a `material` — at the SAME dropPrng draw
   *  count as the weapon would have cost, so every later drop in the run lands
   *  identically whether the allowance was open or not. */
  weaponAllowed?: boolean;
}

/**
 * The table's weights for one roll, with a heal multiplier applied by TRANSFER from
 * `material` rather than by addition, so the total — and therefore `weapon`'s and
 * `buff`'s odds — is invariant in the multiplier. Without that, picking the potion
 * card would quietly dilute every other kind, and a player who took it three times
 * would find weapons rarer for a reason nothing on the card mentions.
 */
function effectiveWeights(healMult: number): number[] {
  const w = DROP_TABLE.map((e) => e.weight);
  const mult = Math.min(Math.max(1, Math.round(healMult)), HEAL_DROP_MULT_CAP);
  if (mult === 1) return w;
  const base = w[HEAL_ENTRY]!;
  w[HEAL_ENTRY] = base * mult;
  w[MATERIAL_ENTRY] = w[MATERIAL_ENTRY]! - (base * mult - base);
  return w;
}

/** Weapon ids a drop can roll (must exist in WEAPON_SPECS). Player-facing only. */
export const WEAPON_DROP_POOL: readonly string[] = [
  'repeater',
  'cannon',
  'saber',
  // Elemental drops — the "swap your gun AND your playstyle" moment (design/03/05).
  'flamer',
  'cryobolt',
  'teslagun',
  'venomspit',
  'emberblade',
  'frostbrand',
  'stormglaive',
  // Frame-library drops (design/03 landing order, ROADMAP 1.1) — one per new
  // ballistic/melee frame, physical so the frame's own behavior reads clearly.
  'scattergun',
  'seeker',
  'mortar',
  'lasercutter',
  'tomahawk',
  'hammer',
  'spear',
  // Orbit + radial-emission frames (design/03 tier 4, the last frame-library additions).
  'novaburst',
  'gyre',
  // k_* on-hit procs (design/03/09, ENGINE_VERSION 28 — the first concrete batch).
  'carom',
  'leech',
  // First frame-library elemental siblings (design/03 follow-up) — fire/ice variants
  // of the scattergun/seeker frames, closing a chunk of the "N frames × 5 elements"
  // combinatorial gap that Phase 1.1's physical-only showcase left open.
  'cinderscatter',
  'frostseeker',
];

/** Buff ids a drop can roll (must exist in RUN_BUFFS). Fixed order = deterministic. */
export const BUFF_DROP_POOL: readonly string[] = ['dmg_up', 'rof_up', 'vit_up', 'crit_up'];

/**
 * `RUN_BUFFS` ids that are reachable ONLY from a floor card, never from this table
 * (ENGINE_VERSION 60). Not an oversight list — a named decision, so that adding a buff
 * family and forgetting to place it fails `drops.test.ts` instead of silently becoming
 * undroppable.
 *
 * `cell_up` is here because +max energy is CONDITIONAL in a way the other four families
 * are not: its worth depends entirely on what you are currently holding. As a 1-in-5 floor
 * drop, a run that never empties its bar spends a fifth of every buff drop it gets on a
 * reward it cannot use, taken out of four families that always do something. As a card it
 * is a CHOICE against two alternatives, which is the correct home for a reward like that.
 *
 * The argument was STRONGER when it was written (ENGINE_VERSION 60) than it is now. It
 * used to rest on "a fresh save's pool never empties", which was true while the starter
 * blaster sat below the regen line with headroom; at ENGINE_VERSION 62 the line dropped to
 * 15/s and the blaster sits exactly ON it, so a fresh save's bar now empties whenever a
 * `rof_up` or a burst takes it over (measured: 22.6% of live ticks holding a gun the pool
 * cannot pay for, up from 0.9%). `cell_up` stays card-only because the conditionality
 * argument survives — it is worth nothing to a player who is not currently over the line —
 * but this is now a judgement rather than the near-tautology it was, and moving it into
 * `BUFF_DROP_POOL` is a legitimate thing to reconsider. Doing so changes the buff pool's
 * indexing and therefore the dropPrng draw sequence, so it is a version bump, not a tweak.
 */
export const CARD_ONLY_BUFF_IDS: readonly string[] = ['cell_up'];

/**
 * Roll one drop from the dropPrng (design/05/09). Draw count varies by branch
 * (table → 1, +1 for weapon / buff / material to pick the payload) — deterministic
 * given the stream, and deliberately IDENTICAL for a weapon and for the material it
 * degrades to when `opts.weaponAllowed` is false. `tier` (default 0, ROADMAP 1.5 materialTierByDepth) is the
 * depth signal a material drop rolls at — DeathDropsSystem passes `state.floorIndex`
 * (0 for every config without floors, so the default keeps old callers identical).
 */
export function rollDrop(prng: DropPrng, tier = 0, opts: DropOpts = {}): DropResult {
  const entry = DROP_TABLE[prng.weightedIndex(effectiveWeights(opts.healMult ?? 1))]!;
  // A weapon the floor's allowance won't cover falls through to the material branch,
  // which costs the same one extra `nextInt` the weapon branch would have — see
  // DropOpts.weaponAllowed for why the draw count has to match.
  const kind = entry.kind === 'weapon' && !(opts.weaponAllowed ?? true) ? 'material' : entry.kind;
  switch (kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'buff':
      return { kind: 'buff', buffId: BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]! };
    case 'material':
      return {
        kind: 'material',
        materialId: MATERIAL_DROP_POOL[prng.nextInt(MATERIAL_DROP_POOL.length)]!,
        qty: MATERIAL_DROP_QTY,
        tier,
      };
    // Payload-free, like `heal` — but named explicitly rather than left to the default
    // arm, so that adding a sixth kind cannot silently start returning heals.
    case 'energy':
      return { kind: 'energy' };
    default:
      return { kind: 'heal' };
  }
}

// ── PvP arena drop table (design/15, ROADMAP 4.3) ──────────────────────────────
//
// "Same drop MODEL as PvE — weapon/buff/heal — but the arena's own table, zero
// connection to a player's account/materials" (design/15). `material` is
// STRUCTURALLY absent, not just zero-weighted — an arena death can never bank
// toward `state.bankedMaterials` (PvP's fairness wall, same spirit as
// `buildArenaSpecs` taking no meta param). Weights are a first-pass placeholder
// (design/15's loot-marker/DropTable weighting is explicitly still "to design") —
// re-weight freely; this only needs to exercise the mechanism honestly today.

type ArenaDropTableEntry = { kind: Exclude<DropResult['kind'], 'material'>; weight: number };

export const ARENA_DROP_TABLE: readonly ArenaDropTableEntry[] = [
  { kind: 'heal', weight: 35 },
  { kind: 'weapon', weight: 40 },
  { kind: 'buff', weight: 20 },
  // The arena has to carry the energy refill too (ENGINE_VERSION 59), or a looted
  // heavy frame runs dry with nothing on the map that can feed it — the arena's loot
  // pool IS its whole power curve (design/05/15), so a missing kind here is not a
  // smaller version of the PvE gap, it is the only supply line there is.
  { kind: 'energy', weight: 25 },
  // Squad revive currency (design/05/15) — a first-pass weight, same "needs real
  // playtesting" caveat as every other number on this table; not so common a downed
  // teammate is trivially free, not so rare a squad realistically never revives.
  { kind: 'bandage', weight: 5 },
];

/** Roll one drop from the arena's own table (never a `material`) — same dropPrng
 * stream as PvE `rollDrop` (mode-exclusive: a match is never both dungeon and
 * arena, so there's no aliasing to guard against, same reasoning as `roomgenPrng`
 * being reused rather than duplicated per mode). */
export function rollArenaDrop(prng: DropPrng): DropResult {
  const entry = ARENA_DROP_TABLE[prng.weightedIndex(ARENA_DROP_TABLE.map((e) => e.weight))]!;
  switch (entry.kind) {
    case 'weapon':
      return { kind: 'weapon', weaponId: WEAPON_DROP_POOL[prng.nextInt(WEAPON_DROP_POOL.length)]! };
    case 'buff':
      return { kind: 'buff', buffId: BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]! };
    case 'bandage':
      return { kind: 'bandage' };
    case 'energy':
      return { kind: 'energy' };
    default:
      return { kind: 'heal' };
  }
}
