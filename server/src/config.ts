/**
 * Shared server config (ROADMAP 3.3). Kept OUT of ticket.ts so that module stays env-free
 * and purely testable — this is the one place that reads process.env for the ticket secret,
 * imported by BOTH the control plane (matchsvc, signs) and the data plane (index.ts,
 * verifies) so they agree on the secret.
 *
 * Posture: a real `DDU_TICKET_SECRET` → production signing. Unset → a shared, well-known
 * DEV secret so the online path works out of the box locally, with a loud warning; in that
 * dev mode the gameserver also still honours the legacy raw-param handshake for manual
 * testing. Setting a real secret makes a valid ticket mandatory.
 */
const DEV_SECRET = 'dev-insecure-secret-do-not-use-in-prod';

// PvP squad size (design/05/15's long-deferred "squads" reserved interface) and its
// derived helpers live in `client/src/game/pvpConfig.ts`, NOT here — `buildPvpEngineConfig`
// must independently derive the exact same per-seat `teamId` from nothing but
// `(owner, playerCount)` (no ticket to read: `BotClient.ts` calls it with only
// `seed`/`playerCount`), so this server and that client function share one formula via
// the `@dd/game/match/pvpConfig` alias (already used by `BotClient.ts`/`Matchmaker.ts`)
// instead of two hand-mirrored copies that could drift (design/06's own stated lesson).
export { SQUAD_SIZE, squadSizeForPlayerCount, teamIdForOwner } from '@dd/game/match/pvpConfig';

import type { InternalCaller } from './internalAuth';

let warned = false;

