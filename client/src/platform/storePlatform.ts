// Which payment platform — if any — this build is allowed to sell through.
//
// ## Why this is a hard gate and not polish
//
// The web payment processor (`stripe` in `server/src/billsvc/iap/`) is WEB ONLY. Shipping a
// web checkout inside an iOS store build breaks App Store rule 3.1.1, which requires
// in-app purchase of digital goods to go through StoreKit and forbids steering the player
// anywhere else — and a store button that merely LOOKS unavailable is still a store button
// a reviewer can find. So the gate returns `null` for a host it cannot sell on, and the
// caller does not render the entry at all.
//
// The same reasoning runs the other way for the mini-game target, which is why `wx` returns
// `null` too rather than falling through to the web answer: a WeChat mini-game may not open
// an external web checkout either, and the `wechat` platform in the server's dispatch has no
// merchant credentials (design/19 §9) — there is nothing to route it to yet. When there is,
// this file gains one branch and the screen above it needs no change.
//
// ## Why feature detection, and not a build flag
//
// `client/src/platform` selects its Platform by ENTRY POINT (`main.ts` vs `main.wechat.ts`),
// so there is no runtime object that already knows which host this is. `replayDownload.ts`
// set the precedent for the answer: detect the capability, report the absence by returning a
// falsy value rather than throwing, and let the caller say "not here". A `host` parameter
// keeps that testable without a browser — every branch below is reachable from a plain
// object.

import { getHostKind, isPortalHost, type HostKind } from './hostKind';

/** The platforms this client can start a purchase on. Values are the `IapPlatform` strings
 * `POST /store/order` takes; anything not listed here is a platform the client never names. */
export type StorePlatform = 'stripe' | 'dev';

/** The ambient globals this gate reads. Structural so a test passes a plain object. */
export interface StoreHost {
  document?: unknown;
  fetch?: unknown;
  wx?: unknown;
  location?: { search?: string };
}

/**
 * True only for a real web browser: a DOM and a `fetch` (the three store routes are `fetch`
 * calls, so a host without one could not complete a purchase even if it were allowed to
 * start one), and NOT the mini-game runtime.
 *
 * The `wx` check is first and unconditional. WeChat's runtime injects DOM-shaped compat
 * shims for libraries that probe for them (`gameQueryParams.ts` records the same trap with
 * its always-empty `location.search`), so "has a document" alone would answer `true` there.
 */
export function isWebStoreHost(host: StoreHost): boolean {
  if (host.wx !== undefined && host.wx !== null) return false;
  return host.document !== undefined && host.document !== null && typeof host.fetch === 'function';
}

/**
 * The platform to sell on, or `null` when this build must show no store entry at all.
 *
 * `?store=dev` opts a web session into the server's dev stub — the one platform whose
 * `paymentParams` come back `configured: true` (and only while `devStubEnabled`, which is
 * off under `NODE_ENV=production`, so this cannot become a live free-money path). It is the
 * only way to walk create → pay → webhook → delivered locally, which is the same reason
 * every other dev toggle in `game/match/gameQueryParams.ts` exists.
 *
 * `location`/`URLSearchParams` are both guarded for the reason `readGameQueryParams` guards
 * them: the mini-game runtime has a compat `location` and no `URLSearchParams` at all, so
 * constructing one there throws a bare ReferenceError. That host has already returned `null`
 * above, but the guard is not conditional on that — it is a property of this function.
 */
export function detectStorePlatform(
  host: StoreHost = globalThis as StoreHost,
  hostKind: HostKind = getHostKind(),
): StorePlatform | null {
  // A GAME PORTAL is the one host this file cannot feature-detect, and the exception is
  // worth stating rather than hiding in a truth table.
  //
  // Every other branch here asks the runtime a question, because every other difference was
  // about capability. A CrazyGames page is an ordinary Chrome in an iframe: it has a
  // `document`, it has `fetch`, it has no `wx`, and it would sail through both checks
  // around this one. What it does not have is PERMISSION — in-game purchases there are
  // limited to invited games and must be handled through the platform's own Xsolla account
  // (`docs.crazygames.com/sdk/in-game-purchases`), so a checkout of ours is exactly the
  // "steering the player somewhere else" that the iOS branch above already refuses for the
  // same underlying reason. Hence `platform/hostKind.ts`: a declared fact, because the
  // runtime does not know it.
  //
  // As everywhere else here, the answer is `null` rather than a disabled button — the Forge
  // renders no STORE entry and binds no `[B]` key at all, which is what makes this a policy
  // the screen cannot violate rather than a label it could get wrong.
  if (isPortalHost(hostKind)) return null;
  if (!isWebStoreHost(host)) return null;
  const search = host.location?.search;
  if (typeof search === 'string' && typeof URLSearchParams !== 'undefined') {
    if (new URLSearchParams(search).get('store') === 'dev') return 'dev';
  }
  return 'stripe';
}
