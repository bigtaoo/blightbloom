/**
 * The melee ACTIVE HIT WINDOW (design/07 step 7, ENGINE_VERSION 53).
 *
 * ## What was broken, and what "green" used to mean
 *
 * `MeleeSpec.swingSec` was authored on all seven melee weapons from Stage C onward, documented
 * in `weaponTypes.ts` as the "ACTIVE hit-window (subset of cooldownSec), 07 step 7" and in
 * design/09's conversion table as `swingSec → swingTicks (active-hit window, 07)`. `toSimSpec`
 * never converted it, `MeleeSimSpec` had no field for it, and nothing in the repo read it.
 * `HitResolveSystem.meleeArc` resolved the whole arc on the single tick `justSwung` latched, so
 * every blade in the roster had a one-tick window regardless of what its own data said — the
 * hammer's authored 0.2 s and the spear's 0.1 s produced identical timing. 1104 engine tests
 * were green over that, because every one of them staged a swing by hand-latching `justSwung`
 * and asserting the hits that same tick, which is precisely the behaviour the one-tick bug
 * produces. This file is the half none of them tested: what happens on tick TWO of a swing.
 *
 * ## What each test here is actually pinning
 *
 * The failure mode to design against is a window test that passes against a ONE-TICK window —
 * assert a hit "during the swing" and a snapshot-on-the-swing-tick engine satisfies you.
 * So every test below either counts the ticks it observed, or proves the target was NOT
 * reachable on the swing tick before asserting it was reached later. A test that would pass
 * with `swingTicks: 1` is not testing this feature.
 *
 * ## Mutation battery — measured, not assumed (2026-09-02, ENGINE_VERSION 53)
 *
 * 21 mutants against the four source files this covers, whole engine suite per mutant, green
 * baseline before and after, every mutant reverted in a `finally`. **21/21 KILLED, no
 * survivors.** The count in brackets is how many tests died — a `(1 failing)` row is carried by
 * exactly one assertion, so deleting that test silently reopens the hole.
 *
 *   KILLED (6)   replay: drop swingTicksLeft from the hash
 *   KILLED (6)   replay: drop swingHitIds from the hash
 *   KILLED (6)   replay: drop swingDamage from the hash
 *   KILLED (6)   replay: drop spec.swingTicks from the melee branch
 *   KILLED (20)  spec: clamp every window to 1 tick (the pre-v53 behaviour)
 *   KILLED (14)  spec: window one tick too long
 *   KILLED (1)   spec: drop the min-1 clamp
 *   KILLED (1)   spec: drop the cooldown ceiling
 *   KILLED (8)   hitresolve: drop the once-per-swing hit-id guard
 *   KILLED (1)   hitresolve: re-roll the crit every active tick
 *   KILLED (2)   hitresolve: gate the arc on justSwung again (one-tick damage)
 *   KILLED (5)   deflect: gate the parry on justSwung again (one-tick parry)
 *   KILLED (2)   hitresolve: drop the alive/downed re-check
 *   KILLED (15)  weaponfire: never count the window down (permanently armed)
 *   KILLED (12)  weaponfire: count down twice as fast
 *   KILLED (3)   weaponfire: never clear the hit list when the window closes
 *   KILLED (4)   applyinput: leave a holstered blade armed mid-swing
 *   KILLED (1)   weaponfire: report a constant window on the event
 *   KILLED (1)   openSwing: drop the ranged guard
 *   KILLED (1)   openSwing: do not clear the hit list on restart
 *   KILLED (1)   closeSwing: reallocate the hit list instead of clearing it
 *
 * The four `replay:` rows are the point of the hash block below: before it, all four mutants
 * survived the ENTIRE repo, because `replay.ts`'s own comment is right that a golden-replay
 * comparison of two identical runs cannot see a missing field.
 *
 * **A harness trap worth recording, because it faked a clean sweep of CRASHED.** On Windows,
 * `subprocess.run(..., text=True)` decodes with cp1252, which cannot decode the box-drawing
 * characters vitest prints in FAILURE output. The reader threads die, `stdout`/`stderr` come
 * back EMPTY, and every genuinely-killed mutant is reported as a crash — the harness looks
 * conservative while telling you nothing. Pass `encoding='utf-8', errors='replace'`. The first
 * run of this battery reported 21/21 crashed for exactly that reason. See
 * [[daydayup-mutation-battery]].
 *
 * The other half is the guarantees the window must NOT break. A multi-tick window is a
 * multi-tick opportunity to deal damage repeatedly and to re-roll `combatPrng` per tick, and
 * design/07 locks both out ("each target is hit at most once per swing"; "a melee swing rolls
 * ONCE for the whole arc"). `once per swing, not once per tick` and `the crit is one draw for
 * the whole window` are the tests for those, and the golden fixture's own witness backs the
 * second one up independently: `prngCursors` is byte-identical across the v52→v53 re-record
 * while `deflect` counts rose, which is only possible if the window added zero draws.
 */