export function ticketSecret(): { secret: string; isDev: boolean } {
  const env = process.env.DDU_TICKET_SECRET;
  if (env && env.length > 0) return { secret: env, isDev: false };
  if (!warned) {
    warned = true;
    console.warn(
      '[blightbloom] DDU_TICKET_SECRET unset — using an insecure DEV ticket secret. ' +
        'Set DDU_TICKET_SECRET (same value on matchsvc + gameserver) for any real deployment.',
    );
  }
  return { secret: DEV_SECRET, isDev: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal service-to-service key (design/19 §3, ROADMAP 8.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one caller in the registry today: the gameserver (`index.ts`), which POSTs a settled
 * PvP match to matchsvc's `/rating/report`. Named rather than inlined because the registry
 * is deliberately shaped to grow (design/19 §3) — `billsvc` is the next entry, and the day
 * there are two, each gets its own key and this becomes a lookup rather than a rename.
 */
export const INTERNAL_CALLER_GAMESERVER = 'gameserver';

const DEV_INTERNAL_KEY = 'dev-insecure-internal-key-do-not-use-in-prod';

let internalWarned = false;

/**
 * Where the internal key comes from, with the same posture `ticketSecret()` above already
 * establishes for the ticket secret — one mental model for both, because an operator
 * configures them together and a second, different rule is a second thing to get wrong:
 * a real `DDU_INTERNAL_KEY` is production, unset falls back to a shared well-known DEV key
 * with a loud one-time warning so the local two-process setup works out of the box.
 *
 * With ONE difference, and it is the important one: under `NODE_ENV=production` an unset
 * key does NOT fall back. It returns an EMPTY registry, and `createInternalVerifier`
 * rejects every internal call — design/19 §5's "fail closed in production" principle, which
 * that section states for the billing dev stub and which applies here for the same reason.
 * The alternative is a deploy that misses one env var and silently ships a route whose key
 * is published in this file, which is indistinguishable from having no key at all.
 *
 * Read per CALL, never captured at module scope, for the reason `config.test.ts` spells out
 * for `ticketSecret`: a module-scope capture makes the answer depend on whether the
 * environment was loaded before the first import.
 */
export function internalKeys(): { registry: InternalCaller[]; isDev: boolean } {
  const env = process.env.DDU_INTERNAL_KEY;
  if (env && env.length > 0) {
    return { registry: [{ caller: INTERNAL_CALLER_GAMESERVER, key: env }], isDev: false };
  }
  if (process.env.NODE_ENV === 'production') {
    if (!internalWarned) {
      internalWarned = true;
      console.warn(
        '[blightbloom] DDU_INTERNAL_KEY unset in production — every internal route now REJECTS ' +
          'every call (fail closed). Set DDU_INTERNAL_KEY (same value on matchsvc + gameserver).',
      );
    }
    return { registry: [], isDev: false };
  }
  if (!internalWarned) {
    internalWarned = true;
    console.warn(
      '[blightbloom] DDU_INTERNAL_KEY unset — using an insecure DEV internal key. ' +
        'Set DDU_INTERNAL_KEY (same value on matchsvc + gameserver) for any real deployment.',
    );
  }
  return { registry: [{ caller: INTERNAL_CALLER_GAMESERVER, key: DEV_INTERNAL_KEY }], isDev: true };
}

/**
 * The key THIS process presents on an OUTBOUND internal call — the caller-side mirror of
 * `internalKeys()`. `undefined` when nothing is configured (the production fail-closed
 * branch above), which `internalFetch` turns into a request with no `x-internal-key` at
 * all: rejected by the peer with a logged reason, rather than sent with a placeholder that
 * would have to be recognised as one somewhere.
 */
export function internalKeyFor(caller: string): string | undefined {
  return internalKeys().registry.find((entry) => entry.caller === caller)?.key;
}

/** billsvc, the second process to make an outbound internal call (the delivery pump). */
export const INTERNAL_CALLER_BILLSVC = 'billsvc';

/**
 * matchsvc, the THIRD process to make an outbound internal call (ROADMAP 8.8's store proxy,
 * `routes/store.ts`). The control plane is a caller as well as a callee now: a player's
 * bearer session reaches `/store/*` here, and what leaves for billsvc is an internal-key
 * call carrying the accountId this process resolved.
 *
 * `billsvc/server.ts`'s `INTERNAL_CALLER_CONTROL_PLANE` is an alias of this string rather
 * than a second literal — it is what billsvc's verifier labels the same hop from the other
 * end, and two hand-kept copies of one caller name is exactly the drift an audit line cannot
 * survive.
 */
export const INTERNAL_CALLER_MATCHSVC = 'matchsvc';

/**
 * The secret an outbound caller presents when it is NOT the entry the registry happens to
 * be labelled after. Today that registry holds exactly one key and all three processes
 * share it (§3), so "billsvc's key" and "the one key" are the same string — and this
 * function names that fact rather than having billsvc ask for
 * `internalKeyFor(INTERNAL_CALLER_GAMESERVER)`, which would put a false caller name in the
 * one place an audit line reads it. When the registry grows a key per caller this becomes
 * `internalKeyFor(INTERNAL_CALLER_BILLSVC)` and nothing else moves.
 *
 * `undefined` in the production fail-closed branch, exactly as `internalKeyFor` is.
 */
export function sharedInternalKey(): string | undefined {
  return internalKeys().registry[0]?.key;
}

/**
 * Where the CONTROL PLANE answers, for a process that needs to call it. Read per call for
 * the reason `ticketSecret` is: a module-scope capture makes the answer depend on whether
 * the environment was loaded before the first import.
 *
 * Defaults to localhost rather than to "disabled", matching `matchsvc.ts`'s own
 * `DDU_GAMESERVER_URL` default — the local three-process setup then works with no
 * configuration, and a real deployment that forgets the variable fails visibly (a refused
 * connection, logged per attempt, with the owed deliveries still `pending`) rather than
 * silently doing nothing.
 */
export function controlPlaneUrl(): string {
  const env = process.env.DDU_MATCHSVC_URL;
  return env && env.length > 0 ? env : 'http://localhost:8788';
}

/**
 * The CrazyGames game id this deployment accepts user tokens for (design/20 "account
 * integration"), or `undefined` while it is unknown.
 *
 * `undefined` is a real state rather than a placeholder: the id is assigned when the game is
 * registered on the portal, and the build has to be uploadable before that. But a user token
 * is a bearer credential that ANY game on the platform can obtain for the same player, so an
 * unset id means this server would accept a token minted for somebody else's game — i.e. it
 * trusts every other developer on the platform not to replay it here. `portalToken.ts`
 * therefore treats the check as optional and this function warns once when it is skipped,
 * the same posture `ticketSecret`/`internalKeys` take for their dev fallbacks.
 *
 * Deliberately NOT defaulted to a placeholder string: a wrong id rejects every real login,
 * which looks exactly like a broken integration and would be debugged as one.
 */
let portalGameIdWarned = false;

export function portalGameId(): string | undefined {
  const env = process.env.DDU_CG_GAME_ID;
  if (env && env.length > 0) return env;
  if (!portalGameIdWarned) {
    portalGameIdWarned = true;
    console.warn(
      '[blightbloom] DDU_CG_GAME_ID unset — /auth/portal accepts a CrazyGames user token ' +
        'minted for ANY game on the platform. Set it to this game id once the portal assigns one.',
    );
  }
  return undefined;
}

/**
 * Where the BILLING plane answers, for a process that needs to call it — the mirror of
 * `controlPlaneUrl()` above, and read per call for the same reason. Its only caller today is
 * matchsvc's store proxy (`routes/store.ts`, ROADMAP 8.8).
 *
 * Defaults to localhost:8789 (`billsvc/main.ts`'s `DEFAULT_BILL_PORT`) rather than to
 * "disabled", so the local three-process setup needs no configuration; a real deployment that
 * forgets the variable fails VISIBLY — a refused connection the proxy answers 502 to and logs
 * — rather than by quietly serving an empty store, which would look like a catalogue decision.
 */
export function billingPlaneUrl(): string {
  const env = process.env.DDU_BILLSVC_URL;
  return env && env.length > 0 ? env : 'http://localhost:8789';
}
