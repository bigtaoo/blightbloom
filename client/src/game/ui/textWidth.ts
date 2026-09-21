/** True for code points a monospace font renders at roughly double the Latin advance
 * (CJK ideographs + kana + hangul + fullwidth forms) — the ranges the Unicode East
 * Asian Width property calls Wide/Fullwidth, trimmed to the blocks this project's
 * locales actually use (`zh.ts`). Without this, a translated HUD string measures at
 * 60% of its real width and every backing panel sized from it comes up short. */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, kangxi, CJK symbols/punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, hangul compat jamo, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  );
}

/** Approximate a monospace string's rendered pixel width without touching Pixi's
 * canvas-based text measurement (`Text.width`/`Container.getBounds()` need a real 2D
 * canvas context to measure glyphs — expensive to redo every frame in the browser, and
 * unavailable at all in this project's Node-only unit-test environment, which has
 * neither jsdom/happy-dom nor a native canvas polyfill installed). Every HUD text style
 * this is used for is `fontFamily: 'monospace'`, so a fixed per-character advance is
 * accurate enough for sizing a backing panel; 0.6 matches common monospace
 * advance-width ratios, and a wide (CJK/fullwidth) code point counts as a full em. */
export function estimateMonoWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += isWideChar(ch.codePointAt(0) ?? 0) ? 1 : 0.6;
  return units * fontSize;
}

/** The widest LINE of a multi-line string — what a box has to be to hold it, as opposed
 *  to `estimateMonoWidth`, which would sum every line into one impossible run. */
export function widestMonoLine(text: string, fontSize: number): number {
  let widest = 0;
  for (const line of text.split('\n')) widest = Math.max(widest, estimateMonoWidth(line, fontSize));
  return widest;
}

/** The pieces a line may be broken between: runs of non-space Latin characters, single
 *  spaces, and single wide characters. CJK is per-character on purpose — Chinese has no
 *  spaces, so a whole translated sentence is one "word" and a space-only wrapper leaves
 *  it overflowing as a single line (the same hole `PortalPrompt` patches with Pixi's
 *  `breakWords`). */
function wrapTokens(line: string): string[] {
  const out: string[] = [];
  let latin = '';
  for (const ch of line) {
    if (ch === ' ' || isWideChar(ch.codePointAt(0) ?? 0)) {
      if (latin) out.push(latin);
      latin = '';
      out.push(ch);
    } else {
      latin += ch;
    }
  }
  if (latin) out.push(latin);
  return out;
}

/** Break `tok`, which is wider than the whole box on its own, at whatever character
 *  runs out of room. The last piece is returned to keep filling — only the completed
 *  ones are pushed. */
function hardBreak(tok: string, fontSize: number, maxWidth: number, lines: string[]): string {
  let piece = '';
  for (const ch of tok) {
    if (piece && estimateMonoWidth(piece + ch, fontSize) > maxWidth) {
      lines.push(piece);
      piece = '';
    }
    piece += ch;
  }
  return piece;
}

/**
 * Greedy word wrap for a monospace string, measured with `estimateMonoWidth`.
 *
 * Pixi can wrap text itself (`style.wordWrap`), and the menu screens use it. The HUD
 * does not, for the same reason nothing here calls `Text.width`: wrapping happens inside
 * the canvas text measurer, so what it produces is invisible to a Node-only test — a
 * label that overflows its button in Polish would wrap correctly in the browser and be
 * unmeasurable in the suite, which is how 26 of the 56 floor-card strings shipped
 * overflowing their 150px card (2026-09-21). Wrapping HERE, as a pure function over the
 * same estimator every panel is already sized from, makes the fit an assertable property
 * rather than a thing you have to screenshot eight locales to see.
 *
 * Returns at least one line, always, and preserves the source's own `\n` breaks — a
 * caller that has already composed "name\ndescription" keeps that split.
 */
export function wrapMono(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const source of text.split('\n')) {
    let cur = '';
    for (const tok of wrapTokens(source)) {
      const isSpace = tok === ' ';
      if (!cur && isSpace) continue; // a wrapped line never starts with the space it broke on
      if (cur && estimateMonoWidth(cur + tok, fontSize) > maxWidth) {
        lines.push(cur.trimEnd());
        cur = '';
        if (isSpace) continue;
      }
      // Either it fits after the break, or it is a single token wider than the whole box
      // (a long German compound, a locale with no spaces) and has to be cut mid-token.
      cur = estimateMonoWidth(cur + tok, fontSize) > maxWidth
        ? hardBreak(cur + tok, fontSize, maxWidth, lines)
        : cur + tok;
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}
