/**
 * The console's flag routes (design/21 §4): the internal endpoint services poll, and the two
 * write paths — set and clear.
 *
 * A sibling of `routes.ts` rather than more of it, for the reason the 500-line convention
 * gives and one better: these three handlers are the only ones in this process that WRITE
 * anything, and the only one that authenticates with something other than the operator
 * cookie. Keeping them in their own file means "what can this console change, and who is
 * allowed to ask" is a question with a file for an answer.
 *
 * ## Two different credentials, and neither is the other's fallback
 *
 * `GET /internal/flags` is authenticated by `x-internal-key` (design/19 §3) and by nothing
 * else — it never looks at a cookie. `POST /admin/flags/{set,clear}` is authenticated by
 * the operator session and by nothing else — it never looks at an internal key. That
 * separation is the same one `internalAuth.ts`'s header describes for matchsvc: there is no
 * code path in which one credential could be accepted in the other's place, because neither
 * handler contains a read of the other's header.
 *
 * ## Why the internal endpoint is not behind Caddy, and what actually keeps it out
 *
 * Caddy proxies `/admin*` to this process. `/internal/flags` is not under `/admin`, so no
 * reverse-proxy route reaches it at all — it is answerable only over the compose network.
 * That is the primary control, and it is a routing fact rather than a check. The
 * `x-internal-key` on top is what makes it safe if that fact ever changes, which is the
 * same layering matchsvc's `/metrics` uses (an `x-forwarded-for` refusal behind a route
 * nobody should be able to reach).
 *
 * ## CSRF
 *
 * Not a separate mechanism: the session cookie is `SameSite=Strict`, so a form on another
 * origin cannot cause the browser to attach it, and the two write routes are refused
 * without it. There is no token to forget to check because there is no cross-site request
 * that could carry a session.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { describeInternalAuthFailure, sanitizeAuditValue, type InternalVerifier } from '../internalAuth';
import { effectiveFlags, clearFlag, setFlag } from '../flags/store';
import { FLAG_DEFS, isFlagName, type FlagName } from '../flags/defs';
import { readForm, redirect, sendJson } from './http';
import { authed, ADMIN_ROOT, type AdminRouteDeps } from './routes';
import { notFound } from './routes';

/** The internal path services poll. Defined in `flags/client.ts` — the poller and the
 *  route it calls must name one string, or the two agree in review and disagree at
 *  runtime with nothing red. */
export { INTERNAL_FLAGS_PATH } from '../flags/client';

/** Where the console's flag tab lives, and where a write redirects back to. */
export const FLAGS_TAB_URL = `${ADMIN_ROOT}?tab=flags`;
export const FLAGS_SET_PATH = '/admin/flags/set';
export const FLAGS_CLEAR_PATH = '/admin/flags/clear';

export interface FlagRouteDeps extends AdminRouteDeps {
  /**
   * `ops.db`, or `null` when this deployment has no flag store.
   *
   * Null is a real state, not a defensive one: `BB_OPS_DB_PATH` unset means the console
   * shows no flag tab and `/internal/flags` answers 503, so every service stays on its
   * compiled-in defaults — which is Phase C's fail-safe posture arriving through
   * configuration rather than through a failure. A deployment that never wants a remote
   * switch simply does not set the variable.
   */
  opsDb: DatabaseSync | null;
  /**
   * Internal-key verifier for `GET /internal/flags`. REQUIRED, not optional.
   *
   * An optional one would need a default, and the only safe default is
   * `createInternalVerifier([])` — an empty registry that rejects everything. That is
   * correct, and it is also a branch nothing can reach once `server.ts` always supplies
   * one: a dead fallback whose whole job is to be safe, which is exactly the kind of guard
   * that gets deleted in a refactor because no test covers it. Required instead, so
   * "forgot the verifier" is a compile error rather than a silently-open route.
   *
   * `server.ts` builds it from `config.ts`'s registry, which under `NODE_ENV=production`
   * with no `BB_INTERNAL_KEY` set is EMPTY and therefore rejects every call (design/19 §5).
   */
  verifier: InternalVerifier;
}

/**
 * `GET /internal/flags` — what a polling service reads.
 *
 * Answers the FULL effective set (defaults merged with overrides), because
 * `flags/client.ts` treats a response missing any name as unusable. See its header for why
 * all-or-nothing is the safe shape.
 *
 * A 503 with no body when there is no `ops.db`: the client turns any non-2xx into "keep the
 * defaults", so this is the same outcome as being unreachable, said explicitly.
 */
