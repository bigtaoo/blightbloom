/**
 * Paddle webhook signature verification (ROADMAP 9.1/9.4) — "the one component whose bug is
 * silent and total", so it is tested against the documented algorithm rather than against
 * itself.
 *
 * WHERE THE VECTOR COMES FROM, stated plainly because it matters: Paddle's "Verify webhook
 * signatures" page (developer.paddle.com, read 2026-09-26) documents the ALGORITHM — header
 * `ts=<unix seconds>;h1=<hex>`, signed payload `${ts}:${rawBody}`, HMAC-SHA256 keyed with the
 * destination secret, hex — and shows an example header, but it does NOT publish a complete
 * test vector (no secret/body pair that produces its example h1). So the expected h1 below is
 * SELF-COMPUTED with `node:crypto`'s `createHmac` directly from that documented algorithm,
 * written out independently of `paddleSignatureFor` so the two implementations check each
 * other. It is not an official Paddle vector. The first real notification from a Paddle
 * sandbox destination is the end-to-end proof, and that is an owner step (ROADMAP 9.4).
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  constantTimeHexEqual,
  paddleSignatureFor,
  parsePaddleSignature,
  PADDLE_SIGNATURE_TOLERANCE_S,
  verifyPaddleSignature,
} from '../src/billsvc/paddle/signature';

const SECRET = 'pdl_ntfset_01hv8x0000000000000000000_test-only-secret';
/** The fixture's bytes EXACTLY as stored — whitespace, key order and all. */
const RAW = readFileSync(new URL('./fixtures/paddle/transaction.completed.json', import.meta.url));
const TS = 1790418000; // 2026-09-26T10:20:00Z
const NOW = TS * 1000;

/** The documented algorithm, spelled out by hand — NOT via the module under test. */
function documentedH1(secret: string, ts: number, raw: Buffer): string {
  const signedPayload = Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), raw]);
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

const H1 = documentedH1(SECRET, TS, RAW);

describe('the documented algorithm', () => {
  it('the module computes the same h1 as the hand-written documented algorithm', () => {
    expect(paddleSignatureFor(SECRET, TS, RAW)).toBe(H1);
    expect(H1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a valid signature over the raw fixture bytes', () => {
    expect(verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: NOW })).toEqual({ ok: true, ts: TS });
  });

  it('accepts an upper-case h1 and whitespace around the pairs', () => {
    const res = verifyPaddleSignature({ header: ` ts=${TS} ; h1=${H1.toUpperCase()} `, rawBody: RAW, secret: SECRET, nowMs: NOW });
    expect(res.ok).toBe(true);
  });

  it('a RE-SERIALISED body fails — the reason the route reads raw bytes', () => {
    const reserialised = JSON.stringify(JSON.parse(RAW.toString('utf8')));
    expect(reserialised).not.toBe(RAW.toString('utf8'));
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: reserialised, secret: SECRET, nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });
});

describe('refusals', () => {
  it('a tampered body is a mismatch', () => {
    const tampered = Buffer.from(RAW.toString('utf8').replace('"296"', '"1"'));
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: tampered, secret: SECRET, nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });

  it('the wrong secret is a mismatch', () => {
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: 'another-destination', nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });

  it('a signature re-used under a different ts is a mismatch (the ts is signed)', () => {
    const res = verifyPaddleSignature({ header: `ts=${TS + 1};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'signature-mismatch' });
  });

  it('a stale ts beyond the tolerance is refused as STALE, before the HMAC is even checked', () => {
    const late = NOW + (PADDLE_SIGNATURE_TOLERANCE_S + 1) * 1000;
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: late });
    expect(res).toMatchObject({ ok: false, reason: 'stale-timestamp' });
    // Named as a replay, not a forgery, even with a perfectly good signature.
    expect(res.ok === false && res.detail).toContain('6s ago');
  });

  it('the tolerance edge is inclusive on both sides', () => {
    const edge = PADDLE_SIGNATURE_TOLERANCE_S * 1000;
    for (const now of [NOW + edge, NOW - edge]) {
      expect(verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: now }).ok).toBe(true);
    }
  });

  it('a future ts beyond the tolerance is refused as FUTURE', () => {
    const early = NOW - (PADDLE_SIGNATURE_TOLERANCE_S + 1) * 1000;
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: early });
    expect(res).toMatchObject({ ok: false, reason: 'future-timestamp' });
  });

  it('a custom tolerance is honoured', () => {
    const late = NOW + 30_000;
    expect(verifyPaddleSignature({ header: `ts=${TS};h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: late, toleranceS: 60 }).ok).toBe(true);
  });

  it('a missing header is refused as missing (undefined and empty alike)', () => {
    for (const header of [undefined, '']) {
      expect(verifyPaddleSignature({ header, rawBody: RAW, secret: SECRET, nowMs: NOW })).toMatchObject({ ok: false, reason: 'missing-header' });
    }
  });

  it('a repeated header (node hands an array) is refused as malformed', () => {
    const res = verifyPaddleSignature({ header: [`ts=${TS};h1=${H1}`, `ts=${TS};h1=${H1}`], rawBody: RAW, secret: SECRET, nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'malformed-header' });
  });

  it.each([
    ['no ts', `h1=${'a'.repeat(64)}`],
    ['no h1', `ts=${TS}`],
    ['non-numeric ts', `ts=soon;h1=${'a'.repeat(64)}`],
    ['two ts values', `ts=${TS};ts=${TS};h1=${'a'.repeat(64)}`],
    ['a non-hex h1 only', `ts=${TS};h1=not-hex-at-all`],
    ['a short h1 only', `ts=${TS};h1=abcd`],
    ['garbage', 'this is not a signature'],
    ['a bare key', `ts;h1`],
  ])('a malformed header (%s) is refused, never thrown', (_label, header) => {
    expect(verifyPaddleSignature({ header, rawBody: RAW, secret: SECRET, nowMs: NOW })).toMatchObject({ ok: false, reason: 'malformed-header' });
  });
});

describe('multiple h1 values (secret rotation)', () => {
  const OLD = documentedH1('the-old-secret', TS, RAW);

  it('accepts when ANY h1 matches, whichever position it is in', () => {
    for (const header of [`ts=${TS};h1=${OLD};h1=${H1}`, `ts=${TS};h1=${H1};h1=${OLD}`]) {
      expect(verifyPaddleSignature({ header, rawBody: RAW, secret: SECRET, nowMs: NOW }).ok).toBe(true);
    }
  });

  it('refuses when none match, and says how many were tried', () => {
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=${OLD};h1=${'0'.repeat(64)}`, rawBody: RAW, secret: SECRET, nowMs: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'signature-mismatch' });
    expect(res.ok === false && res.detail).toContain('2 h1');
  });

  it('a malformed h1 next to a good one is skipped, not fatal; unknown keys are ignored', () => {
    const res = verifyPaddleSignature({ header: `ts=${TS};h1=zz;h2=whatever;h1=${H1}`, rawBody: RAW, secret: SECRET, nowMs: NOW });
    expect(res.ok).toBe(true);
    expect(parsePaddleSignature(`ts=${TS};h1=zz;h1=${H1}`)).toEqual({ ts: TS, h1: [H1] });
  });
});

describe('constantTimeHexEqual', () => {
  it('compares equal digests true and different ones false', () => {
    expect(constantTimeHexEqual(H1, H1)).toBe(true);
    expect(constantTimeHexEqual(H1, '0'.repeat(64))).toBe(false);
  });

  it('a length mismatch is false, not a throw (timingSafeEqual throws on it)', () => {
    expect(constantTimeHexEqual(H1, 'abcd')).toBe(false);
  });
});
