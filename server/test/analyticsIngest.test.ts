/**
 * The analytics ingest boundary — `src/analytics/ingest.ts` + the shared vocabulary it
 * reads (`@dd/net/analyticsEvents`).
 *
 * This is the widest trust boundary this pass adds: `POST /client/events` takes a body from
 * anyone who can reach the host, so almost every case below is a REFUSAL rather than a
 * happy path. The three properties worth naming, because they are the ones that go quiet
 * when they break rather than red:
 *
 *   - **A bad field costs itself, a bad event costs itself, only an unrecognisable envelope
 *     costs the batch.** Nothing here 4xx's, so a regression that started dropping whole
 *     batches would look exactly like "traffic went down".
 *   - **A device clock cannot choose a cohort.** `anchorToServer` is the only reason a
 *     browser whose clock says 2011 does not invent a 2011 cohort, and a retention number
 *     computed off invented cohorts is wrong in a way no percentage would show.
 *   - **The vocabulary is the only list.** The parser has no names of its own, so the sweep
 *     at the bottom drives it from the table. The table's OWN properties (its exact member
 *     list, the id charset, `coerceProp` case by case) are tested beside the module in
 *     `client/src/net/analyticsEvents.test.ts` — this file is about the parser.
 */
import { describe, it, expect } from 'vitest';
import { EVENT_NAMES, LIMITS, specFor } from '@dd/net/analyticsEvents';
import { anchorToServer, dayKey, parseAnalyticsBatch } from '../src/analytics/ingest';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09T12:00:00Z
const SENT = NOW;

/** A minimal valid envelope. Individual cases override one field at a time. */
function batch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    install: 'i-abc',
    session: 's-xyz',
    host: 'web',
    build: '1.2.3',
    locale: 'en',
    sentAt: SENT,
    events: [{ name: 'session_start', at: SENT }],
    ...over,
  };
}

describe('parseAnalyticsBatch — the envelope', () => {
  it('accepts a well-formed batch and carries every envelope field through', () => {
    const out = parseAnalyticsBatch(batch(), NOW);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ install: 'i-abc', session: 's-xyz', host: 'web', build: '1.2.3', locale: 'en' });
    expect(out!.events).toHaveLength(1);
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['a number', 7],
    ['an array', []],
  ])('refuses a body that is %s', (_label, body) => {
    expect(parseAnalyticsBatch(body, NOW)).toBeNull();
  });

  it.each(['install', 'session', 'host', 'sentAt'])('refuses a batch with no %s', (field) => {
    expect(parseAnalyticsBatch(batch({ [field]: undefined }), NOW)).toBeNull();
  });

  it('refuses an empty-string install (a present field that identifies nobody)', () => {
    expect(parseAnalyticsBatch(batch({ install: '' }), NOW)).toBeNull();
  });

  it('refuses an over-long install rather than truncating it', () => {
    // Truncating would merge two installs into one cohort member, which is a wrong number
    // rather than a missing one.
    expect(parseAnalyticsBatch(batch({ install: 'i'.repeat(LIMITS.idMax + 1) }), NOW)).toBeNull();
    expect(parseAnalyticsBatch(batch({ install: 'i'.repeat(LIMITS.idMax) }), NOW)).not.toBeNull();
  });

  it('refuses a host outside the three build targets', () => {
    expect(parseAnalyticsBatch(batch({ host: 'ios' }), NOW)).toBeNull();
    expect(parseAnalyticsBatch(batch({ host: 42 }), NOW)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, '123'])('refuses sentAt = %p', (sentAt) => {
    expect(parseAnalyticsBatch(batch({ sentAt }), NOW)).toBeNull();
  });

  it('defaults a missing build and locale rather than losing the batch', () => {
    // A dev build has no version manifest. Dropping over it would lose exactly the data
    // from the odd build, which is the build most likely to be interesting.
    const out = parseAnalyticsBatch(batch({ build: undefined, locale: undefined }), NOW);
    expect(out).toMatchObject({ build: 'unknown', locale: 'unknown' });
  });

  it('defaults an over-long build rather than storing it', () => {
    const out = parseAnalyticsBatch(batch({ build: 'v'.repeat(LIMITS.shortMax + 1) }), NOW);
    expect(out!.build).toBe('unknown');
  });

  it('refuses a batch whose events field is not an array', () => {
    expect(parseAnalyticsBatch(batch({ events: 'session_start' }), NOW)).toBeNull();
    expect(parseAnalyticsBatch(batch({ events: undefined }), NOW)).toBeNull();
  });

  it('refuses a batch whose events all failed validation — nothing to store is nothing', () => {
    expect(parseAnalyticsBatch(batch({ events: [] }), NOW)).toBeNull();
    expect(parseAnalyticsBatch(batch({ events: [{ name: 'made_up', at: SENT }] }), NOW)).toBeNull();
  });

  it('truncates at the per-batch cap instead of refusing', () => {
    const many = Array.from({ length: LIMITS.eventsPerBatch + 25 }, () => ({ name: 'session_start', at: SENT }));
    const out = parseAnalyticsBatch(batch({ events: many }), NOW);
    expect(out!.events).toHaveLength(LIMITS.eventsPerBatch);
  });

  it('keeps the good events in a batch that also contains bad ones', () => {
    const out = parseAnalyticsBatch(
      batch({
        events: [
          { name: 'session_start', at: SENT },
          'not an object',
          null,
          { name: 'no_such_event', at: SENT },
          { name: 'ad_offer_shown', at: SENT },
          { name: 'ad_offer_shown' }, // no `at`
          { name: 42, at: SENT },
        ],
      }),
      NOW,
    );
    expect(out!.events.map((e) => e.name)).toEqual(['session_start', 'ad_offer_shown']);
  });
});

