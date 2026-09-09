/**
 * THE BROWSER'S BATCH, AND EVERY WAY IT CAN BE WRONG (src/clientLog.ts).
 *
 * This is the widest trust boundary the server has — the one route that takes a body from
 * anybody who can reach the domain, with no session required (see routes/telemetry.ts for
 * why that is deliberate). So most of this file is about refusals: a value that is not
 * capped becomes a Loki line somebody else wrote, and a label that is not allowlisted
 * becomes a Loki STREAM somebody else created.
 */
import { describe, it, expect } from 'vitest';
import { buildLokiPayload, parseBatch, toNanos, LIMITS, HOSTS, CLIENT_LEVELS } from '../src/clientLog';

const NOW = 1_800_000_000_000;

const validBatch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: 's1',
  host: 'web',
  ver: 'abc123',
  now: NOW,
  entries: [{ t: NOW - 1000, level: 'error', msg: 'boom', tag: 'boot' }],
  ...over,
});

describe('parseBatch — what it accepts', () => {
  it('accepts a well-formed batch and keeps every field', () => {
    expect(parseBatch(validBatch())).toEqual({
      session: 's1',
      host: 'web',
      ver: 'abc123',
      now: NOW,
      entries: [{ t: NOW - 1000, level: 'error', msg: 'boom', tag: 'boot' }],
    });
  });

  it('accepts every host in the allowlist, and no others', () => {
    for (const host of HOSTS) expect(parseBatch(validBatch({ host }))?.host, host).toBe(host);
    // A host label is a Loki LABEL, so an unknown value here is a new stream per value —
    // the standard way to make a log store unqueryable, reachable from the open internet.
    expect(parseBatch(validBatch({ host: 'steam' }))).toBeNull();
    expect(parseBatch(validBatch({ host: 'WEB' }))).toBeNull();
  });

  it('accepts every level in the allowlist, and drops an entry with any other', () => {
    for (const level of CLIENT_LEVELS) {
      const parsed = parseBatch(validBatch({ entries: [{ t: NOW, level, msg: 'm' }] }));
      expect(parsed?.entries[0]!.level, level).toBe(level);
    }
    expect(parseBatch(validBatch({ entries: [{ t: NOW, level: 'fatal', msg: 'm' }] }))).toBeNull();
  });

  it('defaults a missing build version rather than losing the batch over it', () => {
    // A dev build and a target with no manifest both have none, and those are exactly the
    // builds whose logs are most worth having.
    expect(parseBatch(validBatch({ ver: undefined }))?.ver).toBe('unknown');
    expect(parseBatch(validBatch({ ver: '   ' }))?.ver).toBe('unknown');
  });

  it('keeps the good entries in a batch that also contains bad ones', () => {
    // A single unserialisable line must not cost the crash report it sits next to.
    const parsed = parseBatch(
      validBatch({
        entries: [
          { t: NOW, level: 'error', msg: 'kept' },
          { t: NOW, level: 'error' }, // no message
          null,
          { t: 'soon', level: 'error', msg: 'bad time' },
          { t: NOW, level: 'info', msg: 'also kept' },
        ],
      }),
    );
    expect(parsed?.entries.map((e) => e.msg)).toEqual(['kept', 'also kept']);
  });
});

describe('parseBatch — what it refuses', () => {
  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['no session', validBatch({ session: undefined })],
    ['empty session', validBatch({ session: '' })],
    ['no host', validBatch({ host: undefined })],
    ['no clock anchor', validBatch({ now: undefined })],
    ['a non-finite clock anchor', validBatch({ now: Number.NaN })],
    ['an infinite clock anchor', validBatch({ now: Number.POSITIVE_INFINITY })],
    ['entries that are not an array', validBatch({ entries: { 0: { t: 1, level: 'error', msg: 'm' } } })],
    ['no usable entries at all', validBatch({ entries: [{}, 3] })],
    ['an empty entry list', validBatch({ entries: [] })],
  ])('returns null for %s', (_label, body) => {
    expect(parseBatch(body)).toBeNull();
  });
});

describe('parseBatch — the caps', () => {
  it('truncates an over-long message instead of dropping or storing it', () => {
    const parsed = parseBatch(validBatch({ entries: [{ t: NOW, level: 'error', msg: 'x'.repeat(9999) }] }));
    expect(parsed!.entries[0]!.msg).toHaveLength(LIMITS.msg);
  });

  it('truncates session, ver and tag — the three fields an attacker can make enormous', () => {
    const parsed = parseBatch(
      validBatch({
        session: 'a'.repeat(500),
        ver: 'b'.repeat(500),
        entries: [{ t: NOW, level: 'error', msg: 'm', tag: 'c'.repeat(500) }],
      }),
    );
    expect(parsed!.session).toHaveLength(LIMITS.session);
    expect(parsed!.ver).toHaveLength(LIMITS.ver);
    expect(parsed!.entries[0]!.tag).toHaveLength(LIMITS.tag);
  });

  it('caps the ENTRY COUNT, which is the amplification that matters', () => {
    // funny's own audit of the equivalent endpoint found ~200x amplification into its log
    // store from one request. Without this, a single POST writes as many lines as it likes.
    const entries = Array.from({ length: 5000 }, (_, i) => ({ t: NOW, level: 'info', msg: `m${i}` }));
    expect(parseBatch(validBatch({ entries }))!.entries).toHaveLength(LIMITS.entries);
  });
});

