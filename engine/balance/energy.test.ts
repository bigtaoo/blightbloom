/**
 * `balance/energy.ts` — the ammo economy's pure arithmetic, plus the gate that keeps
 * the PRICING itself honest across the whole shipped roster (design/03/05,
 * ENGINE_VERSION 59).
 *
 * The second half is the load-bearing one. `spendEnergy`/`regenEnergy` are five lines
 * each and hard to get wrong; what is easy to get wrong is a weapon whose price says
 * something the design does not mean — a starter gun that quietly stops being
 * sustainable, or a legendary frame priced so low the pool never becomes a decision.
 * Those are content edits nothing else in the tree would notice.
 */
import { describe, it, expect } from 'vitest';
import {
  ENERGY_PICKUP_AMOUNT,
  ENERGY_REGEN_AMOUNT,
  ENERGY_REGEN_INTERVAL,
  ENERGY_REGEN_PER_SEC,
  BASE_MAX_ENERGY,
  isSustainable,
  regenEnergy,
  spendEnergy,
  sustainedDrainPerSec,
} from './energy';
import { WEAPON_SPECS } from '../content/weapons';
import { toTicks } from '../content/convert';
import { SKIN_DEFS } from '../content/skins';
import { NON_PLAYER_WEAPON_IDS } from './weaponProfile';
import type { RangedSpec } from '../content/weaponTypes';

const PLAYER_RANGED = Object.entries(WEAPON_SPECS)
  .filter((e): e is [string, RangedSpec] => e[1].kind === 'ranged')
  .filter(([id]) => !NON_PLAYER_WEAPON_IDS.includes(id));

describe('spendEnergy', () => {
  it('deducts the cost and hands back what is left', () => {
    expect(spendEnergy(100, 22)).toBe(78);
  });

  it('refuses when the pool cannot cover the pull, rather than clamping to 0', () => {
    // null, not 0: the caller has to be able to tell "spent it all" from "could not
    // afford it", because only the second leaves the weapon's cooldown untouched.
    expect(spendEnergy(21, 22)).toBeNull();
  });

  it('allows a pull that spends the pool down to exactly empty', () => {
    expect(spendEnergy(22, 22)).toBe(0);
  });

  it('always succeeds at zero cost, INCLUDING at zero energy', () => {
    // "Free" has to mean free. If a 0-cost weapon were refused at an empty pool, the
    // enemy gun (energyCost 0) would be silenced by an economy enemies do not have —
    // and so would any future weapon deliberately priced at nothing.
    expect(spendEnergy(0, 0)).toBe(0);
    expect(spendEnergy(50, 0)).toBe(50);
  });

  it('treats a negative cost as free rather than as a refund', () => {
    // Unreachable from WEAPON_SPECS (the roster gate below forbids it), but the guard is
    // `cost <= 0` rather than `cost === 0`, and a reader should be able to tell which of
    // "free" and "refill" that means without running it.
    expect(spendEnergy(50, -10)).toBe(50);
  });
});

describe('regenEnergy', () => {
  it('adds one cadence tick worth of refill', () => {
    expect(regenEnergy(10, BASE_MAX_ENERGY)).toBe(10 + ENERGY_REGEN_AMOUNT);
  });

  it('clamps to the pool instead of overfilling', () => {
    expect(regenEnergy(BASE_MAX_ENERGY - 1, BASE_MAX_ENERGY)).toBe(BASE_MAX_ENERGY);
    expect(regenEnergy(BASE_MAX_ENERGY, BASE_MAX_ENERGY)).toBe(BASE_MAX_ENERGY);
  });

  it('respects a pool smaller than the global default', () => {
    // The clamp reads `max` from the ACTOR, not the constant — so a seat whose cap was
    // never set (or a future per-character cap) cannot be regenerated past it.
    expect(regenEnergy(3, 4)).toBe(4);
    expect(regenEnergy(0, 0)).toBe(0);
  });
});

describe('sustainedDrainPerSec / isSustainable', () => {
  it('converts a per-pull cost and a cooldown into a per-second drain', () => {
    expect(sustainedDrainPerSec(3, 0.2)).toBeCloseTo(15, 10); // the blaster
    expect(sustainedDrainPerSec(26, 0.8)).toBeCloseTo(32.5, 10); // novaburst
  });

  it('reports the regen line the whole roster is priced against', () => {
    expect(ENERGY_REGEN_PER_SEC).toBe((ENERGY_REGEN_AMOUNT * 30) / ENERGY_REGEN_INTERVAL);
    expect(ENERGY_REGEN_PER_SEC).toBe(15);
  });

  it('calls a weapon at exactly the regen line sustainable', () => {
    // The boundary matters MORE since v62 than it did before it: the starter `blaster` is
    // now the weapon authored to sit exactly ON the line, so a strict `<` here would
    // reclassify the one gun every run begins with as one that runs you dry.
    expect(isSustainable(3, 0.2)).toBe(true); // 15/s === the line (the blaster)
    expect(isSustainable(3, 0.1)).toBe(false); // 30/s
  });

  it('treats a zero cooldown as infinitely draining rather than dividing by zero', () => {
    expect(sustainedDrainPerSec(1, 0)).toBe(Infinity);
    expect(isSustainable(1, 0)).toBe(false);
  });
});

