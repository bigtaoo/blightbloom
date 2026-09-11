/**
 * Weapon energy — the ammo economy (design/03/05, ENGINE_VERSION 59, 2026-09-05).
 *
 * Two design calls from the game's owner, made together because they are one
 * question: *"我打算给武器加一个子弹的概念。1，能解决武器平衡性问题…… 2，能解决怪物
 * 掉落的问题。毕竟降低了掉率之后打完地图空空如也也不好。"*
 *
 * ## Why a shared regenerating POOL and not per-weapon magazines
 *
 * Soul Knight's energy model, which is also the reference design/05 keeps citing.
 * A magazine model was considered and rejected on three counts, all of them
 * properties of THIS repo rather than general taste:
 *
 *   - It needs a RELOAD verb. `10` removed aim input entirely and the button cluster
 *     is already full; and a reload is a pause, which lockstep cannot give one player
 *     (`06`).
 *   - It puts state on a weapon, so a weapon lying on the floor has to carry its
 *     remaining rounds through `PickupItem` and back out again on a drop-on-replace
 *     swap (`03`). A pool belongs to the PLAYER, so a swap moves nothing.
 *   - Per-weapon ammo TYPES were rejected for a content reason: a floor hands out
 *     2-3 weapons (`05`), so a gun you cannot feed wastes a third of the floor's
 *     entire weapon output.
 *
 * ## Why the cost is indexed on the MECHANIC, not on damage
 *
 * `03`'s measured roster shape forbids a damage-indexed price: mean dps by rarity
 * runs DOWNWARD (`fine` 8.41 -> `epic` 5.63 -> `legend` 3.75), because "rarity buys a
 * mechanic, not pace". Charging by damage would tax the legendary frames — already
 * the slowest guns in the game — hardest, and make the starter blaster strictly
 * best. What the roster was missing is stated in `03` in as many words: *"a mechanic
 * has no price anywhere in this repo"*, which is exactly why `weaponBalance.test.ts`
 * can only gate domination WITHIN an identical mechanical signature. `energyCost` is
 * that missing price — the first exchange rate the balance layer has ever had.
 *
 * ## How the numbers were sized (measured, not guessed)
 *
 * The same discipline `05`'s loot-economy pass used. `client/sim/pve/report.ts`'s
 * `floorFireStats` was built FIRST and read, over 8 careful bot runs of the shipped
 * level:
 *
 *   | floor | complete visits | kills | trigger pulls (avg/min/max) | pulls/kill |
 *   |-------|-----------------|-------|-----------------------------|------------|
 *   | 0     | 3               | 34.6  | 217 / 237 / 252             | 6.3        |
 *   | 1     | 2               | 37.7  | 536 / 730 / 760             | 14.2       |
 *   | 2     | 1               | 52    | 598 / 742 / 742             | 11.5       |
 *
 * Two findings decided the shape of everything below.
 *
 * **Pulls per kill RISES with depth** (6.3 -> 14.2), because `difficultyCurve` scales
 * enemy HP per floor while a drop table is priced per KILL. So an ammo economy funded
 * only by kill-drops goes negative with depth — it would be tightest exactly on the
 * floors the level is already hardest on (100% of careful bot runs die today). That
 * is why the pool REGENERATES on a clock: a time-based refill is depth-invariant,
 * and the drop is a burst top-up on top of it rather than the whole supply.
 *
 * **A floor costs 237-760 pulls and hands back ~35-52 drops.** No per-kill drop can
 * fund a 250-pull floor at a meaningful price per pull. So the baseline gun has to be
 * effectively free, and the economy has to bite only on the expensive frames — which
 * is precisely the design goal ("有些大威力的武器一次就要消耗大量子弹") rather than a
 * concession to it.
 *
 * ## The break-even rule that ties the two together
 *
 * A weapon firing continuously spends `energyCost / cooldownSec` per second against
 * `ENERGY_REGEN_PER_SEC`. Below it, the weapon is sustainable forever and the pool is
 * invisible; above it, the pool drains and the weapon becomes regen-paced once empty.
 * The starter `blaster` sits EXACTLY ON the line; the next section is why it stopped
 * sitting below it with headroom. See `content/weaponSpecs/` for each weapon's price
 * and `balance/energy.test.ts` for the assertions that pin the classification.
 *
 * ## Why regen is 15/s and not 20/s (2026-09-11, the owner's second design call here)
 *
 * *"现在的子弹自动回复速度太快了，地图上掉落的子弹价值变得非常低。"* Measured before it
 * was changed, over the same 8 careful bot runs of the shipped level the numbers above
 * came from (`client/sim/pve/reportFire.ts`'s `clock%`/`floor%`/`refills` columns, built for
 * this pass):
 *
 *   | loadout            | supply from the CLOCK | from the FLOOR |
 *   |--------------------|-----------------------|----------------|
 *   | blaster (fresh)    | 97.6%                 | 2.4%           |
 *   | scattergun         | 97.9%                 | 2.1%           |
 *   | novaburst          | 98.0%                 | 2.0%           |
 *
 * **98% of every shot fired came off the clock**, and the same 2% held for the most
 * expensive gun in the roster as for the starter. That is the whole complaint as a
 * number: the clock was not a supplement to the floor's refills, it WAS the supply.
 *
 * Note what that ratio is and is not made of. It is `collected x ENERGY_PICKUP_AMOUNT`
 * over a floor's total spend, and neither term moves with the regen rate — a floor
 * drops ~7 refills (~210 energy) against ~2000 energy of pulls, so ~10% is the ceiling
 * the DROP TABLE sets even with perfect collection, and the sim still reads 1-2% after
 * this change. Lowering regen does not raise the floor's share of supply. What it
 * changes is whether the shortfall is felt at all.
 *
 * That is the honest form of the fix: at 20/s the clock covered a continuously-firing
 * starter outright, so a refill topped up a bar that refilled itself in five seconds.
 * At 15/s the clock covers the unbuffed starter and NOTHING else — a `rof_up` stack, a
 * burst, the first interesting gun the floor hands you all run a deficit only the pool
 * and the floor can pay. Measured over the same 8 runs: **22.6% of live ticks now hold
 * a gun the pool cannot pay for** (0.9% before), with the average floor reached UNMOVED
 * at 0.75. A refill also goes from 1.5 to 2 seconds of regen, which is the smaller half.
 *
 * 10/s was measured too and rejected: same 23% dry, but average floor reached fell
 * 0.75 -> 0.50. That is the difference between an economy that paces the player and
 * one that re-tunes the level from underneath, and only the first was asked for.
 *
 * ## What the collection rate does and does not say (a correction, same day)
 *
 * The first write-up of this pass blamed the uncollected refills — 12 of 100 — on
 * `PickupSystem.pickupWouldApply` refusing them at a full bar, and called them
 * "unpickable". **That was a guess presented as a mechanism, and the control says it is
 * mostly wrong.** `material` has no usefulness gate at all, so its collection rate is
 * the pure "did the bot walk over it" baseline, and over the same runs it reads 21.2%
 * (77 of 364) against energy's 12.0%. The bot misses ~80% of everything: most of the
 * uncollected refills are a bot that does not path to pickups, not a gate.
 *
 * The gate is real but secondary — a gated pickup is collected about half as often as
 * an identical ungated one, and ~21-27% of live ticks sit at a full pool. And the
 * collection rate is too small a sample to A/B this change at all (12 -> 5 events over
 * 8 seeds), so it is reported, never concluded from. The numbers this pass actually
 * rests on are the supply split and `dry%`.
 */

