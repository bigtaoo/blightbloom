/**
 * The ammo economy through the real systems (design/03/05, ENGINE_VERSION 59):
 * `WeaponFireSystem` charges a pull and refuses one it cannot afford,
 * `StatusEffectSystem` regenerates the pool on its global cadence, and `PickupSystem`
 * collects the refill under the same "only when useful" rule the heal pickup is under.
 *
 * `balance/energy.test.ts` covers the arithmetic and the roster's pricing; everything
 * here is about the WIRING — which is where the branches that never run in a happy path
 * live (the refusal arm, the enemy exemption, the full-pool leave-it-on-the-floor arm).
 */
import { describe, it, expect } from 'vitest';
import { createGameState, type GameState } from '@dd/engine/state/GameState';
import { PickupSystem, StatusEffectSystem, WeaponFireSystem } from '@dd/engine/systems';
import { pickupWouldApply } from './PickupSystem';
import {
  ENERGY_PICKUP_AMOUNT,
  ENERGY_REGEN_AMOUNT,
  ENERGY_REGEN_INTERVAL,
  BASE_MAX_ENERGY,
} from '@dd/engine/balance/energy';
import { buildEnemyActor } from '@dd/engine/content/enemies';
import { buffedCooldown, sumBuffs } from '@dd/engine/balance/runbuffs';
import { makeWeapon, WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { pxToFp } from '@dd/engine/content/convert';
import type { PickupItem, RangedSimSpec } from '@dd/engine/state/entities';

const CFG = { seed: 3, worldW: 800, worldH: 800, waves: [] as const };

/** Put a specific gun in the player's hands, trigger down, cooldown ready. */
function armed(s: GameState, weaponId: string) {
  const p = s.players[0]!;
  const w = makeWeapon(WEAPON_SIM_BY_ID[weaponId]!);
  p.weapon = w;
  p.weapons[0] = w;
  p.activeSlot = 0;
  p.firing = true;
  w.cooldownTicks = 0;
  return p;
}

/** Run WeaponFireSystem `n` times with the tick advancing, as the engine would. */
function fire(sys: WeaponFireSystem, s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    s.tick++;
    s.clearEvents();
    sys.tick(s);
  }
}

function energyPickup(s: GameState, gx: number, gy: number): PickupItem {
  const item: PickupItem = {
    id: s.nextId(),
    kind: 'energy',
    gx: pxToFp(gx),
    gy: pxToFp(gy),
    spawnTick: s.tick - 1, // not this tick — the step 9->10 vacuum guard
    alive: true,
  };
  s.pickups.push(item);
  return item;
}

