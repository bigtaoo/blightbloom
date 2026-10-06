/**
 * Enemy blueprints (design/09 actor content). The basic mob plus a set of elemental
 * variants that carry a resist/weakness profile, so damage types matter tactically:
 * match the enemy's weakness to melt it, hit its resistance and it shrugs the hit
 * toward the min-1 floor (design/07). SpawnSystem reads a blueprint by `type` (the
 * optional third field of a wave spawn entry; missing = 'basic').
 *
 * HP / footprint / radius / loadout are in human/px units re-anchored to grid via
 * pxToFp (÷32); the weapon is one of the shared mob sim specs (content/weapons.ts) —
 * `ENEMY_GUN_SIM` for the eight ranged variants, `ENEMY_CLAW_SIM`/`ENEMY_MAUL_SIM` for
 * the two melee ones added in ENGINE_VERSION 59.
 * `resist` and `tint` are the variant knobs — `resist` is read by the sim (per-type
 * multiplier), `tint` is render-only (Scene colours the body by it; the sim never
 * reads it, like Actor.z). Adding a new variant here + a new `type` id in a wave is
 * a forward-compatible content add (design/09) — no ENGINE_VERSION bump.
 */
import { toFp, type Fp } from '../math/fixed';
import { ENEMY_TEAM_ID, type EnemyActor, type EnrageSim, type WeaponSimSpec } from '../state/entities';
import type { GameState } from '../state/GameState';
import type { DamageType, ResistMap } from './damage';
import { freshStatus } from './damage';
import { pxToFp } from './convert';
import { PLAYER_BASE } from './players';
import { ENEMY_CLAW_SIM, ENEMY_GUN_SIM, ENEMY_MAUL_SIM, makeWeapon } from './weapons';
import { BLIGHTLORD, GLACIMAW, IRONWARDEN, PYREFANG, ROTBLOOM, VOLTREAVER } from './bosses';

// The boss blueprints and the random-boss pool live in their own file (split 2026-10-06 when
// chapter 2's boss pushed this one past 500 lines); re-exported so every existing import of
// `./enemies` keeps working.
export * from './bosses';
import { curveAt } from '../world/dungeon';