import { describe, it, expect } from 'vitest';
import { toFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import { degToBrad, type Brad } from '@dd/engine/math/trig';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor, type Faction, type MeleeSimSpec, type Projectile } from '@dd/engine/state/entities';
import {
  closeSwing,
  makeWeapon,
  openSwing,
  toSimSpec,
  BLASTER_SIM,
  SABER_SIM,
  WEAPON_SPECS,
  type MeleeSpec,
} from '@dd/engine/content/weapons';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { hashState } from '@dd/engine/replay';
import { buffedCooldown, BUFF_CAPS, NO_BUFFS, type BuffSums } from '@dd/engine/balance/runbuffs';
import { toTicks, pxToFp } from '@dd/engine/content/convert';
import { freshStatus } from '@dd/engine/content/damage';
import { BASIC_ENEMY } from '@dd/engine/content/enemies';
import { Button, type PlayerCommand } from '@dd/engine/state/commands';
import { ApplyInputSystem, DeflectSystem, HitResolveSystem, WeaponFireSystem } from '@dd/engine/systems';

const CFG = { seed: 7, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

/** Every authored melee weapon, id + authored spec + converted sim spec. Drawn from
 *  WEAPON_SPECS itself rather than a hand-listed set, so a new blade is covered the day it
 *  is authored instead of the day someone remembers to add it here. */
const MELEE = Object.entries(WEAPON_SPECS)
  .filter((e): e is [string, MeleeSpec] => e[1].kind === 'melee')
  .map(([id, spec]) => ({ id, spec, sim: toSimSpec(spec) as MeleeSimSpec }));

function addEnemy(s: GameState, xpx: number, ypx: number, hp = 999): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp, maxHp: hp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius,
    footprintRadius: BASIC_ENEMY.footprintRadius, solidRadius: BASIC_ENEMY.radius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, aggroed: false, holding: false,
  };
  s.enemies.push(e);
  return e;
}

function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction): Projectile {
  const b: Projectile = {
    id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: pxToFp(12),
    vx, vy: toFp(0), radius: pxToFp(5), damage: 1,
    damageType: 'physical', lifeTicks: 90, alive: true,
  };
  s.projectiles.push(b);
  return b;
}

/** A player at world centre holding a melee weapon, facing +x, trigger down. */
function swinger(s: GameState, spec: MeleeSimSpec = SABER_SIM) {
  const p = s.players[0]!;
  p.weapon = makeWeapon(spec);
  p.weapons[0] = p.weapon;
  p.facing = 0 as Brad;
  p.firing = true;
  return p;
}

describe('swingSec → swingTicks conversion (design/09 conversion table)', () => {
  it('every authored melee weapon gets its own window, and none of them is the one-tick default', () => {
    // The anti-tautology guard: `toTicks(spec.swingSec)` recomputed from the AUTHORED seconds,
    // not read back off the sim spec. And the roster has to contain more than one distinct
    // value — the pre-v53 bug's signature is every blade behaving identically, so a conversion
    // that collapsed them all to the same number would satisfy a per-weapon check alone.
    // 7 player blades + the 2 mob blades added in ENGINE_VERSION 59 (enemyclaw, enemymaul).
    // The mob blades are deliberately IN scope here: the swing window is what makes a
    // telegraph readable, and a mob whose window collapsed to one tick would hit without a
    // tell — the exact pre-v53 bug, on the side of the fight where it is least fair.
    expect(MELEE.length).toBe(9); // saber, emberblade, frostbrand, stormglaive, hammer, spear, leech, enemyclaw, enemymaul
    for (const { id, spec, sim } of MELEE) {
      expect(sim.swingTicks, id).toBe(toTicks(spec.swingSec));
      expect(sim.swingTicks, `${id}: a 1-tick window is the bug this replaced`).toBeGreaterThan(1);
    }
    expect(new Set(MELEE.map((m) => m.sim.swingTicks)).size).toBeGreaterThan(1);
    // The specific numbers, so a silent unit change (ms for s, ticks for seconds) fails here
    // rather than merely re-rounding to something plausible.
    const byId = new Map(MELEE.map((m) => [m.id, m.sim.swingTicks]));
    expect(byId.get('spear')).toBe(3); // 0.1 s — the shortest poke
    expect(byId.get('saber')).toBe(4); // 0.13 s — the baseline
    expect(byId.get('hammer')).toBe(6); // 0.2 s — the long heavy sweep
  });

  it('the window is a strict SUBSET of the recovery, for every weapon (design/07 wording)', () => {
    for (const { id, sim } of MELEE) {
      expect(sim.swingTicks, id).toBeLessThan(sim.swingCooldownTicks);
    }
  });

  it('clamps a window authored at 0 ticks up to 1, and one longer than its cooldown down', () => {
    // Neither case exists in shipped content; both are one typo away, and each fails silently
    // in a different direction (a weapon that can never hit / a weapon permanently active).
    const base = WEAPON_SPECS.saber as MeleeSpec;
    const tiny = toSimSpec({ ...base, swingSec: 0.001 }) as MeleeSimSpec;
    expect(toTicks(0.001)).toBe(0); // the raw conversion really does round to nothing
    expect(tiny.swingTicks).toBe(1);
    const huge = toSimSpec({ ...base, swingSec: 99 }) as MeleeSimSpec;
    expect(huge.swingTicks).toBe(huge.swingCooldownTicks);
  });
});

