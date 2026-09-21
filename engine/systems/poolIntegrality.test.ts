/**
 * The two-pool invariant that `ENGINE_VERSION` 67 turned from an accident into a rule:
 * **hp and shield only ever hold whole numbers.**
 *
 * They did not, for two months. `vanguard.maxShield` was authored as `3.2` (a rounding
 * artefact of the old PvP derivation — see `content/skins.ts`), so a spent shield left
 * `0.2` behind, the next hit overflowed `0.8` into hp, and the player's body sat at
 * `5.2` for the rest of the run. Nothing failed. The pools are hashed by `serializeState`
 * and rendered by the character screen, and the detector that eventually fired was a
 * human reading a screenshot.
 *
 * Two halves, because there are two ways to break it and they are maintained in different
 * files:
 *
 *   1. the damage pipeline (`content/damage.ts`, `balance/runbuffs.ts`) must only ever
 *      hand `takeDamage` an integer — every multiplier in it is per-mille and every one
 *      of them rounds, which is a property of five separate functions, not of one;
 *   2. the pools themselves (`systems/combat.ts`, `systems/StatusEffectSystem.ts`) must
 *      keep what they are handed whole — the absorb, the overflow and the idle regen.
 *
 * `content/authoredNumbers.test.ts` covers the third way in: a fractional number authored
 * in the content tables in the first place.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import { StatusEffectSystem } from '@dd/engine/systems';
import { SHIELD_REGEN_DELAY, SHIELD_REGEN_INTERVAL } from '@dd/engine/config';
import {
  applyResist,
  burnDamageFor,
  CHAIN_DMG_PERMILLE,
  DAMAGE_TYPES,
  type ResistMap,
} from '@dd/engine/content/damage';
import { ENEMY_BLUEPRINTS } from '@dd/engine/content/enemies';
import { SKIN_DEFS } from '@dd/engine/content/skins';
import { BUFF_CAPS, buffedDamage, critDamage, NO_BUFFS } from '@dd/engine/balance/runbuffs';
import { takeDamage } from './combat';

/** Raw hit sizes worth sweeping: PvE weapons deal 1-9, PvP ones up to ~45 after scaling. */
const RAW_DAMAGE = [1, 2, 3, 4, 5, 6, 7, 9, 10, 15, 25, 45];

