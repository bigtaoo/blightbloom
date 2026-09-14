import { describe, it, expect } from 'vitest';
import { Prng } from '@dd/engine/math/prng';
import {
  rollDrop,
  DROP_TABLE,
  ARENA_DROP_TABLE,
  WEAPON_DROP_POOL,
  BUFF_DROP_POOL,
  CARD_ONLY_BUFF_IDS,
  HEAL_DROP_MULT_CAP,
} from '@dd/engine/content/drops';
import { COIN_DROP_QTY } from '@dd/engine/config';
import { WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { RUN_BUFFS } from '@dd/engine/balance/runbuffs';
import { MATERIAL_DEFS, MATERIAL_DROP_POOL } from '@dd/engine/content/materials';

describe('rollDrop — deterministic drop table', () => {
  it('is reproducible from the same seed', () => {
    const a = new Prng(1234);
    const b = new Prng(1234);
    for (let i = 0; i < 100; i++) {
      expect(rollDrop(a)).toEqual(rollDrop(b));
    }
  });

  it('diverges on a different seed', () => {
    const s1 = new Prng(1);
    const s2 = new Prng(2);
    const a = Array.from({ length: 50 }, () => rollDrop(s1));
    const b = Array.from({ length: 50 }, () => rollDrop(s2));
    expect(a).not.toEqual(b);
  });

  it('only ever yields kinds in the table', () => {
    const kinds = new Set(DROP_TABLE.map((e) => e.kind));
    const p = new Prng(99);
    for (let i = 0; i < 500; i++) expect(kinds.has(rollDrop(p).kind)).toBe(true);
  });

  it('weapon drops resolve to a real, player-facing weapon spec', () => {
    const p = new Prng(7);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'weapon') {
        expect(WEAPON_DROP_POOL).toContain(d.weaponId);
        expect(WEAPON_SIM_BY_ID[d.weaponId]).toBeDefined();
      }
    }
  });

  it('buff drops resolve to a real buff id in the catalogue', () => {
    const p = new Prng(11);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'buff') {
        expect(BUFF_DROP_POOL).toContain(d.buffId);
        expect(RUN_BUFFS[d.buffId]).toBeDefined();
      }
    }
  });

  it('every buff in the drop pool exists in the catalogue', () => {
    for (const id of BUFF_DROP_POOL) expect(RUN_BUFFS[id]).toBeDefined();
  });

  // The partition that keeps a NEW buff family from being stranded (ENGINE_VERSION 60).
  // `cell_up` is deliberately undroppable — see `CARD_ONLY_BUFF_IDS` for why — but
  // "deliberately undroppable" and "somebody forgot to add it to the pool" look identical
  // from outside, and the second one ships a buff no player can ever obtain. Requiring
  // every catalogue id to be in exactly ONE of the two lists makes the difference a
  // decision somebody has to write down.
  it('every buff in the catalogue is either droppable or explicitly card-only, never neither', () => {
    for (const id of Object.keys(RUN_BUFFS)) {
      const droppable = BUFF_DROP_POOL.includes(id);
      const cardOnly = CARD_ONLY_BUFF_IDS.includes(id);
      expect(droppable || cardOnly, `${id} is reachable from nothing`).toBe(true);
      expect(droppable && cardOnly, `${id} is listed as both droppable and card-only`).toBe(false);
    }
  });

  it('a card-only buff never comes off the drop table, however long the stream runs', () => {
    // Asserted over a real sweep rather than by re-reading `BUFF_DROP_POOL` (which would
    // only restate the line above): this is the claim that the ROLL, not just the list,
    // excludes it.
    const p = new Prng(4242);
    let buffDrops = 0;
    for (let i = 0; i < 20000; i++) {
      const d = rollDrop(p);
      if (d.kind !== 'buff') continue;
      buffDrops++;
      expect(CARD_ONLY_BUFF_IDS).not.toContain(d.buffId);
    }
    expect(buffDrops, 'the sweep never rolled a buff at all').toBeGreaterThan(100);
  });

  it('names the card-only list by CONTENT, so emptying it is a decision and not a silent pass', () => {
    expect([...CARD_ONLY_BUFF_IDS]).toEqual(['cell_up']);
  });

  it('material drops resolve to a real material id + positive quantity', () => {
    const p = new Prng(13);
    for (let i = 0; i < 2000; i++) {
      const d = rollDrop(p);
      if (d.kind === 'material') {
        expect(MATERIAL_DROP_POOL).toContain(d.materialId);
        expect(MATERIAL_DEFS[d.materialId]).toBeDefined();
        expect(d.qty).toBeGreaterThan(0);
      }
    }
  });

  it('every material in the drop pool exists in the catalogue', () => {
    for (const id of MATERIAL_DROP_POOL) expect(MATERIAL_DEFS[id]).toBeDefined();
  });

  it('cinderscatter/frostseeker carry their frame + element (design/03 elemental-variant follow-up)', () => {
    expect(WEAPON_SIM_BY_ID.cinderscatter?.damageType).toBe('fire');
    expect(WEAPON_SIM_BY_ID.frostseeker?.damageType).toBe('ice');
    expect(WEAPON_DROP_POOL).toContain('cinderscatter');
    expect(WEAPON_DROP_POOL).toContain('frostseeker');
  });

  it('produces every kind over a large sample (material the most common)', () => {
    const counts: Record<string, number> = {};
    const p = new Prng(2024);
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const k = rollDrop(p).kind;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const e of DROP_TABLE) expect(counts[e.kind] ?? 0).toBeGreaterThan(0);
    // material has the highest weight → should be the modal drop.
    const material = counts.material ?? 0;
    for (const e of DROP_TABLE) {
      if (e.kind !== 'material') expect(material).toBeGreaterThan(counts[e.kind] ?? 0);
    }
  });
});

