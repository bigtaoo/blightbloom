/**
 * `toSimSpec` — the authored → sim CONVERSION CONTRACT (design/09 convert-once).
 *
 * ## Why this file exists
 *
 * `content/weapons.ts` had no test of its own. It was exercised only sideways — by
 * `balance/rarity.test.ts` (the damage edge), `systems/meleeWindow.test.ts` (`swingTicks`),
 * and two client render sweeps (`muzzleParity`, `rigAttackMotion`) — and every one of those
 * reads the ONE field it cares about. Nothing anywhere asserted that the other twenty-odd
 * authored fields arrive at all.
 *
 * That is not a hypothetical gap. `toSimSpec` has dropped an authored field on the floor
 * three separate times, and each one shipped:
 *
 *   - `piercing`   — authored on `RangedSpec` since Stage C, converted by nothing until
 *                    `ENGINE_VERSION` 28.
 *   - `ricochetCount` — same batch; found only because someone went looking at the
 *                    piercing branch next door.
 *   - `swingSec`   — authored on EVERY melee weapon since Stage C, converted by nothing
 *                    until `ENGINE_VERSION` 53, so for ~45 engine versions every blade's
 *                    active hit window was one tick regardless of what its spec said, and
 *                    the third axis of design/03's "swing shape" did not exist.
 *
 * Coverage cannot see this bug. `content/weapons.ts` reads 100% lines AND 100% branches
 * today — every `?? default` and `!== undefined ? … : undefined` ternary is exercised both
 * ways by some weapon in the catalog — and a dropped field is precisely a line that was
 * never written, so there is nothing for a percentage to miss.
 *
 * ## What is asserted
 *
 * A hand-written LANDING TABLE (`RANGED_LANDINGS` / `MELEE_LANDINGS`) names, for every
 * authored field, the sim-spec key it lands on and the formula that produces it. The table
 * is then closed on BOTH sides against reality, which is what makes it a gate rather than
 * documentation:
 *
 *   authored → table   every key any shipped weapon sets must be in the table; a new
 *                      authored field with no converter line fails here, by name.
 *   schema   → table   enforced by the COMPILER, not an assertion: the tables are typed
 *                      `Record<keyof RangedSpec, …>` / `Record<keyof MeleeSpec, …>`, so a
 *                      field declared in `weaponTypes.ts` with no landing line is a
 *                      `tsc --noEmit` error. That closes the hole `piercing` sat in for a
 *                      whole stage — declared, authored by nobody, converted by nothing —
 *                      without reaching for `node:fs` to regex the schema, which this
 *                      package's tsconfig withholds on purpose.
 *   table    → sim     every key `toSimSpec` actually emits must be claimed by a landing;
 *                      a sim field invented in the converter with no authored source fails.
 *
 * Formula arithmetic is pinned separately, on real weapons, with the design/09 conversion
 * spelled out in the comment so it can be checked by hand rather than against the
 * implementation it is supposed to be guarding.
 *
 * ## Mutation battery
 *
 * Recorded 2026-09-04 against `content/weapons.ts` (+ `weaponTypes.ts` / `convert.ts` /
 * `weaponSpecs/starter.ts` for the schema and catalog directions). Every row is a real
 * edit, then `npx tsc --noEmit` AND `npx vitest run content/weapons.test.ts`, revert. Both
 * are recorded because the schema direction is a compile-time gate — reporting only the
 * test column would show it as a survivor when it is the strongest check in the file.
 *
 *                                                                        tsc   tests
 *   KILLED  `piercing: spec.piercing ?? false` deleted (the bug, restaged)  —      19
 *   KILLED  `swingTicks: …` pinned back to the pre-v53 `1` ...............  —       8
 *   KILLED  `spreadHalf: degToBrad(spec.spreadDeg / 2)` → not halved .....  —       3
 *   KILLED  `ricochetCount: spec.ricochetCount` deleted .................  —       2
 *   KILLED  a new authored field (`recoilGrid`) on a weapon + the schema .  1       1
 *   KILLED  a schema-ONLY field (`chargeSec?`), authored by no weapon ....  1       0
 *   SURVIVED `toFpPerTick`'s `Math.trunc` → `Math.round` ................  —       0
 *
 * The `chargeSec` row is the interesting one: no assertion fires, because no weapon sets
 * the field and nothing in the catalog can therefore see it — the `Record<keyof …>` type is
 * what catches it, before a test ever runs. That is exactly the shape of the `piercing`
 * bug, and it is the reason the schema direction is a type and not a test.
 *
 * The survivor is recorded rather than hidden, and then closed by its own named case
 * below: every authored speed in the catalog is a whole grid/s, and `n · 33` is exact for
 * integer n, so truncation vs rounding changes no shipped number at all. A test built only
 * from real content provably cannot see it — which is the argument for the one assertion
 * in this file that calls a converter directly instead of reading a weapon.
 *
 * Not re-tested here (already owned elsewhere, deliberately not duplicated):
 * `swingTicks`'s [1, cooldown] clamp (`systems/meleeWindow.test.ts`), the rarity quality
 * edge's own arithmetic (`balance/rarity.test.ts`), and every field's runtime BEHAVIOUR
 * once converted (`systems/rangedCatalog.test.ts` — the sibling sweep that fires each
 * weapon and watches its own numbers move).
 */
