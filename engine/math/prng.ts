/**
 * Deterministic Linear Congruential Generator (LCG). Ported from `funny`
 * (server/engine/src/math/prng.ts) per design/06.
 *
 * Multiplier and increment from Numerical Recipes (Knuth). Produces uint32
 * values — never calls Math.random(). Safe for deterministic game logic and
 * replay verification.
 *
 * Injected per-concern, never global (design/06/08): roomgenPrng, aiPrng,
 * combatPrng, dropPrng — each `new Prng(seed ^ <distinct constant>)` so the
 * streams never alias.
 *
 * Seed and output both go through `mix32` (2026-09-26, engine v78). The bare LCG
 * had two measured defects: `nextInt(max)` reduces the RAW state mod `max`, and an
 * LCG's low k bits cycle with period 2^k, so `nextInt(2)` strictly alternated
 * 0101... and `nextInt(4)` cycled with period 4; and seeds that differ by a little
 * (1..N, or `seed ^ constant` over 1..N) gave correlated first draws (the second
 * `nextInt(1000) < 10` hit 20 times in 6000 seeds instead of ~60). Together they
 * starved `shuffle`, which reached 15 of the 120 orders of five items. Hashing the seed
 * spreads nearby seeds across the state space; hashing each output makes every
 * bit usable. The state itself is still the full-period LCG.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    // uint32 after mixing; 0 is still mapped to 1 so the guard reads the same as before.
    this.state = mix32(seed >>> 0) || 1;
  }

  /**
   * Read-only view of the current internal state (uint32). Does NOT advance the
   * stream — for state hashing / replay verification only (design/08). Two engines
   * that have drawn the same sequence expose the same value here.
   */
  peek(): number {
    return this.state >>> 0;
  }

  /** Advance state and return the next uint32, hashed so its low bits are as good as its high ones. */
  private next(): number {
    // state = (1664525 × state + 1013904223) mod 2^32
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return mix32(this.state);
  }

  /** Return integer in [0, max). max must be a positive integer. */
  nextInt(max: number): number {
    return (this.next() >>> 0) % max;
  }

  /**
   * Weighted pick: given integer weights, return the index chosen proportionally.
   * Deterministic (single `next()` draw). Used by drop tables (design/05/09).
   * Weights must be non-negative integers with a positive sum.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.nextInt(total);
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return weights.length - 1; // unreachable when sum > 0
  }

  /**
   * Fisher-Yates shuffle in-place.
   * Returns the same array (mutated).
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j]!;
      arr[j] = tmp!;
    }
    return arr;
  }
}

/**
 * MurmurHash3's 32-bit finalizer: a bijection on uint32 with full avalanche, so
 * every input bit flips each output bit with probability ~1/2. Integer-only
 * (`Math.imul`, shifts), so it is exact on every JS engine.
 */
export function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
