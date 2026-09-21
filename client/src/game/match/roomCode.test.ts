/**
 * The shared room-code shape (`roomCode.ts`) — the module both packages read, so this is the
 * one place its contract is stated as tests rather than as prose.
 *
 * What is NOT here, deliberately: the server's `randomCode` generator, and whether it obeys
 * this pattern. That agreement is asserted in `server/test/routes.test.ts`, against the real
 * generator, because it is a claim about the server's draw and not about this module.
 */
import { describe, it, expect } from 'vitest';
import {
  ROOM_CODE_DIGITS,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
  isRoomCode,
  normalizeRoomCode,
} from './roomCode';

describe('roomCode — the shape', () => {
  it('is six decimal digits', () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
    expect(ROOM_CODE_DIGITS).toBe(10);
  });

  it('accepts every well-formed code, leading zeros included', () => {
    // `000000` and `004271` are the cases a digit-only code has to keep working, and the ones
    // an implementation reaching for `type="number"` or a round-trip through `Number` breaks.
    for (const code of ['000000', '004271', '123456', '999999', '100000']) {
      expect(ROOM_CODE_PATTERN.test(code), code).toBe(true);
      expect(isRoomCode(code), code).toBe(true);
    }
  });

  it('is ANCHORED at both ends — the half that actually matters', () => {
    // An unanchored `[0-9]{6}` matches `abc123456xyz`, which would put an arbitrary string
    // into `PartyService`'s lookup map. Asserted as its own case because it is invisible in a
    // list of well-formed inputs: every one of those passes either way.
    for (const bad of ['abc123456xyz', 'x123456', '123456y', '/party/123456']) {
      expect(ROOM_CODE_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('refuses every near-miss, including the shape this replaced', () => {
    // `ABCDE` is on this list on purpose: five characters of a no-0/O/1/I alphabet is what a
    // stale client, or a bookmarked portal invite link, still sends.
    const nearMisses = [
      '', '1', '12345', '1234567', 'ABCDE', 'A12345', '12345A',
      ' 123456', '123456 ', '12 456', '12-345', '12.456', '1e5',
      // Six characters that read as a code and are not one. Written as escapes on
      // purpose: full-width \uff11 is indistinguishable from ASCII 1 in most fonts, so
      // the literal form would make this list look like it was testing '123456' twice.
      '\u4e00\u4e8c\u4e09\u56db\u4e94\u516d', // CJK numerals — not digits at all
      //
      // The next three are here for ONE mutant rather than for thoroughness. Changing
      // the pattern's `[0-9]` to `[\p{Nd}]` with the `u` flag is a one-character edit
      // that reads as a tidy-up and accepts every one of them — six glyphs a human reads
      // as a valid code, keying `PartyService`'s map as something the server could never
      // have minted. A battery confirmed these kill it, and that the `\d` variant is
      // equivalent in JS and therefore unkillable. See `roomCode.ts`'s note on the pattern.
      '\uff11\uff12\uff13\uff14\uff15\uff16', // FULL-WIDTH
      '\u0661\u0662\u0663\u0664\u0665\u0666', // ARABIC-INDIC
      '\u0966\u0967\u0968\u0969\u096a\u096b', // DEVANAGARI
    ];
    for (const bad of nearMisses) {
      expect(ROOM_CODE_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
      expect(isRoomCode(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('roomCode — isRoomCode narrows from unknown', () => {
  it('refuses a NUMBER, which is the mistake a digit-only code invites', () => {
    // The whole reason the parameter is `unknown`. A client that round-trips the code through
    // a number sends `482913` (a number, not a string) and `4271` (for `004271`) — and a
    // predicate typed to `string` would have let the first one through a `test()` coercion.
    expect(isRoomCode(482913)).toBe(false);
    expect(isRoomCode(4271)).toBe(false);
    expect(isRoomCode(Number('004271'))).toBe(false);
    // And the truncation itself, so the reason is visible next to the refusal.
    expect(String(Number('004271'))).toBe('4271');
  });

  it('refuses every other non-string a JSON body can carry', () => {
    for (const value of [null, undefined, true, {}, [], ['123456'], { code: '123456' }, 0 / 0]) {
      expect(isRoomCode(value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });

  it('agrees with ROOM_CODE_PATTERN on every string', () => {
    // The two are separately exported and separately used (the route calls the predicate, a
    // test asserts against the pattern), so a predicate that stopped consulting the pattern
    // would leave both green on their own.
    for (const s of ['000000', '123456', '12345', 'ABCDE', '', ' 123456']) {
      expect(isRoomCode(s)).toBe(ROOM_CODE_PATTERN.test(s));
    }
  });
});

describe('roomCode — normalizeRoomCode', () => {
  it('strips surrounding whitespace, including what a chat paste carries', () => {
    // The last one is a NON-BREAKING space (U+00A0), and it is the entry worth having
    // rather than a fifth spelling of " ": several chat clients emit NBSP, and `.trim()`
    // strips ALL Unicode whitespace rather than just the ASCII five — so a code pasted out
    // of one still joins. Written as an escape because the character is invisible in
    // source, which made this entry indistinguishable from the plain-space one.
    for (const raw of [' 123456', '123456 ', '  123456  ', '\t123456\n', '\u00a0123456\u00a0']) {
      expect(normalizeRoomCode(raw), JSON.stringify(raw)).toBe('123456');
    }
  });

  it('does NOT repair a code — no interior stripping, no padding, no coercion', () => {
    // The converse, and it is the important half: a normalizer that also removed separators
    // or padded to six would turn a caller-side bug into a lookup miss, which reads to the
    // player as "the code my friend gave me is wrong" instead of as a refusal the sender can
    // act on. Every one of these must come back unchanged and then FAIL `isRoomCode`.
    for (const raw of ['12-34-56', '12 34 56', '4271', '1234567', 'ABCDE']) {
      expect(normalizeRoomCode(raw), raw).toBe(raw);
      expect(isRoomCode(normalizeRoomCode(raw)), raw).toBe(false);
    }
  });

  it('leaves an already-clean code untouched', () => {
    expect(normalizeRoomCode('004271')).toBe('004271');
  });
});
