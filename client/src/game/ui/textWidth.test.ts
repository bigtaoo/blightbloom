/**
 * `estimateMonoWidth` is the only sizing input the whole HUD has — no widget here can
 * call `Text.width`/`getBounds()`, because this project's vitest environment has no
 * canvas to measure glyphs with (see textWidth.ts's own header). That makes it worth
 * pinning down directly: every backing panel, chip pill, and compare-card offset is
 * derived from it, so an error here shows up as clipped or over-padded UI everywhere
 * at once, in whichever locale happens to trip it.
 */
import { describe, it, expect } from 'vitest';
import { estimateMonoWidth, widestMonoLine, wrapMono } from './textWidth';

describe('estimateMonoWidth — Latin', () => {
  it('is zero for the empty string', () => {
    expect(estimateMonoWidth('', 13)).toBe(0);
  });

  it('advances 0.6em per ASCII character', () => {
    expect(estimateMonoWidth('abcde', 10)).toBeCloseTo(30, 6);
  });

  it('scales linearly with font size', () => {
    expect(estimateMonoWidth('SCORE', 20)).toBeCloseTo(estimateMonoWidth('SCORE', 10) * 2, 6);
  });

  it('scales linearly with length', () => {
    expect(estimateMonoWidth('ab', 13)).toBeCloseTo(estimateMonoWidth('a', 13) * 2, 6);
  });
});

describe('estimateMonoWidth — East Asian wide characters', () => {
  // The bug this half exists for: the original `text.length * size * 0.6` measured
  // every zh HUD string at 60% of its real width, so every panel sized from one came
  // up short — invisible in English, a clipped HUD in Chinese.
  it('counts a CJK ideograph as a full em, not 0.6', () => {
    expect(estimateMonoWidth('楼', 10)).toBeCloseTo(10, 6);
  });

  it('measures a CJK label wider than a Latin one of the same length', () => {
    expect(estimateMonoWidth('楼层', 13)).toBeGreaterThan(estimateMonoWidth('ab', 13));
  });

  it('measures a CJK label wider than the Latin word it translates', () => {
    expect(estimateMonoWidth('伤害 12', 11)).toBeGreaterThan(estimateMonoWidth('DMG 12', 11) * 0.9);
  });

  it('adds mixed Latin and CJK per character rather than picking one rate', () => {
    // The zh weapon subtitle's own shape: 4 wide ideographs (4em) plus the separator
    // it actually uses, U+00B7 MIDDLE DOT — a Latin-1 character a monospace font
    // renders NARROW, unlike its fullwidth U+30FB lookalike. 4 * 10 + 0.6 * 10 = 46.
    expect(estimateMonoWidth('普通·远程', 10)).toBeCloseTo(46, 6);
    expect(estimateMonoWidth('a楼', 10)).toBeCloseTo(16, 6);
  });

  it('handles the locales this project actually ships plus their punctuation', () => {
    for (const s of ['队友', '倒地 2秒', '存活', '（无）', '普通']) {
      expect(estimateMonoWidth(s, 12)).toBeGreaterThan(0);
    }
  });

  it('iterates by code point, so an astral character counts once (not as two surrogates)', () => {
    // U+20000 is a wide CJK ext-B ideograph stored as a surrogate pair; `.length` is 2.
    const astral = '\u{20000}';
    expect(astral.length).toBe(2);
    expect(estimateMonoWidth(astral, 10)).toBeCloseTo(10, 6);
  });

  it('leaves ordinary Latin punctuation narrow', () => {
    expect(estimateMonoWidth('· ', 10)).toBeCloseTo(12, 6); // U+00B7 middle dot is NOT wide
  });
});

describe('widestMonoLine', () => {
  it('measures the widest line, not the concatenation of all of them', () => {
    // The distinction an `autoWidth` button depends on: three 5-character lines need a
    // 30px box at 10px, not the 90px `estimateMonoWidth` would charge for one run.
    expect(widestMonoLine('abcde\nfg\nhij', 10)).toBeCloseTo(30, 6);
    expect(estimateMonoWidth('abcde\nfg\nhij', 10)).toBeGreaterThan(60);
  });

  it('is the plain width for a string with no breaks in it', () => {
    expect(widestMonoLine('SCORE', 13)).toBeCloseTo(estimateMonoWidth('SCORE', 13), 6);
  });
});

describe('wrapMono', () => {
  /** Nothing the wrapper returns may be wider than the box it was given. */
  const fits = (lines: string[], fontSize: number, max: number) =>
    lines.every((l) => estimateMonoWidth(l, fontSize) <= max + 1e-9);

  it('leaves a string that already fits on one line', () => {
    expect(wrapMono('+50% damage', 12, 200)).toEqual(['+50% damage']);
  });

  it('breaks at a space and never starts a line with the space it broke on', () => {
    const lines = wrapMono('Potions drop 2x as often', 12, 90);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.startsWith(' '))).toBe(false);
    expect(fits(lines, 12, 90)).toBe(true);
  });

  it('keeps every word — wrapping is not truncation', () => {
    const source = 'Las pociones caen 2x más a menudo';
    expect(wrapMono(source, 12, 134).join(' ')).toBe(source);
  });

  it('preserves the caller’s own line breaks', () => {
    // `FloorCardPrompt` composes "name\ndescription" before wrapping; the name must stay
    // on its own line even though the description would fit beside it.
    expect(wrapMono('Edge\n+50% damage', 12, 400)).toEqual(['Edge', '+50% damage']);
  });

  it('breaks a single word that is wider than the whole box', () => {
    // No space to break at — a locale's compound noun, or a box narrower than one word.
    const lines = wrapMono('Zwiększona', 12, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('Zwiększona');
    expect(fits(lines, 12, 40)).toBe(true);
  });

  it('breaks Chinese between characters, which is the only break it has', () => {
    // The hole `breakWords` patches for Pixi: CJK has no spaces, so a whitespace-only
    // wrapper would return the whole sentence as one overflowing line.
    const lines = wrapMono('血瓶掉落率提高两倍', 12, 48);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('血瓶掉落率提高两倍');
    expect(fits(lines, 12, 48)).toBe(true);
  });

  it('drops leading spaces but keeps the ones inside the line', () => {
    // The HUD does have double-spaced strings ("Shop  120c"), and they are alignment, not
    // accident — only the space a line was BROKEN on is dropped.
    expect(wrapMono('  Shop  120c', 12, 200)).toEqual(['Shop  120c']);
  });

  it('always returns at least one line, including for the empty string', () => {
    expect(wrapMono('', 12, 100)).toEqual(['']);
  });
});