export interface EnemyBlueprint {
  type: string; // registry key + the id a wave spawn entry references
  maxHp: number;
  radius: Fp;
  footprintRadius: Fp; // feet circle for solid push-out (< radius); see Actor.footprintRadius
  /**
   * The mob's loadout. Widened from `RangedSimSpec` to the full union in
   * ENGINE_VERSION 59: every blueprint carried `ENEMY_GUN_SIM` until then, so "the
   * roster is all ranged" was enforced by this type rather than chosen as content —
   * which is exactly the shape of gap design/03 records elsewhere ("three fields this
   * doc's schema implies are live, and are not"). See STALKER / RAVAGER below, and
   * `weaponSpecs/dropOnly.ts` for why neither melee mob deflects.
   */
  weapon: WeaponSimSpec;
  // Per-type damage multiplier (per-mille; 1000 = normal, 2000 = weak/×2, 500 = resist/×½).
  // Missing type = neutral. The knob that makes damage types matter per mob (design/07).
  resist?: ResistMap;
  tint?: number; // render-only body colour (design/01); the sim never reads it
  // Which of design/13's five elements this variant IS — render-only, copied to the
  // actor like `tint`, never read by the sim. The view draws the locked element ICON
  // badge from it (design/13: "told apart by colour + icon alone"), which is the second
  // channel of a dual-channel rule whose colour half is `tint` right above.
  //
  // AUTHORED, not derived from `resist`. A "strongest resist wins" rule would have been
  // free and would also have been wrong twice over: `brute` resists physical without
  // being the physical variant, and `blightlord` — the boss whose whole flavour is
  // poison — resists physical hardest and is WEAK to poison, so it would have been
  // badged as the physical mob. Only the five locked variants carry this; everything
  // else is deliberately unbadged (see the design/13 sentence naming exactly five).
  element?: DamageType;
  // Render-only body rig atlas key (design/13 "roster variety beyond the base body: a
  // heavy brute, a floating ranged form") — like `tint`, the sim never reads it.
  // Undefined = the shared 'critter-core' body (Actor.ts's existing default).
  bodyRig?: string;
  boss?: boolean; // render-only (like tint): the view draws a health bar for a boss
  // Boss AI depth (design/09 aspirational `traits`/`onDeathSpawn`, ENGINE_VERSION 27).
  // See EnemyActor's matching fields for the full account; undefined = neither trait.
  enrage?: EnrageSim;
  onDeathSpawn?: { type: string; count: number };
  // Boss AI depth, a THIRD axis alongside enrage/onDeathSpawn (Task 2's boss pass,
  // ENGINE_VERSION 70): an armored phase that breaks once hp first crosses the
  // threshold — the opposite direction of `enrage` (a DEFENSIVE trait, not an
  // offensive one) but the same one-way latch shape. `resist` above is the pre-break
  // (armored) profile; this is the post-break (exposed) one it is REPLACED BY, once,
  // never restored (see `WeaponFireSystem.latchArmorBreak`).
  armorBreak?: { hpThresholdPermille: number; resist: ResistMap };
  // Movement AI (ENGINE_VERSION 37, see EnemyActor's matching fields) — per-type
  // override; undefined = the shared DEFAULT_ENEMY_* constant below. No blueprint
  // sets these yet (first-pass numbers, tune per mob once there's real playtesting);
  // the knob exists so a future rush/melee variant can go faster with a near-zero
  // range, or a sniper variant can hang back at a much longer one.
  moveSpeedPerTick?: Fp;
  engageRangeFp?: Fp;
  // Perception radius (ENGINE_VERSION 42) — how close the player has to get before this
  // mob reacts at all. Undefined = DEFAULT_ENEMY_AGGRO_RANGE_FP below.
  aggroRangeFp?: Fp;
}

// ── Movement AI defaults (ENGINE_VERSION 37) ─────────────────────────────────────
// Every enemy used to be rooted at its spawn point (AIDecideSystem's old header:
// "Enemies are stationary in the slice") — it faced and shot at the nearest player
// but never closed distance, which read as "the AI doesn't move" (exactly the
// reported bug). These are first-pass numbers: slower than the player so committing
// to running away always opens the gap, and a stop-distance short enough that a mob
// actually has to cross most of a room's width to reach it (design/09's authored
// room sizes run ~12-24 grid / 384-768px — deriving the range from the gun's own
// max travel (bulletSpeed × lifespan, ~30 grid for ENEMY_GUN_SIM) would put the
// mob's standoff distance beyond most rooms' diagonal, so it would rarely be
// observed moving at all).
// Exported so AIDecideSystem can fall back to the SAME numbers for a hand-built
// EnemyActor that bypasses this factory (most unit tests) — one source of truth,
// not two constants that could drift apart.
// Retuned 2026-08-17 (ENGINE_VERSION 42, live play report: "怪物的感知范围弄小一些，移动
// 速度调低"). Was 4 px/tick, i.e. ~63% of the player's — close enough that a garrison that
// had noticed you stayed glued to you, and backing off never actually opened a gap the way
// the v37 note claimed it would (the player also has to aim and dodge, so the effective
// gap-opening rate is far below the raw speed ratio). 2.6 px/tick ≈ 78 px/s is ~41% of
// PLAYER_BASE.speedPerTick: retreating now visibly outruns them, and a mob crossing a room
// to reach you reads as a threat approaching rather than a rush.
export const DEFAULT_ENEMY_MOVE_SPEED_PER_TICK = pxToFp(2.6); // ≈78 px/s, ~41% of PLAYER_BASE.speedPerTick
export const DEFAULT_ENEMY_ENGAGE_RANGE_FP = pxToFp(180); // ~5.6 grid — stop and shoot once this close
// Perception radius (ENGINE_VERSION 42): the INNER aggro gate, inside design/05's
// room-as-the-aggro-unit outer one. Room activation still wakes the room; this decides
// which of its mobs have actually noticed you. 320 px = 10 grid, wider than
// DEFAULT_ENEMY_ENGAGE_RANGE_FP (so a mob that notices you still has ~4 grid to close
// before it may shoot — the reaction window is preserved) but well under the 12-24 grid
// span of level 1's authored rooms (`world/dungeons/ember/`), so walking into a room no
// longer sets its whole garrison marching at you at once. Latched via `EnemyActor.aggroed`
// — once a mob has noticed you it stays awake, so this is a wake-up trigger, not a leash.
export const DEFAULT_ENEMY_AGGRO_RANGE_FP = pxToFp(320); // 10 grid