import { describe, it, expect } from 'vitest';
import { MOB_WEAPON_IDS, WEAPON_SPECS, WEAPON_SIM_BY_ID, toSimSpec } from './weapons';
import type { MeleeSpec, RangedSpec, WeaponSpec } from './weaponTypes';
import type { MeleeSimSpec, RangedSimSpec } from '../state/entities';
import { toTicks, toFpGrid, toFpPerTick } from './convert';
import { degToBrad } from '../math/trig';
import { TICK_RATE } from '../math/fixed';
import { applyQuality } from '../balance/rarity';

// ── The landing table ─────────────────────────────────────────────────────────

interface Landing<S> {
  /** Sim-spec key this authored field lands on. `null` = deliberately never converted. */
  readonly sim: string | null;
  /** Expected sim value, given the authored spec. Called only when the field IS set. */
  readonly convert?: (spec: S) => unknown;
  /** Expected sim value when the authored field is ABSENT. Omit for required fields. */
  readonly whenUnset?: unknown;
  /** Required when `sim` is null: why this field never reaches the sim. */
  readonly why?: string;
}

/**
 * `skinRef`'s landing is `null` for a reason worth stating once: the render layer does
 * NOT read it. `client/src/render/weaponSkins.ts` is keyed by weapon id, and
 * `muzzleParity.test.ts` asserts every `WEAPON_SPECS` id resolves to its OWN entry there,
 * never a kind default — so the view already swaps by id, and `skinRef` is a second,
 * unread name for the same thing. See the standing-drift test at the bottom of this file.
 */
const SKIN_REF_LANDING: Landing<WeaponSpec> = {
  sim: null,
  why: 'render resolves the skin by weapon id (weaponSkins.ts); nothing reads skinRef',
};

