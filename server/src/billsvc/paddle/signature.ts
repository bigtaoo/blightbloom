/**
 * Paddle Billing webhook signature verification (design/19-server-platform.md §9, ROADMAP
 * 9.1). Pure: no env, no clock, no I/O — the secret, the header, the raw bytes and "now" all
 * arrive as arguments, so every branch is a plain unit test.
 *
 * THE ALGORITHM, as Paddle documents it (developer.paddle.com, "Verify webhook signatures",
 * read 2026-09-26):
 *
 *   header   `Paddle-Signature: ts=<unix seconds>;h1=<hex>` — "Signatures contain at least
 *            one h1"; during a secret rotation "more than one h1 is returned", so ANY h1
 *            that matches is accepted.
 *   payload  `${ts}:${rawBody}` — the timestamp, a colon, and the body EXACTLY as it arrived.
 *            "Don't transform or process the raw body of the request" — which is why the
 *            webhook route hands this function the bytes and never a parsed object.
 *   hmac     HMAC-SHA256 keyed with the notification destination's secret, hex-encoded.
 *
 * THE TOLERANCE IS 5 SECONDS, EACH WAY. That is the documented default ("The SDK helper
 * methods enforce a five-second timestamp tolerance by default to protect against replay
 * attacks; manual implementations should apply the same check"). It is tight, and that is
 * acceptable here for a reason specific to push webhooks: a refusal is not a lost payment,
 * because Paddle re-sends a non-2xx notification with a fresh signature. The failure mode of
 * a drifting server clock is therefore a stream of `stale`/`future` log lines naming the skew
 * in seconds — loud and fixable — not a silent loss. A FUTURE timestamp is bounded too:
 * accepting any ts ahead of the clock would let one captured request be replayed for as long
 * as the attacker cared to pre-date it.
 *
 * `timingSafeEqual` is called INSIDE a try (design/19 §9's third funny trap): it throws on a
 * length mismatch, and a malformed h1 must be a refusal, not a 500. Non-hex / wrong-length h1
 * values are filtered out before comparison anyway, so the try is belt to that braces.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The documented default, in seconds. See the header for why it is kept rather than widened. */
export const PADDLE_SIGNATURE_TOLERANCE_S = 5;

/** The header name as Paddle sends it. node lower-cases incoming header names. */
export const PADDLE_SIGNATURE_HEADER = 'paddle-signature';

export type PaddleSignatureFailure =
  | 'missing-header'
  | 'malformed-header'
  | 'stale-timestamp'
  | 'future-timestamp'
  | 'signature-mismatch';

export type PaddleSignatureCheck = { ok: true; ts: number } | { ok: false; reason: PaddleSignatureFailure; detail: string };

export interface ParsedPaddleSignature {
  ts: number;
  /** Every well-formed h1 in the header, lower-cased. Never empty. */
  h1: string[];
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Parse `ts=<digits>;h1=<hex>[;h1=<hex>...]`. `null` for anything else: no ts, a non-numeric
 * ts, two ts values (which one would be the signed one?), or no well-formed h1 at all.
 * Unknown keys are ignored — Paddle may add a scheme later, and an `h2` must not make today's
 * `h1` unverifiable.
 */
export function parsePaddleSignature(header: string): ParsedPaddleSignature | null {
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') {
      if (ts !== null || !/^\d{1,12}$/.test(value)) return null;
      ts = Number(value);
    } else if (key === 'h1' && HEX_SHA256.test(value)) {
      h1.push(value.toLowerCase());
    }
  }
  if (ts === null || h1.length === 0) return null;
  return { ts, h1 };
}

/** HMAC-SHA256(secret, `${ts}:` + rawBody), hex. Exported so a test can sign a fixture. */
export function paddleSignatureFor(secret: string, ts: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest('hex');
}

/** Exported for its own test: the catch arm is unreachable through `verifyPaddleSignature`. */
export function constantTimeHexEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export interface VerifyPaddleSignatureInput {
  /** The raw `Paddle-Signature` header value; an array (a repeated header) is refused. */
  header: string | string[] | undefined;
  /** The request body EXACTLY as received. */
  rawBody: Buffer | string;
  secret: string;
  nowMs: number;
  toleranceS?: number;
}

/**
 * The whole check. The timestamp window is tested BEFORE the HMAC, so a replayed request is
 * named as stale rather than as a forgery — the two mean different things to whoever reads
 * the log line — and every h1 is compared (no early exit) so the time taken does not say which
 * of several rotated secrets matched.
 */
export function verifyPaddleSignature(input: VerifyPaddleSignatureInput): PaddleSignatureCheck {
  const { header } = input;
  if (header === undefined || header === '') {
    return { ok: false, reason: 'missing-header', detail: 'no Paddle-Signature header' };
  }
  if (typeof header !== 'string') {
    return { ok: false, reason: 'malformed-header', detail: 'Paddle-Signature header repeated' };
  }
  const parsed = parsePaddleSignature(header);
  if (!parsed) return { ok: false, reason: 'malformed-header', detail: 'Paddle-Signature is not ts=<n>;h1=<hex>' };

  const tolerance = input.toleranceS ?? PADDLE_SIGNATURE_TOLERANCE_S;
  const skewS = Math.floor(input.nowMs / 1000) - parsed.ts;
  if (skewS > tolerance) {
    return { ok: false, reason: 'stale-timestamp', detail: `signed ${skewS}s ago, tolerance ${tolerance}s` };
  }
  if (-skewS > tolerance) {
    return { ok: false, reason: 'future-timestamp', detail: `signed ${-skewS}s in the future, tolerance ${tolerance}s` };
  }

  const expected = paddleSignatureFor(input.secret, parsed.ts, input.rawBody);
  let matched = false;
  for (const candidate of parsed.h1) {
    if (constantTimeHexEqual(candidate, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'signature-mismatch', detail: `none of ${parsed.h1.length} h1 value(s) matched` };
  return { ok: true, ts: parsed.ts };
}
