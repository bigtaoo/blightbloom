/**
 * Drop tables (design/05/09) — what a dead enemy leaves behind, rolled from the
 * injected dropPrng so every client / headless re-judge produces the same drops
 * from seed + input stream (design/06). This is the content that turns kills into
 * the roguelite power ramp: materials, coins, health, energy and run buffs (design/05).
 *
 * **A kill does not drop a weapon** (2026-09-14). Weapons come from a chest, from the boss, or
 * from a shop counter, and nothing else — the `weapon` entry that sat on this table from Stage E
 * until then is gone, along with the per-floor allowance built to smooth it. `DropResult` still
 * has a `weapon` arm because the arena table below rolls one and because chests/boss/shop build
 * their pickups through the same vocabulary.
 *
 * `coin` is the replacement, and it is the SECOND time this file has had a coin kind: the
 * original was a score counter renamed to `material` at ROADMAP 0.6's pickup-vocabulary sync.
 * This one is a different thing wearing the same word — an in-run currency with exactly one
 * sink (a shop room), never banked, never carried out, never seen by the meta layer. Materials
 * remain the only carry-out (design/05/14).
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
import { COIN_DROP_QTY } from '../config';
import { MATERIAL_DROP_POOL } from './materials';

/** What one enemy death yields (design/09 vocabulary). weapon/buff/material/coin carry payload.
 * `tier` (material only) is the ROLLED instance quality, distinct from the static
 * `MaterialDef.tier` catalog base — see rollDrop's `tier` param (ROADMAP 1.5). */
export type DropResult =
  | { kind: 'material'; materialId: string; qty: number; tier: number }
  | { kind: 'heal' }
  // Never rolled by PvE's `rollDrop` since 2026-09-14 — only `rollArenaDrop`, and the three
  // PvE sources that build a pickup directly (ChestSystem, the boss kill, a shop purchase).
  | { kind: 'weapon'; weaponId: string }
  // In-run currency (design/05 "Shops", 2026-09-14). `qty` is COIN_DROP_QTY, flat rather than
  // rolled, so a coin costs the same single table draw `heal` and `energy` do. The `windfall`
  // floor card multiplies it at the point of USE (`DeathDropsSystem`), never here — a card
  // that scaled a payload through this function would be a card that changed nothing about
  // the draw and everything about its signature.
  | { kind: 'coin'; qty: number }
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

/** How much a shield-battery instant item restores (Task 4, ENGINE_VERSION 71) — sized
 *  above every shipped character's `maxShield` (4-8) so it reads as a full recharge
 *  today, the same "flat amount, clamped to the pool" shape `HEAL_PICKUP_AMOUNT`/
 *  `ENERGY_PICKUP_AMOUNT` use rather than a hardcoded `p.shield = p.maxShield`
 *  assignment, so a future higher-`maxShield` character gets a partial top-up instead
 *  of a silently-still-full recharge. */
export const SHIELD_PICKUP_AMOUNT = 10;

/** EMP grenade instant item's flat damage per enemy caught in `SIM.empRadius` (Task 4,
 *  ENGINE_VERSION 71), before resist — `lightning`-typed (design/07), which is what
 *  makes it the answer to `IRONCLAD`/`IRONWARDEN`'s armour (both are weak to shock).
 *  Comparable to one `ENEMY_GUN_SIM` hit's worth of damage per target, not a wipe —
 *  its value is hitting EVERYTHING nearby at once, not out-damaging aimed fire. */
export const EMP_DAMAGE = 2;

/** Material quantity per drop (design/09; depth-scaled amounts are 1.5 to-come). */
export const MATERIAL_DROP_QTY = 1;

// ── The table ────────────────────────────────────────────────────────────────
// Frequent materials keep the carry-out economy ticking; coins fund the shop rooms;
// health is deliberately SCARCE. Weapons are NOT on this table (2026-09-14) — see the
// module header.
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
// Re-weighted again 2026-09-14, on the design call that put weapons behind chests and
// shops: *"怪物是不掉落武器的。要获得武器，只有 boss 掉落和开箱子。有些房间还会有商店，
// 怪物的掉落里加一个金币"*. `weapon` (5) is deleted outright and `coin` arrives at 20,
// funded 5 from that deletion and 15 out of `material`.
//
// **The total stays 84 on purpose, and the 15 points come from `material` rather than
// off the top**, for the same reason the two re-weights before this one did: `heal`,
// `buff` and `energy` keep the exact per-kill odds they had, so this pass is readable
// as one change (weapons out, coins in) instead of as a quiet dilution of everything
// else. What it does cost is real and should be named: the carry-out currency falls
// from 55/84 (65.5%) of kills to 40/84 (47.6%), i.e. roughly a 27% cut in the rate a
// run banks materials, which slows forge progression. That is the trade this design
// makes — value moves from the META ramp to the IN-RUN one, which is where the search
// verb and the shop now live — and it is one number to reverse if the sim says the
// forge went too dry.

type DropTableEntry = { kind: DropResult['kind']; weight: number };