/**
 * The roster's REFERENCE pool — the denominator every `energyCost` in
 * `content/weaponSpecs/` was priced against, and the default character's own capacity
 * (`SKIN_DEFS.vanguard.maxEnergy`, pinned by `content/skins.test.ts`). A weapon costing a
 * third of it gets three shots off a full bar before regen is what paces it — the
 * intended "burst freely, then it paces you" feel.
 *
 * NOT the maximum any player can have, which is why it stopped being called
 * `MAX_ENERGY` in ENGINE_VERSION 60. Capacity is now a character stat plus whatever
 * `flat_energy` buffs the run has picked up, so a live pool runs from `juggernaut`'s 70
 * to `skirmisher`'s 130 + `BUFF_CAPS.flat_energy`. What varying it can and cannot do is
 * the load-bearing part:
 *
 *   - It buys BURST — how many expensive pulls come out back-to-back off a full bar.
 *   - It cannot buy SUSTAIN. Once the bar is empty every character fires at exactly
 *     `ENERGY_REGEN_PER_SEC / energyCost` shots per second, because regen is a flat
 *     shared constant and deliberately not a per-character stat. That is what keeps
 *     capacity a side-grade axis rather than the raw dps ladder design/14 forbids, and
 *     it is why `design/15`'s fairness wall lets the stat cross into PvP at all.
 */