describe('the window opens for exactly swingTicks ticks (WeaponFireSystem, step 3)', () => {
  it('counts swingTicks active ticks per swing — not 1, and not the whole recovery', () => {
    const s = state();
    const p = swinger(s);
    const fire = new WeaponFireSystem();
    let active = 0;
    let swings = 0;
    // One full recovery cycle: the swing tick plus every tick until the next swing is due.
    for (let t = 0; t < SABER_SIM.swingCooldownTicks; t++) {
      fire.tick(s);
      if (p.weapon!.justSwung) swings++;
      if (p.weapon!.swingTicksLeft > 0) active++;
    }
    expect(swings).toBe(1); // exactly one swing in a cooldown's worth of held trigger
    expect(active).toBe(SABER_SIM.swingTicks); // 4
    expect(p.weapon!.swingTicksLeft).toBe(0); // and it really did close before the next swing
  });

  it('a longer-windowed weapon really does stay active longer — the field is read, not ignored', () => {
    // The per-weapon claim the conversion test can only assert as data. Same harness, two
    // weapons, and the observed active-tick counts have to differ the way the specs do.
    const hammer = toSimSpec(WEAPON_SPECS.hammer as MeleeSpec) as MeleeSimSpec;
    const spear = toSimSpec(WEAPON_SPECS.spear as MeleeSpec) as MeleeSimSpec;
    const count = (spec: MeleeSimSpec): number => {
      const s = state();
      const p = swinger(s, spec);
      const fire = new WeaponFireSystem();
      let active = 0;
      for (let t = 0; t < spec.swingCooldownTicks; t++) {
        fire.tick(s);
        if (p.weapon!.swingTicksLeft > 0) active++;
      }
      return active;
    };
    expect(count(hammer)).toBe(6);
    expect(count(spear)).toBe(3);
  });

  it('a swing that starts while one is still active restarts the window and clears its hit list', () => {
    // Only reachable with enough mult_firerate to buff the cooldown below swingTicks. Pinned
    // because the alternative reading — ignore the new swing, or keep the old hit list — makes
    // a fast build's second swing a no-op against the body it is standing in.
    const s = state();
    const p = swinger(s);
    const w = p.weapon!;
    openSwing(w);
    w.swingHitIds.push(4242);
    w.swingTicksLeft = 1; // mid-window
    openSwing(w);
    expect(w.swingTicksLeft).toBe(SABER_SIM.swingTicks);
    expect(w.swingHitIds).toEqual([]);
  });
});