const RANGED_LANDINGS: Record<keyof RangedSpec, Landing<RangedSpec>> = {
  // — shared (WeaponBase) —
  id: { sim: 'name', convert: (s) => s.id },
  nameKey: { sim: 'nameKey', convert: (s) => s.nameKey },
  skinRef: SKIN_REF_LANDING,
  rarity: { sim: 'rarity', convert: (s) => s.rarity },
  kind: { sim: 'kind', convert: () => 'ranged' },
  cooldownSec: { sim: 'fireRateTicks', convert: (s) => toTicks(s.cooldownSec) },
  lifestealPermille: { sim: 'lifestealPermille', convert: (s) => s.lifestealPermille, whenUnset: undefined },
  // — emission —
  bullets: { sim: 'bullets', convert: (s) => s.bullets },
  spreadDeg: { sim: 'spreadHalf', convert: (s) => degToBrad(s.spreadDeg / 2) },
  pattern: { sim: 'pattern', convert: (s) => s.pattern, whenUnset: 'spread' },
  // — projectile payload —
  bulletSpeed: { sim: 'bulletSpeed', convert: (s) => toFpPerTick(s.bulletSpeed) },
  damage: { sim: 'damage', convert: (s) => applyQuality(s.damage, s.rarity) },
  damageType: { sim: 'damageType', convert: (s) => s.damageType, whenUnset: 'physical' },
  lifespanSec: { sim: 'bulletLifeTicks', convert: (s) => toTicks(s.lifespanSec) },
  bulletRadius: { sim: 'bulletRadius', convert: (s) => toFpGrid(s.bulletRadius) },
  muzzleGrid: { sim: 'muzzleOffset', convert: (s) => toFpGrid(s.muzzleGrid) },
  bulletZ: { sim: 'bulletZ', convert: (s) => toFpGrid(s.bulletZ) },
  // — ballistic + its per-shape params —
  ballistic: { sim: 'ballistic', convert: (s) => s.ballistic },
  turnRateDegPerSec: {
    sim: 'turnRateBrad',
    convert: (s) => degToBrad(s.turnRateDegPerSec! / TICK_RATE),
    whenUnset: undefined,
  },
  blastRadiusGrid: { sim: 'blastRadius', convert: (s) => toFpGrid(s.blastRadiusGrid!), whenUnset: undefined },
  returnAfterSec: { sim: 'returnAfterTicks', convert: (s) => toTicks(s.returnAfterSec!), whenUnset: undefined },
  beamSec: { sim: 'beamTicks', convert: (s) => toTicks(s.beamSec!), whenUnset: undefined },
  beamTickIntervalSec: { sim: 'beamTickInterval', convert: (s) => toTicks(s.beamTickIntervalSec!), whenUnset: undefined },
  beamRangeGrid: { sim: 'beamRange', convert: (s) => toFpGrid(s.beamRangeGrid!), whenUnset: undefined },
  orbitRadiusGrid: { sim: 'orbitRadius', convert: (s) => toFpGrid(s.orbitRadiusGrid!), whenUnset: undefined },
  orbitPeriodSec: {
    sim: 'orbitAngularVelBrad',
    // A full revolution is 65536 brad over (periodSec · TICK_RATE) ticks.
    convert: (s) => Math.round(65536 / (s.orbitPeriodSec! * TICK_RATE)),
    whenUnset: undefined,
  },
  // — the ammo economy (design/03/05, ENGINE_VERSION 59) —
  // The one authored field that crosses unchanged: already an integer in pool units,
  // and deliberately NOT run through `applyQuality` — see toSimSpec's own comment.
  energyCost: { sim: 'energyCost', convert: (s) => s.energyCost },
  // — on-hit procs —
  piercing: { sim: 'piercing', convert: (s) => s.piercing, whenUnset: false },
  ricochetCount: { sim: 'ricochetCount', convert: (s) => s.ricochetCount, whenUnset: undefined },
};

const MELEE_LANDINGS: Record<keyof MeleeSpec, Landing<MeleeSpec>> = {
  // — shared (WeaponBase) —
  id: { sim: 'name', convert: (s) => s.id },
  nameKey: { sim: 'nameKey', convert: (s) => s.nameKey },
  skinRef: SKIN_REF_LANDING,
  rarity: { sim: 'rarity', convert: (s) => s.rarity },
  kind: { sim: 'kind', convert: () => 'melee' },
  cooldownSec: { sim: 'swingCooldownTicks', convert: (s) => toTicks(s.cooldownSec) },
  lifestealPermille: { sim: 'lifestealPermille', convert: (s) => s.lifestealPermille, whenUnset: undefined },
  // — swing shape (design/03's third melee axis) —
  damage: { sim: 'damage', convert: (s) => applyQuality(s.damage, s.rarity) },
  damageType: { sim: 'damageType', convert: (s) => s.damageType, whenUnset: 'physical' },
  arcDeg: { sim: 'arcHalf', convert: (s) => degToBrad(s.arcDeg / 2) },
  rangeGrid: { sim: 'range', convert: (s) => toFpGrid(s.rangeGrid) },
  // Clamped into [1, cooldown] — the clamp itself is meleeWindow.test.ts's; every shipped
  // weapon authors a window well inside that range, so the raw formula is what lands here.
  swingSec: { sim: 'swingTicks', convert: (s) => toTicks(s.swingSec) },
  knockback: { sim: 'knockback', convert: (s) => toFpPerTick(s.knockback) },
  deflect: { sim: 'deflect', convert: (s) => s.deflect },
  deflectSpeed: { sim: 'deflectSpeed', convert: (s) => toFpPerTick(s.deflectSpeed) },
};