export function getInternalFlags(
  req: IncomingMessage,
  res: ServerResponse,
  _url: URL,
  deps: FlagRouteDeps,
): void {
  const auth = deps.verifier.verify(req.headers);
  if (!auth.ok) {
    // The audit line for a rejected internal call, in the shared format — the claimed
    // caller is sanitized there, because it is attacker-chosen text on its way to a log.
    deps.log.warn(describeInternalAuthFailure(auth, '/internal/flags'));
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  if (deps.opsDb === null) return sendJson(res, 503, { error: 'no flag store' });
  sendJson(res, 200, { flags: effectiveFlags(deps.opsDb) });
}

/**
 * `POST /admin/flags/set` — the first of Phase C's two write paths.
 *
 * The form carries `name` and `value`, and `value` arrives as TEXT because that is what an
 * HTML form sends. It is parsed per the flag's declared type rather than by guessing at the
 * string: `'true'`/`'false'` for a boolean, `Number()` for a number, verbatim for a string.
 * `store.ts`'s `setFlag` then validates the result against the same definition, so a value
 * this function mis-parses is refused rather than stored — the parse is a convenience and
 * the validation is the control.
 *
 * A refusal is a redirect back to the tab, not a 400: the tab re-renders from the table, so
 * an unchanged page IS the refusal, and the log line says which flag and why.
 */
export function postFlagSet(req: IncomingMessage, res: ServerResponse, _url: URL, deps: FlagRouteDeps): void {
  if (!authed(req, deps)) return notFound(res);
  const db = deps.opsDb;
  if (db === null) return notFound(res);

  readForm(req, (form) => {
    const name = form.get('name') ?? '';
    const raw = form.get('value') ?? '';
    if (!isFlagName(name)) {
      // C1's line, at the write path: a name that is not in the allowlist cannot become a
      // row. Logged rather than silently dropped, because the only way to get here is a
      // hand-made request or a stale page.
      deps.log.warn('flag set refused — unknown flag', { flag: sanitizeAuditValue(name) });
      return redirect(res, FLAGS_TAB_URL);
    }
    const ok = setFlag(db, name, parseFormValue(name, raw), (deps.now ?? Date.now)(), deps.credential.user);
    if (!ok) deps.log.warn('flag set refused — value rejected by its definition', { flag: name });
    else deps.log.info('flag set', { flag: name, by: deps.credential.user });
    redirect(res, FLAGS_TAB_URL);
  });
}

/** `POST /admin/flags/clear` — returns one flag to its compiled-in default by DELETING its
 *  row (`store.ts` explains why deleting beats writing the default in). */
export function postFlagClear(req: IncomingMessage, res: ServerResponse, _url: URL, deps: FlagRouteDeps): void {
  if (!authed(req, deps)) return notFound(res);
  const db = deps.opsDb;
  if (db === null) return notFound(res);

  readForm(req, (form) => {
    const name = form.get('name') ?? '';
    // Deliberately NOT gated on `isFlagName`: clearing is the one operation that has to work
    // on the stale row a flag REMOVED in a deploy leaves behind, and that name is by
    // definition no longer in the allowlist.
    const removed = clearFlag(db, name);
    deps.log.info('flag cleared', { flag: sanitizeAuditValue(name), removed, by: deps.credential.user });
    redirect(res, FLAGS_TAB_URL);
  });
}

/**
 * Turns a form's text into the type the flag declares.
 *
 * Returns `unknown` on purpose — `setFlag` validates, and this function's job is only to
 * stop a boolean flag from being handed the string `'true'`. Anything it cannot parse comes
 * back as something `coerceFlag` will refuse, which is the safe direction.
 */
export function parseFormValue(name: FlagName, raw: string): unknown {
  const def = FLAG_DEFS[name] as { default: boolean | number | string };
  if (typeof def.default === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw; // a string, which `coerceFlag` refuses for a boolean flag
  }
  if (typeof def.default === 'number') {
    const trimmed = raw.trim();
    // An EMPTY field must not become 0: `Number('')` is 0, and a cleared number input would
    // otherwise silently set a timeout to zero. Returned as the empty string, which
    // `coerceFlag` refuses.
    return trimmed.length === 0 ? raw : Number(trimmed);
  }
  return raw;
}
