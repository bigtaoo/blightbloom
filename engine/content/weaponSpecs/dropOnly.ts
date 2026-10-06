/**
 * Drop-only physical weapons + the mob loadout (split out of weaponSpecs.ts, CLAUDE.md
 * "500-line file convention", form ①; see starter.ts's header for the split rationale).
 * repeater/cannon are opposite poles of the same "gun" identity (uptime vs punch);
 * enemygun is the basic mob's loadout, never player-selectable.
 */
import type { WeaponSpec } from '../weaponTypes';

export const DROP_ONLY_WEAPON_SPECS: Record<string, WeaponSpec> = {
  // ── Repeater (drop-only: fast, weak) ─────────────────────────────────────────
  // The "spray" gun — a weapon drop that trades punch for uptime, a wall of chip damage.
  repeater: {
    id: 'repeater',
    kind: 'ranged',
    nameKey: 'weapon.repeater.name',
    skinRef: 'gun_default',
    rarity: 'fine', // 蓝 — a slightly nicer floor drop

    cooldownSec: 0.1, // 3 ticks — 10 shots/s
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 12, // grid/s
    damage: 1,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): the pace weapon: 20/s, exactly break-even — sustainable, and the cheapest pull in the game
    energyCost: 2,
    lifespanSec: 2.0,
    bulletRadius: 0.12,
    muzzleGrid: 0.9375,
    bulletZ: 0.5,
  },

  // ── Cannon (drop-only: slow, heavy) ──────────────────────────────────────────
  // The opposite pole — big single hits that two-shot a basic enemy raw. Slow
  // enough that positioning matters.
  cannon: {
    id: 'cannon',
    kind: 'ranged',
    nameKey: 'weapon.cannon.name',
    skinRef: 'gun_default',
    rarity: 'epic', // 紫 — a standout heavy-hitter drop

    cooldownSec: 0.6, // 18 ticks
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 8, // grid/s
    damage: 3,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): the heavy single shot —
    // 23/s, above the regen line, so three damage a trigger is something you spend for
    energyCost: 14,
    lifespanSec: 3.0,
    bulletRadius: 0.28,
    muzzleGrid: 1.0,
    bulletZ: 0.5,
  },

  // ── Enemy gun (basic mob loadout — not player-selectable) ───────────────────
  // Demo Game.ts enemy: fireInterval 90f, bullet dmg 1, muzzle 20px, same ballistic.
  //   cooldownSec 1.5 → 45 ticks    muzzleGrid 0.625 (20px)
  enemygun: {
    id: 'enemygun',
    kind: 'ranged',
    nameKey: 'weapon.enemygun.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.5, // 90 frames @60fps
    bullets: 1,
    spreadDeg: 0,
    bulletSpeed: 10, // grid/s
    damage: 1,
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged (WeaponFireSystem) — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 3.0,
    bulletRadius: 0.15,
    muzzleGrid: 0.625, // grid (demo 20px/32)
    bulletZ: 0.5,
  },

  // ── Enemy nova (Pyrefang boss loadout — Task 2, ENGINE_VERSION 70, not player-
  // selectable) ────────────────────────────────────────────────────────────────
  // The boss's entire threat, not a burst option like the player-facing `novaburst`
  // it copies the pattern from: an even ring of fire pellets, deterministic (no
  // spread PRNG, same as `novaburst`), so standing still to trade hits is the losing
  // play regardless of where the boss is facing. A fuller ring (12 vs 10) and a
  // slower cooldown than `novaburst` — the boss telegraphs a whole volley rather than
  // spending a burst resource, so the ring itself is the cost.
  enemynova: {
    id: 'enemynova',
    kind: 'ranged',
    nameKey: 'weapon.enemynova.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.6, // 48 ticks — a full volley to react to and reposition around
    bullets: 12, // a fuller ring than novaburst's 10 — boss-scale
    spreadDeg: 0, // unused by radial (the ring is even, not jittered)
    pattern: 'radial',
    bulletSpeed: 9,
    damage: 1, // per pellet — the threat is standing in several, not one big hit
    damageType: 'fire', // PYREFANG's element (design/07 payload → on-hit burn status)
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 1.2,
    bulletRadius: 0.16,
    muzzleGrid: 0.875, // grid (28px/32) — PYREFANG's own radius
    bulletZ: 0.5,
  },

  // ── Enemy melee loadouts (ENGINE_VERSION 59, design/05/09) ──────────────────
  // The roster had NO melee mob at all until now: every one of the eight blueprints
  // carried `ENEMY_GUN_SIM`, and `EnemyBlueprint.weapon` was typed `RangedSimSpec`, so
  // an all-ranged garrison was not a content choice — it was a type constraint.
  //
  // That mattered the moment the ammo economy landed (design/03/05,
  // `balance/energy.ts`): a player who runs an expensive frame dry falls back on the
  // melee half of the loadout, and against an all-ranged roster that fallback means
  // walking into every gun on the floor with the shield's idle regen (the sustain
  // design/05 chose over potions) unable to tick while you do it. A melee mob is what
  // makes the ranged half worth its price back — something you WANT the gun for.
  //
  // Neither carries `deflect`. A mob that parries your bullets back at you is a much
  // larger design change than this pass (it inverts design/03's core mechanic, which
  // is the player's alone today), and it would make the ranged half strictly worse
  // against exactly the mobs it exists to counter. Recorded as a deliberate no, not an
  // oversight; `enemies.test.ts` pins it.
  //
  // Neither is player-facing, so both are excluded from `WEAPON_SIM_BY_ID` alongside
  // `enemygun` — they can never roll as a weapon drop.

  // The rusher's claw: quick, short, one point of damage. Its threat is arriving, not
  // the swing — see `STALKER`'s move speed.
  enemyclaw: {
    id: 'enemyclaw',
    kind: 'melee',
    nameKey: 'weapon.enemyclaw.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 0.9, // 27 ticks — slower than the player's saber (11), so a rush is readable
    damage: 1, // same per-hit as ENEMY_GUN_SIM; the difference is that it has to reach you
    arcDeg: 90, // a narrow lunge, not a sweep — it commits to one direction
    rangeGrid: 1.1, // ~35 px reach; STALKER's engageRangeFp parks it inside this
    swingSec: 0.2, // active hit window ⊂ cooldown — long enough to read the wind-up and step out
    knockback: 4, // a shove, not a launch
    deflect: false, // see the section note above — deliberate
    deflectSpeed: 0, // unused while deflect is false; 0 rather than a lie about a speed
  },

  // The heavy's maul: slow, wide, and it moves you. The counterpart to `enemyclaw` —
  // one you dodge by timing, one you dodge by distance.
  enemymaul: {
    id: 'enemymaul',
    kind: 'melee',
    nameKey: 'weapon.enemymaul.name',
    skinRef: 'sword_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.8, // 54 ticks — the slowest attack in the game, telegraphed by its window
    damage: 2, // twice a gun shot, at contact range only
    arcDeg: 150, // a wide sweep: standing beside it is not standing clear of it
    rangeGrid: 1.5,
    swingSec: 0.33, // 10 ticks of active window — the long tell that makes it fair
    knockback: 14, // it shoves you out of its own reach, which is what opens the next gap
    deflect: false,
    deflectSpeed: 0,
  },

  // ── Enemy shard fan (Glacimaw boss loadout — chapter 2, design/gameplay/04-chapters.md,
  // not player-selectable) ─────────────────────────────────────────────────────────────
  // The chapter-2 boss's whole threat: an AIMED cone of ice shards, where Pyrefang's
  // `enemynova` is an unaimed ring. Every shard is ice, so a hit chills (HitResolveSystem's
  // CHILL_SLOW) — and a chilled player is slower to leave the next cone. The counterplay is
  // lateral movement BEFORE the volley, not distance after it. The jitter draws from
  // combatPrng exactly like any spread weapon's pellets (WeaponFireSystem.fireRanged).
  enemyshardfan: {
    id: 'enemyshardfan',
    kind: 'ranged',
    nameKey: 'weapon.enemyshardfan.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.4, // 42 ticks — a touch quicker than the ring: a cone is easier to step out of
    bullets: 5,
    spreadDeg: 50, // wide enough that backing straight off still eats a shard
    bulletSpeed: 11,
    damage: 1, // per shard — the threat is the chill chaining volleys, not one big hit
    damageType: 'ice', // GLACIMAW's element (design/07 payload → on-hit chill status)
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 1.6,
    bulletRadius: 0.14,
    muzzleGrid: 0.875, // grid (28px/32) — GLACIMAW's own radius
    bulletZ: 0.5,
  },

  // ── Enemy arc seeker (Voltreaver boss loadout — chapter 3, design/gameplay/04-chapters.md,
  // not player-selectable) ─────────────────────────────────────────────────────────────
  // The "out-turn it" fight. Three HOMING lightning orbs per volley, launched in a wide fan so
  // they close from both flanks rather than down the line the player is shooting along: they
  // follow, so neither stepping sideways (Glacimaw's answer) nor backing off clears a volley
  // for free. The answer is a late, hard cut across their path — the turn rate is well under
  // the player's own seeker's, so an orb that has committed overshoots — or shooting the ones
  // that do come down the firing line (hostile bullets annihilate, and a fat, slowish orb is
  // easy to catch). In co-op every hit also ARCS to the nearest teammate within `CHAIN_RANGE`
  // (lightning's payload, design/07), so the party's answer adds a third: do not stand together.
  //
  // Set by a boss-duel sweep (`client/sim/chapterSim.sim.ts`, careful bot, 40 seeds, the boss
  // alone at 90 HP, 2026-10-06). The fight is knife-edged on speed and turn rate, and each knob
  // was walked until the orbs landed at all:
  //   as first authored (3 orbs, 80° fan, 5 grid/s, 110°/s, every 1.8 s)  100% kills, 0 damage
  //   160° fan, 6 grid/s, 160°/s, every 1.4 s                             100% kills, 0 damage
  //   160° fan, 7 grid/s, 140°/s, every 1.4 s                              98% kills
  //   160° fan, 7 grid/s, 160°/s, every 1.4 s   ← shipped                  57% kills, 43% deaths
  //   160° fan, 7 grid/s, 180°/s, every 1.6 s                              33% kills, 70% deaths
  // An orb under ~7 grid/s is simply erased by the bot's own fire, which crosses the fan's
  // centre line. At chapter 3's shipped boss-floor scale (95 HP) the duel reads 50% / 50%:
  // between Glacimaw (23% kills) and the chapter-1 bosses whose single aimed bullets never
  // land on the bot (100%).
  enemyarcseeker: {
    id: 'enemyarcseeker',
    kind: 'ranged',
    nameKey: 'weapon.enemyarcseeker.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.4, // 42 ticks — the shardfan's cadence
    bullets: 3,
    spreadDeg: 160, // launched wide, so the orbs converge from the flanks
    bulletSpeed: 7, // under the starter blaster's 10: still a bullet the player can catch
    damage: 1, // per orb
    damageType: 'lightning', // VOLTREAVER's element (design/07 payload → chain arc)
    ballistic: 'homing',
    turnRateDegPerSec: 160, // well under the player's seeker (260) — it can be out-turned
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 3.0, // ~21 grid of flight, then it fizzles
    bulletRadius: 0.24, // the fattest enemy bullet: a target, not a needle
    muzzleGrid: 0.875, // grid (28px/32) — VOLTREAVER's own radius
    bulletZ: 0.5,
  },

  // ── Enemy spore spray (Rotbloom boss loadout — chapter 4, design/gameplay/04-chapters.md,
  // not player-selectable) ─────────────────────────────────────────────────────────────
  // The "keep your distance" fight. A dense, SHORT cone of poison spores: every spore that
  // lands pushes an independent poison stack (design/07), and stacks are what kill — each one
  // ticks on after the hit, and a poisoned actor's shield does not regenerate. Trading at close
  // range ramps the stacks; the spores die ~5 grid out, so a player who kites the boss past
  // that takes none.
  //
  // Set by a boss-duel sweep (`client/sim/chapterSim.sim.ts`, careful bot, 40 seeds, the boss
  // alone at the boss floor's 105 HP, 2026-10-06):
  //   as first authored (6 spores, 60°, 6 grid/s, 1.0 s life, every 1.0 s)  60% kills, 51 s median
  //   + 6.5 grid/s                                                          15% kills, 85% deaths
  //   + 7 grid/s, every 1.4 s   ← shipped                                   35% kills, 65% deaths, 35 s
  //   8 spores in 80°, 6 grid/s                                              0% kills
  // Like Voltreaver's orbs, a slow spore is erased by the bot's own fire (hostile bullets
  // annihilate), so speed is the knob that decides whether the cone lands at all. The flight
  // time is NOT a knob for the bot: 0.5 s and 2.0 s read the same, because every spore that
  // lands does so inside ~3.5 grid — the boss walks the bot into a wall or corner first. 0.3 s
  // (~2 grid) lands nothing. The shipped 0.7 s keeps the reach (~5 grid) under the bot's own
  // 7.5-grid standoff, so the distance a human can hold is real.
  enemysporespray: {
    id: 'enemysporespray',
    kind: 'ranged',
    nameKey: 'weapon.enemysporespray.name',
    skinRef: 'gun_default',
    rarity: 'common', // 白 — mob loadout, never player-facing

    cooldownSec: 1.4, // 42 ticks — the shardfan's and the arc seeker's cadence
    bullets: 6,
    spreadDeg: 60,
    bulletSpeed: 7, // the arc seeker's: the slowest a cone can be and still survive the bot's fire
    damage: 1, // per spore — the threat is the stacks it leaves, not the hit
    damageType: 'poison', // ROTBLOOM's element (design/07 payload → on-hit poison stack)
    ballistic: 'straight',
    // Energy per trigger pull (design/03/05, balance/energy.ts): enemies are never charged — required by the schema, read by nothing
    energyCost: 0,
    lifespanSec: 0.7, // ~5 grid of flight: the whole fight is about staying past it
    bulletRadius: 0.18,
    muzzleGrid: 0.875, // grid (28px/32) — ROTBLOOM's own radius
    bulletZ: 0.5,
  },
};