describe('once per swing, NOT once per tick (design/07 "at most once per swing")', () => {
  it('an enemy parked in the arc for the whole window takes exactly one hit', () => {
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 830, 600); // 30 px ahead, inside the saber arc, and it never moves
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    let activeTicks = 0;
    for (let t = 0; t < SABER_SIM.swingTicks; t++) {
      fire.tick(s);
      if (p.weapon!.swingTicksLeft > 0) activeTicks++;
      hits.tick(s);
    }
    // Proof the multi-tick case actually AROSE — without this the assertion below is equally
    // satisfied by a one-tick window, which is the bug.
    expect(activeTicks).toBe(SABER_SIM.swingTicks);
    expect(activeTicks).toBeGreaterThan(1);
    expect(s.events.filter((ev) => ev.type === 'hit')).toHaveLength(1);
    expect(e.hp).toBe(999 - SABER_SIM.damage);
  });

  it('the NEXT swing may hit the same body again — the hit list does not leak across swings', () => {
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 830, 600);
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    let swings = 0;
    for (let t = 0; t < SABER_SIM.swingCooldownTicks * 2; t++) {
      fire.tick(s);
      if (p.weapon!.justSwung) swings++;
      hits.tick(s);
    }
    expect(swings).toBe(2); // two swings really happened over two recoveries
    expect(e.hp).toBe(999 - SABER_SIM.damage * 2); // and each landed exactly once
  });

  it('the crit is ONE combatPrng draw for the whole window, however long the window is', () => {
    // design/07: "a melee swing rolls ONCE for the whole arc (not per target)" — which after
    // v53 also has to mean not per ACTIVE TICK. The hammer is the worst case at 6 ticks.
    const hammer = toSimSpec(WEAPON_SPECS.hammer as MeleeSpec) as MeleeSimSpec;
    const s = state();
    const p = swinger(s, hammer);
    p.buffs = ['crit_up']; // crit_chance > 0, so rollCrit actually draws (it skips the draw at 0)
    addEnemy(s, 830, 600);
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    const before = s.combatPrng.peek();
    let draws = 0;
    for (let t = 0; t < hammer.swingTicks; t++) {
      fire.tick(s);
      const mid = s.combatPrng.peek();
      hits.tick(s);
      if (s.combatPrng.peek() !== mid) draws++;
    }
    expect(hammer.swingTicks).toBe(6); // six active ticks of opportunity to over-draw
    expect(draws).toBe(1);
    expect(s.combatPrng.peek()).not.toBe(before); // it drew at all — the test isn't vacuous
  });

  it('a zero-crit build advances combatPrng not at all across a full window', () => {
    // design/07's "hard wall": a build with critChance 0 keeps its replays independent of the
    // crit stream. The window must not put a draw back in.
    const s = state();
    const p = swinger(s);
    expect(p.buffs).toEqual([]); // no crit buff → rollCrit short-circuits before the draw
    addEnemy(s, 830, 600);
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    const before = s.combatPrng.peek();
    for (let t = 0; t < SABER_SIM.swingTicks; t++) {
      fire.tick(s);
      hits.tick(s);
    }
    expect(s.events.filter((ev) => ev.type === 'hit')).toHaveLength(1); // the swing did connect
    expect(s.combatPrng.peek()).toBe(before);
  });
});

describe('the window is a window — targets reachable on tick 2+ that were not on tick 1', () => {
  it('an enemy that walks INTO the arc mid-swing is hit', () => {
    // The feature, stated as its own test. The enemy starts out of reach, so the swing tick
    // provably cannot hit it; it steps in on the second active tick.
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 1000, 600); // 200 px ahead — way outside the saber's 1.44-grid reach
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();

    fire.tick(s); // the swing tick
    hits.tick(s);
    expect(p.weapon!.justSwung).toBe(true);
    expect(e.hp).toBe(999); // untouched — it was never in range on the tick the swing started

    e.gx = pxToFp(830); // it closes the distance
    fire.tick(s);
    hits.tick(s);
    expect(p.weapon!.swingTicksLeft).toBeGreaterThan(0); // still inside the same swing
    expect(p.weapon!.justSwung).toBe(false); // and NOT a new one
    expect(e.hp).toBe(999 - SABER_SIM.damage);
  });

  it('turning mid-swing sweeps the arc onto a target that was behind the swinger', () => {
    // The "sweeps/re-tests during it" half: the arc is re-tested against the LIVE facing, so
    // a player who turns through their own swing carries it around. The saber's arc is 162°,
    // so a target at 180° starts outside it by a provable margin.
    const s = state();
    const p = swinger(s);
    const behind = addEnemy(s, 770, 600); // 30 px BEHIND (bearing 180°), outside a ±81° arc
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();

    fire.tick(s);
    hits.tick(s);
    expect(behind.hp).toBe(999); // the forward arc cannot reach it

    p.facing = degToBrad(180); // the swinger turns to face it, still mid-window
    fire.tick(s);
    hits.tick(s);
    expect(p.weapon!.swingTicksLeft).toBeGreaterThan(0);
    expect(behind.hp).toBe(999 - SABER_SIM.damage);
  });

  it('an enemy that arrives one tick AFTER the window closes is not hit', () => {
    // The other edge. Without it, "the window is open" and "the window is always open" are
    // indistinguishable, and the recovery would deal free damage.
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 1000, 600); // out of reach for now
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    // swingTicks + 1: the window's LAST active tick is the swingTicks-th, so it takes one
    // more turn of step 3 to count it down to 0. Off by one here and this test would be
    // asserting "a target inside an OPEN window is not hit", which is the opposite claim.
    for (let t = 0; t <= SABER_SIM.swingTicks; t++) {
      fire.tick(s);
      hits.tick(s);
    }
    expect(p.weapon!.swingTicksLeft).toBe(0); // closed
    e.gx = pxToFp(830); // now it steps into the sector — one tick too late
    fire.tick(s);
    hits.tick(s);
    expect(e.hp).toBe(999);
    expect(s.events.filter((ev) => ev.type === 'hit')).toHaveLength(0);
  });
});

