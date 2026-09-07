// Which HOST this build is running on — a policy fact, not a capability.
//
// `platform/` already selects an implementation by entry point (`main.ts` /
// `main.wechat.ts` / `main.crazygames.ts`), and everything that differs between hosts so
// far could be FEATURE-DETECTED: `storePlatform.ts` asks whether there is a `document` and
// a `fetch`, `replayDownload.ts` asks whether an anchor can carry a download. That worked
// because every difference was about what the runtime can DO.
//
// A game portal breaks that assumption, and this module exists for exactly that break. A
// CrazyGames build runs in an ordinary Chrome inside an iframe: every capability probe in
// this codebase answers the same as it does on `b.gamestao.com`. What differs is what we
// are ALLOWED to do there — no external checkout (`docs.crazygames.com`'s in-game-purchase
// rule), no self-managed reload, one click to gameplay. None of that is discoverable by
// asking the runtime a question, so the entry point declares it and the modules that care
// read it back.
//
// Deliberately NOT a build-time `define`: the value has to be readable from a plain unit
// test with no bundler in the picture, which is the same reason `assetHost.ts` is a
// settable module singleton rather than a compile-time switch.

/** The hosts this client ships to. `web` is the default (a plain browser on our own
 *  domain), so nothing that fails to opt in changes behaviour. */
export type HostKind = 'web' | 'wechat' | 'crazygames';

let current: HostKind = 'web';

/** Called by an entry point BEFORE `new Game(...)`. Every reader below is consulted during
 *  screen assembly, so a late call would be read too late rather than being ignored. */
export function setHostKind(kind: HostKind): void {
  current = kind;
}

export function getHostKind(): HostKind {
  return current;
}

/** Restores the default. For tests, which must not leak a host into the next file's
 *  module registry (`resetAssetHost`'s convention). */
export function resetHostKind(): void {
  current = 'web';
}

/**
 * True where a third party owns the page the game is embedded in.
 *
 * The one predicate worth naming rather than comparing to `'crazygames'` at each call site:
 * it is the reason behind every host branch in this codebase (we do not control the URL, the
 * cache, the payment rail or the surrounding chrome), and a second portal target would join
 * it here instead of adding a second `=== 'crazygames'` everywhere.
 */
export function isPortalHost(kind: HostKind = current): boolean {
  return kind === 'crazygames';
}