// ── Basic (neutral) ─────────────────────────────────────────────────────────────
export const BASIC_ENEMY: EnemyBlueprint = {
  type: 'basic',
  maxHp: 3,
  radius: pxToFp(15), // demo 15px
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  // Neutral to every type; status effects still apply. tint omitted → default palette.
};

// ── Elemental variants ──────────────────────────────────────────────────────────
// Each resists its own element (shrug it off) and is weak to a counter, so all four
// elemental weapons have a target they excel against. Slightly higher HP than basic
// so the resist/weakness actually reads before the mob dies. First-pass numbers.

/** Fire mob: shrugs off fire, melts to ice. */
export const EMBERLING: EnemyBlueprint = {
  type: 'emberling',
  element: 'fire',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { fire: 400, ice: 1800 }, // ×0.4 fire, ×1.8 ice
  tint: 0xff7043, // ember orange
};

/** Ice mob: shrugs off ice, melts to fire. */
export const FROSTLING: EnemyBlueprint = {
  type: 'frostling',
  element: 'ice',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { ice: 400, fire: 1800 },
  tint: 0x81d4fa, // frost blue — matches design/13's locked ice element hue (ELEMENT_COLORS.ice)
};

/** Charged mob: shrugs off lightning, rots to poison. */
export const GALVANIST: EnemyBlueprint = {
  type: 'galvanist',
  element: 'lightning',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { lightning: 400, poison: 1800 },
  tint: 0xfff176, // charged yellow — matches design/13's locked lightning element hue (ELEMENT_COLORS.lightning)
};

/** Rot mob (chapter 4, design/gameplay/04-chapters.md): shrugs off poison, burns to fire.
 *  The fifth of design/13's locked elements to get a critter; until it existed the poison read
 *  lived only on `blightlord`, which is WEAK to poison. Fire is the counter because the Blight
 *  is rot, and rot burns; it also leaves ice as fire's only counter and fire as the counter to
 *  both ice and poison, which chapter 4 leans on: its garrison is the one where fire drops shine. */
export const BLIGHTLING: EnemyBlueprint = {
  type: 'blightling',
  element: 'poison',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { poison: 400, fire: 1800 },
  tint: 0x9ccc65, // sickly green — matches design/13's locked poison element hue (ELEMENT_COLORS.poison)
};

/** Armoured mob: shrugs off bullets (physical) and fire, but conducts lightning.
 *  Tougher — the "bring the right tool" wall. */
export const IRONCLAD: EnemyBlueprint = {
  type: 'ironclad',
  element: 'physical',
  maxHp: 6,
  radius: pxToFp(17),
  footprintRadius: pxToFp(8),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 500, fire: 700, lightning: 1900 }, // armour vs bullets/fire, weak to shock
  tint: 0x90a4ae, // steel grey
};