describe('the damage pipeline only ever produces integers (design/07 min-1, per-mille rounding)', () => {
  // Every resist profile the game actually ships, against every type — rather than a
  // hand-picked multiplier, which is how a rounding rule gets tested against the one input
  // it was written for. `applyResist` rounds a weakness UP and truncates a resistance DOWN
  // (deliberately asymmetric, so a weakness stays visible on a 1-damage elemental hit and a
  // resistance always reduces); both directions have to land on an integer.
  const PROFILES: readonly { name: string; resist: ResistMap | undefined }[] = [
    { name: 'no profile', resist: undefined },
    ...Object.values(ENEMY_BLUEPRINTS)
      .filter((b) => b.resist)
      .map((b) => ({ name: b.type, resist: b.resist })),
  ];

  it('the sweep has real subjects — the shipped roster does carry resist profiles', () => {
    expect(PROFILES.length).toBeGreaterThan(3);
    const multipliers = new Set(PROFILES.flatMap((p) => Object.values(p.resist ?? {})));
    expect(multipliers.size, 'every profile has the same multiplier').toBeGreaterThan(1);
    // Both directions are present, or the asymmetric rounding rule is only half-tested.
    expect([...multipliers].some((m) => m > 1000), 'no weakness in the roster').toBe(true);
    expect([...multipliers].some((m) => m < 1000), 'no resistance in the roster').toBe(true);
  });

  it.each(PROFILES.map((p) => p.name))('applyResist stays a whole number >= 1 for %s', (name) => {
    const { resist } = PROFILES.find((p) => p.name === name)!;
    for (const type of DAMAGE_TYPES) {
      for (const raw of RAW_DAMAGE) {
        const out = applyResist(raw, type, resist);
        expect(Number.isInteger(out), `${name}/${type}/${raw} -> ${out}`).toBe(true);
        expect(out, `${name}/${type}/${raw} fell through the min-1 floor`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('crit, damage buffs and their composition stay whole across the buff cap', () => {
    // Swept to the cap rather than at one buff's value: `mult_damage` sums before it
    // rounds, so the interesting inputs are the totals a stacked run can actually reach.
    for (let mult = 0; mult <= BUFF_CAPS.mult_damage; mult += 50) {
      const sums = { ...NO_BUFFS, mult_damage: mult };
      for (const raw of RAW_DAMAGE) {
        const buffed = buffedDamage(raw, sums);
        expect(Number.isInteger(buffed), `buffedDamage(${raw}, ${mult}) -> ${buffed}`).toBe(true);
        for (const isCrit of [false, true]) {
          const out = critDamage(buffed, isCrit);
          expect(Number.isInteger(out), `critDamage(${buffed}, ${isCrit}) -> ${out}`).toBe(true);
        }
      }
    }
  });

  it('the derived payloads — burn ticks and a lightning chain — stay whole', () => {
    for (const raw of RAW_DAMAGE) {
      expect(Number.isInteger(burnDamageFor(raw))).toBe(true);
      expect(burnDamageFor(raw)).toBeGreaterThanOrEqual(1);
      // HitResolveSystem's chain arithmetic, restated at the value it is applied to.
      const chain = Math.max(1, Math.trunc((raw * CHAIN_DMG_PERMILLE) / 1000));
      expect(Number.isInteger(chain)).toBe(true);
    }
  });
});

describe('the pools keep what they are handed whole (design/07 two-pool)', () => {
  const CFG = { seed: 7, worldW: 800, worldH: 800, waves: [] as const };
  const ROSTER = Object.keys(SKIN_DEFS);

  it.each(ROSTER)('%s: absorb and overflow leave hp/shield integral, hit after hit', (skinId) => {
    // Every damage size against every character, each on its own fresh state — the
    // fractional residue that shipped only appeared once a pool had been partially spent,
    // so a single hit would not have caught it. Runs past death deliberately: a corpse's
    // negative hp is hashed like any other number.
    for (const dmg of RAW_DAMAGE) {
      const s = createGameState({ ...CFG, skinId });
      const p = s.players[0]!;
      for (let hit = 1; hit <= 12; hit++) {
        takeDamage(s, p, dmg, 'enemy', 'physical');
        expect(Number.isInteger(p.shield), `${skinId}: shield ${p.shield} after ${hit}x${dmg}`).toBe(true);
        expect(Number.isInteger(p.hp), `${skinId}: hp ${p.hp} after ${hit}x${dmg}`).toBe(true);
      }
    }
  });

  it.each(ROSTER)('%s: it takes exactly ceil(pool / damage) hits to empty the body', (skinId) => {
    // The property the `3.2` fraction hid behind: against integer damage, only the TOTAL
    // pool decides the hit count, so 6/3.2 and 6/4 were the same character and the tuning
    // pass that wrote the fraction moved nothing in PvE. Stated as a rule here so the next
    // person to reach for a fraction as a balance lever finds out what it buys — nothing —
    // from a test rather than from a screenshot two months later.
    const skin = SKIN_DEFS[skinId]!;
    const pool = skin.maxHp + skin.maxShield;
    for (const dmg of RAW_DAMAGE) {
      const s = createGameState({ ...CFG, skinId });
      const p = s.players[0]!;
      let hits = 0;
      while (p.hp > 0 && hits < 200) {
        takeDamage(s, p, dmg, 'enemy', 'physical');
        hits++;
      }
      expect(hits, `${skinId} @ ${dmg} damage`).toBe(Math.ceil(pool / dmg));
    }
  });

  it('idle regen refills in whole points and stops exactly on maxShield', () => {
    const sys = new StatusEffectSystem();
    for (const skinId of ROSTER) {
      const skin = SKIN_DEFS[skinId]!;
      if (skin.maxShield === 0) continue; // no pool to regen (juggernaut, by design)
      const s = createGameState({ ...CFG, skinId });
      const p = s.players[0]!;
      takeDamage(s, p, skin.maxShield, 'enemy', 'physical'); // empty the shield, keep hp
      expect(p.shield).toBe(0);
      const ticks = SHIELD_REGEN_DELAY + SHIELD_REGEN_INTERVAL * (skin.maxShield + 2);
      for (let i = 0; i < ticks; i++) {
        s.tick++;
        sys.tick(s);
        expect(Number.isInteger(p.shield), `${skinId}: shield ${p.shield} mid-regen`).toBe(true);
        expect(p.shield).toBeLessThanOrEqual(skin.maxShield);
      }
      expect(p.shield, `${skinId} never refilled`).toBe(skin.maxShield);
    }
  });
});
