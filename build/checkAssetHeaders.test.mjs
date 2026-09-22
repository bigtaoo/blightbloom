// build/checkAssetHeaders.mjs — the gate that keeps a new asset directory from silently
// inheriting Cloudflare's `max-age=0` default.
import { describe, it, expect } from 'vitest';
import { checkAssetHeaders, findUncachedDirs, parseHeaders } from './checkAssetHeaders.mjs';

describe('parseHeaders', () => {
  it('reads a pattern and its indented directives, ignoring comments and blanks', () => {
    const rules = parseHeaders(`# a comment\n\n/ui/*\n  Cache-Control: public, max-age=3600\n  X-Thing: 1\n`);
    expect(rules).toEqual([
      { pattern: '/ui/*', headers: { 'cache-control': 'public, max-age=3600', 'x-thing': '1' } },
    ]);
  });

  it('does not take an indented comment for a directive', () => {
    const rules = parseHeaders(`/ui/*\n  # why this policy\n  Cache-Control: public, max-age=60\n`);
    expect(Object.keys(rules[0].headers)).toEqual(['cache-control']);
  });

  it('survives a directive line before any pattern', () => {
    // A malformed file must fail the gate below, not throw inside the parser.
    expect(() => parseHeaders('  Cache-Control: public\n')).not.toThrow();
  });
});

describe('findUncachedDirs', () => {
  const cached = (dir) => ({ pattern: `/${dir}/*`, headers: { 'cache-control': 'public, max-age=3600' } });

  it('passes a directory with a real policy', () => {
    expect(findUncachedDirs(['ui'], [cached('ui')])).toEqual([]);
  });

  it('names a directory with no rule at all', () => {
    // The whole point: this is what a NEW art directory looks like on the day it is added.
    expect(findUncachedDirs(['ui', 'newart'], [cached('ui')])).toEqual([
      expect.stringContaining('/newart/*'),
    ]);
  });

  it('rejects a rule that caches for zero seconds', () => {
    // A rule that exists and says `max-age=0` is worse than none, because it looks handled.
    // This is verbatim the platform default the live deploy was serving.
    const zero = { pattern: '/ui/*', headers: { 'cache-control': 'public, max-age=0, must-revalidate' } };
    expect(findUncachedDirs(['ui'], [zero])[0]).toMatch(/zero seconds/);
  });

  it('rejects no-store, and is not fooled by max-age=0 inside another number', () => {
    expect(findUncachedDirs(['ui'], [{ pattern: '/ui/*', headers: { 'cache-control': 'no-store' } }])).toHaveLength(1);
    // `max-age=0...` must match but `max-age=0` as a prefix of `max-age=604800` must not —
    // the naive /max-age=0/ that this guards against would fail every correct long policy.
    const long = { pattern: '/ui/*', headers: { 'cache-control': 'public, max-age=0604800' } };
    expect(findUncachedDirs(['ui'], [long])).toEqual([]);
  });

  it('names a rule with no Cache-Control in it', () => {
    const noCc = { pattern: '/ui/*', headers: { 'x-thing': '1' } };
    expect(findUncachedDirs(['ui'], [noCc])[0]).toMatch(/no Cache-Control/);
  });
});

describe('the real client/public/_headers', () => {
  it('covers every shipped asset directory', () => {
    expect(checkAssetHeaders()).toEqual([]);
  });
});