// ── Body-form variety (design/13 "roster variety beyond the base body") ──────────
// Both reuse the generic enemy AI/gun (no ranged/melee AI split exists yet, same as
// every variant above) — the differentiation here is silhouette + stats, not
// behavior, exactly like the elemental re-tints. `bodyRig` picks the distinct art
// (render/skinRegistry.ts's 'brute-core'/'floater-core', sharing critter-core's rig);
// `tint` is design/13's locked neutral/physical hex so it doesn't get discoloured by
// the enemy body's own default red tint (Actor.ts's `resolvedTint = tint ?? body`).

/** Heavy bruiser: armoured, tankier than ironclad's wall-of-bullets read but no
 *  elemental weakness/resist pair — a flat physical damage reduction instead. */
export const BRUTE: EnemyBlueprint = {
  type: 'brute',
  maxHp: 7,
  radius: pxToFp(20),
  footprintRadius: pxToFp(9),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 700 }, // ×0.7 bullets — armoured, not immune
  tint: 0xe2e8f0, // design/13's locked neutral/physical hex
  bodyRig: 'brute-core',
};

/** Fragile floating form: lower HP than basic, no resist — the "glass" read to pair
 *  with the brute's "tank" read. Movement/targeting AI is the same shared chase-and-
 *  shoot as every other mob (no distinct kiting behavior exists yet). */
export const FLOATER: EnemyBlueprint = {
  type: 'floater',
  maxHp: 2,
  radius: pxToFp(13),
  footprintRadius: pxToFp(6),
  weapon: ENEMY_GUN_SIM,
  tint: 0xe2e8f0,
  bodyRig: 'floater-core',
};

// ── Melee mobs (ENGINE_VERSION 59, design/05 — "近战的怪也加上一些") ──────────────
// The roster's first two melee variants. They exist because of the ammo economy
// (`balance/energy.ts`): the melee half of a loadout is the free fallback when the
// pool runs dry, and against an all-ranged garrison that fallback means walking into
// every gun on the floor. A melee mob is the mob you keep the GUN for — it closes the
// loop the other direction, so both halves of design/03's ranged-vs-melee trade-off
// have something they are the right answer to.
//
// The two are deliberately opposite failure modes: the stalker punishes standing
// still, the ravager punishes standing close. Both reuse the shared chase-and-engage
// AI unchanged — `AIDecideSystem` never reads the weapon's kind, it walks a mob to
// its `engageRangeFp` ring and lets `WeaponFireSystem` branch — so the only knobs
// that make them melee are the loadout and that range.

/** Fast, fragile rusher. Its threat is ARRIVING, not the swing: it moves at ~67% of
 *  the player's speed (against the roster default's 41%), notices from further out,
 *  and closes to claw range. Fragile enough that noticing it early is the whole
 *  counterplay — 2 HP is one saber swing or two blaster shots. */
export const STALKER: EnemyBlueprint = {
  type: 'stalker',
  maxHp: 2,
  radius: pxToFp(14),
  footprintRadius: pxToFp(6),
  weapon: ENEMY_CLAW_SIM,
  tint: 0xef5350, // hot red — reads as "coming at you" against the neutral palette
  bodyRig: 'floater-core', // the light silhouette; no dedicated rusher rig exists yet (design/12)
  // 4.2 px/tick ≈ 126 px/s, ~67% of PLAYER_BASE.speedPerTick. Deliberately still UNDER
  // the player's: running away has to remain a real option (the v42 retune's stated
  // rule), it just stops being a free one.
  moveSpeedPerTick: pxToFp(4.2),
  // Parks it inside `enemyclaw`'s 1.1-grid reach with room to spare: approachSlots
  // places the ring RING_MARGIN_STEPS inside this, so it stops at ~24 px against a
  // ~51 px reach (claw range + player radius).
  engageRangeFp: pxToFp(32),
  // Wider perception than the roster default (320): a rusher that only wakes at the
  // same distance as a shooter gets its whole approach eaten by the notice delay and
  // arrives as just another body in the crowd.
  aggroRangeFp: pxToFp(400),
};

