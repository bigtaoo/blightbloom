/**
 * `src/internalAuth.ts` — the inbound half of the internal trust seam (design/19 §3,
 * ROADMAP 8.1). Every case here is a REFUSAL path or a near-miss, because that is the whole
 * value of the module: the happy path was already reachable before this file existed (the
 * route simply answered 200 for everyone), so a test that only proves "the right key works"
 * proves nothing that was broken.
 *
 * Four shapes are worth naming, since each is a way an authentication check is written that
 * looks correct and is not:
 *
 *  - **An empty registry that allows.** The fail-closed branch `config.ts` returns under
 *    `NODE_ENV=production` with no key configured. "No keys" must mean "nobody", and the
 *    obvious `entries.some(...)` over an empty array is vacuously false in the safe
 *    direction only by accident — so it is pinned, not assumed.
 *  - **A length mismatch that throws.** `timingSafeEqual` throws on differing lengths, and
 *    a key is operator-chosen so lengths genuinely differ. A throw out of a request handler
 *    is not a rejection; it is a 500 at best.
 *  - **A player token accepted as an internal key.** design/19's third-namespace rule. This
 *    is asserted here at the unit layer and again over real HTTP with a REAL session token
 *    in `internalTrustSeam.http.test.ts`.
 *  - **The advisory caller header becoming load-bearing.** `x-internal-caller` is attacker
 *    controlled. If it were used to select which key to compare against, an attacker would
 *    choose their own examiner; if it were echoed into a log unsanitized, they would write
 *    the audit trail. Both are pinned below.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_KEY_HEADER,
  createInternalVerifier,
  describeInternalAuthFailure,
  sanitizeAuditValue,
  type InternalAuthResult,
} from '../src/internalAuth';

const GAMESERVER_KEY = 'a-real-internal-key-0123456789';
const REGISTRY = [{ caller: 'gameserver', key: GAMESERVER_KEY }];

const headers = (h: Record<string, string | string[] | undefined>): IncomingHttpHeaders =>
  h as IncomingHttpHeaders;

/** Narrow to the refusal arm so a case can read `.reason` without a non-null assertion. */
function refusal(result: InternalAuthResult): Extract<InternalAuthResult, { ok: false }> {
  expect(result.ok).toBe(false);
  return result as Extract<InternalAuthResult, { ok: false }>;
}

describe('createInternalVerifier — accepts exactly the configured key', () => {
  it('accepts the registered key and reports the caller the KEY names', () => {
    const v = createInternalVerifier(REGISTRY);
    expect(v.verify(headers({ [INTERNAL_KEY_HEADER]: GAMESERVER_KEY }))).toEqual({
      ok: true,
      caller: 'gameserver',
      claimedCaller: undefined,
    });
  });

  it('carries the advisory x-internal-caller through on success, for the audit line only', () => {
    const v = createInternalVerifier(REGISTRY);
    const result = v.verify(
      headers({ [INTERNAL_KEY_HEADER]: GAMESERVER_KEY, [INTERNAL_CALLER_HEADER]: 'gameserver-2' }),
    );
    expect(result).toEqual({ ok: true, caller: 'gameserver', claimedCaller: 'gameserver-2' });
    // The authoritative identity is the registry entry that matched, NOT the header — they
    // deliberately disagree here, and `caller` follows the key.
    expect(result.ok && result.caller).toBe('gameserver');
  });

  it('picks the matching entry out of a multi-caller registry (the shape 8.3 grows into)', () => {
    const v = createInternalVerifier([
      { caller: 'gameserver', key: GAMESERVER_KEY },
      { caller: 'billsvc', key: 'a-different-key-for-billing' },
    ]);
    expect(v.verify(headers({ [INTERNAL_KEY_HEADER]: 'a-different-key-for-billing' }))).toMatchObject({
      ok: true,
      caller: 'billsvc',
    });
    expect(v.verify(headers({ [INTERNAL_KEY_HEADER]: GAMESERVER_KEY }))).toMatchObject({
      ok: true,
      caller: 'gameserver',
    });
  });
});