describe('toNanos — a device clock is not a clock', () => {
  it('converts an ordinary entry to server-now minus its age', () => {
    expect(BigInt(toNanos(NOW - 5000, NOW, 1_900_000_000_000))).toBe((1_900_000_000_000n - 5000n) * 1_000_000n);
  });

  it('clamps a clock running YEARS SLOW to the oldest allowed age', () => {
    // Left alone, this lands outside Loki's ingestion window: the batch is rejected whole,
    // at the store, with a 400 nobody at this end is watching for.
    const ns = BigInt(toNanos(NOW - 400 * 24 * 3600 * 1000, NOW, NOW));
    expect(ns).toBe((BigInt(NOW) - BigInt(LIMITS.ageMs)) * 1_000_000n);
  });

  it('clamps a clock running FAST to now, never into the future', () => {
    // A future timestamp is the other half of the same rejection, and the more common one:
    // a device whose clock is a few minutes ahead.
    expect(BigInt(toNanos(NOW + 60_000, NOW, NOW))).toBe(BigInt(NOW) * 1_000_000n);
  });

  it('preserves relative order and spacing WITHIN a batch', () => {
    // The whole point of measuring an age rather than trusting the instant: a session read
    // in order still reads in order, even off a device whose absolute clock is nonsense.
    const a = BigInt(toNanos(NOW - 3000, NOW, NOW));
    const b = BigInt(toNanos(NOW - 1000, NOW, NOW));
    expect(b - a).toBe(2000n * 1_000_000n);
  });

  it('produces a decimal integer string, never exponential notation', () => {
    // `ms * 1e6` exceeds Number.MAX_SAFE_INTEGER and, past 1e21, `String()` yields "1e+21",
    // which Loki rejects outright. funny shipped that bug; this is why it is BigInt.
    const s = toNanos(NOW, NOW, NOW);
    expect(s).toMatch(/^[0-9]+$/);
    expect(s).toHaveLength(19);
  });
});

describe('buildLokiPayload', () => {
  it('creates one stream per level, with exactly the three allowed labels', () => {
    const batch = parseBatch(
      validBatch({
        entries: [
          { t: NOW, level: 'error', msg: 'e1' },
          { t: NOW, level: 'error', msg: 'e2' },
          { t: NOW, level: 'info', msg: 'i1' },
        ],
      }),
    )!;
    const payload = buildLokiPayload({ batch, serverNowMs: NOW });
    expect(payload.streams).toHaveLength(2);
    for (const s of payload.streams) {
      // Pinned as an exact key set, not a superset: a fourth label added carelessly here is
      // a stream multiplier, and every value on it comes from the open internet.
      expect(Object.keys(s.stream).sort()).toEqual(['host', 'level', 'source']);
      expect(s.stream.source).toBe('client');
      expect(s.stream.host).toBe('web');
    }
    expect(payload.streams.find((s) => s.stream.level === 'error')!.values).toHaveLength(2);
  });

  it('never puts the session, the version or the account in a LABEL', () => {
    // The one that would actually break the store: a label per session is a stream per
    // player per visit.
    const batch = parseBatch(validBatch())!;
    const payload = buildLokiPayload({ batch, serverNowMs: NOW, accountId: 'acct-1' });
    const labels = JSON.stringify(payload.streams.map((s) => s.stream));
    expect(labels).not.toContain('s1');
    expect(labels).not.toContain('abc123');
    expect(labels).not.toContain('acct-1');
    // ...and they are all in the LINE, which is where `| logfmt` can filter on them.
    expect(payload.streams[0]!.values[0]![1]).toContain('session=s1');
    expect(payload.streams[0]!.values[0]![1]).toContain('ver=abc123');
    expect(payload.streams[0]!.values[0]![1]).toContain('acct=acct-1');
  });

  it('omits acct entirely for a guest, rather than writing an empty one', () => {
    const batch = parseBatch(validBatch())!;
    const line = buildLokiPayload({ batch, serverNowMs: NOW }).streams[0]!.values[0]![1];
    expect(line).not.toContain('acct=');
  });

  it('logfmt-quotes a message with spaces, so the fields around it still parse', () => {
    const batch = parseBatch(validBatch({ entries: [{ t: NOW, level: 'error', msg: 'two words here' }] }))!;
    const line = buildLokiPayload({ batch, serverNowMs: NOW }).streams[0]!.values[0]![1];
    expect(line).toContain('msg="two words here"');
    expect(line).toContain('session=s1');
  });

  it('sorts each stream oldest-first', () => {
    const batch = parseBatch(
      validBatch({
        entries: [
          { t: NOW - 1000, level: 'error', msg: 'later' },
          { t: NOW - 9000, level: 'error', msg: 'earlier' },
        ],
      }),
    )!;
    const values = buildLokiPayload({ batch, serverNowMs: NOW }).streams[0]!.values;
    expect(values.map((v) => v[1])).toEqual([expect.stringContaining('earlier'), expect.stringContaining('later')]);
    expect(BigInt(values[0]![0])).toBeLessThan(BigInt(values[1]![0]));
  });
});