describe('GATE — the roster is priced the way the design says it is', () => {
  it('sweeps a real, non-trivial number of player weapons (anti-vacuity)', () => {
    // Every assertion below is a loop over this list; an empty or silently shrunken one
    // would satisfy all of them (design/18's sweep-with-no-cases trap).
    expect(PLAYER_RANGED.length).toBeGreaterThanOrEqual(17);
  });

  it('every player gun carries a POSITIVE price — no accidental free weapon', () => {
    // `energyCost` is required by the type, so the failure mode this catches is not an
    // omission but a 0 someone typed while stubbing a new weapon in. A free gun is not a
    // balance choice available to this design: the pool is the only price a mechanic has.
    const free = PLAYER_RANGED.filter(([, s]) => s.energyCost <= 0).map(([id]) => id);
    expect(free, 'player weapons priced at nothing').toEqual([]);
  });

  it('exactly ONE gun is sustainable on regen alone, and it is the starter', () => {
    // The property that keeps the shipped level's difficulty unmoved for a fresh save
    // (`balance/energy.ts` records the measurement behind it, at 15/s and at 10/s): the
    // starter loadout, fired flat out and unbuffed, neither drains nor fills — so the
    // level a new player learns is the level they were always playing.
    //
    // It was TWO guns through ENGINE_VERSION 61, when the line sat at 20/s and `repeater`
    // (20/s) sat exactly on it. Dropping the line to 15/s moved `repeater` above it
    // deliberately: the 2026-09-11 report was that floor-dropped ammo had no value, and a
    // drop-pool gun that funds itself forever is one more gun the floor's refills are
    // worthless to. `repeater` is now the CHEAPEST paced weapon rather than a free one.
    //
    // Named rather than counted: "one is sustainable" would still pass if the one were
    // `novaburst`.
    const sustainable = PLAYER_RANGED.filter(([, s]) => isSustainable(s.energyCost, s.cooldownSec)).map(([id]) => id);
    expect(sustainable.sort()).toEqual(['blaster']);
  });

  it('the starter blaster sits EXACTLY on the line — free to hold down, and nothing more', () => {
    // The load-bearing number of the 2026-09-11 pass, and the reason it is asserted as an
    // equality rather than as a bound in either direction:
    //
    //   - BELOW the line (where it was through v61, with 25% spare) the bar sits pinned at
    //     full on an ordinary run, and `PickupSystem.pickupWouldApply` leaves every energy
    //     refill on the floor as a no-op. Measured: 12 of 100 refills collected, 2.4% of
    //     the run's spend. That is the reported bug, and it is a property of the HEADROOM,
    //     not of `ENERGY_PICKUP_AMOUNT`.
    //   - ABOVE it, holding the trigger on the gun a fresh save has no alternative to
    //     drains to empty on its own, which re-tunes the shipped level from underneath
    //     (measured at 10/s: average floor reached 0.75 -> 0.50).
    //
    // So: every point of firerate buff, every burst, and every better gun now comes out of
    // the pool and has to be bought back — while the floor of the economy stays exactly
    // where a fresh save can live on it.
    const blaster = WEAPON_SPECS.blaster as RangedSpec;
    expect(sustainedDrainPerSec(blaster.energyCost, blaster.cooldownSec)).toBe(ENERGY_REGEN_PER_SEC);
  });

  it('break-even survives the conversion to TICKS, which is the unit energy is actually spent in', () => {
    // The gate above is an equality in SECONDS; the engine spends energy in whole TICKS, and
    // `toTicks` rounds. For every other weapon that rounding only nudges it inside its class
    // — `scattergun`'s 0.55 s is 16.5 ticks and lands on 17, and "above the line" stays above
    // it either way. For the ONE weapon authored to sit exactly ON the line it is not a nudge
    // but the difference between the claim holding and not: at 0.22 s the blaster would run
    // 6.6 -> 7 ticks and quietly become sustainable-with-headroom, i.e. the pre-v62 bug back
    // again, with this file's equality still green because seconds do not round.
    //
    // (`buffedCooldown` rounds a second time, and that one is NOT absorbable — a single
    // `rof_up` takes 6 ticks to 4, not 4.29, so the buffed drain is 22.5/s rather than the
    // 21.4/s the per-second arithmetic implies. `systems/energy.test.ts` pins that in the
    // engine's own units, which is the only place it can be seen.)
    const blaster = WEAPON_SPECS.blaster as RangedSpec;
    expect(Number.isInteger(blaster.cooldownSec * 30)).toBe(true);
    expect(toTicks(blaster.cooldownSec)).toBe(blaster.cooldownSec * 30);
    // And the cadence divides that cooldown, so one cooldown's regen is a whole number of
    // points: 6 ticks / 2 = 3 = exactly one pull. A cadence that did not divide it would make
    // the "break-even" sawtooth drift slowly in one direction or the other.
    expect(toTicks(blaster.cooldownSec) % ENERGY_REGEN_INTERVAL).toBe(0);
    expect((toTicks(blaster.cooldownSec) / ENERGY_REGEN_INTERVAL) * ENERGY_REGEN_AMOUNT).toBe(blaster.energyCost);
  });

  it('no weapon can be fired even once from a full pool without emptying it twice over', () => {
    // A pull that costs more than the whole pool would be a weapon you can never fire at
    // all — the pool refuses it forever, since regen clamps at max. The ceiling is half
    // the pool rather than all of it, so every gun in the game gets at least two shots
    // off a full bar, which is what "burst freely, then it paces you" needs to mean.
    //
    // Measured against the SMALLEST pool in the roster, not `BASE_MAX_ENERGY` (which is
    // only the default character's). Since ENGINE_VERSION 60 capacity is a `SkinDef`
    // stat, so "every gun gets two shots" is a claim about the character who has the
    // least room to make it — pinning it to the reference pool instead would let a
    // 40-cost weapon ship that `juggernaut` (70) can fire exactly once and `vanguard`
    // (100) can fire twice, which is precisely the asymmetry a shared price table must
    // not have.
    const smallestPool = Math.min(...Object.values(SKIN_DEFS).map((s) => s.maxEnergy));
    expect(smallestPool).toBeLessThanOrEqual(BASE_MAX_ENERGY); // or the bound below is vacuous
    for (const [id, spec] of PLAYER_RANGED) {
      expect(spec.energyCost, `${id} costs more than half the roster's smallest pool`).toBeLessThanOrEqual(
        smallestPool / 2,
      );
    }
  });

  it('a refill drop is worth a meaningful fraction of the pool, and never overfills it', () => {
    expect(ENERGY_PICKUP_AMOUNT).toBeLessThanOrEqual(BASE_MAX_ENERGY);
    expect(ENERGY_PICKUP_AMOUNT).toBeGreaterThanOrEqual(BASE_MAX_ENERGY / 5);
    // A flat amount, deliberately, so it is worth proportionally MORE to the shallow pool
    // than to the deep one (ENGINE_VERSION 60) — the juggernaut's compensation for paying
    // for its body on this axis. Pinned so a later pass cannot quietly turn it into a
    // fraction of `maxEnergy`, which would erase that and hand the deepest bar the
    // biggest refill as well.
    const deepest = Math.max(...Object.values(SKIN_DEFS).map((s) => s.maxEnergy));
    const shallowest = Math.min(...Object.values(SKIN_DEFS).map((s) => s.maxEnergy));
    expect(deepest).toBeGreaterThan(shallowest); // the roster actually spreads on this axis
    expect(ENERGY_PICKUP_AMOUNT / shallowest).toBeGreaterThan(ENERGY_PICKUP_AMOUNT / deepest);
  });

  it('price tracks the MECHANIC, not the damage — the axis design/03 forbids', () => {
    // design/03: mean dps by rarity already runs DOWNWARD, so a damage-indexed price
    // would tax the slowest guns hardest and make the starter strictly best. Stated as a
    // measurement: among the straight/physical frames — the group with no mechanic to
    // pay for — the cheapest pull must NOT be the one that deals the least damage per
    // shot, which is what a damage-indexed table would guarantee.
    const plain = PLAYER_RANGED.filter(
      ([, s]) => s.ballistic === 'straight' && (s.damageType ?? 'physical') === 'physical' && s.bullets === 1,
    );
    expect(plain.length).toBeGreaterThanOrEqual(3); // blaster, repeater, cannon at least
    const byCost = [...plain].sort((a, b) => a[1].energyCost - b[1].energyCost);
    const byDamage = [...plain].sort((a, b) => a[1].damage - b[1].damage);
    // If price were a restatement of damage these two orders would be identical.
    expect(byCost.map(([id]) => id)).not.toEqual(byDamage.map(([id]) => id));
  });

  it('the two spread frames pay per TRIGGER, well under what per-pellet would cost', () => {
    // The choice `balance/energy.ts` records, as a number rather than a comment: charging
    // `scattergun`'s five pellets individually at the blaster's price would be 15 per
    // pull, and it is nowhere near five times a single-shot gun of its own class.
    for (const id of ['scattergun', 'cinderscatter']) {
      const s = WEAPON_SPECS[id] as RangedSpec;
      expect(s.bullets, id).toBeGreaterThan(1);
      const cannon = WEAPON_SPECS.cannon as RangedSpec;
      expect(s.energyCost, `${id} is priced as if per-pellet`).toBeLessThan(cannon.energyCost * s.bullets);
    }
  });

  it('every mob loadout is priced at zero — the field is inert on that side', () => {
    // Enemies are never charged (`WeaponFireSystem.asEnergyUser`), so a non-zero price on
    // a mob weapon would be a number that looks load-bearing and is not. Zero says so.
    for (const id of NON_PLAYER_WEAPON_IDS) {
      const spec = WEAPON_SPECS[id]!;
      if (spec.kind !== 'ranged') continue; // melee has no energyCost field at all
      expect(spec.energyCost, `${id} carries a price nothing reads`).toBe(0);
    }
  });
});
