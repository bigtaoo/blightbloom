// Enemy blueprints, the boss half (split out of `enemies.ts`, which re-exports it): the six
// bosses and the random-boss pool chapter 1's boss room draws from.
import { pxToFp } from './convert';
import type { EnemyBlueprint } from './enemies';
import { ENEMY_ARCSEEKER_SIM, ENEMY_GUN_SIM, ENEMY_NOVA_SIM, ENEMY_SHARDFAN_SIM, ENEMY_SPORESPRAY_SIM } from './weapons';

// ── Boss ────────────────────────────────────────────────────────────────────────
// The durable finale — a big, tanky mob that survives long enough to *show* the
// combat systems working (design/03/07): its huge HP pool lets poison stacks ramp
// to full and lingering burn/chill/poison auras persist visibly, while its broad
// resist profile forces the player to find the right damage type. It shrugs bullets
// (physical, floored to min-1) and partially resists fire/ice/lightning, but is
// doubly WEAK to poison — so the intended kill is to stack venom and let the DoT
// melt it, the clearest showcase of independent poison stacks on a target that
// doesn't die first. Neutral-ish elements still land, so their auras read too.
export const BLIGHTLORD: EnemyBlueprint = {
  type: 'blightlord',
  maxHp: 40, // ~a dozen full-poison DoT ticks; bullets alone take forever (min-1)
  radius: pxToFp(30), // twice a basic mob — reads as a boss; auras/bar scale with it
  footprintRadius: pxToFp(14),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 400, fire: 800, ice: 800, lightning: 800, poison: 2000 },
  tint: 0x8e24aa, // toxic purple
  boss: true,
  bodyRig: 'boss-core', // design/13's "giant failed core" — its own rig, not a scaled critter-core
  // Boss AI depth (design/09 aspirational `traits`/`onDeathSpawn`, ENGINE_VERSION 27,
  // first-pass numbers — tune against real play like every other constant here).
  // Below 30% HP (the "poison is really biting now" moment): +50% damage, +50% fire
  // rate — a real, felt escalation rather than a slow HP-bar melt with no counterplay
  // change. On death, two basic adds spawn around its body — the fight doesn't just
  // end the instant the bar hits 0.
  enrage: { hpThresholdPermille: 300, bonusDamagePermille: 500, bonusFireratePermille: 500 },
  onDeathSpawn: { type: 'basic', count: 2 },
};

/**
 * Fire/AoE specialist (Task 2's second boss, ENGINE_VERSION 70) — the "keep moving"
 * axis, distinct from Blightlord's "race the DoT" one. Its threat is the omnidirectional
 * `enemynova` ring (`weaponSpecs/dropOnly.ts`), not sustained single-target dps: standing
 * still to trade damage is the losing play, same as `novaburst`'s own player-facing
 * "panic button" read but authored as the boss's BASELINE attack rather than a burst
 * option. Elemental like the four basic variants (fire, weak to ice — `EMBERLING`'s exact
 * ratios, boss-scaled resist instead of a flat bump so the counterplay reads the same at
 * both tiers), and faster/wider-perceiving than the roster default so it can reposition
 * between volleys instead of standing in the ring it just fired (`STALKER`'s own
 * precedent for both knobs). Carries `enrage` alone, no `onDeathSpawn` — Blightlord
 * already owns the "adds on death" beat; this boss's escalation is entirely its own ring
 * firing faster, never more shooters.
 */
export const PYREFANG: EnemyBlueprint = {
  type: 'pyrefang',
  // No `element` badge — like BLIGHTLORD/BRUTE/RAVAGER, a boss/body-form variant is
  // deliberately NOT one of design/13's five locked elemental variants, even though
  // its resist profile mirrors one (`enemies.test.ts` pins the exact five).
  maxHp: 36,
  radius: pxToFp(28),
  footprintRadius: pxToFp(13),
  weapon: ENEMY_NOVA_SIM,
  resist: { fire: 400, ice: 1800 },
  tint: 0xff7043, // ember orange — EMBERLING's exact hue, boss-scaled
  boss: true,
  bodyRig: 'boss-core',
  moveSpeedPerTick: pxToFp(3.6), // faster than the roster default (2.6) — repositions between rings
  aggroRangeFp: pxToFp(400), // STALKER's wider perception — wakes before the player is on top of it
  // Below 30% HP: the ring fires 60% faster, no damage bonus (its threat is the AoE
  // itself, not a bigger single hit) — the escalation is "dodge more often," not
  // "dodge harder."
  enrage: { hpThresholdPermille: 300, bonusDamagePermille: 0, bonusFireratePermille: 600 },
};

