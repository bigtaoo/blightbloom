/**
 * `GET /client/flags` — the PUBLIC half of the feature-flag delivery path
 * (design/21-ops-analytics.md §9, first bullet; the contract is `@dd/net/publicFlags`).
 *
 * ## Why this route exists rather than a field on an existing response
 *
 * §9 proposed a public field on "a response the client already fetches", and there is no
 * such response. Both unauthenticated calls a browser makes to matchsvc — `POST /client/log`
 * and `POST /client/events` — are batched on a 30-second timer, fire-and-forget, absent on
 * the WeChat shell, and (for the analytics one) behind an opt-out. A maintenance banner
 * delivered on those terms reaches a player half a minute into a visit if they opted in and
 * never otherwise, which is not a delivery path for an operational switch.
 *
 * ## Why an unauthenticated GET is the small surface and not the large one
 *
 * Everything about this handler is deliberately shallow, and each part is a property rather
 * than a convenience:
 *
 *  - **It reads no database.** matchsvc already holds the flag values in memory — the poll
 *    client built in `matchsvc.ts` keeps them there — so this answers from a field. There is
 *    no query to be made expensive, and no `ops.db` handle in this process at all (design/21
 *    B1: only adminsvc opens that file, and it is the one writable database in the design).
 *  - **It discloses only what the requester can already see.** `FlagDef.public` is the
 *    marker and its test is "is this value already visible to the player it is delivered
 *    to": the banner IS its own disclosure, and the ad offer is a button on their screen.
 *    The two matchmaking timings are NOT public, and that is the interesting one —
 *    `match.pvpBotBackfillDelayMs` would tell a player which opponent was not a person.
 *  - **It is not rate-limited, and `/health` beside it is the precedent.** The telemetry
 *    routes carry a limiter because they APPEND to a database and push to Loki; this one
 *    does no work, holds no state and returns about a hundred bytes. A per-IP limit here
 *    would meet a school or an office NAT long before it met an attacker, and the thing it
 *    would be protecting is a field read.
 *  - **It answers `x-forwarded-for` requests happily**, which is the opposite of `/metrics`
 *    in the same dispatch chain. Caddy proxies matchsvc wholesale and stamps that header on
 *    everything it forwards, so for `/metrics` its presence is what "came from outside"
 *    means. Here outside is the entire point.
 *
 * `no-store` on the response for the reason an operator would expect: a flag flipped in the
 * console has to take effect on the next fetch, and a browser or an intermediary holding a
 * cached copy for even a minute makes "I turned the banner on and it did not appear" a real
 * report with no bug behind it.
 */
import type { ServerResponse } from 'node:http';
import { CORS } from './http';
import { publicFlagValues } from '../flags/defs';
import type { FlagClient } from '../flags/client';
import { PUBLIC_FLAGS_PATH } from '@dd/net/publicFlags';

export { PUBLIC_FLAGS_PATH };

/** What this route needs, and nothing else — the narrow `Pick<>` habit the rest of the
 *  route modules follow, so a test constructs a flag client and not a matchsvc. */
export interface ClientFlagsDeps {
  flags: Pick<FlagClient, 'all'>;
}

/**
 * The handler. Takes no request and no URL, because it uses neither — a signature that
 * cannot read a header cannot grow a behaviour that depends on one, which for a route whose
 * whole claim is "the same answer for everybody" is worth the inconsistency with
 * `RouteHandler`.
 *
 * The envelope matches the internal endpoint's (`{ flags: { ... } }`) so that the client's
 * parser and the services' parser read the same shape — one wire format for a flag poll in
 * this project rather than two.
 */
export function getClientFlags(res: ServerResponse, deps: ClientFlagsDeps): void {
  res.writeHead(200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ flags: publicFlagValues(deps.flags.all()) }));
}