describe('parseAnalyticsBatch — props', () => {
  const one = (name: string, props: unknown): Record<string, unknown> | undefined => {
    const out = parseAnalyticsBatch(batch({ events: [{ name, at: SENT, props }] }), NOW);
    return out?.events[0]?.props;
  };

  it('keeps a valid prop of each kind', () => {
    expect(one('run_end', { outcome: 'win', floor: 12, duration_s: 300 })).toEqual({
      outcome: 'win',
      floor: 12,
      duration_s: 300,
    });
  });

  it('drops a prop the vocabulary does not name, keeping the rest', () => {
    expect(one('store_purchase', { sku: 'blueprint:rifle', smuggled: 'x'.repeat(5000) })).toEqual({
      sku: 'blueprint:rifle',
    });
  });

  it('drops a bad value without dropping the event', () => {
    const out = parseAnalyticsBatch(batch({ events: [{ name: 'run_end', at: SENT, props: { outcome: 'exploded' } }] }), NOW);
    expect(out!.events).toHaveLength(1);
    expect(out!.events[0]!.props).toEqual({});
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'outcome=win'],
  ])('treats props that are %s as no props', (_label, props) => {
    expect(one('run_end', props)).toEqual({});
  });

  it('cannot be made to store a prototype-polluting key', () => {
    // The loop walks the SPEC, so `__proto__` is not "rejected" — it is unreachable.
    const props = one('ad_offer_shown', JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(props).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('anchorToServer — a device clock is not a clock', () => {
  it('places an entry at its age before the server clock', () => {
    expect(anchorToServer(SENT - 5_000, SENT, NOW)).toBe(NOW - 5_000);
  });

  it('preserves relative order inside a batch', () => {
    const a = anchorToServer(SENT - 9_000, SENT, NOW);
    const b = anchorToServer(SENT - 1_000, SENT, NOW);
    expect(a).toBeLessThan(b);
  });

  it('treats an entry stamped AFTER the send as now, not as the future', () => {
    expect(anchorToServer(SENT + 60_000, SENT, NOW)).toBe(NOW);
  });

  it('clamps an absurd age instead of dropping the entry', () => {
    const ancient = anchorToServer(SENT - 400 * 86_400_000, SENT, NOW);
    expect(ancient).toBe(NOW - LIMITS.maxAgeMs);
  });

  it('cannot file a row outside the ingest window however wrong the device clock is', () => {
    // The property the cohort table depends on: whatever the client says, the row lands
    // within maxAgeMs of the server's own clock.
    for (const clientNow of [0, 1e12, 4e12, -1e9]) {
      const at = anchorToServer(clientNow - 1e9, clientNow, NOW);
      expect(at).toBeLessThanOrEqual(NOW);
      expect(at).toBeGreaterThanOrEqual(NOW - LIMITS.maxAgeMs);
    }
  });
});

describe('dayKey', () => {
  it('is the UTC calendar day', () => {
    expect(dayKey(Date.UTC(2026, 8, 9, 23, 59, 59))).toBe('2026-09-09');
    expect(dayKey(Date.UTC(2026, 8, 10, 0, 0, 0))).toBe('2026-09-10');
  });

  it('sorts chronologically as text, which every window comparison relies on', () => {
    const days = [Date.UTC(2026, 0, 2), Date.UTC(2025, 11, 31), Date.UTC(2026, 0, 10)].map(dayKey);
    expect([...days].sort()).toEqual(['2025-12-31', '2026-01-02', '2026-01-10']);
  });
});

describe('the vocabulary itself', () => {
  it('every event in the table is accepted by the parser', () => {
    for (const name of EVENT_NAMES) {
      const out = parseAnalyticsBatch(batch({ events: [{ name, at: SENT }] }), NOW);
      expect(out, `${name} was refused`).not.toBeNull();
    }
  });

  it('every declared field is reachable — no spec entry is dead', () => {
    // A field nobody can set is a field the client cannot send, and it would sit in the
    // table looking collected.
    const sample: Record<string, unknown> = { id: 'x', int: 0 };
    for (const name of EVENT_NAMES) {
      const spec = specFor(name)!;
      for (const [field, fieldSpec] of Object.entries(spec)) {
        const value =
          fieldSpec.kind === 'enum' ? fieldSpec.values[0] : fieldSpec.kind === 'id' ? sample.id : fieldSpec.min;
        const out = parseAnalyticsBatch(batch({ events: [{ name, at: SENT, props: { [field]: value } }] }), NOW);
        expect(out!.events[0]!.props, `${name}.${field} did not survive`).toHaveProperty(field);
      }
    }
  });

  it('refuses a name outside the table, including one inherited from Object', () => {
    for (const name of ['no_such_event', 'constructor', '__proto__', 'toString']) {
      expect(parseAnalyticsBatch(batch({ events: [{ name, at: SENT }] }), NOW), name).toBeNull();
    }
  });
});