// ── The re-weighted table + DropOpts (design/05, ENGINE_VERSION 57) ────────────
//
// The weights below are a design decision, not an implementation detail, and before
// this block nothing in 1346 engine tests noticed when they moved: the heal weight
// went 18 -> 2 and every suite stayed green. These pin the two properties the
// 2026-09-05 loot pass actually promised — potions are rare, and weapons kept the
// odds they had — plus the two invariants the floor-card multiplier rests on.

/** A Prng stand-in that records the weight array it was asked to draw from and the
 *  number of draws it served, so the table can be asserted exactly instead of
 *  sampled. `pick` chooses which DROP_TABLE index `weightedIndex` returns. */
class RecordingPrng {
  readonly weightsSeen: number[][] = [];
  draws = 0;
  constructor(private readonly pick: number) {}
  weightedIndex(weights: readonly number[]): number {
    this.weightsSeen.push([...weights]);
    this.draws++;
    return this.pick;
  }
  nextInt(_max: number): number {
    this.draws++;
    return 0;
  }
}

/** Index of a kind in DROP_TABLE — the tests below name kinds, not positions. */
const entryIndex = (kind: string) => DROP_TABLE.findIndex((e) => e.kind === kind);

describe('drop weights — how much loot a kill actually produces', () => {
  it('makes a health potion RARE: about 2-3% of kills, not the 21% it used to be', () => {
    // Measured, not asserted from the table's own numbers — re-deriving the weights
    // here would make this pass no matter what `rollDrop` did with them.
    const p = new Prng(4242);
    const n = 20_000;
    let heals = 0;
    for (let i = 0; i < n; i++) if (rollDrop(p).kind === 'heal') heals++;
    const rate = heals / n;
    expect(rate).toBeGreaterThan(0.015);
    expect(rate).toBeLessThan(0.04); // the pre-v57 table sat at 0.214 — nowhere near this
  });

  it('produces coins at the rate the shop economy is priced against', () => {
    // This slot used to pin the WEAPON rate at 5/84, guarding the v57 claim that the
    // allowance changed the count and not the odds. Weapons left the table entirely on
    // 2026-09-14 and coins took their place, so the measurement worth keeping is the one
    // shop prices are set from: 20/84 = 23.8% of kills.
    //
    // A rate and not an exact weight, deliberately. Re-weighting this table against a real
    // sim run is expected work; what must not drift silently is the ORDER of magnitude the
    // prices in `content/shops.ts` were chosen against, which is what a band catches and an
    // equality assertion would merely restate.
    const p = new Prng(4242);
    const n = 20_000;
    let coins = 0;
    for (let i = 0; i < n; i++) if (rollDrop(p).kind === 'coin') coins++;
    expect(coins / n).toBeGreaterThan(0.21);
    expect(coins / n).toBeLessThan(0.27);
  });

  it('spends the heal multiplier out of MATERIAL, so the table total never moves', () => {
    // The invariant the floor card rests on: doubling potions must not quietly make
    // weapons rarer for a reason nothing on the card mentions.
    const base = new RecordingPrng(entryIndex('material'));
    rollDrop(base, 0, { healMult: 1 });
    const doubled = new RecordingPrng(entryIndex('material'));
    rollDrop(doubled, 0, { healMult: 2 });

    const w1 = base.weightsSeen[0]!;
    const w2 = doubled.weightsSeen[0]!;
    const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
    expect(sum(w2)).toBe(sum(w1));
    expect(w2[entryIndex('heal')]).toBe(w1[entryIndex('heal')]! * 2);
    expect(w2[entryIndex('weapon')]).toBe(w1[entryIndex('weapon')]);
    expect(w2[entryIndex('buff')]).toBe(w1[entryIndex('buff')]);
    expect(w2[entryIndex('material')]).toBe(w1[entryIndex('material')]! - w1[entryIndex('heal')]!);
  });

  it('clamps the heal multiplier to [1, HEAL_DROP_MULT_CAP] and rounds it', () => {
    const at = (healMult: number) => {
      const r = new RecordingPrng(entryIndex('material'));
      rollDrop(r, 0, { healMult });
      return r.weightsSeen[0]![entryIndex('heal')]!;
    };
    const base = at(1);
    expect(at(0)).toBe(base); // never REDUCES potions below the table's own floor
    expect(at(-5)).toBe(base);
    expect(at(2.4)).toBe(base * 2); // rounded — weightedIndex draws on integers only
    expect(at(1000)).toBe(base * HEAL_DROP_MULT_CAP);
    expect(at(HEAL_DROP_MULT_CAP)).toBe(base * HEAL_DROP_MULT_CAP);
  });
});

