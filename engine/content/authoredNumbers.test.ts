/**
 * The repo-wide half of the rule `skins.test.ts` states per character: **a design number
 * is a whole number.** Fixed point (`math/fixed.ts`) is how the SIM carries a sub-unit
 * quantity — a position, a velocity, an angle — and it is deliberately invisible to
 * content: authoring is in human units and converts ONCE (design/09). What must never
 * happen is the reverse direction, a fraction leaking OUT of the arithmetic and into a
 * number a player reads.
 *
 * It happened once, and the roster-only gate is why it lasted: `vanguard.maxShield`
 * shipped as `3.2` for two months (ENGINE_VERSION 67 has the account) because the PvP
 * pair was derived as `Math.round(pool × PVP_SCALE_FACTOR)` and 16/5 is 3.2. It was
 * reported from a screenshot of the character screen, which is the slowest and least
 * reliable detector available. Nothing in the tree would have caught the same mistake on
 * an enemy's `maxHp`, a weapon's `damage`, a drop amount or a blueprint cost, so this
 * sweeps the whole content surface rather than the one table that has already been fixed.
 *
 * ## What the exception list is, and why it is by NAME
 *
 * `SkinDef.shieldBreak.radiusGrid: 2.5` is the only fractional number in the swept
 * catalogs, and it is not a design number in this sense: it is a GRID LENGTH, an authored
 * human-unit input that `toShieldBreakSim` converts to fp the moment anything reads it.
 * Half a grid cell is a legitimate distance in a way that 0.2 of a shield point is not.
 *
 * So the exception is keyed on the field's NAME (the unit suffix this codebase already
 * uses consistently — `radiusGrid`, `speedGridPerSec`, `cooldownSec`), never on its value
 * or its path. That direction matters: a fractional `damage`, `maxHp`, `maxShield`, `cost`
 * or `amount` cannot become legal by being added somewhere new, and a genuinely new
 * human-unit field announces itself in its own name. A fraction in a field whose name
 * claims to be sim-side is a convert-once violation and fails here too.
 */
import { describe, it, expect } from 'vitest';
import { WEAPON_SIM_BY_ID } from './weapons';
import { ENEMY_BLUEPRINTS } from './enemies';
import { PLAYER_BASE } from './players';
import { SKIN_DEFS } from './skins';
import { DROP_TABLE } from './drops';
import { BLUEPRINT_CATALOG } from './blueprints';

/**
 * Field-name suffixes that mark an authored HUMAN-UNIT input (design/09 convert-once).
 * These may be fractional; everything else may not.
 */
const HUMAN_UNIT_SUFFIX = /(Grid|GridPerSec|PerSec|Sec|Deg|Px)$/;
/** `bulletZ` is a height in grid cells — the one human-unit field with no unit suffix. */
const HUMAN_UNIT_FIELD = new Set(['bulletZ']);

function isHumanUnit(key: string): boolean {
  return HUMAN_UNIT_FIELD.has(key) || HUMAN_UNIT_SUFFIX.test(key);
}

interface Sweep {
  fractions: string[];
  numbersSeen: number;
  humanUnitFieldsSeen: number;
}

function sweep(root: unknown, rootName: string): Sweep {
  const out: Sweep = { fractions: [], numbersSeen: 0, humanUnitFieldsSeen: 0 };
  const walk = (v: unknown, path: string, key: string): void => {
    if (typeof v === 'number') {
      out.numbersSeen++;
      if (isHumanUnit(key)) {
        out.humanUnitFieldsSeen++;
        return;
      }
      if (!Number.isInteger(v)) out.fractions.push(`${path} = ${v}`);
      return;
    }
    if (Array.isArray(v)) {
      // An array element inherits its ARRAY's key: `radiiGrid: [1.5, 2]` is still grid.
      v.forEach((item, i) => walk(item, `${path}[${i}]`, key));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) walk(item, `${path}.${k}`, k);
    }
  };
  walk(root, rootName, rootName);
  return out;
}

const CATALOGS: readonly { name: string; value: unknown }[] = [
  { name: 'SKIN_DEFS', value: SKIN_DEFS },
  { name: 'ENEMY_BLUEPRINTS', value: ENEMY_BLUEPRINTS },
  { name: 'WEAPON_SIM_BY_ID', value: WEAPON_SIM_BY_ID },
  { name: 'PLAYER_BASE', value: PLAYER_BASE },
  { name: 'DROP_TABLE', value: DROP_TABLE },
  { name: 'BLUEPRINT_CATALOG', value: BLUEPRINT_CATALOG },
];

describe('authored content numbers (design/09) — a design number is a whole number', () => {
  it.each(CATALOGS.map((c) => c.name))('%s carries no fractional design number', (name) => {
    const catalog = CATALOGS.find((c) => c.name === name)!;
    const { fractions } = sweep(catalog.value, name);
    expect(fractions).toEqual([]);
  });

  // Anti-vacuity, both directions. A sweep over an empty catalog, or one whose every field
  // happened to be named `...Grid`, would report no fractions just as loudly.
  it('the sweep has real subjects — it is looking at numbers, and gated ones', () => {
    const totals = CATALOGS.map((c) => sweep(c.value, c.name));
    for (const [i, t] of totals.entries()) {
      expect(t.numbersSeen, `${CATALOGS[i]!.name} contributed no numbers`).toBeGreaterThan(0);
    }
    const gated = totals.reduce((n, t) => n + (t.numbersSeen - t.humanUnitFieldsSeen), 0);
    expect(gated, 'every number swept was exempt — the rule is inert').toBeGreaterThan(200);
  });

  /**
   * The exception's own control. `radiusGrid: 2.5` is the one fraction the rule allows, and
   * an exception nothing exercises is indistinguishable from a rule with a typo in it: if
   * that field were renamed, or the suffix pattern stopped matching, every test above would
   * stay green while the allowance silently became dead code.
   */
  it('the human-unit exception is live — a real fractional grid length rides it', () => {
    const exempted = CATALOGS.flatMap((c) => {
      const before = sweep(c.value, c.name);
      return before.humanUnitFieldsSeen > 0 ? [c.name] : [];
    });
    expect(exempted.length, 'no catalog has a human-unit field at all').toBeGreaterThan(0);
    const vanguardBreak = SKIN_DEFS['vanguard']!.shieldBreak;
    expect(vanguardBreak?.kind).toBe('aoe');
    expect(Number.isInteger(vanguardBreak!.radiusGrid)).toBe(false); // the live subject
    expect(isHumanUnit('radiusGrid')).toBe(true);
    // …and the exception is keyed on the name, not on "it's a radius" or "it's small":
    // the same value under a sim-side name is still a failure.
    expect(isHumanUnit('radius')).toBe(false);
    expect(isHumanUnit('maxShield')).toBe(false);
    expect(isHumanUnit('damage')).toBe(false);
  });
});
