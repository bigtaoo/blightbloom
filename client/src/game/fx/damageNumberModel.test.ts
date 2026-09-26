import { describe, it, expect } from 'vitest';
import {
  DamageNumberBook, digitsOf, glyphOffsets, glyphsOf, magnitudeScale, poseAt, styleScale,
  BANG_GLYPH, CRIT_SCALE, PLUS_GLYPH, MERGE_MS, LIFE_MS, FADE_MS, POP_MS, POP_SCALE, RISE_PX, DRIFT_PX,
} from './damageNumberModel';

/** A view stub that records which spawn built it, so reuse is observable. */
function views() {
  let made = 0;
  return { make: () => ({ id: ++made }), made: () => made };
}

describe('digitsOf', () => {
  it('splits an integer into its digits, most significant first', () => {
    expect(digitsOf(7)).toEqual([7]);
    expect(digitsOf(1204)).toEqual([1, 2, 0, 4]);
  });

  it('rounds a fraction to the nearest integer rather than printing a decimal point', () => {
    expect(digitsOf(12.6)).toEqual([1, 3]);
  });

  it.each([0, 0.4, -5, NaN, Infinity])('gives %s no digits, so it draws nothing', (v) => {
    expect(digitsOf(v)).toEqual([]);
  });
});

describe('glyphsOf', () => {
  it('is the bare digits for a plain hit', () => {
    expect(glyphsOf(305, 'hit')).toEqual([3, 0, 5]);
  });

  it('leads a heal with "+" and closes a crit with "!"', () => {
    expect(glyphsOf(12, 'heal')).toEqual([PLUS_GLYPH, 1, 2]);
    expect(glyphsOf(48, 'crit')).toEqual([4, 8, BANG_GLYPH]);
  });

  it('draws no bare mark for a value with no digits', () => {
    for (const style of ['hit', 'crit', 'heal'] as const) expect(glyphsOf(0, style)).toEqual([]);
  });
});

describe('glyphOffsets', () => {
  it('spaces digits one advance apart, centred on the anchor, whatever the length', () => {
    expect(glyphOffsets([7], 10, 4)).toEqual([0]);
    expect(glyphOffsets([1, 2], 10, 4)).toEqual([-5, 5]);
    expect(glyphOffsets([1, 2, 3], 10, 4)).toEqual([-10, 0, 10]);
    expect(glyphOffsets([PLUS_GLYPH, 1, 2], 10, 4)).toEqual([-10, 0, 10]); // "+" is digit-wide
  });

  it('packs the narrow "!" against the number instead of giving it a whole digit slot', () => {
    // "48!": widths 10, 10, 4 → total 24, left edge -12.
    expect(glyphOffsets([4, 8, BANG_GLYPH], 10, 4)).toEqual([-7, 3, 10]);
  });
});

describe('styleScale', () => {
  it('prints only a crit bigger', () => {
    expect(styleScale('crit')).toBe(CRIT_SCALE);
    expect(CRIT_SCALE).toBeGreaterThan(1);
    expect(styleScale('hit')).toBe(1);
    expect(styleScale('heal')).toBe(1);
  });
});

describe('magnitudeScale', () => {
  it('is 1 up to 10, grows with the log of the hit, and caps at 1.35 from 1000', () => {
    expect(magnitudeScale(1)).toBe(1);
    expect(magnitudeScale(10)).toBe(1);
    expect(magnitudeScale(100)).toBeCloseTo(1.175);
    expect(magnitudeScale(1000)).toBeCloseTo(1.35);
    expect(magnitudeScale(1e6)).toBeCloseTo(1.35);
    expect(magnitudeScale(0)).toBe(1);
  });
});

describe('poseAt', () => {
  it('starts on the anchor, fully visible and popped', () => {
    expect(poseAt(0, 0)).toEqual({ rise: 0, alpha: 1, pop: 1 + POP_SCALE });
  });

  it('settles the pop after POP_MS and holds full alpha until the fade starts', () => {
    const p = poseAt(LIFE_MS - FADE_MS, POP_MS);
    expect(p.pop).toBe(1);
    expect(p.alpha).toBe(1);
  });

  it('eases out: more than half the rise is done by half the life', () => {
    expect(poseAt(LIFE_MS / 2, POP_MS).rise).toBeGreaterThan(RISE_PX / 2);
    expect(poseAt(LIFE_MS, POP_MS).rise).toBe(RISE_PX);
  });

  it('fades linearly to 0 over the last FADE_MS', () => {
    expect(poseAt(LIFE_MS - FADE_MS / 2, POP_MS).alpha).toBeCloseTo(0.5);
    expect(poseAt(LIFE_MS, POP_MS).alpha).toBe(0);
    expect(poseAt(LIFE_MS + 100, POP_MS).rise).toBe(RISE_PX);
  });
});

