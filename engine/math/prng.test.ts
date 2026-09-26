import { describe, it, expect } from 'vitest';
import { Prng, mix32 } from '@dd/engine/math/prng';

// First six `nextInt(1_000_000)` of `new Prng(12345)` as of engine v78.
const PINNED_12345 = [801372, 2804, 472196, 846805, 838136, 443029];

describe('Prng (deterministic LCG)', () => {
  it('same seed → identical sequence (replay foundation)', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    const seqA = Array.from({ length: 64 }, () => a.nextInt(1000));
    const seqB = Array.from({ length: 64 }, () => b.nextInt(1000));
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const seqA = Array.from({ length: 16 }, () => a.nextInt(1_000_000));
    const seqB = Array.from({ length: 16 }, () => b.nextInt(1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it('seed 0 is guarded (does not lock to 0)', () => {
    const p = new Prng(0);
    const vals = Array.from({ length: 8 }, () => p.nextInt(100));
    expect(vals.some((v) => v !== 0)).toBe(true);
  });

  it('nextInt stays in [0, max)', () => {
    const p = new Prng(777);
    for (let i = 0; i < 5000; i++) {
      const v = p.nextInt(37);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(37);
    }
  });

  it('weightedIndex respects weights and is deterministic', () => {
    const weights = [1, 0, 3]; // index 1 has zero weight → never chosen
    const counts = [0, 0, 0];
    const p = new Prng(42);
    for (let i = 0; i < 4000; i++) counts[p.weightedIndex(weights)]!++;
    expect(counts[1]).toBe(0);
    expect(counts[2]).toBeGreaterThan(counts[0]!); // 3:1 ratio
    // reproducible
    expect(new Prng(42).weightedIndex(weights)).toBe(new Prng(42).weightedIndex(weights));
  });

  it('shuffle is deterministic for a given seed', () => {
    const base = () => [0, 1, 2, 3, 4, 5, 6, 7];
    const s1 = new Prng(9).shuffle(base());
    const s2 = new Prng(9).shuffle(base());
    expect(s1).toEqual(s2);
    expect(s1.slice().sort((x, y) => x - y)).toEqual(base()); // permutation
  });

  it('pins the stream: a change here changes every seeded run, so it is an ENGINE_VERSION bump', () => {
    const p = new Prng(12345);
    expect(Array.from({ length: 6 }, () => p.nextInt(1_000_000))).toEqual(PINNED_12345);
  });
});

/**
 * The two defects the bare LCG had until engine v78 (2026-09-26). Each test here fails on
 * that LCG: `nextInt` reduced the raw state, whose low k bits cycle with period 2^k, and
 * nearby seeds gave correlated first draws.
 */
describe('Prng — every bit and every seed is usable', () => {
  const draws = (seed: number, n: number, max: number) => {
    const p = new Prng(seed);
    return Array.from({ length: n }, () => p.nextInt(max));
  };

  it('a coin flip does not alternate: repeats come up about half the time', () => {
    // The bare LCG's lowest bit alternated, so nextInt(2) read 0101... and repeated 0 times.
    const v = draws(12345, 4000, 2);
    let repeats = 0;
    for (let i = 1; i < v.length; i++) if (v[i] === v[i - 1]) repeats++;
    expect(repeats).toBeGreaterThan(1800); // ~2000 expected, sd ~32
    expect(repeats).toBeLessThan(2200);
  });

  it('nextInt(4) has no period of 4', () => {
    // The low two bits cycled with period 4, so v[i] === v[i+4] held every time.
    const v = draws(777, 4000, 4);
    let same = 0;
    for (let i = 4; i < v.length; i++) if (v[i] === v[i - 4]) same++;
    expect(same).toBeGreaterThan(850); // ~1000 expected, sd ~27
    expect(same).toBeLessThan(1150);
  });

  // Consecutive seeds, bare and XORed with a stream constant the way GameState derives its
  // streams (0x9c0d1e2f is SEED_DROP).
  const families = [
    ['consecutive', (i: number) => i],
    ['XORed with a stream constant', (i: number) => i ^ 0x9c0d1e2f],
  ] as const;

  it.each(families)('neighbouring %s seeds give unrelated first draws', (_label, seedOf) => {
    // For seeds i and i+1 the bare LCG's first raw values differed by the constant multiplier,
    // so their difference mod 1000 was the SAME residue 19993 times in 20000 (bare) and 18744
    // (XORed). Unrelated draws spread over all 1000 residues, ~20 each.
    const first = (seed: number) => new Prng(seed).nextInt(1000);
    const counts = new Map<number, number>();
    for (let i = 1; i <= 20_000; i++) {
      const d = (first(seedOf(i + 1)) - first(seedOf(i)) + 1000) % 1000;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    expect(counts.size).toBe(1000);
    expect(Math.max(...counts.values())).toBeLessThan(60);
  });

  it.each(families)('a one-in-a-hundred roll holds its rate on each early draw across %s seeds 1..6000', (_label, seedOf) => {
    // The window the bug was found in (the boss's 1% character drop read 0.35%): the bare LCG
    // hit 102 on the first draw (bare) and 20 on the second (XORed). The bias is local to a
    // window of seeds — over 1..20000 it averages out — so the window is the test.
    const hits = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i <= 6000; i++) {
      const p = new Prng(seedOf(i));
      for (let d = 0; d < hits.length; d++) if (p.nextInt(1000) < 10) hits[d]!++;
    }
    for (const h of hits) {
      expect(h).toBeGreaterThan(35); // 60 expected, sd ~7.7
      expect(h).toBeLessThan(95);
    }
  });
});

describe('Prng — shuffle and weightedIndex reach every outcome', () => {
  const orderOf = (p: Prng, n: number) => p.shuffle(Array.from({ length: n }, (_, i) => i)).join('');
  const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

  it.each([3, 4, 5])('shuffling %i items from one stream reaches all n! orders, evenly', (n) => {
    // The bare LCG's locked low bits reached 3 of 6 orders for three items, 12 of 24 for four
    // and 15 of 120 for five — within one stream, however long, so every shuffle in the engine
    // (room generation among them) drew from a fixed fraction of its orders.
    const p = new Prng(12345);
    const counts = new Map<string, number>();
    const perOrder = 400;
    const orders = factorial(n);
    for (let t = 0; t < perOrder * orders; t++) {
      const k = orderOf(p, n);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(orders);
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(perOrder * 0.75); // sd ~20 at 400
      expect(c).toBeLessThan(perOrder * 1.25);
    }
  });

  it('the first shuffle of a run reaches every order across consecutive seeds', () => {
    // The shape GameState uses: a fresh stream per seed, a shuffle among its first draws.
    // The bare LCG reached 12 of 24 orders here.
    const counts = new Map<string, number>();
    for (let seed = 1; seed <= 6000; seed++) {
      const k = orderOf(new Prng(seed), 4);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(175); // 250 expected, sd ~15
      expect(c).toBeLessThan(325);
    }
  });

  it('weightedIndex holds its weights on the first draw across consecutive seeds', () => {
    // Not a regression for the v78 bug (the bare LCG passed this too): it pins the weight-to-
    // index walk itself, which an off-by-one (`roll <= 0`) would double for index 0.
    const weights = [1, 2, 3];
    const counts = [0, 0, 0];
    for (let seed = 1; seed <= 6000; seed++) counts[new Prng(seed ^ 0x9c0d1e2f).weightedIndex(weights)]!++;
    // 1000 / 2000 / 3000 expected, sd at most ~39.
    expect(Math.abs(counts[0]! - 1000)).toBeLessThan(150);
    expect(Math.abs(counts[1]! - 2000)).toBeLessThan(150);
    expect(Math.abs(counts[2]! - 3000)).toBeLessThan(150);
  });
});

describe('mix32', () => {
  it('keeps 0 at 0 (why the constructor still maps it to 1) and moves everything else', () => {
    expect(mix32(0)).toBe(0);
    for (const x of [1, 2, 3, 0x9c0d1e2f, 0xffffffff]) {
      expect(mix32(x)).not.toBe(x);
      expect(mix32(x)).toBeGreaterThanOrEqual(0);
      expect(mix32(x)).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is injective over a run of consecutive inputs', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 50_000; x++) seen.add(mix32(x));
    expect(seen.size).toBe(50_000);
  });

  it('avalanches: one flipped input bit flips about half of the output bits', () => {
    const popcount = (n: number) => {
      let c = 0;
      for (let v = n >>> 0; v; v &= v - 1) c++;
      return c;
    };
    let flipped = 0;
    let pairs = 0;
    for (let x = 1; x <= 500; x++) {
      for (let bit = 0; bit < 32; bit++) {
        flipped += popcount(mix32(x) ^ mix32((x ^ (1 << bit)) >>> 0));
        pairs++;
      }
    }
    const mean = flipped / pairs;
    expect(mean).toBeGreaterThan(15);
    expect(mean).toBeLessThan(17);
  });
});
