/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/rating/*`
 * route group (design/15, ROADMAP 4.6): the settled-match report the gameserver POSTs once
 * a PvP match resolves with a checkpoint/hash-verified placement result (never the client
 * directly; the gameserver is the one that knows `hashOk`), plus the per-account lookup.
 *
 * ROADMAP 8.1 (2026-09-04) landed here: `POST /rating/report` is now behind
 * `internalAuth.ts`'s timing-safe `x-internal-key`, closing design/19's D1 — the route had
 * no key, no origin check and open CORS while being the one endpoint that can move any
 * account's ladder rating, so anyone could POST an arbitrary placement for an arbitrary
 * `accountId`. `GET /rating/:accountId` is deliberately NOT gated: it is a public read of a
 * player's own visible rank, and it writes nothing.
 *
 * And 8.1's one open item is closed here (design/19 §3): the report carries a `reportKey`,
 * `RatingStore.applyMatchOnce` claims it in the same transaction that moves the ratings, and
 * a LOST claim answers **200 with `duplicate: true`** — see `postReport` for why that is not
 * a 409.
 */
import type { RatingChange, RatingStore } from '../rating';
import { internalKeys } from '../config';
import {
  createInternalVerifier,
  describeInternalAuthFailure,
  sanitizeAuditValue,
  type InternalVerifier,
} from '../internalAuth';
import { readJson, send, type RouteHandler } from './http';

/**
 * A sanity bound on the dedupe key, which becomes a PRIMARY KEY value. `ladderReport.ts`
 * produces ~53 characters (a UUID room id plus a 16-hex digest); `readJson` already caps the
 * whole body at 4 KB, so this is not the size defence — it is the "this is not a key we
 * generated" signal, which is worth refusing loudly rather than storing.
 */
export const MAX_REPORT_KEY_LENGTH = 256;

export interface RatingRouteDeps {
  ratings: RatingStore;
  /**
   * Internal-key verifier override. OPTIONAL, and the default is not "no auth" — it is a
   * verifier built from `config.ts`'s env-derived registry, so a caller that wires nothing
   * (which is every caller today: `matchsvc.ts` builds one untyped `deps` bundle for all
   * five route groups) still gets the real check. The seam exists so a test can pin a
   * registry without touching `process.env`, the same way `MatchsvcServerOptions.secret`
   * pins the ticket secret.
   */
  internalAuth?: InternalVerifier;
}

/** `GET /rating/:accountId` — checked after `POST /rating/report`, which it would shadow. */
export const RATING_LOOKUP_PATH = /^\/rating\/([^/]+)$/;

export const postReport: RouteHandler<RatingRouteDeps> = (req, res, _url, deps) => {
  const verifier = deps.internalAuth ?? createInternalVerifier(internalKeys().registry);
  const auth = verifier.verify(req.headers);
  if (!auth.ok) {
    // The rejection is logged and the response is not: the caller learns only "unauthorized",
    // while the reason (and the caller's own advisory, untrusted `x-internal-caller` claim)
    // goes to the operator — design/19 §7's "log every event, not just the successful one",
    // applied to the seam that is worth watching first.
    console.warn(describeInternalAuthFailure(auth, 'POST /rating/report'));
    return send(res, 401, { error: 'unauthorized' });
  }

  readJson(req, (body) => {
    const { accountIds, places, teamIds, reportKey } =
      (body as { accountIds?: unknown; places?: unknown; teamIds?: unknown; reportKey?: unknown }) ?? {};
    if (!Array.isArray(accountIds) || !Array.isArray(places) || accountIds.length !== places.length) {
      return send(res, 400, { error: 'accountIds and places must be equal-length arrays' });
    }
    if (teamIds !== undefined && (!Array.isArray(teamIds) || teamIds.length !== accountIds.length)) {
      return send(res, 400, { error: 'teamIds, if present, must be the same length as accountIds' });
    }
    if (reportKey !== undefined && (typeof reportKey !== 'string' || reportKey.length === 0 || reportKey.length > MAX_REPORT_KEY_LENGTH)) {
      return send(res, 400, { error: `reportKey, if present, must be a non-empty string of at most ${MAX_REPORT_KEY_LENGTH} characters` });
    }

    try {
      // A THROWN apply is a 5xx, not an escaped exception. `applyMatchOnce` rolls its claim
      // back before rethrowing, so the report has provably not been applied — and a 5xx is
      // the one status `internalFetch` retries, which is exactly what should happen next.
      // Without this the throw would escape a `req.on('end')` handler, where node answers
      // nothing at all and the caller waits out its own timeout instead.
      send(res, 200, applyReport(deps, accountIds as string[], places as number[], teamIds as number[] | undefined, reportKey));
    } catch (e) {
      // `sanitizeAuditValue` for the same reason `internalAuth.ts` uses it on the caller
      // claim: `reportKey` arrives in a request body, and a newline in it would forge a
      // second line into the log an operator reads this one from.
      console.error(
        `[blightbloom] matchsvc: /rating/report failed to apply${
          typeof reportKey === 'string' ? ` (reportKey ${sanitizeAuditValue(reportKey)})` : ''
        }: ${e instanceof Error ? e.message : String(e)}`,
      );
      send(res, 500, { error: 'rating apply failed' });
    }
  });
};