/**
 * Schema fields declared on `weaponTypes.ts` that NO shipped weapon sets — so the
 * authored→sim sweeps below never see them, and their landing line is unverified by
 * content. Pinned as a set rather than skipped silently, because "declared, wired, and
 * used by nothing" is exactly the state `piercing` was in for a whole stage.
 *
 * `piercing`: `HitResolveSystem` honours it and `systems/procs.test.ts` proves the
 * mechanic on a synthetic bullet, but no weapon in `WEAPON_SPECS` turns it on — `carom`
 * deliberately took ricochet instead (see its comment in `weaponSpecs/frameLibrary.ts`),
 * and nothing else claimed it. It ships dead. When a weapon finally sets it, delete the
 * entry here; when a NEW field lands in this state, this test says so on the day it does.
 */
const UNUSED_BY_CONTENT = new Set(['piercing']);

// ── Catalog helpers ───────────────────────────────────────────────────────────

const ALL = Object.entries(WEAPON_SPECS);
const RANGED = ALL.filter((e): e is [string, RangedSpec] => e[1].kind === 'ranged');
const MELEE = ALL.filter((e): e is [string, MeleeSpec] => e[1].kind === 'melee');

/** Every authored key set by at least one weapon of this kind. */
function authoredKeys(entries: readonly (readonly [string, WeaponSpec])[]): Set<string> {
  const keys = new Set<string>();
  for (const [, spec] of entries) for (const k of Object.keys(spec)) keys.add(k);
  return keys;
}

describe('the landing table is closed against the SCHEMA (schema → table)', () => {
  /**
   * This direction is enforced by the COMPILER, not by an assertion: the two tables above
   * are declared `Record<keyof RangedSpec, …>` / `Record<keyof MeleeSpec, …>`, so a field
   * added to `weaponTypes.ts` without a landing line is a `tsc --noEmit` error ("Property
   * 'x' is missing"), and a landing naming a field the schema does not have is one too.
   *
   * Deliberately not a source scan. The obvious implementation — read `weaponTypes.ts` and
   * regex its interface bodies — needs `node:fs`, and `engine/tsconfig.json` withholds node
   * AND DOM types from this package on purpose (the sim core's determinism guarantee: it
   * may resolve only itself). Reaching for `readFileSync` here to test the schema would
   * have meant widening that boundary to write a weaker version of what the type system
   * already does for free.
   *
   * The runtime checks left in this block are the ones a type cannot make: that the tables
   * are non-trivially populated, and that a landing's own fields are internally consistent.
   */
  it('both tables are populated — a type error cannot tell you a table is EMPTY', () => {
    expect(Object.keys(RANGED_LANDINGS).length).toBeGreaterThanOrEqual(26);
    expect(Object.keys(MELEE_LANDINGS).length).toBeGreaterThanOrEqual(15);
  });

  it('every landing either names a sim key with a formula, or is a declared non-landing', () => {
    for (const [kind, table] of [['ranged', RANGED_LANDINGS], ['melee', MELEE_LANDINGS]] as const) {
      for (const [field, landing] of Object.entries(table)) {
        if (landing.sim === null) expect(landing.why, `${kind}.${field}`).toBeTruthy();
        else expect(typeof landing.convert, `${kind}.${field} has no convert()`).toBe('function');
      }
    }
  });
});

describe('the landing table is closed against the catalog (authored → table)', () => {
  it('every key a shipped RANGED weapon sets is in the table', () => {
    expect([...authoredKeys(RANGED)].filter((k) => !(k in RANGED_LANDINGS))).toEqual([]);
  });

  it('every key a shipped MELEE weapon sets is in the table', () => {
    expect([...authoredKeys(MELEE)].filter((k) => !(k in MELEE_LANDINGS))).toEqual([]);
  });

  it('the fields no shipped weapon sets are exactly the declared UNUSED_BY_CONTENT set', () => {
    const setByContent = new Set([...authoredKeys(RANGED), ...authoredKeys(MELEE)]);
    const declared = new Set([...Object.keys(RANGED_LANDINGS), ...Object.keys(MELEE_LANDINGS)]);
    const unused = [...declared].filter((k) => !setByContent.has(k)).sort();
    expect(unused).toEqual([...UNUSED_BY_CONTENT].sort());
  });
});