/**
 * Armor/phase specialist (Task 2's third boss, ENGINE_VERSION 70) — the "burst it to
 * the break-point, then finish" axis: a DEFENSIVE trait that changes once, the mirror
 * image of `enrage`'s offensive one (see `armorBreak` on `EnemyBlueprint` and
 * `WeaponFireSystem.latchArmorBreak`). Armored phase resist matches `IRONCLAD`'s own
 * ratios boss-scaled (shrugs bullets/fire, weak to lightning); once hp first crosses
 * 50%, its `armorBreak.resist` REPLACES that map with a far weaker one — the "core
 * exposed" moment — and never reverts. Slower than the roster default (a stand-and-
 * tank read, the opposite of Pyrefang's kiting) and carries neither `enrage` nor
 * `onDeathSpawn`: its escalation is entirely the one-time defensive break, so the
 * player's read is "the same enemy became easier," not "harder."
 */
export const IRONWARDEN: EnemyBlueprint = {
  type: 'ironwarden',
  // No `element` badge — see PYREFANG's own note. IRONCLAD already carries the
  // locked `physical` badge; a second physical-flavoured mob does not get a second one.
  maxHp: 44,
  radius: pxToFp(30),
  footprintRadius: pxToFp(14),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 300, fire: 700, ice: 700, lightning: 1900 },
  tint: 0x90a4ae, // steel grey — IRONCLAD's exact hue, boss-scaled
  boss: true,
  bodyRig: 'boss-core',
  moveSpeedPerTick: pxToFp(1.8), // slower than the roster default — a wall you can outrun
  armorBreak: { hpThresholdPermille: 500, resist: { physical: 1000, fire: 900, ice: 900, lightning: 2200 } },
};

/**
 * Chapter 2's boss (the Frost descent, design/gameplay/04-chapters.md) — the "don't get
 * pinned" axis, distinct from Pyrefang's "keep moving" and Ironwarden's "burst to the
 * break". Its loadout is an AIMED cone of ice shards (`enemyshardfan`), and every shard
 * chills, so the threat is the chain: one shard slows you, a slowed player is late leaving
 * the next cone. Resist profile mirrors FROSTLING's ratios boss-scaled (shrugs ice, melts to
 * fire), exactly as Pyrefang mirrors EMBERLING's — the chapter's fire drops are the answer.
 *
 * Not in `BOSS_POOL`: chapter 2's boss room names it directly
 * (`world/dungeons/frost/pieces/frost_l1_boss.json`), so a frost run always ends here and an
 * ember run's pool draw is unchanged. Slightly slower than the roster default (it plants and
 * aims) and carries `enrage` alone: below 40% the cone comes 50% faster, no damage bonus.
 */
export const GLACIMAW: EnemyBlueprint = {
  type: 'glacimaw',
  // No `element` badge — see PYREFANG's own note.
  maxHp: 40,
  radius: pxToFp(28),
  footprintRadius: pxToFp(13),
  weapon: ENEMY_SHARDFAN_SIM,
  resist: { ice: 400, fire: 1800 },
  tint: 0x81d4fa, // frost blue — FROSTLING's exact hue, boss-scaled
  boss: true,
  bodyRig: 'boss-core',
  moveSpeedPerTick: pxToFp(2.2), // under the roster default (2.6) — it plants and aims
  enrage: { hpThresholdPermille: 400, bonusDamagePermille: 0, bonusFireratePermille: 500 },
};