describe('DamageNumberBook', () => {
  it('starts a new number for the first hit on a target', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const n = book.add(1, 0xfff, 12, 100, 50, 10, v.make)!;
    expect(n).toMatchObject({ target: 1, tint: 0xfff, value: 12, x: 100, y: 50, age: 0, dirty: true });
    expect(book.live).toEqual([n]);
  });

  it('adds a second hit inside MERGE_MS into the same number and pops it again', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const first = book.add(1, 0xfff, 12, 0, 0, 10, v.make)!;
    book.step(MERGE_MS - 1);
    first.dirty = false;
    const second = book.add(1, 0xfff, 5, 99, 99, 10, v.make);
    expect(second).toBe(first);
    expect(first).toMatchObject({ value: 17, popAge: 0, dirty: true, x: 0, y: 0 });
    expect(book.live).toHaveLength(1);
    expect(v.made()).toBe(1);
  });

  it('starts a new number once the first is MERGE_MS old — a slow weapon reads as separate hits', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    book.add(1, 0xfff, 12, 0, 0, 10, v.make);
    book.step(MERGE_MS);
    book.add(1, 0xfff, 5, 0, 0, 10, v.make);
    expect(book.live.map((n) => n.value)).toEqual([12, 5]);
  });

  it('never merges across targets or across colours', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    book.add(1, 0xfff, 1, 0, 0, 10, v.make);
    book.add(2, 0xfff, 1, 0, 0, 10, v.make);
    book.add(1, 0xf00, 1, 0, 0, 10, v.make);
    expect(book.live).toHaveLength(3);
  });

  it('never merges across styles, even in one colour: a crit stands apart from the stream', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const plain = book.add(1, 0xfff, 4, 0, 0, 10, v.make)!;
    const crit = book.add(1, 0xfff, 8, 0, 0, 10, v.make, 'crit')!;
    book.add(1, 0xfff, 8, 0, 0, 10, v.make, 'crit'); // joins the crit, not the plain number
    expect(plain).not.toBe(crit);
    expect(book.live.map((n) => [n.style, n.value])).toEqual([['hit', 4], ['crit', 16]]);
  });

  it('a plain add defaults to the hit style', () => {
    const book = new DamageNumberBook<{ id: number }>();
    expect(book.add(1, 0xfff, 4, 0, 0, 10, views().make)!.style).toBe('hit');
  });

  it('cycles new numbers through the drift offsets, and a merge does not advance the cycle', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const drifts: number[] = [];
    for (let i = 0; i < DRIFT_PX.length + 1; i++) {
      drifts.push(book.add(i, 0xfff, 1, 0, 0, 99, v.make)!.drift);
      book.add(i, 0xfff, 1, 0, 0, 99, v.make); // merges
    }
    expect(drifts).toEqual([...DRIFT_PX, DRIFT_PX[0]]);
  });

  it('at the cap, reuses the OLDEST number and its view for the new hit', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const oldest = book.add(1, 0xfff, 1, 0, 0, 2, v.make)!;
    book.add(2, 0xfff, 1, 0, 0, 2, v.make);
    const newest = book.add(3, 0xfff, 9, 0, 0, 2, v.make)!;
    expect(v.made()).toBe(2);
    expect(newest.view).toBe(oldest.view);
    expect(book.live.map((n) => n.target)).toEqual([2, 3]);
  });

  it('draws nothing with a cap of 0, or for a hit with no digits', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    expect(book.add(1, 0xfff, 5, 0, 0, 0, v.make)).toBeUndefined();
    expect(book.add(1, 0xfff, 0, 0, 0, 10, v.make)).toBeUndefined();
    expect(book.live).toHaveLength(0);
    expect(v.made()).toBe(0);
  });

  it('still merges into a live number when the cap has since dropped to 0', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    book.add(1, 0xfff, 5, 0, 0, 10, v.make);
    expect(book.add(1, 0xfff, 5, 0, 0, 0, v.make)?.value).toBe(10);
  });

  it('step ages every number and hands back the ones whose life ran out', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const a = book.add(1, 0xfff, 1, 0, 0, 10, v.make)!;
    book.step(LIFE_MS - 100);
    const b = book.add(2, 0xfff, 1, 0, 0, 10, v.make)!;
    expect(book.step(99)).toEqual([]);
    expect(book.step(1)).toEqual([a]);
    expect(book.live).toEqual([b]);
    expect(b).toMatchObject({ age: 100, popAge: 100 });
  });

  it('trimTo drops the oldest down to the cap and returns them', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const [a, b, c] = [1, 2, 3].map((t) => book.add(t, 0xfff, 1, 0, 0, 10, v.make)!);
    expect(book.trimTo(5)).toEqual([]);
    expect(book.trimTo(1)).toEqual([a, b]);
    expect(book.live).toEqual([c]);
    expect(book.trimTo(-1)).toEqual([c]);
  });

  it('clear empties the book and returns what was live', () => {
    const book = new DamageNumberBook<{ id: number }>();
    const v = views();
    const a = book.add(1, 0xfff, 1, 0, 0, 10, v.make)!;
    expect(book.clear()).toEqual([a]);
    expect(book.live).toEqual([]);
  });
});