describe('the landing table is closed against the converter (table → sim)', () => {
  it('every key toSimSpec emits for a ranged weapon is claimed by a landing', () => {
    const emitted = new Set<string>();
    for (const [, spec] of RANGED) for (const k of Object.keys(toSimSpec(spec))) emitted.add(k);
    const claimed = new Set(Object.values(RANGED_LANDINGS).map((l) => l.sim).filter((s): s is string => s !== null));
    expect([...emitted].filter((k) => !claimed.has(k)).sort()).toEqual([]);
    // …and every claimed key is really emitted, so a landing can't name a sim field that
    // does not exist (which would make its `convert` assertion below unreachable).
    expect([...claimed].filter((k) => !emitted.has(k)).sort()).toEqual([]);
  });

  it('every key toSimSpec emits for a melee weapon is claimed by a landing', () => {
    const emitted = new Set<string>();
    for (const [, spec] of MELEE) for (const k of Object.keys(toSimSpec(spec))) emitted.add(k);
    const claimed = new Set(Object.values(MELEE_LANDINGS).map((l) => l.sim).filter((s): s is string => s !== null));
    expect([...emitted].filter((k) => !claimed.has(k)).sort()).toEqual([]);
    expect([...claimed].filter((k) => !emitted.has(k)).sort()).toEqual([]);
  });

  it('a null landing carries its reason, and names a key the sim really does NOT have', () => {
    for (const [kind, table] of [['ranged', RANGED_LANDINGS], ['melee', MELEE_LANDINGS]] as const) {
      const nulls = Object.entries(table).filter(([, l]) => l.sim === null);
      expect(nulls.length, `${kind} has no deliberately-unconverted field`).toBeGreaterThan(0);
      for (const [field, landing] of nulls) {
        expect(landing.why, `${kind}.${field} must say why it never converts`).toBeTruthy();
        const sample = (kind === 'ranged' ? RANGED : MELEE)[0]![1];
        expect(Object.keys(toSimSpec(sample))).not.toContain(field);
      }
    }
  });
});

// ── The sweep the whole table exists for ──────────────────────────────────────

/**
 * Every weapon × every authored field it sets: the value LANDS, by the declared formula,
 * and is never `undefined`. This is the assertion `piercing` / `ricochetCount` / `swingSec`
 * each failed for stages at a time.
 */
describe('every authored field on every shipped weapon reaches the sim spec', () => {
  it.each(RANGED.map(([id]) => id))('ranged: %s', (id) => {
    const spec = WEAPON_SPECS[id] as RangedSpec;
    const sim = toSimSpec(spec) as unknown as Record<string, unknown>;
    let checked = 0;
    for (const [field, landing] of Object.entries(RANGED_LANDINGS)) {
      if (landing.sim === null) continue;
      const authored = (spec as unknown as Record<string, unknown>)[field];
      if (authored === undefined) {
        expect(sim[landing.sim], `${id}.${field} unset → ${landing.sim}`).toBe(landing.whenUnset);
        continue;
      }
      expect(sim[landing.sim], `${id}.${field} → ${landing.sim} must not be dropped`).not.toBeUndefined();
      expect(sim[landing.sim], `${id}.${field} → ${landing.sim}`).toBe(landing.convert!(spec));
      checked++;
    }
    // The sweep is only worth its runtime if it actually visited fields (design/18: a
    // sweep that asserts nothing because its filter matched nothing is a green no-op).
    expect(checked, `${id} landed no authored field at all`).toBeGreaterThanOrEqual(14);
  });

  it.each(MELEE.map(([id]) => id))('melee: %s', (id) => {
    const spec = WEAPON_SPECS[id] as MeleeSpec;
    const sim = toSimSpec(spec) as unknown as Record<string, unknown>;
    let checked = 0;
    for (const [field, landing] of Object.entries(MELEE_LANDINGS)) {
      if (landing.sim === null) continue;
      const authored = (spec as unknown as Record<string, unknown>)[field];
      if (authored === undefined) {
        expect(sim[landing.sim], `${id}.${field} unset → ${landing.sim}`).toBe(landing.whenUnset);
        continue;
      }
      expect(sim[landing.sim], `${id}.${field} → ${landing.sim} must not be dropped`).not.toBeUndefined();
      expect(sim[landing.sim], `${id}.${field} → ${landing.sim}`).toBe(landing.convert!(spec));
      checked++;
    }
    expect(checked, `${id} landed no authored field at all`).toBeGreaterThanOrEqual(12);
  });

  it('the optional ballistic params of the OTHER shapes stay absent (only its own land)', () => {
    // The converter sets every param unconditionally from its authored field, so a weapon
    // gets a foreign shape's param the moment someone authors one by accident. Sweeping
    // this here (rather than only on the projectile, systems/rangedCatalog.test.ts) pins
    // it at the spec, which is what `WeaponFireSystem` copies from.
    const BY_SHAPE: Record<string, readonly string[]> = {
      straight: [],
      homing: ['turnRateBrad'],
      lob: ['blastRadius'],
      boomerang: ['returnAfterTicks'],
      beam: ['beamTicks', 'beamTickInterval', 'beamRange'],
      orbit: ['orbitRadius', 'orbitAngularVelBrad'],
    };
    const every = Object.values(BY_SHAPE).flat();
    for (const [id, spec] of RANGED) {
      const sim = toSimSpec(spec) as unknown as Record<string, unknown>;
      const own = BY_SHAPE[spec.ballistic]!;
      for (const param of every) {
        if (own.includes(param)) expect(sim[param], `${id} (${spec.ballistic}) needs ${param}`).not.toBeUndefined();
        else expect(sim[param], `${id} (${spec.ballistic}) must not carry ${param}`).toBeUndefined();
      }
    }
  });
});