/**
 * The body of a successful report, and the one decision in this file worth arguing.
 *
 * A LOST claim answers **200 with `duplicate: true`**, not 409. The caller is
 * `reportSettledMatch`, an at-least-once sender with a retry budget: a 409 is a non-2xx, so
 * `internalFetch` would count it a failure, log a scary "ladder report failed" line naming a
 * match whose rating actually landed, and — for the retryable statuses — keep asking. A
 * duplicate is not a failure; it is the correct, final answer to "please make sure this was
 * applied". 200 stops the ladder on the first attempt that reaches an already-applied
 * report, which is the proper end of at-least-once delivery meeting an idempotent receiver.
 * The marker is in the body so an operator can still tell the two apart in a log.
 *
 * A report with NO `reportKey` is applied the old, non-deduped way rather than refused. Only
 * one process legitimately calls this route, so a keyless report means version skew across a
 * rolling deploy (an older gameserver against a newer matchsvc), and the two outcomes are:
 * accept it and risk 8.1's bounded double-apply, or 400 it and lose those matches' ratings
 * permanently, since `internalFetch` never retries a 4xx. The first is recoverable and the
 * second is not. It is logged, because "the gameserver has not been redeployed yet" is
 * something an operator can act on and a silent fallback is not. This is not a security
 * hole to keep small: the route is internal-key gated, and anyone who can reach it can
 * already post whatever placements they like.
 */
function applyReport(
  deps: RatingRouteDeps,
  accountIds: string[],
  places: number[],
  teamIds: number[] | undefined,
  reportKey: string | undefined,
): { duplicate: boolean; changes: RatingChange[]; reportKey?: string } {
  if (reportKey === undefined) {
    console.warn(
      '[blightbloom] matchsvc: /rating/report with no reportKey — applied WITHOUT the ' +
        'exactly-once claim (design/19 §3). A retried delivery of this report will double-apply it; ' +
        'the sender is running a pre-8.1-followup gameserver.',
    );
    return { duplicate: false, changes: deps.ratings.applyMatch(accountIds, places, teamIds) };
  }
  const result = deps.ratings.applyMatchOnce(reportKey, accountIds, places, teamIds);
  return result.applied
    ? { duplicate: false, reportKey, changes: result.changes }
    : { duplicate: true, reportKey, changes: [] };
}

export const getRating: RouteHandler<RatingRouteDeps> = (_req, res, url, deps) => {
  const accountId = decodeURIComponent(url.pathname.match(RATING_LOOKUP_PATH)![1]!);
  send(res, 200, { accountId, rating: deps.ratings.get(accountId) });
};
