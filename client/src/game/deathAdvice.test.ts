/**
 * The defeat screen's diagnosis line. Every test here pins a BOUNDARY rather than a
 * comfortable middle value, because the only thing that can go quietly wrong in a
 * three-branch table is a branch that starts one step too early or too late — and a
 * player who is told to go craft something when what killed them was a spike has been
 * given the wrong fix, which is worse than the four ledger lines this replaces nothing of.
 */
import { describe, expect, it } from 'vitest';
import { BURST_ADVICE_PCT, FRAGILE_ADVICE_HITS, deathAdvice } from './deathAdvice';
import { t } from '../i18n';

describe('deathAdvice', () => {
  it('says nothing at all when the run recorded no hit to read', () => {
    expect(deathAdvice({})).toBeNull();
    expect(deathAdvice({ hits: 0, burst_pct: 90 })).toBeNull();
    expect(deathAdvice({ killer: 'basic', room: 'r2_alcove' })).toBeNull();
  });

  // LITERAL numbers on both sides of each threshold, not `BURST_ADVICE_PCT ± 1`: a test
  // written against the constant moves when the constant moves, so it cannot tell a
  // deliberate retune from a typo. The two `toBe` checks below are what make the thresholds
  // themselves a decision a reader has to make on purpose.
  it('holds the thresholds the design doc quotes, so moving one is a deliberate act', () => {
    expect(BURST_ADVICE_PCT).toBe(70); // design/22, 2026-11-11d
    expect(FRAGILE_ADVICE_HITS).toBe(3);
  });

  it('calls a spike a spike at 70% of the pool, and a bleed at 69%', () => {
    expect(deathAdvice({ hits: 9, burst_pct: 70 })?.id).toBe('burst');
    expect(deathAdvice({ hits: 9, burst_pct: 69 })?.id).toBe('attrition');
  });

  it('reads the median sandbox death — 13 hits at 50% burst — as attrition, the shield line', () => {
    const a = deathAdvice({ killer: 'basic', hits: 13, burst_pct: 50 });
    expect(a?.id).toBe('attrition');
    expect(a?.key).toBe('results.adviceAttrition');
  });

  it('blames the build at three hits and the play at four', () => {
    expect(deathAdvice({ hits: 3 })?.id).toBe('fragile');
    expect(deathAdvice({ hits: 4 })?.id).toBe('attrition');
  });

  it('prefers the spike reading over the fragile one: three hits that took the pool is not a build problem', () => {
    expect(deathAdvice({ hits: 1, burst_pct: 120 })?.id).toBe('burst');
    expect(deathAdvice({ hits: 3, burst_pct: 70 })?.id).toBe('burst');
  });

  it('treats a death with no burst figure at all as the hit count alone, never as a spike', () => {
    expect(deathAdvice({ hits: 2 })?.id).toBe('fragile');
    expect(deathAdvice({ hits: 20 })?.id).toBe('attrition');
  });

  // Every branch, not just the one: `params` is built three times in the table, and a
  // branch that hard-codes a count renders a line quoting a number the run never had.
  it('carries the real hit count into EVERY line, so no branch can quote a constant', () => {
    expect(deathAdvice({ hits: 17 })?.params).toEqual({ hits: 17 }); // attrition
    expect(deathAdvice({ hits: 2 })?.params).toEqual({ hits: 2 }); // fragile
    expect(deathAdvice({ hits: 5, burst_pct: 95 })?.params).toEqual({ hits: 5 }); // burst
    expect(t(deathAdvice({ hits: 17 })!.key, { hits: 17 })).toContain('17');
  });

  it('gives each reading its own key, and each key resolves to real English copy', () => {
    const all = [deathAdvice({ hits: 1, burst_pct: 99 })!, deathAdvice({ hits: 2 })!, deathAdvice({ hits: 9 })!];
    expect(all.map((a) => a.id)).toEqual(['burst', 'fragile', 'attrition']);
    expect(new Set(all.map((a) => a.key)).size).toBe(3);
    for (const a of all) {
      const line = t(a.key, a.params);
      expect(line).not.toBe(a.key); // a missing key falls back to the key itself
      expect(line.length).toBeGreaterThan(20);
    }
  });

  it('names a DIFFERENT action in each line — three ways to say "you lost" would be decoration', () => {
    const burst = t('results.adviceBurst', { hits: 9 });
    const attrition = t('results.adviceAttrition', { hits: 9 });
    const fragile = t('results.adviceFragile', { hits: 9 });
    expect(new Set([burst, attrition, fragile]).size).toBe(3);
    expect(burst).toMatch(/moving|sight/i); // positional
    expect(attrition).toMatch(/shield/i); // let it come back
    expect(fragile).toMatch(/materials/i); // go build something
  });
});