describe('coin — the shop economy\u2019s income', () => {
  it('pays the flat COIN_DROP_QTY, and spends exactly ONE dropPrng draw doing it', () => {
    // The draw count is the load-bearing half (design/06). A coin that rolled its own amount
    // would cost two draws where `heal` and `energy` cost one, so re-weighting between the
    // three \u2014 the most likely next tuning pass \u2014 would move every later drop in the run and
    // invalidate every recording. Pinned here so that change fails a test rather than a hash.
    const r = new RecordingPrng(entryIndex('coin'));
    const drop = rollDrop(r);
    expect(drop).toEqual({ kind: 'coin', qty: COIN_DROP_QTY });
    expect(r.draws).toBe(1);
  });

  it('costs the same number of draws as the other payload-free kinds', () => {
    const coin = new RecordingPrng(entryIndex('coin'));
    rollDrop(coin);
    for (const kind of ['heal', 'energy']) {
      const other = new RecordingPrng(entryIndex(kind));
      rollDrop(other);
      expect(other.draws).toBe(coin.draws);
    }
  });
});

describe('a kill cannot drop a weapon (2026-09-14)', () => {
  it('has no weapon entry on the PvE table at all', () => {
    // STRUCTURAL, not a zero weight: `weightedIndex` over a 0-weight entry is one
    // `nextInt` bound away from being reachable again by accident, and a zero that
    // nobody can see is exactly the shape of a "fix" that silently un-fixes itself.
    expect(DROP_TABLE.some((e) => e.kind === 'weapon')).toBe(false);
  });

  it('never returns a weapon for ANY index into the table', () => {
    // The assertion that survives a re-weight: it walks every entry rather than trusting
    // the one above to have enumerated them, so adding a weapon entry back fails here even
    // if someone updates the membership test to match.
    for (let i = 0; i < DROP_TABLE.length; i++) {
      expect(rollDrop(new RecordingPrng(i)).kind).not.toBe('weapon');
    }
  });

  it('leaves the ARENA table\u2019s weapons alone', () => {
    // The arena's loot pool IS its whole power curve (design/15) \u2014 it has no chest, no boss
    // and no shop to move weapons to, so the same deletion there would delete weapons rather
    // than relocate them. Asserted because "apply the change everywhere" is the obvious wrong
    // generalisation of this pass.
    expect(ARENA_DROP_TABLE.some((e) => e.kind === 'weapon')).toBe(true);
  });

  it('keeps coins OUT of the arena table, for the mirror-image reason', () => {
    expect(ARENA_DROP_TABLE.some((e) => (e.kind as string) === 'coin')).toBe(false);
  });
});