/** Slow, armoured heavy. Its threat is being NEAR it: a wide 150° sweep for 2 damage
 *  with enough knockback to shove you out of its own reach — which is what opens the
 *  gap you use to shoot it. Armoured against bullets like `brute`, so the answer is
 *  positioning rather than raw dps. */
export const RAVAGER: EnemyBlueprint = {
  type: 'ravager',
  maxHp: 8,
  radius: pxToFp(20),
  footprintRadius: pxToFp(9),
  weapon: ENEMY_MAUL_SIM,
  resist: { physical: 700, ice: 1600 }, // ×0.7 bullets, ×1.6 ice — slow it and it never lands one
  tint: 0xa1887f, // scorched iron
  bodyRig: 'brute-core',
  // Left at the roster default speed on purpose: a fast heavy with a 150° sweep has no
  // counterplay at all. You are meant to be able to walk away from this one.
  engageRangeFp: pxToFp(40), // inside `enemymaul`'s 1.5-grid (48 px) reach
};


/** Blueprint registry, keyed by `type` (design/09 "content is plain data keyed by
 *  type"). SpawnSystem resolves a wave entry's type through this; unknown → basic. */
export const ENEMY_BLUEPRINTS: Record<string, EnemyBlueprint> = {
  basic: BASIC_ENEMY,
  emberling: EMBERLING,
  frostling: FROSTLING,
  galvanist: GALVANIST,
  blightling: BLIGHTLING,
  ironclad: IRONCLAD,
  brute: BRUTE,
  floater: FLOATER,
  stalker: STALKER,
  ravager: RAVAGER,
  blightlord: BLIGHTLORD,
  pyrefang: PYREFANG,
  ironwarden: IRONWARDEN,
  glacimaw: GLACIMAW,
  voltreaver: VOLTREAVER,
  rotbloom: ROTBLOOM,
};

/**
 * The single EnemyActor factory (design/09 "content is plain data"; ENGINE_VERSION
 * 27's own reason to exist — a spawned onDeathSpawn minion needs EXACTLY the same
 * construction as a wave spawn, and hand-duplicating the full Actor field list a
 * second time is exactly how knockVx/knockVy got missed from a couple of test
 * fixtures earlier in this same version's own work). Shared by SpawnSystem (wave/
 * dungeon/arena spawns) and DeathDropsSystem (a dying boss's onDeathSpawn adds).
 * Resolves the blueprint by `type` (missing/unknown → basic, forward-compat); the
 * aiPrng draw stays one-per-spawn regardless of variant or caller, so fire-phase
 * jitter is unaffected by which system spawned the mob.
 */
