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
export type HostKind = 'web' | 'wechat' | 'crazygames' | 'playgama';

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
  return kind === 'crazygames' || kind === 'playgama';
}

/**
 * Whether telling this host's player to "sign in" would lead anywhere.
 *
 * Added 2026-09-17 for design/16 hole 3: the PvP results screen tells a guest their rank is
 * not being recorded and that signing in starts recording it, and that sentence is only
 * honest where signing in is possible AND sticks. Anywhere else it is a door painted on a
 * wall — the failure the lobby's own dead doors were just cleared of.
 *
 * A `Record` rather than `kind === 'web'`, so a fourth host is a COMPILE error here and has
 * to answer the question rather than inherit an answer (the shape `Matchmaker.botFillMs`
 * uses for the same reason).
 */
const SIGN_IN_AVAILABLE: Record<HostKind, boolean> = {
  // Our own domain: `LoginScreen`, a real `POST /auth/login`, and a session in localStorage.
  web: true,
  // No `wx.login` exchange and — the part that decides it — no `SessionStore` over
  // `wx.getStorageSync`, so `net/session.ts` reads through `createWebSessionStore`, finds no
  // `localStorage`, and answers `null` forever. A player there could type a password into a
  // screen that then forgets it. design/16's "Correction: WeChat does not log in at all".
  wechat: false,
  // The portal signs the player in silently (`platform/crazygames/portalAuth.ts`), so a
  // logged-out player is not a state that exists there — and the platform forbids our own
  // login as a call to action anyway (`MainMenu.setAccountEntry` carries the citation).
  crazygames: false,
  // No server to sign in to: the frame cannot reach ours (`ONLINE_AVAILABLE` below).
  playgama: false,
};

export function canSignIn(kind: HostKind = current): boolean {
  return SIGN_IN_AVAILABLE[kind];
}

/**
 * Whether this host's frame can reach our server at all — matchsvc's WebSocket for co-op, PvP
 * and parties, and its HTTP routes for logs, flags and accounts.
 *
 * Added 2026-11-06 with the Playgama target. Playgama's sandbox frame has a CSP that admits
 * only Playgama's own origins (Holy Kicker measured it: every request to its backend refused),
 * so every online door there would open onto a connection error. The build is single-player
 * instead, and the lobby draws no online routes (`LobbyRoutes.setOnline`) rather than routes
 * that fail. A `Record` for `SIGN_IN_AVAILABLE`'s reason: a new host has to answer.
 */
const ONLINE_AVAILABLE: Record<HostKind, boolean> = {
  web: true,
  wechat: true,
  crazygames: true,
  playgama: false,
};

export function canPlayOnline(kind: HostKind = current): boolean {
  return ONLINE_AVAILABLE[kind];
}

/**
 * Whether the game may open a page outside itself — today only the privacy-policy link the
 * portal menu shows beside its data notice (`MainMenu.setAccountEntry`).
 *
 * False on Playgama, whose requirements forbid links that lead a player out of the game; the
 * policy pages are the platform's own there.
 */
const LINK_OUT_AVAILABLE: Record<HostKind, boolean> = {
  web: true,
  wechat: true,
  crazygames: true,
  playgama: false,
};

export function canLinkOut(kind: HostKind = current): boolean {
  return LINK_OUT_AVAILABLE[kind];
}

/**
 * Whether the Escape key is the game's to bind. It pauses a run and closes the settings screen
 * elsewhere (`gameWiring.keydownAction`); P and O do the same, so nothing is lost without it.
 *
 * False on Playgama, whose requirements reserve Escape for the platform (it leaves full screen
 * there, and a game that also pauses on it does two things on one press).
 */
const ESCAPE_KEY_AVAILABLE: Record<HostKind, boolean> = {
  web: true,
  wechat: true,
  crazygames: true,
  playgama: false,
};

export function canBindEscape(kind: HostKind = current): boolean {
  return ESCAPE_KEY_AVAILABLE[kind];
}