describe('deflect shares the window (design/07 "there is no separate blockArc")', () => {
  it('parries a bullet that enters the arc on a later active tick, not just the swing tick', () => {
    const s = state();
    const p = swinger(s);
    addEnemy(s, 900, 600); // a redirect target on the +x side
    const fire = new WeaponFireSystem();
    const deflect = new DeflectSystem();

    fire.tick(s); // swing tick — no bullet exists yet
    deflect.tick(s);
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy'); // arrives on the SECOND active tick
    fire.tick(s);
    expect(p.weapon!.swingTicksLeft).toBeGreaterThan(0);
    expect(p.weapon!.justSwung).toBe(false); // proof this is a later tick of the SAME swing
    deflect.tick(s);

    expect(b.faction).toBe('player');
    expect(s.events.some((e) => e.type === 'deflect')).toBe(true);
  });

  it('does not parry once the window has closed, even with the trigger still held', () => {
    const s = state();
    const p = swinger(s);
    const fire = new WeaponFireSystem();
    const deflect = new DeflectSystem();
    for (let t = 0; t <= SABER_SIM.swingTicks; t++) fire.tick(s); // +1 — see the note above
    expect(p.weapon!.swingTicksLeft).toBe(0);
    expect(p.firing).toBe(true); // still holding — the recovery is not a passive block
    const b = addBullet(s, 830, 600, toFp(-11), 'enemy');
    deflect.tick(s);
    expect(b.faction).toBe('enemy');
  });

  it('the damage window and the parry window are the same length', () => {
    // Guards the asymmetry this change exists to avoid: one field, read by both systems, so
    // they cannot drift into a de-facto separate blockArc.
    const s = state();
    const p = swinger(s);
    const fire = new WeaponFireSystem();
    let damageActive = 0;
    let parryActive = 0;
    for (let t = 0; t < SABER_SIM.swingCooldownTicks; t++) {
      fire.tick(s);
      // Both systems' gate, read the way each of them reads it.
      const w = p.weapon!;
      if (w.swingTicksLeft > 0) damageActive++;
      if (w.spec.kind === 'melee' && w.spec.deflect && w.swingTicksLeft > 0) parryActive++;
    }
    expect(damageActive).toBe(SABER_SIM.swingTicks);
    expect(parryActive).toBe(damageActive);
  });
});

describe('a swing that cannot finish', () => {
  it('a player downed mid-swing stops hitting for the rest of the window', () => {
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 1000, 600);
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();

    fire.tick(s);
    hits.tick(s);
    expect(e.hp).toBe(999);
    p.downed = true; // goes down with the blade still travelling
    e.gx = pxToFp(830); // and the enemy walks into what would have been the arc
    fire.tick(s);
    hits.tick(s);
    expect(p.weapon!.swingTicksLeft).toBeGreaterThan(0); // the window IS still open…
    expect(e.hp).toBe(999); // …but a downed player is not swinging it
  });

  it('holstering mid-swing closes the window instead of freezing it armed', () => {
    // Only the ACTIVE weapon is ticked, so a window left open on a holstered blade would sit
    // frozen — frozen crit and all — and re-open on the swap back, however much later.
    const s = state();
    const p = swinger(s);
    p.weapons[1] = makeWeapon(SABER_SIM); // a second slot to swap into
    new WeaponFireSystem().tick(s);
    const swung = p.weapons[0]!;
    expect(swung.swingTicksLeft).toBeGreaterThan(0);
    swung.swingDamage = 7; // stand in for a frozen crit, so we can see it dropped

    const cmd: PlayerCommand = {
      type: 'input', owner: 0, tick: s.tick, moveBrad: 0 as Brad, moveMag: 0,
      buttons: Button.SWAP_WEAPON, pickupTargetId: 0, cardVote: 0, shopBuyId: 0,
    };
    new ApplyInputSystem().tick(s, [cmd]);

    expect(p.activeSlot).toBe(1);
    expect(swung.swingTicksLeft).toBe(0);
    expect(swung.swingHitIds).toEqual([]);
    expect(swung.swingDamage).toBe(0);
  });
});