// ── The formulas themselves, on real content, hand-checked ────────────────────

/**
 * The sweep above compares `toSimSpec`'s output against the same helper calls the
 * converter makes, so it proves the field ARRIVES but not that the formula is right — a
 * `toTicks` that returned `sec * 30` unrounded would satisfy both sides. These pin the
 * design/09 conversion table itself, on shipped numbers, with the arithmetic written out.
 */
describe('design/09 conversion arithmetic, pinned on real weapons', () => {
  const blaster = WEAPON_SIM_BY_ID.blaster as RangedSimSpec;
  const saber = WEAPON_SIM_BY_ID.saber as MeleeSimSpec;

  it('toTicks(sec) = round(sec · 30)', () => {
    expect(blaster.fireRateTicks).toBe(6); // 0.2 s  · 30 = 6
    expect(blaster.bulletLifeTicks).toBe(90); // 3.0 s · 30 = 90
    expect(saber.swingCooldownTicks).toBe(11); // 0.37 s · 30 = 11.1 → 11
    expect(saber.swingTicks).toBe(4); // 0.13 s · 30 = 3.9 → 4
  });

  it('toFpGrid(grid) = round(grid · 1000)', () => {
    expect(blaster.bulletRadius).toBe(150); // 0.15 grid
    expect(blaster.bulletZ).toBe(500); // 0.5 grid
    expect(blaster.muzzleOffset).toBe(938); // 0.9375 grid → 937.5 → 938
    expect(saber.range).toBe(1440); // 1.44 grid
  });

  it('toFpPerTick(grid/s) = ⌊round(g/s · 1000) · 33 / 1000⌋', () => {
    expect(blaster.bulletSpeed).toBe(330); // 10 g/s → 10000 fp/s → ⌊330.0⌋
    expect(saber.knockback).toBe(198); // 6 g/s → 6000 → ⌊198.0⌋
    expect(saber.deflectSpeed).toBe(475); // 14.4 g/s → 14400 → ⌊475.2⌋
  });

  it('…and it TRUNCATES, which no shipped weapon can tell you (mutant M7)', () => {
    // Every authored speed/knockback in the catalog is a whole grid/s (or 14.4, whose
    // 475.2 rounds down anyway), and `n · 1000 · 33 / 1000 = n · 33` is exact for an
    // integer n — so swapping `Math.trunc` for `Math.round` in `toFpPerTick` changes NOT
    // ONE shipped number, and the pins above cannot see it. It is still a replay-affecting
    // rule (design/09: the truncated dt is what makes a baked-in velocity match a
    // dt-multiplied one bit-for-bit), so it is asserted on the helper directly, at a value
    // that discriminates.
    expect(toFpPerTick(14.5)).toBe(478); // 14500 · 33 / 1000 = 478.5 → ⌊⌋ = 478, not 479
    expect(toFpGrid(0.9375)).toBe(938); // toFpGrid, by contrast, ROUNDS: 937.5 → 938
  });

  it('degToBrad(deg) = round(deg / 360 · 65536), applied to HALF the authored cone/arc', () => {
    expect(saber.arcHalf).toBe(14746); // 162° / 2 = 81° → 81/360·65536 = 14745.6 → 14746
    const scattergun = WEAPON_SIM_BY_ID.scattergun as RangedSimSpec;
    expect(scattergun.spreadHalf).toBe(2549); // 28° / 2 = 14° → 14/360·65536 = 2548.6 → 2549
    expect(blaster.spreadHalf).toBe(0); // pinpoint stays pinpoint
  });

  it('homing turn rate converts per TICK, not per second', () => {
    const seeker = WEAPON_SIM_BY_ID.seeker as RangedSimSpec;
    // 260 °/s ÷ 30 ticks = 8.6̅ °/tick → 8.6̅/360·65536 = 1577.8 → 1578.
    expect(seeker.turnRateBrad).toBe(1578);
  });

  it('orbit period converts to brad-per-tick: 65536 / (periodSec · 30)', () => {
    const gyre = WEAPON_SIM_BY_ID.gyre as RangedSimSpec;
    expect(gyre.orbitAngularVelBrad).toBe(2185); // 1.0 s → 65536/30 = 2184.53 → 2185
  });

  it('the beam channel converts to a whole number of damage ticks', () => {
    const laser = WEAPON_SIM_BY_ID.lasercutter as RangedSimSpec;
    expect(laser.beamTicks).toBe(12); // 0.4 s
    expect(laser.beamTickInterval).toBe(3); // 0.1 s
    expect(laser.beamRange).toBe(3500); // 3.5 grid
    expect(laser.beamTicks! / laser.beamTickInterval!).toBe(4); // 4 applications per channel
  });
});