describe('WeaponFireSystem — a ranged pull is charged against the pool', () => {
  const sys = new WeaponFireSystem();

  it('deducts the weapon’s own price, once per TRIGGER and not per pellet', () => {
    const s = createGameState(CFG);
    const p = armed(s, 'scattergun');
    const spec = p.weapon!.spec as RangedSimSpec;
    expect(spec.bullets).toBeGreaterThan(1); // the case this is about
    fire(sys, s, 1);
    expect(s.events.filter((e) => e.type === 'bullet_fired')).toHaveLength(spec.bullets);
    expect(p.energy).toBe(BASE_MAX_ENERGY - spec.energyCost); // ONE price, five bullets
  });

  it('refuses the pull outright when the pool cannot cover it', () => {
    const s = createGameState(CFG);
    const p = armed(s, 'novaburst');
    p.energy = (p.weapon!.spec as RangedSimSpec).energyCost - 1;
    fire(sys, s, 1);
    expect(s.events.some((e) => e.type === 'bullet_fired')).toBe(false);
    expect(p.energy).toBe((p.weapon!.spec as RangedSimSpec).energyCost - 1); // nothing spent
  });

  it('leaves the COOLDOWN untouched on a refused pull, so the trigger retries', () => {
    // The behavioural heart of running dry: an empty player is regen-PACED, not
    // disarmed. If the refusal consumed a recovery the weapon would fire strictly slower
    // than the pool alone implies, and topping the pool back up would not fix it.
    const s = createGameState(CFG);
    const p = armed(s, 'mortar');
    p.energy = 0;
    fire(sys, s, 1);
    expect(p.weapon!.cooldownTicks).toBe(0);
    // Give it exactly enough and the very next tick fires — no recovery was burned.
    p.energy = (p.weapon!.spec as RangedSimSpec).energyCost;
    fire(sys, s, 1);
    expect(s.events.filter((e) => e.type === 'bullet_fired')).toHaveLength(1);
    expect(p.energy).toBe(0);
  });

  it('a MELEE swing costs nothing — the fallback has to actually be free', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const w = makeWeapon(WEAPON_SIM_BY_ID.saber!);
    p.weapon = w;
    p.weapons[0] = w;
    p.firing = true;
    w.cooldownTicks = 0;
    p.energy = 0; // bone dry
    fire(sys, s, 1);
    expect(s.events.filter((e) => e.type === 'melee_swing')).toHaveLength(1);
    expect(p.energy).toBe(0);
  });

  it('an ENEMY is never charged, and never silenced by an empty pool it does not have', () => {
    // The trust boundary `asEnergyUser` draws. A mob that stopped shooting because of an
    // economy it has no bar for would be a garrison going quiet for a reason nothing on
    // screen explains. Proven by giving the mob an `energy: 0` field it has no business
    // having — if the gate keyed on the FIELD instead of the faction, this would silence it.
    const s = createGameState(CFG);
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    e.weapon!.cooldownTicks = 0;
    e.firing = true;
    (e as unknown as { energy: number }).energy = 0;
    s.enemies.push(e);
    fire(sys, s, 1);
    expect(s.events.filter((ev) => ev.type === 'bullet_fired' && ev.ownerId === e.id)).toHaveLength(1);
    expect((e as unknown as { energy: number }).energy).toBe(0); // nothing was deducted either
  });

  it('the starter blaster holds its trigger down forever without drifting (break-even, measured)', () => {
    // The claim `balance/energy.ts` makes as arithmetic, re-measured through the two real
    // systems that implement it — a unit test of `isSustainable` cannot catch a regen
    // cadence wired to the wrong modulus, and it cannot see the engine's INTEGER cooldown
    // at all (see `balance/energy.test.ts`'s whole-ticks gate for why that matters).
    //
    // Rewritten at ENGINE_VERSION 62, and the old version is the reason this one asserts a
    // SHAPE rather than an endpoint. It was called "outruns its own drain" and ended on
    // `energy === BASE_MAX_ENERGY`, which passed identically at the old 20/s line and at
    // the new 15/s one: sampling the last tick of a sawtooth says nothing about whether
    // the sawtooth is climbing, flat, or decaying. What break-even actually means is that
    // the trough does not move.
    const s = createGameState(CFG);
    const p = armed(s, 'blaster');
    const cost = (p.weapon!.spec as RangedSimSpec).energyCost;
    const cd = (p.weapon!.spec as RangedSimSpec).fireRateTicks;
    const status = new StatusEffectSystem();
    const fireSys = new WeaponFireSystem();
    const trace: number[] = [];
    let shots = 0;
    for (let i = 0; i < 900; i++) {
      // 30 s of holding the trigger
      s.tick++;
      s.clearEvents();
      fireSys.tick(s);
      status.tick(s);
      if (s.events.some((e) => e.type === 'bullet_fired')) shots++;
      trace.push(p.energy);
    }

    // 1. Never paced: every pull the COOLDOWN allowed actually came out. This is the half a
    //    player feels — the starter's rate of fire is its own cooldown and nothing else.
    expect(shots).toBe(Math.floor(900 / cd));

    // 2. Stationary, not merely non-zero: the trough of the last third equals the trough of
    //    the first. A gun ABOVE the line decays (the `rof_up` case below drops to 0 inside
    //    this same window), one BELOW it climbs until it is pinned at the cap.
    const troughOf = (from: number, to: number) => Math.min(...trace.slice(from, to));
    expect(troughOf(0, 300)).toBe(BASE_MAX_ENERGY - cost);
    expect(troughOf(600, 900)).toBe(troughOf(0, 300));

    // 3. And the bar is genuinely NOT "pinned at full" while firing — it is at the cap for
    //    exactly one tick in every cooldown, which is the state a refill would be refused
    //    in. Pinned here because the ENGINE_VERSION 62 write-up originally claimed the
    //    opposite in prose, and prose is not measured.
    const atCap = trace.filter((v) => v === BASE_MAX_ENERGY).length;
    expect(atCap).toBe(Math.floor(900 / cd));
  });

  it('one rof_up takes the starter OVER the line, and a second one buys nothing', () => {
    // The sentence design/03 makes about the 15/s line — "everything on top of holding the
    // trigger comes out of the pool" — as behaviour. Nothing pinned it before v62.
    //
    // It is also the seconds-vs-TICKS trap, which is the one a balance table cannot see:
    // `buffedCooldown` rounds to whole ticks, so the blaster's 6 ticks become 4 (not 4.29),
    // i.e. the real drain is 22.5/s and not the 21.4/s the per-second arithmetic implies.
    // A second `rof_up` rounds to 4 as well, so it is pure waste on this weapon — the kind
    // of thing only a test in the engine's own units can state.
    const s = createGameState(CFG);
    const p = armed(s, 'blaster');
    p.buffs = ['rof_up'];
    const spec = p.weapon!.spec as RangedSimSpec;
    expect(buffedCooldown(spec.fireRateTicks, sumBuffs(['rof_up']))).toBe(4);
    expect(buffedCooldown(spec.fireRateTicks, sumBuffs(['rof_up', 'rof_up']))).toBe(4);

    const status = new StatusEffectSystem();
    const fireSys = new WeaponFireSystem();
    const trace: number[] = [];
    let shots = 0;
    for (let i = 0; i < 900; i++) {
      s.tick++;
      s.clearEvents();
      fireSys.tick(s);
      status.tick(s);
      if (s.events.some((e) => e.type === 'bullet_fired')) shots++;
      trace.push(p.energy);
    }
    // The TROUGH, never the endpoint: a sawtooth sampled on its last tick can read as high
    // as `max` on a pool that spent the whole run at the floor. (Asserting the endpoint is
    // exactly what made the pre-v62 version of the test above unable to tell 20/s from 15/s,
    // and the `repeater` case below reads 2 on its final tick after bottoming out at 0.)
    expect(Math.min(...trace)).toBe(0); // it really did run out
    expect(shots).toBeLessThan(Math.floor(900 / 4)); // and is now paced by regen, not by cooldown
    expect(shots).toBeGreaterThan(0); // paced, never disarmed
  });

  it('the repeater is paced now, not free — the v62 reclassification, as behaviour', () => {
    // `balance/energy.test.ts` pins the sustainable list as `['blaster']`; that is a claim
    // about two numbers. This is the same claim about the engine: `repeater` (20/s) used to
    // sit exactly ON the 20/s line and fund itself forever, and at 15/s it does not.
    const s = createGameState(CFG);
    const p = armed(s, 'repeater');
    const spec = p.weapon!.spec as RangedSimSpec;
    const status = new StatusEffectSystem();
    const fireSys = new WeaponFireSystem();
    const trace: number[] = [];
    let shots = 0;
    for (let i = 0; i < 900; i++) {
      s.tick++;
      s.clearEvents();
      fireSys.tick(s);
      status.tick(s);
      if (s.events.some((e) => e.type === 'bullet_fired')) shots++;
      trace.push(p.energy);
    }
    expect(Math.min(...trace)).toBe(0);
    expect(shots).toBeLessThan(Math.floor(900 / spec.fireRateTicks));
  });

  it('an expensive frame drains to empty and then fires at the regen-limited pace', () => {
    const s = createGameState(CFG);
    const p = armed(s, 'novaburst');
    const cost = (p.weapon!.spec as RangedSimSpec).energyCost;
    const status = new StatusEffectSystem();
    const fireSys = new WeaponFireSystem();
    let shots = 0;
    for (let i = 0; i < 900; i++) {
      s.tick++;
      s.clearEvents();
      fireSys.tick(s);
      status.tick(s);
      if (s.events.some((e) => e.type === 'bullet_fired')) shots++;
    }
    expect(p.energy).toBeLessThan(cost); // it really is living hand to mouth
    // Over 30 s the pool supplies BASE_MAX_ENERGY once plus 30 s of regen; the weapon's own
    // cooldown would have allowed far more pulls than that, which is the whole point.
    const cooldownLimit = Math.floor(900 / (p.weapon!.spec as RangedSimSpec).fireRateTicks);
    expect(shots).toBeLessThan(cooldownLimit);
    expect(shots).toBeGreaterThan(0); // and it is paced, not disarmed
  });
});