export function buildEnemyActor(state: GameState, gx: Fp, gy: Fp, type?: string): EnemyActor {
  const bp = ENEMY_BLUEPRINTS[type ?? 'basic'] ?? BASIC_ENEMY;
  const weapon = makeWeapon(bp.weapon);
  // Fire-phase jitter, so a garrison spawned on one tick doesn't attack in unison.
  // Reads whichever field the loadout's kind calls its recovery (ENGINE_VERSION 59's
  // melee mobs) — ONE aiPrng draw either way, unconditionally, so adding melee mobs
  // to a wave cannot shift the aiPrng stream for the mobs spawned after them.
  const recovery = bp.weapon.kind === 'ranged' ? bp.weapon.fireRateTicks : bp.weapon.swingCooldownTicks;
  weapon.cooldownTicks = state.aiPrng.nextInt(recovery);
  // Floor-to-floor difficulty escalation (design/05's own "to design" item — how enemy
  // tier scales with depth). `DungeonConfig.difficultyCurve` was authored on EMBER_DUNGEON
  // back at ROADMAP 1.3 but nothing ever read it — this is that wiring. Only maxHp scales
  // (weapon damage stays flat): deeper floors read as tougher, not as sudden one-shots.
  // floorIndex 0 always resolves to `curve.base` (EMBER_DUNGEON: 1) and every non-dungeon
  // config has no `dungeonConfig` at all (scale 1), so this is byte-identical to before
  // for a fresh dungeon's floor 0 and for every PvE/PvP config without floors.
  const scale = state.dungeonConfig ? curveAt(state.dungeonConfig.difficultyCurve, state.floorIndex) : 1;
  const maxHp = Math.max(1, Math.round(bp.maxHp * scale));
  return {
    id: state.nextId(),
    faction: 'enemy',
    teamId: ENEMY_TEAM_ID, // hostile to every player team (design/15), never to other AI
    gx,
    gy,
    z: toFp(0),
    vx: toFp(0),
    vy: toFp(0),
    knockVx: toFp(0),
    knockVy: toFp(0),
    facing: 0 as EnemyActor['facing'],
    hp: maxHp,
    maxHp,
    shield: 0, // enemies have no shield pool (design/07 — shields are a character trait)
    maxShield: 0,
    ticksSinceHit: 0,
    radius: bp.radius,
    footprintRadius: bp.footprintRadius,
    // Body radius, matching PLAYER_BASE.solidRadius's own convention (ENGINE_VERSION 43/48) —
    // an actor stops at the silhouette it draws, not the smaller feet circle, so it reads as
    // standing AGAINST a wall or pillar rather than sunk into one. Through v47 mobs deliberately
    // kept the feet circle here (`bp.footprintRadius`) on the grounds that widening it moves
    // every chase path that hugs a wall — a balance change to garrisons measured against the
    // paths in `client/sim/pveLevelSim.sim.ts`. Reversed in v48 (live report: *"怪物也要遵守
    // 同样的规则"* — a monster standing where its own tiny clearance let it should hide behind a
    // wall no more than the player does) — see ENGINE_VERSION_HISTORY for what the sim re-run
    // found.
    //
    // FLOORED at the player's own clearance in v50, which is the other half of that same
    // sentence and the half v48 did not deliver. Four of the eight blueprints draw a body
    // SMALLER than the player's (critter 13 px, basic/ember/frost/venom 15 px vs the player's
    // 16), so "the same rule" still left them able to stand — and to die, and to drop loot —
    // in a band no player could enter. The reporter stated it directly in the third round of
    // this report: *"怪物不能跑进阻挡区域"*. A floor rather than a flat `PLAYER_BASE.solidRadius`
    // keeps the bigger bodies (brute 20 px, boss 30 px) stopping at their own silhouette, which
    // is what v43/v48 were about; it only ever WIDENS a mob's clearance, so it cannot re-open
    // the sunk-into-stone reading from the other side.
    //
    // Route safety is a non-question rather than a measurement here, and that is the point of
    // the floor's VALUE: every mob now clears a solid by at least what the player clears it by,
    // so any gap a player can walk through a mob can walk through, and the player's own
    // connectivity over all shipped content is what v48/v49 already measured and pinned
    // (`launchArena.test.ts`, the per-floor region sweep). Chase paths do move — see the
    // ENGINE_VERSION_HISTORY entry for the `test:pve-sim` re-run.
    solidRadius: Math.max(bp.radius as number, PLAYER_BASE.solidRadius as number) as Fp,
    alive: true,
    weapon,
    firing: false,
    status: freshStatus(),
    resist: bp.resist,
    tint: bp.tint,
    element: bp.element,
    bodyRig: bp.bodyRig,
    boss: bp.boss,
    enrage: bp.enrage,
    enraged: false,
    armorBreak: bp.armorBreak,
    armorBroken: false,
    aggroed: false,
    holding: false,
    onDeathSpawn: bp.onDeathSpawn,
    moveSpeedPerTick: bp.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
    engageRangeFp: bp.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP,
    aggroRangeFp: bp.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP,
  };
}
