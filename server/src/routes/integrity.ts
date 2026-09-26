/**
 * The `/integrity/*` route group (design/15, "PvP integrity", decided 2026-09-26): the
 * gameserver POSTs a PvP match that did not settle cleanly, and `IntegrityStore` records it.
 *
 * Internal-key gated exactly like `POST /rating/report` beside it, and for the same reason:
 * only the gameserver knows how a room settled. It is not public, and there is no read route —
 * the only reader is the ops console, which goes to the database directly.
 *
 * The one thing that differs from its sibling is the body limit. A record carries the match's
 * gzipped input log, which is far past the 4 KB every other route accepts; see
 * {@link INTEGRITY_BODY_LIMIT}.
 */
import type { IntegrityStore } from '../integrity';
import { MAX_LOG_GZIP_BYTES, type IntegrityReportBody } from '../integrityReport';
import { internalKeys } from '../config';
import { createInternalVerifier, describeInternalAuthFailure, type InternalVerifier } from '../internalAuth';
import { readJsonBodyUpTo, send, type RouteHandler } from './http';

/** The sender's log cap, base64-inflated (4/3), plus room for everything else in the body. */
export const INTEGRITY_BODY_LIMIT = Math.ceil((MAX_LOG_GZIP_BYTES * 4) / 3) + 64 * 1024;

const VERDICTS = new Set(['dissent', 'no_consensus', 'bounds']);

export interface IntegrityRouteDeps {
  integrity: IntegrityStore;
  /** Same seam as `RatingRouteDeps.internalAuth`: optional, and the default is the real check. */
  internalAuth?: InternalVerifier;
}

const isSeat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * Whether `body` is a well-formed `IntegrityReportBody`. The sender is trusted (it holds the
 * internal key), so this is not a security boundary — it is what keeps a version-skewed or
 * buggy sender from writing a document the console then fails to render.
 */
export function isIntegrityReportBody(body: unknown): body is IntegrityReportBody {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.roomId !== 'string' || b.roomId.length === 0 || b.roomId.length > 256) return false;
  if (typeof b.verdict !== 'string' || !VERDICTS.has(b.verdict)) return false;
  if (b.bounds !== undefined && typeof b.bounds !== 'string') return false;
  for (const k of ['playerCount', 'seed', 'engineVersion', 'settleFrame'] as const) {
    if (!isSeat(b[k])) return false;
  }
  if (!Array.isArray(b.suspects)) return false;
  for (const s of b.suspects as unknown[]) {
    if (s === null || typeof s !== 'object') return false;
    const r = s as Record<string, unknown>;
    if (!isSeat(r.seat) || typeof r.dissented !== 'boolean' || typeof r.kicked !== 'boolean') return false;
    if (r.accountId !== undefined && typeof r.accountId !== 'string') return false;
  }
  if (b.seatAccounts === null || typeof b.seatAccounts !== 'object' || Array.isArray(b.seatAccounts)) return false;
  if (!Object.values(b.seatAccounts).every((v) => typeof v === 'string')) return false;
  if (b.logGzipB64 !== undefined && typeof b.logGzipB64 !== 'string') return false;
  if (b.logDropped !== undefined && typeof b.logDropped !== 'boolean') return false;
  return true;
}

/** `POST /integrity/report` → `{ recorded }`; a retried report answers `recorded: false`. */
export const postIntegrityReport: RouteHandler<IntegrityRouteDeps> = async (req, res, _url, deps) => {
  const verifier = deps.internalAuth ?? createInternalVerifier(internalKeys().registry);
  const auth = verifier.verify(req.headers);
  if (!auth.ok) {
    console.warn(describeInternalAuthFailure(auth, 'POST /integrity/report'));
    return send(res, 401, { error: 'unauthorized' });
  }
  const body = await readJsonBodyUpTo(req, INTEGRITY_BODY_LIMIT);
  if (!isIntegrityReportBody(body)) return send(res, 400, { error: 'malformed integrity report' });
  try {
    // 200 either way, for the reason `routes/rating.ts` gives for its duplicates: the sender
    // retries anything else, and a record that already exists is the right final answer.
    send(res, 200, { recorded: await deps.integrity.recordOnce(body) });
  } catch (e) {
    console.error(
      `[blightbloom] matchsvc: /integrity/report failed to store: ${e instanceof Error ? e.message : String(e)}`,
    );
    send(res, 500, { error: 'integrity store failed' });
  }
};