describe('StatusEffectSystem — energy regen (design/03/05)', () => {
  const sys = new StatusEffectSystem();

  it('refills on the GLOBAL tick cadence, not a per-actor clock', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = 0;
    // Walk to just before a cadence boundary and confirm nothing moved, then cross it.
    let refills = 0;
    for (let i = 0; i < ENERGY_REGEN_INTERVAL * 4; i++) {
      s.tick++;
      const before = p.energy;
      sys.tick(s);
      if (p.energy !== before) {
        refills++;
        expect(s.tick % ENERGY_REGEN_INTERVAL, 'refilled off the global boundary').toBe(0);
        expect(p.energy - before).toBe(ENERGY_REGEN_AMOUNT);
      }
    }
    expect(refills).toBe(4);
  });

  it('regenerates while being shot at — unlike the shield, deliberately', () => {
    // The one place this pool's rule differs from `SHIELD_REGEN_DELAY`'s, and the reason
    // is load-bearing: the starter gun is priced just under the regen line, so a regen
    // that paused under fire would take the only weapon you always have below break-even
    // in exactly the moments it is the only thing you have.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = 0;
    p.ticksSinceHit = 0; // just hit — the shield's own regen is locked out here
    for (let i = 0; i < ENERGY_REGEN_INTERVAL; i++) {
      s.tick++;
      p.ticksSinceHit = 0; // keep taking fire
      sys.tick(s);
    }
    expect(p.energy).toBe(ENERGY_REGEN_AMOUNT);
  });

  it('clamps at the pool rather than growing past it', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = p.maxEnergy - 1;
    for (let i = 0; i < ENERGY_REGEN_INTERVAL * 3; i++) {
      s.tick++;
      sys.tick(s);
    }
    expect(p.energy).toBe(p.maxEnergy);
  });

  it('a DOWNED player does not regen — they cannot shoot either', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = 0;
    p.downed = true;
    for (let i = 0; i < ENERGY_REGEN_INTERVAL * 3; i++) {
      s.tick++;
      sys.tick(s);
    }
    expect(p.energy).toBe(0);
  });

  it('an enemy is not given a pool by the regen pass', () => {
    const s = createGameState(CFG);
    const e = buildEnemyActor(s, pxToFp(400), pxToFp(400), 'basic');
    s.enemies.push(e);
    for (let i = 0; i < ENERGY_REGEN_INTERVAL * 3; i++) {
      s.tick++;
      sys.tick(s);
    }
    expect((e as unknown as { energy?: number }).energy).toBeUndefined();
  });
});