describe('createInternalVerifier — refusals', () => {
  it('an EMPTY registry rejects everything, including a plausible key (fail closed)', () => {
    const v = createInternalVerifier([]);
    expect(refusal(v.verify(headers({}))).reason).toBe('no-keys-configured');
    expect(refusal(v.verify(headers({ [INTERNAL_KEY_HEADER]: GAMESERVER_KEY }))).reason).toBe(
      'no-keys-configured',
    );
  });

  it('no key header at all', () => {
    const v = createInternalVerifier(REGISTRY);
    expect(refusal(v.verify(headers({}))).reason).toBe('missing-key');
  });

  it('an EMPTY key header is missing, not an empty-string key to compare', () => {
    const v = createInternalVerifier(REGISTRY);
    expect(refusal(v.verify(headers({ [INTERNAL_KEY_HEADER]: '' }))).reason).toBe('missing-key');
  });

  it('a non-string (array) header value is treated as absent, never coerced', () => {
    // Node comma-joins duplicates of an ordinary header, so this is not reachable over real
    // HTTP — but the TYPE admits it, and `String(['a','b'])` would compare against "a,b".
    const v = createInternalVerifier(REGISTRY);
    expect(refusal(v.verify(headers({ [INTERNAL_KEY_HEADER]: [GAMESERVER_KEY, 'x'] }))).reason).toBe(
      'missing-key',
    );
  });

  it('a wrong key of the SAME length', () => {
    const wrong = 'b-real-internal-key-0123456789';
    expect(wrong).toHaveLength(GAMESERVER_KEY.length); // the case is only interesting if so
    const v = createInternalVerifier(REGISTRY);
    expect(refusal(v.verify(headers({ [INTERNAL_KEY_HEADER]: wrong }))).reason).toBe('unknown-key');
  });

  it.each([
    ['much shorter', 'a'],
    ['one byte short', GAMESERVER_KEY.slice(0, -1)],
    ['a prefix plus one byte', `${GAMESERVER_KEY}x`],
    ['much longer', GAMESERVER_KEY.repeat(20)],
  ])('a wrong key of a DIFFERENT length rejects without throwing: %s', (_label, presented) => {
    // `timingSafeEqual` throws on a length mismatch; hashing both sides is what makes this
    // a plain refusal instead of an exception out of a request handler.
    const v = createInternalVerifier(REGISTRY);
    let result: InternalAuthResult | undefined;
    expect(() => {
      result = v.verify(headers({ [INTERNAL_KEY_HEADER]: presented }));
    }).not.toThrow();
    expect(refusal(result!).reason).toBe('unknown-key');
  });

  it('a valid-looking PLAYER session token presented as the internal key is just a wrong key', () => {
    // design/19's third-namespace rule, at the unit layer. `AuthService` tokens are opaque
    // hex; nothing here can tell one from noise, which is the point — there is no code path
    // that would consult the session store.
    const playerToken = '9f2c1ab4d5e6f70819a2b3c4d5e6f7081';
    const v = createInternalVerifier(REGISTRY);
    expect(refusal(v.verify(headers({ [INTERNAL_KEY_HEADER]: playerToken }))).reason).toBe('unknown-key');
  });

  it('an Authorization: Bearer header is not read at all — it cannot authenticate anything here', () => {
    const v = createInternalVerifier(REGISTRY);
    const result = v.verify(
      headers({ authorization: `Bearer ${GAMESERVER_KEY}`, [INTERNAL_CALLER_HEADER]: 'gameserver' }),
    );
    // Even carrying the REAL internal key, in the wrong header, under the caller name that
    // owns it: refused, because this namespace has exactly one door.
    expect(refusal(result).reason).toBe('missing-key');
  });

  it('the advisory caller header cannot buy access on its own', () => {
    const v = createInternalVerifier(REGISTRY);
    const result = refusal(v.verify(headers({ [INTERNAL_CALLER_HEADER]: 'gameserver' })));
    expect(result.reason).toBe('missing-key');
    expect(result.claimedCaller).toBe('gameserver'); // recorded, never trusted
  });
});

describe('sanitizeAuditValue — the untrusted header never writes the log', () => {
  it('strips newlines and carriage returns, so a fake log record cannot be injected', () => {
    const hostile = 'gameserver\n[blightbloom] internal auth ACCEPTED everything\r\n';
    expect(sanitizeAuditValue(hostile)).toBe('gameserver[blightbloom] internal auth ACCEPTED everything');
    expect(sanitizeAuditValue(hostile)).not.toContain('\n');
  });

  it('strips other control characters, DEL included', () => {
    const withControls = `a${String.fromCharCode(0x7f)}bcd${String.fromCharCode(0x09)}E${String.fromCharCode(0x00)}`;
    expect(sanitizeAuditValue(withControls)).toBe('abcdE');
  });

  it('truncates a long value and marks it as truncated', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeAuditValue(long, 10);
    expect(out).toBe(`${'x'.repeat(10)}...`);
  });

  it('leaves an ordinary caller name exactly as it is', () => {
    expect(sanitizeAuditValue('gameserver')).toBe('gameserver');
  });

  it('a value that is exactly at the limit is NOT truncated (boundary, not >=)', () => {
    expect(sanitizeAuditValue('abcde', 5)).toBe('abcde');
    expect(sanitizeAuditValue('abcdef', 5)).toBe('abcde...');
  });
});

describe('describeInternalAuthFailure — the audit line', () => {
  it('names the route and the reason', () => {
    const line = describeInternalAuthFailure({ ok: false, reason: 'unknown-key' }, 'POST /rating/report');
    expect(line).toContain('POST /rating/report');
    expect(line).toContain('unknown-key');
    expect(line).toContain('unidentified'); // no claim was made
  });

  it('quotes the caller claim when one was made, sanitized', () => {
    const line = describeInternalAuthFailure(
      { ok: false, reason: 'missing-key', claimedCaller: 'bill\nsvc' },
      'POST /rating/report',
    );
    expect(line).toContain('claimed "billsvc"');
    expect(line.split('\n')).toHaveLength(1); // one record, whatever the caller sent
  });
});