export const BASE_MAX_ENERGY = 100;

/** Regen cadence: `+ENERGY_REGEN_AMOUNT` every `ENERGY_REGEN_INTERVAL` ticks, on the
 *  GLOBAL `tick % interval` boundary — the same lockstep pattern DoT and the beam
 *  cadence use (`07`/`08`), so every player refills in step with no per-actor clock
 *  field and nothing to desync (`06`). Unconditional, unlike the shield's idle timer
 *  (`SHIELD_REGEN_DELAY`): an energy pool that stopped while you were being shot at
 *  would take the baseline gun below break-even in exactly the moments it is the only
 *  thing you have.
 *
 *  The cadence is the FINEST one that produces the rate: +1 every 2 ticks rather than
 *  +3 every 6. Both average 15/s, but the coarse one makes the wait at an empty bar
 *  lumpy — a 3-cost pull becomes affordable in one step every sixth tick instead of
 *  arriving smoothly — and lumpiness is exactly what a player reads as the gun
 *  stuttering rather than as the gun being paced. */
export const ENERGY_REGEN_INTERVAL = 2;
export const ENERGY_REGEN_AMOUNT = 1;

/** 15/s @30Hz (was 20/s through ENGINE_VERSION 61 — see the header's "Why regen is
 *  15/s" for the measurement that moved it). The break-even line every `energyCost` is
 *  chosen against, and the starter blaster now sits exactly ON it. */
export const ENERGY_REGEN_PER_SEC = (ENERGY_REGEN_AMOUNT * 30) / ENERGY_REGEN_INTERVAL;

/**
 * What one `energy` pickup restores — 30% of the pool, so it reads as a real find
 * rather than as a rounding error, and so a player running an expensive frame gets
 * roughly one extra burst out of it. Collected under the same "only when it would
 * actually do something" rule as the health pickup (`05`, `PickupSystem`'s
 * `pickupWouldApply`), so a full player leaves it on the floor for later.
 */
export const ENERGY_PICKUP_AMOUNT = 30;

/**
 * Energy a weapon's TRIGGER PULL costs — not its projectile. A spread frame emits
 * `bullets` pellets from one decision, and charging per pellet would tax
 * `scattergun` five times over for one press; `client/sim/pve/report.ts` records both
 * columns so this choice stays checkable rather than assumed.
 *
 * Returns the sustained drain, per second, of firing this weapon on cooldown. The
 * classification every price in `content/weaponSpecs/` is authored against.
 */
export function sustainedDrainPerSec(energyCost: number, cooldownSec: number): number {
  return cooldownSec <= 0 ? Infinity : energyCost / cooldownSec;
}

/** Is this weapon sustainable forever on regen alone (drain <= regen)? A weapon that
 *  is has no ammo economy at all — which is the correct answer for the starter gun
 *  and the wrong one for a legendary frame. */
export function isSustainable(energyCost: number, cooldownSec: number): boolean {
  return sustainedDrainPerSec(energyCost, cooldownSec) <= ENERGY_REGEN_PER_SEC;
}

/**
 * Spend `cost` from `have`, or refuse. Returns the remaining energy, or null when
 * the pool cannot cover the pull — the caller must then leave the weapon's cooldown
 * UNTOUCHED so the trigger retries on the next tick rather than eating a full
 * recovery for a shot that never happened.
 *
 * A cost of 0 always succeeds, including at 0 energy: "free" has to mean free, or an
 * unpriced weapon would become unusable at empty instead of unaffected.
 */
export function spendEnergy(have: number, cost: number): number | null {
  if (cost <= 0) return have;
  return have >= cost ? have - cost : null;
}

/** One regen boundary's worth of refill, clamped to the pool. Pure so the cadence
 *  arithmetic and the clamp can be tested without staging a whole tick. */
export function regenEnergy(have: number, max: number): number {
  return Math.min(max, have + ENERGY_REGEN_AMOUNT);
}