/** Index into DROP_TABLE. `effectiveWeights` moves weight between exactly these two. */
const MATERIAL_ENTRY = 0;
const HEAL_ENTRY = 1;

export const DROP_TABLE: readonly DropTableEntry[] = [
  { kind: 'material', weight: 40 }, // the run's carry-out currency (design/05/14)
  { kind: 'heal', weight: 2 },
  // The shop economy's income (design/05 "Shops", 2026-09-14). 20/84 = 23.8% of kills,
  // which against the measured floor (34.6 kills on floor 0, 52 on floor 2) is ~8-12
  // drops a floor — at COIN_DROP_QTY 5 that is ~40-60 coins per floor, and shop prices
  // are set against that measurement rather than the other way round.
  { kind: 'coin', weight: 20 },
  { kind: 'buff', weight: 6 }, // run-scoped power buffs (design/14) — the affix replacement
  // Weapon-energy refill (ENGINE_VERSION 59) — the second design call of the ammo pass:
  // *"能解决怪物掉落的问题。毕竟降低了掉率之后打完地图空空如也也不好"*. The 16 points came
  // out of `material` and NOT off the total, exactly as the 2026-09-05 heal re-weight
  // did, and the 2026-09-14 coin pass kept the same discipline.
  //
  // 16/84 = 19% of kills. Sized off the measured floor: the sweep reads 34.6 kills on
  // floor 0 and 52 on floor 2, so a floor produces roughly 6-10 of these — enough to
  // read as loot rather than as a rounding error, and (at ENERGY_PICKUP_AMOUNT 30) worth
  // ~200-300 energy a floor on top of regen, i.e. real fuel for an expensive frame
  // without funding one outright.
  { kind: 'energy', weight: 16 },
];

export const HEAL_DROP_MULT_CAP = 8;

/** Options a caller layers onto one roll. Defaults to "the plain table".
 *
 * `weaponAllowed` lived here until 2026-09-14 and is gone with the weapon entry it gated:
 * the floor allowance it served (`GameState.floorWeaponQuota`) no longer exists, because a
 * kill cannot produce a weapon for an allowance to cap. */
export interface DropOpts {
  /** Multiplier on the heal weight (the `heal_drop_x2` floor card). Clamped to
   *  [1, HEAL_DROP_MULT_CAP] and rounded — an integer keeps `weightedIndex`'s draw a
   *  single deterministic integer comparison (design/06). */
  healMult?: number;
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
 * (table → 1, +1 for buff / material to pick the payload) — deterministic given the
 * stream. `tier` (default 0, ROADMAP 1.5 materialTierByDepth) is the depth signal a
 * material drop rolls at — DeathDropsSystem passes `state.floorIndex` (0 for every config
 * without floors, so the default keeps old callers identical).
 *
 * `coin` costs ONE draw, like `heal` and `energy`: its amount is the flat `COIN_DROP_QTY`
 * rather than a roll. The one place that matters is the sim's own accounting — a coin and a
 * potion are interchangeable in the stream, so re-weighting between them moves no later
 * drop in the run.
 */
/**
 * The material tier a kill on `floorIndex` rolls at (ROADMAP B4, 2026-09-26). A dungeon's own
 * `materialTierByDepth` curve when it has one — clamped to its last entry past the end, so a
 * short curve plateaus instead of reading `undefined` — and otherwise the `tier = floorIndex`
 * identity every config shipped with before the field existed.
 */
export function materialTierForFloor(byDepth: readonly number[] | undefined, floorIndex: number): number {
  if (!byDepth || byDepth.length === 0) return floorIndex;
  return byDepth[Math.max(0, Math.min(byDepth.length - 1, floorIndex))]!;
}

export function rollDrop(prng: DropPrng, tier = 0, opts: DropOpts = {}): DropResult {
  const entry = DROP_TABLE[prng.weightedIndex(effectiveWeights(opts.healMult ?? 1))]!;
  switch (entry.kind) {
    case 'buff':
      return { kind: 'buff', buffId: BUFF_DROP_POOL[prng.nextInt(BUFF_DROP_POOL.length)]! };
    case 'coin':
      return { kind: 'coin', qty: COIN_DROP_QTY };
    case 'material':
      return {
        kind: 'material',
        materialId: MATERIAL_DROP_POOL[prng.nextInt(MATERIAL_DROP_POOL.length)]!,
        qty: MATERIAL_DROP_QTY,
        tier,
      };
    // Payload-free, like `heal` — but named explicitly rather than left to the default
    // arm, so that adding another kind cannot silently start returning heals.
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
//
// **`coin` is excluded the same structural way, and `weapon` deliberately is NOT.** The
// 2026-09-14 pass that took weapons off the PvE table left this one alone on purpose: an
// arena has no chests, no boss and no shop, so its loot pool IS its entire power curve
// (design/15) — deleting the weapon entry here would not move where weapons come from, it
// would delete weapons. Coins have the opposite problem: the only thing that spends one is
// a shop room, which is PvE floor content, so an arena coin would be a pickup that can
// never be used.

type ArenaDropTableEntry = { kind: Exclude<DropResult['kind'], 'material' | 'coin'>; weight: number };

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