/**
 * ── Second pass (same session): the gaps the block above left ──────────────────
 *
 * Everything above drives the two systems by hand, which is the right way to pin the
 * mechanic and the wrong way to know it is WIRED. Three things it cannot see, each of
 * which has its own history of going wrong in this repo:
 *
 *   1. The real `step()` order. A hand-driven `fire.tick(s); hits.tick(s)` pair proves the
 *      two systems agree with each other, not that the other eleven systems leave the
 *      window alone. `ENGINE_VERSION` 49 found a bug that was exactly this shape — the
 *      belief that a value is "corrected next tick" was false once the real order ran.
 *   2. Whether the new fields are actually in the replay hash. `replay.ts`'s own comment
 *      says the golden-replay test "compares two independent runs, so a new always-equal
 *      field never breaks it" — so adding a line to `serializeState` is UNTESTED by
 *      construction, and a typo'd or omitted field is invisible.
 *   3. The contracts on `openSwing`/`closeSwing` that no caller happens to exercise.
 */
describe('the window through the REAL step order (GameEngine.step)', () => {
  // A player 30 px from one enemy, close enough that the auto-aim facing (ApplyInputSystem)
  // puts the saber arc on it. Numbers taken from a probe of the actual run, not guessed.
  const E2E: EngineConfig = { seed: 99, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [[[430, 400]]] };
  const cmd = (tick: number, buttons: number): PlayerCommand =>
    makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons });

  /** Swap to the melee slot (the run spawns holding the blaster), then hold FIRE for `ticks`
   *  ticks, recording the swing window's state after each one. */
  function run(ticks: number) {
    const e = createGameEngine(E2E);
    e.step([cmd(1, Button.SWAP_WEAPON)]);
    const p = e.state.players[0]!;
    expect(p.weapon!.spec.kind).toBe('melee'); // the swap really landed — the rest is meaningless otherwise
    const log: { tick: number; win: number; just: boolean; enemyHp: number | null; swings: number }[] = [];
    for (let t = 2; t <= ticks + 1; t++) {
      e.step([cmd(t, Button.FIRE)]);
      log.push({
        tick: t,
        win: p.weapon!.swingTicksLeft,
        just: p.weapon!.justSwung,
        enemyHp: e.state.enemies[0]?.hp ?? null,
        swings: e.state.events.filter((v) => v.type === 'melee_swing').length,
      });
    }
    return { engine: e, player: p, log };
  }

  it('a held trigger produces windows that are swingTicks long, with the recovery between them', () => {
    const { player, log } = run(30);
    const spec = player.weapon!.spec as MeleeSimSpec;

    const startTicks = log.filter((r) => r.just).map((r) => r.tick);
    const activeTicks = log.filter((r) => r.win > 0).map((r) => r.tick);

    // Three swings in 30 ticks of held trigger at an 11-tick recovery, and each one is a RUN
    // of consecutive active ticks starting at the swing — not one tick, and not all of them.
    expect(startTicks).toEqual([2, 13, 24]);
    expect(activeTicks).toEqual([2, 3, 4, 5, 13, 14, 15, 16, 24, 25, 26, 27]);
    expect(activeTicks.length).toBe(startTicks.length * spec.swingTicks);
    // The gaps are real recovery: the window is CLOSED for the rest of each cooldown, so a
    // held trigger cannot leave a permanently-armed blade.
    expect(log.filter((r) => r.win === 0).length).toBe(30 - startTicks.length * spec.swingTicks);
    // And exactly one event per swing, on the start tick — the render layer is told once.
    expect(log.filter((r) => r.swings === 1).map((r) => r.tick)).toEqual(startTicks);
  });

  it('damage lands once per swing, not once per active tick — end to end', () => {
    // The enemy never moves out of the arc, so it is inside an OPEN window on ticks 2-5. A
    // per-tick hit would take it from 3 hp to dead within the first swing; once-per-swing
    // leaves it at 1 and needs the second swing to finish it.
    const { log } = run(30);
    expect(log.find((r) => r.tick === 2)!.enemyHp).toBe(1); // 3 - 2, the swing connected
    for (const t of [3, 4, 5]) {
      expect(log.find((r) => r.tick === t)!.win, `tick ${t} must still be inside the window`).toBeGreaterThan(0);
      expect(log.find((r) => r.tick === t)!.enemyHp, `tick ${t} must not hit again`).toBe(1);
    }
    expect(log.find((r) => r.tick === 13)!.enemyHp).toBe(null); // the NEXT swing kills it
  });

  it('the hit list is empty again by the time the window closes — it cannot grow across swings', () => {
    const { engine, player } = run(30);
    expect(player.weapon!.swingTicksLeft).toBe(0);
    expect(player.weapon!.swingHitIds).toEqual([]);
    expect(player.weapon!.swingDamage).toBe(0);
    expect(engine.state.tick).toBe(31);
  });
});