describe('PickupSystem — the energy refill (design/05 "only when useful")', () => {
  const sys = new PickupSystem();

  it('tops the pool up and is consumed', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = 10;
    const item = energyPickup(s, (p.gx as number) / 1000 * 32, (p.gy as number) / 1000 * 32);
    s.tick++;
    sys.tick(s);
    expect(p.energy).toBe(10 + ENERGY_PICKUP_AMOUNT);
    expect(item.alive).toBe(false);
    expect(s.events.some((e) => e.type === 'pickup' && e.kind === 'energy')).toBe(true);
  });

  it('clamps the top-up to the pool instead of overfilling', () => {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = p.maxEnergy - 1;
    energyPickup(s, (p.gx as number) / 1000 * 32, (p.gy as number) / 1000 * 32);
    s.tick++;
    sys.tick(s);
    expect(p.energy).toBe(p.maxEnergy);
  });

  it('is LEFT ON THE FLOOR at a full pool — the same rule the heal pickup follows', () => {
    // design/05's locked "consumables auto-apply, but only when useful". With no item bag,
    // a refill collected at full is destroyed for nothing.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.energy = p.maxEnergy;
    const item = energyPickup(s, (p.gx as number) / 1000 * 32, (p.gy as number) / 1000 * 32);
    s.tick++;
    sys.tick(s);
    expect(item.alive).toBe(true);
    expect(s.pickups).toContain(item);
  });

  it('pickupWouldApply says the same thing, so the debug overlay cannot disagree', () => {
    // `PickupDebugOverlay` reads this exact predicate (design/18's G6 drift rule) — a
    // second copy of the condition is how a green dot starts lying.
    const s = createGameState(CFG);
    const p = s.players[0]!;
    const item = energyPickup(s, 0, 0);
    p.energy = p.maxEnergy;
    expect(pickupWouldApply(p, item)).toBe(false);
    p.energy = p.maxEnergy - 1;
    expect(pickupWouldApply(p, item)).toBe(true);
  });

  it('is per-PLAYER: a full teammate does not deny it to an empty one', () => {
    // Same property the heal gate has. The check runs inside the player loop, so the
    // first (full) seat simply skips and the second takes it.
    const s = createGameState(CFG);
    const full = s.players[0]!;
    full.energy = full.maxEnergy;
    const empty = { ...full, id: s.nextId(), energy: 0 };
    s.players.push(empty);
    energyPickup(s, (full.gx as number) / 1000 * 32, (full.gy as number) / 1000 * 32);
    s.tick++;
    sys.tick(s);
    expect(full.energy).toBe(full.maxEnergy); // untouched
    expect(empty.energy).toBe(ENERGY_PICKUP_AMOUNT);
  });
});