// ── The map, and the convert-once rule it enforces ────────────────────────────

describe('WEAPON_SIM_BY_ID — one conversion per weapon, at load (design/09 load-once)', () => {
  it('covers every authored weapon except the mob loadouts', () => {
    expect(Object.keys(WEAPON_SIM_BY_ID).sort()).toEqual(
      Object.keys(WEAPON_SPECS).filter((id) => !MOB_WEAPON_IDS.includes(id)).sort(),
    );
    // The exclusion has teeth only if the excluded ids are really authored — an id that
    // never existed would be filtered out of both sides and prove nothing.
    for (const id of MOB_WEAPON_IDS) {
      expect(WEAPON_SPECS[id], `${id} is still authored, just not player-facing`).toBeDefined();
      expect(WEAPON_SIM_BY_ID[id], `${id} must not be reachable as a drop`).toBeUndefined();
    }
    // Named explicitly so ADDING a mob loadout is a decision that shows up in this diff,
    // rather than one the filter absorbs silently (ENGINE_VERSION 59 added two, v70 a third).
    expect([...MOB_WEAPON_IDS].sort()).toEqual(['enemyclaw', 'enemygun', 'enemymaul', 'enemynova']);
  });

  it('hands out the SAME object every time — conversion is not re-run per lookup', () => {
    expect(WEAPON_SIM_BY_ID.blaster).toBe(WEAPON_SIM_BY_ID.blaster);
    // …and a fresh conversion is a DIFFERENT object with equal contents, which is what
    // makes the identity above meaningful rather than trivially true.
    const fresh = toSimSpec(WEAPON_SPECS.blaster!);
    expect(fresh).not.toBe(WEAPON_SIM_BY_ID.blaster);
    expect(fresh).toEqual(WEAPON_SIM_BY_ID.blaster);
  });

  it('every sim spec keeps its authored id as `name`, so a drop id resolves both ways', () => {
    for (const [id, sim] of Object.entries(WEAPON_SIM_BY_ID)) expect(sim.name).toBe(id);
  });
});

describe('skinRef is authored on every weapon and read by nothing (standing drift check)', () => {
  it('is set on all of them — so the dead-field finding is about consumers, not coverage', () => {
    const missing = ALL.filter(([, s]) => !s.skinRef).map(([id]) => id);
    expect(missing).toEqual([]);
  });

  it('takes exactly two values, both of which are kind defaults rather than per-weapon skins', () => {
    // The tell that it is vestigial: 25 weapons share 2 values, one per `kind`. A field the
    // view actually swapped on would vary per weapon the way `weaponSkins.ts` (keyed by id)
    // does. If a real per-weapon skin system ever lands on this field, this test fails and
    // the `SKIN_REF_LANDING` comment above needs rewriting.
    const byKind = new Map<string, Set<string>>();
    for (const [, s] of ALL) byKind.set(s.kind, (byKind.get(s.kind) ?? new Set()).add(s.skinRef));
    expect([...byKind.get('ranged')!]).toEqual(['gun_default']);
    expect([...byKind.get('melee')!]).toEqual(['sword_default']);
  });
});