describe('the window is really in the replay hash (design/06)', () => {
  /** Two engines stepped identically — byte-equal by construction, which is the baseline every
   *  assertion below perturbs by exactly one field. */
  function twins() {
    const cfg: EngineConfig = { seed: 5, worldW: 800, worldH: 800, playerStart: [400, 400], waves: [] };
    const a = createGameEngine(cfg);
    const b = createGameEngine(cfg);
    const c = makeCommand({ owner: 0, tick: 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
    a.step([c]);
    b.step([{ ...c }]);
    expect(hashState(b.state)).toBe(hashState(a.state)); // the premise
    // weapons[1] is the starter saber (PLAYER_BASE.startWeapons = [blaster, saber]).
    expect(a.state.players[0]!.weapons[1]!.spec.kind).toBe('melee');
    return { a, b };
  }

  it('a divergence in swingTicksLeft moves the hash', () => {
    // Without this, `serializeState` could have omitted the field entirely and every test in
    // this repo would still be green — including the golden gate, which compares a run against
    // a fixture recorded from the same (possibly incomplete) serializer.
    const { a, b } = twins();
    b.state.players[0]!.weapons[1]!.swingTicksLeft = 3;
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });

  it('a divergence in swingHitIds moves the hash', () => {
    const { a, b } = twins();
    b.state.players[0]!.weapons[1]!.swingHitIds.push(77);
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });

  it('a divergence in swingDamage moves the hash', () => {
    // The frozen crit. Two clients disagreeing here agree about every position and hp for the
    // rest of the window and then disagree about how hard it lands.
    const { a, b } = twins();
    b.state.players[0]!.weapons[1]!.swingDamage = 9;
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });

  it("a divergence in the SPEC's swingTicks moves the hash", () => {
    // A loadout desync that swaps in a differently-windowed blade — same name, same damage,
    // same reach, different window. Only the spec field distinguishes them.
    const { a, b } = twins();
    const longer: MeleeSimSpec = { ...(SABER_SIM as MeleeSimSpec), swingTicks: 9 };
    b.state.players[0]!.weapons[1] = makeWeapon(longer);
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });
});

describe('openSwing / closeSwing contracts', () => {
  it('openSwing is a no-op on a ranged weapon — a gun has no window to open', () => {
    // Documented in its own comment ("so a caller never has to narrow the spec first"), and
    // load-bearing: `WeaponFireSystem` calls it only in the melee branch today, but the guard
    // is what makes it safe to call from anywhere.
    const w = makeWeapon(BLASTER_SIM);
    openSwing(w);
    expect(w.justSwung).toBe(false);
    expect(w.swingTicksLeft).toBe(0);
    expect(w.swingHitIds).toEqual([]);
  });

  it('closeSwing on a weapon at rest changes nothing, and is safe to repeat', () => {
    const w = makeWeapon(SABER_SIM);
    closeSwing(w);
    closeSwing(w);
    expect(w.swingTicksLeft).toBe(0);
    expect(w.swingHitIds).toEqual([]);
    expect(w.swingDamage).toBe(0);
  });

  it('closeSwing keeps the SAME hit-list array — it clears, never reallocates', () => {
    // Both helpers mutate `length` rather than assigning `[]`. Not a style choice: the array is
    // hashed every tick (`swingHitIds.join(',')`), and a fresh allocation per swing in the
    // per-tick path is exactly the kind of garbage the sim loop avoids.
    const w = makeWeapon(SABER_SIM);
    const ids = w.swingHitIds;
    openSwing(w);
    w.swingHitIds.push(1, 2);
    closeSwing(w);
    expect(w.swingHitIds).toBe(ids);
    expect(ids).toEqual([]);
  });
});

describe('no shipped weapon can outlast its own recovery, even at the buff cap', () => {
  it("the restart-mid-window branch is unreachable in shipped content — so it stays defensive", () => {
    // `openSwing`'s restart path (tested synthetically above) needs a cooldown SHORTER than the
    // window, which only `mult_firerate` could produce. It cannot, for any shipped blade, at the
    // cap. Worth pinning rather than assuming: this fails the day someone raises BUFF_CAPS or
    // authors a weapon whose window approaches its cooldown, which is precisely when the
    // restart branch stops being theoretical and needs a real look.
    const capped: BuffSums = { ...NO_BUFFS, mult_firerate: BUFF_CAPS.mult_firerate };
    for (const { id, sim } of MELEE) {
      const fastest = buffedCooldown(sim.swingCooldownTicks, capped);
      expect(fastest, `${id}: window ${sim.swingTicks} vs fastest cooldown ${fastest}`).toBeGreaterThan(
        sim.swingTicks,
      );
    }
    expect(BUFF_CAPS.mult_firerate).toBe(700); // the number the claim above depends on
  });
});

describe('what the window does NOT extend to', () => {
  it('an enemy holding a blade opens a window but deals no arc damage — melee is player-only', () => {
    // `HitResolveSystem` loops `state.players` for the arc, so an enemy's swing is timing and an
    // event and nothing else. No shipped blueprint carries a melee weapon, so this is a
    // limitation rather than a bug — pinned so that whoever gives an enemy a blade discovers it
    // here instead of in a playtest where the mob visibly swings and nothing happens.
    const s = state();
    const e = addEnemy(s, 830, 600);
    e.weapon = makeWeapon(SABER_SIM);
    e.firing = true;
    const victim = s.players[0]!;
    victim.gx = pxToFp(800);
    victim.gy = pxToFp(600);
    const hpBefore = victim.hp;
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    let active = 0;
    for (let t = 0; t < SABER_SIM.swingTicks; t++) {
      fire.tick(s);
      if (e.weapon!.swingTicksLeft > 0) active++;
      hits.tick(s);
    }
    expect(active).toBe(SABER_SIM.swingTicks); // the window opened and ran, on an enemy
    expect(s.events.filter((ev) => ev.type === 'melee_swing').length).toBeGreaterThan(0);
    expect(victim.hp).toBe(hpBefore); // and reached nobody
  });

  it('a killed swinger stops mid-window, same as a downed one', () => {
    const s = state();
    const p = swinger(s);
    const e = addEnemy(s, 1000, 600);
    const fire = new WeaponFireSystem();
    const hits = new HitResolveSystem();
    fire.tick(s);
    hits.tick(s);
    expect(e.hp).toBe(999);
    p.alive = false;
    e.gx = pxToFp(830);
    fire.tick(s);
    hits.tick(s);
    expect(p.weapon!.swingTicksLeft).toBeGreaterThan(0);
    expect(e.hp).toBe(999);
  });

  it('one bullet is parried ONCE, however many active ticks it spends in the arc', () => {
    // New risk created by the multi-tick window: a deflected bullet stays inside the sector for
    // the remaining ticks. It survives only because deflect flips its team and the hostility
    // check then skips it — so a bug that flipped faction without teamId, or re-tested by
    // faction alone, would re-aim the same round and reset its lifespan every tick.
    const s = state();
    const p = swinger(s);
    addEnemy(s, 900, 600);
    const b = addBullet(s, 830, 600, toFp(-1), 'enemy'); // slow, so it stays in the sector
    const fire = new WeaponFireSystem();
    const deflect = new DeflectSystem();
    for (let t = 0; t < SABER_SIM.swingTicks; t++) {
      fire.tick(s);
      expect(p.weapon!.swingTicksLeft, `tick ${t}`).toBeGreaterThan(0); // all inside one window
      deflect.tick(s);
    }
    expect(b.faction).toBe('player');
    expect(s.events.filter((e) => e.type === 'deflect')).toHaveLength(1);
  });
});

describe('the window the render layer can see', () => {
  it("is on the ACTIVE weapon's spec, which is what a swinging player's state exposes", () => {
    // `melee_swing` carries no weapon data by design, so the client reads the window off
    // `state.players[i].weapon.spec` (`EventReactor.meleeSwinger` ->
    // `swingShapeOf`). This is the engine-side half of that contract: the spec reachable
    // through the swinging player really is the one that swung, and it really does carry a
    // per-weapon window. Without it, a client pacing the swing off a constant again would be
    // an entirely client-side test's problem to notice.
    for (const [id, ticks] of [['hammer', 6], ['spear', 3], ['saber', 4]] as const) {
      const s = state();
      const p = swinger(s, toSimSpec(WEAPON_SPECS[id] as MeleeSpec) as MeleeSimSpec);
      new WeaponFireSystem().tick(s);
      expect(s.events.filter((e) => e.type === 'melee_swing'), id).toHaveLength(1);
      const spec = p.weapon!.spec;
      expect(spec.kind, id).toBe('melee');
      expect((spec as MeleeSimSpec).swingTicks, id).toBe(ticks);
      // …and it is the window the swing actually opened with, not merely a field on a spec.
      expect(p.weapon!.swingTicksLeft, id).toBe(ticks);
    }
  });
});