/**
 * Chapter 3's boss (the Storm descent, design/gameplay/04-chapters.md) — the "out-turn it"
 * axis, beside Pyrefang's "keep moving", Ironwarden's "burst to the break" and Glacimaw's
 * "don't get pinned". Its loadout fires HOMING lightning orbs (`enemyarcseeker`) in a wide fan,
 * so the dodges the other three teach do not clear a volley on their own: the orbs follow.
 * Their turn rate is modest, so a late, hard cut across their path makes them overshoot, and
 * they are fat and slower than the player's bullets, so the ones that come down the firing
 * line can be shot out of the air (hostile bullets annihilate). In co-op
 * each hit arcs to the nearest teammate (lightning's chain), which makes standing together
 * the mistake. Resist profile mirrors GALVANIST's ratios boss-scaled (shrugs lightning, rots
 * to poison), as Glacimaw mirrors FROSTLING's — the chapter's poison drops are the answer.
 *
 * Not in `BOSS_POOL`: chapter 3's boss room names it directly. A touch faster than the
 * roster default, because a homing volley from a boss that stands still is a turret; it
 * keeps its distance while the orbs do the work. `enrage` alone: below 40% the volleys come
 * 40% faster, no damage bonus.
 */
export const VOLTREAVER: EnemyBlueprint = {
  type: 'voltreaver',
  // No `element` badge — see PYREFANG's own note.
  maxHp: 40,
  radius: pxToFp(28),
  footprintRadius: pxToFp(13),
  weapon: ENEMY_ARCSEEKER_SIM,
  resist: { lightning: 400, poison: 1800 },
  tint: 0xfff176, // charged yellow — GALVANIST's exact hue, boss-scaled
  boss: true,
  bodyRig: 'boss-core',
  moveSpeedPerTick: pxToFp(3.0), // over the roster default (2.6) — it repositions between volleys
  enrage: { hpThresholdPermille: 400, bonusDamagePermille: 0, bonusFireratePermille: 400 },
};

/**
 * Chapter 4's boss and the finale (the Blight descent, design/gameplay/04-chapters.md) — the
 * "keep your distance" axis. Its loadout is a short, dense cone of poison spores
 * (`enemysporespray`): each spore that lands adds a poison stack, the stacks keep ticking after
 * the hit and stop the shield regenerating, so the losing play is trading at close range. The
 * spores die a few grid out, and it walks toward you to close that gap, so the answer is to
 * kite it: back off, shoot, back off. Resist profile mirrors BLIGHTLING's ratios boss-scaled
 * (shrugs poison, burns to fire), as Glacimaw and Voltreaver mirror their chapters' critters.
 *
 * Why not `blightlord`, the boss chapter 4 was planned around. Its single aimed bullets never
 * land on a strafing player (0 damage in 80 bot duels), so the finale would have been the
 * easiest boss in the game, and it is WEAK to poison, the one element a poison chapter's boss
 * should shrug. It stays in chapter 1's pool, unchanged.
 *
 * Not in `BOSS_POOL`: chapter 4's boss room names it directly. Measured alone against the bot at
 * the boss floor's 105 HP: 35% kills, 65% bot deaths, 35 s median kill, the bot carrying poison
 * for 19% of the fight — a step past Voltreaver's 50% / 50%, as a finale should be, and short of
 * Pyrefang's 100% deaths. `enrage` alone: below 40% the spray comes 40% faster.
 */
export const ROTBLOOM: EnemyBlueprint = {
  type: 'rotbloom',
  // No `element` badge — see PYREFANG's own note.
  maxHp: 40,
  radius: pxToFp(28),
  footprintRadius: pxToFp(13),
  weapon: ENEMY_SPORESPRAY_SIM,
  resist: { poison: 400, fire: 1800 },
  tint: 0x9ccc65, // sickly green — BLIGHTLING's exact hue, boss-scaled
  boss: true,
  bodyRig: 'boss-core',
  moveSpeedPerTick: pxToFp(3.4), // over the roster default (2.6), under the player's 6.4 — it closes, you can still out-walk it
  engageRangeFp: pxToFp(128), // 4 grid — it walks inside its own spray's reach before it stops
  enrage: { hpThresholdPermille: 400, bonusDamagePermille: 0, bonusFireratePermille: 400 },
};

/** The random-boss pool floor 5's boss room draws from (`SpawnSystem`'s `'boss_random'`
 *  sentinel, `world/dungeons/ember/pieces/ember_l1_boss.json`) — one `aiPrng` draw the
 *  tick that room activates, so which boss a run gets is decided once and stays fixed
 *  for the run, exactly like any other spawn-time roll. Order is insignificant (an
 *  index into this array, not a weight); Blightlord is included so the pre-Task-2
 *  boss stays reachable, not replaced. */
export const BOSS_POOL: readonly string[] = ['blightlord', 'pyrefang', 'ironwarden'];
