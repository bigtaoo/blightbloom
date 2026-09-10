import { Game } from './game/Game';
import { setUiAudio } from './audio/uiSound';
import { setMusicAudio } from './game/musicDirector';
import { WebPlatform } from './platform/web/WebPlatform';
import { setHostKind } from './platform/hostKind';
import { adSuspension } from './platform/crazygames/suspension';
import { PortalSession } from './platform/crazygames/PortalSession';
import { portalRewardedAd } from './platform/crazygames/portalRewardedAd';
import { setRewardedAd } from './platform/rewardedAd';
import { CrazyGamesSdk } from './platform/crazygames/sdk';
import { baseAssetHost, setAssetHost } from './render/assetHost';
import { beginDeferredArt, preloadLobbyArt } from './render/preloadArt';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWebBootFailure } from './bootError';
import { installPerf } from './perf';
import { parseGameQueryParams } from './game/match/gameQueryParams';
import { resolveMatchBaseUrl } from './game/runState';
import { installClientLog, clientLog } from './net/clientLogInstall';
import { installAnalytics } from './net/analyticsInstall';
import { installPublicFlags } from './net/clientFlags';
import { getLocale } from './i18n';
import { getSession } from './net/session';
import { PortalAuth } from './platform/crazygames/portalAuth';
import { settleIdentity } from './platform/identityGate';
import { PortalRooms } from './platform/crazygames/PortalRooms';
import { applyPortalBootIntent } from './platform/crazygames/portalBoot';

// Game-portal entry (CrazyGames). The third entry point, beside `main.ts` (our own domain)
// and `main.wechat.ts` (the mini-game). Built by `vite.crazygames.config.js`, which is what
// puts the SDK `<script>` in the page and sets `base: './'`.
//
// It is the SAME game: the platform is `WebPlatform`, the input is `WebInput`, the renderer
// and the whole of `src/game/` are untouched. Six things differ, and each one is a rule of
// the host rather than a preference of ours:
//
//  1. **Relative asset paths.** The bundle is served from a path the portal chooses, so every
//     absolute `'/skins/...'` in this repository has to be rewritten. One line, because all
//     asset access already goes through `render/assetHost.ts` (`baseAssetHost`).
//  2. **The host is declared.** A portal page is indistinguishable from our own by feature
//     detection — same browser, same DOM, same `fetch` — so `setHostKind` states it, and the
//     two modules whose behaviour depends on policy rather than capability read it back:
//     the store gate (no external checkout is permitted there) and the main menu (one click
//     to gameplay).
//  3. **The portal is told what is happening.** `PortalSession` brackets loading and
//     gameplay, places ads at the one legal moment, and shows a banner on the menu. It is
//     installed on its own ticker callback and the game does not know it exists — see that
//     file's header for why that is the shape rather than hooks inside `src/game/`. The one
//     exception is the rewarded-ad OFFER (3c below): an offer is a button on a screen the
//     game owns, so it cannot be derived from the outside. It goes through a declared
//     capability (`platform/rewardedAd.ts`) rather than an import, so what the game learns
//     is that a rewarded ad exists — never that a portal does.
//  4. **The player is signed in without being asked.** A portal forbids a game's own
//     credential login and requires that a logged-in portal user be registered and logged
//     in automatically (`design/20` "account integration"). `PortalAuth` does that from
//     here, before the first screen is drawn; `gameWiring.ts` hides the login entry on this
//     host, and `platform/sessionEvents.ts` is how the resulting session reaches the menu
//     and the Forge without `src/game/` importing anything from `platform/crazygames/`.
//  5. **The portal is told about the SQUAD, and can put the player into one.** Room state,
//     an invite button, an accepted invite and "open me straight into multiplayer" are all
//     multiplayer requirements of that platform (`design/20`). Two more seams carry them,
//     both in `platform/` so `src/game/` still imports nothing from `platform/crazygames/`:
//     `partyPresence.ts` (the game declares its squad, `PortalRooms` announces it) and
//     `onlineEntry.ts` (the game installs two doors, `portalBoot.ts` walks through one).
//  6. **No self-managed auto-reload.** `main.ts` polls `/version.json` so a tab left open
//     across a deploy reloads itself. A portal serves a versioned, immutable upload from its
//     own CDN: the file is not there to poll, the URL is not ours, and reloading somebody
//     else's frame is not ours to do either. Deliberately absent, not forgotten.
async function boot() {
  // Both of these are host quirks rather than portal ones, and both must run before any
  // `Text` exists — see render/textMetrics.ts. Identical to `main.ts`.
  pinTextMeasurementToPaintCanvas();
  disableBrokenLetterSpacing();

  // (1) Asset paths, BEFORE the first preload — `preloadLobbyArt` resolves URLs through the
  // host, so a host installed after it would leave the lobby art fetched from the wrong
  // place and everything after it fetched from the right one.
  setAssetHost(baseAssetHost(import.meta.env.BASE_URL));
  // (2) ...and the host declaration before `new Game(...)`, whose assembly reads it.
  setHostKind('crazygames');

  // (2b) Browser logs (design/19 §10). AFTER `setHostKind`, unlike the web entry where the
  // order does not matter: every batch is labelled with the host, and a batch sent before
  // the declaration would be labelled `web` — which would quietly attribute a portal-only
  // failure to the wrong build target, the one thing this label exists to prevent.
  installClientLog({
    baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)),
    token: () => getSession()?.token ?? null,
    // No `version` here on purpose. The portal build is served from a SUB-PATH and
    // `autoReload`s `/version.json` is absolute, so it 404s — a getter would report
    // `unknown` just as clearly while implying a source exists. design/20s no-self-managed-
    // reload rule is why that was never fixed for the portal.
  });

  // Analytics (design/21 §2.6). Installed here and NOT on the WeChat entry, and the
  // difference is whether the install id can persist: this is an ordinary browser, so
  // `localStorage` is there and the id survives a visit.
  //
  // The caveat that does apply here, stated because it inflates a number rather than
  // emptying one: the game runs in an EMBEDDED frame, and some browsers block storage for
  // embedded content (the same fact `client/public/privacy.html` §4 already tells players,
  // where it explains why a guest's progress may not persist). For such a viewer the id is
  // per-visit, so they count as a new install each time — DAU on this host reads slightly
  // high and their retention reads as churn. It is a fraction of viewers rather than all of
  // them, which is what separates this from the WeChat case.
  //
  // `build` is null for the reason the logger's `version` is absent above: this build is
  // served from a sub-path and the version manifest is fetched from an absolute path.
  installAnalytics({
    baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)),
    token: () => getSession()?.token ?? null,
    host: 'crazygames',
    build: () => null,
    locale: getLocale,
  });

  // The public feature flags (design/21 §9's delivery path). This is the host the
  // `ads.rewardedOfferEnabled` switch exists for: the offer doubles an extraction payout,
  // so if the balance turns out wrong — or this platform's ad fill collapses and the offer
  // becomes a button that does nothing — turning it off must not wait for a client deploy.
  // `RunOutcome.doubleOffer` reads it per offer rather than at install time, so a flip takes
  // effect on the next run that ends.
  installPublicFlags({ baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)) });

  // (3a) Announce the download. The SDK measures the span from page open to the first
  // `gameplayStart` as the "initial download", so this bracket opens before the art phase
  // below and `PortalSession.start()` closes it once there is a game to play.
  const sdk = new CrazyGamesSdk();
  sdk.loadingStart();

  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();
  void audio.preload();
  setUiAudio(audio);
  setMusicAudio(audio);

  await preloadLobbyArt();
  beginDeferredArt();

  // Constructed but NOT started: the identity gate below runs between assembly and the first
  // frame, which is the whole point of it (design/10's screen flow).
  const game = new Game(app, input, audio);

  // (3b') Silent login, constructed BEFORE the session so its state can ride in that one
  // diagnostics line, and started AFTER `sdk.init()` (which `portal.start()` performs) since
  // every call it makes goes through the module the script installs.
  const portalAuth = new PortalAuth({
    sdk,
    baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)),
  });

  // (3b) The portal session.
  //
  // `adSuspension(app.ticker)` is the mute-and-freeze an ad needs. Note that it stops the
  // very ticker its update callback runs on, which is correct and not a deadlock: the release
  // is driven by the SDK's own `adFinished`/`adError` callback, which is a DOM event and does
  // not need our clock to arrive.
  // (3b'') The room and invite affordances, driven by the party the game declares
  // (`platform/partyPresence.ts`) rather than by the phase — see `PortalRooms`' header for
  // why that one is a subscription while everything in `PortalSession` is a derivation.
  const portalRooms = new PortalRooms(sdk);

  const portal = new PortalSession(game, {
    sdk,
    suspension: adSuspension(app.ticker),
    auth: portalAuth,
    rooms: portalRooms,
  });

  // Everything that needs a live SDK, in one chain after `portal.start()` (which is what
  // performs `sdk.init()`). Sequential rather than parallel on purpose: the boot intent may
  // put the player straight into a party, and it should do that with their account already
  // signed in — otherwise the seat they take is a guest's and their name is missing from
  // everyone else's roster.
  const signedIn = portal.start().then(() => portalAuth.start());

  // (3b''') THE IDENTITY GATE (design/10, 2026-09-10). The boot splash stays up until the
  // silent login has an answer — an account or a guest — or until the budget runs out.
  //
  // This is the ordering fix, and it is worth being precise about what was wrong before it:
  // `game.start()` used to run first, so the menu was interactive while the login was still
  // in flight. On THIS host that menu is in one-click mode (design/20), so the first click
  // starts a run, and a session landing mid-run drove `syncMetaWithSession` into replacing a
  // `MetaState` the run had already spent (`game/phase.ts`'s `isHubPhase` has the shape).
  // That path is now guarded on its own side too — the gate makes the race unlikely, the
  // guard makes it impossible, and a player who signs in on the portal page mid-session
  // still needs the guard.
  //
  // If the budget expires, boot continues as a guest and `signedIn` keeps running: the
  // session arrives late through `platform/sessionEvents.ts` exactly as it did before, and
  // `PortalSession.start`'s own `previous = null` still re-runs the current phase once the
  // SDK is up — which is what that line was written for and is now only needed on this path.
  const identity = await settleIdentity({ login: () => signedIn });
  if (identity.outcome !== 'settled') {
    // One line, on the host where the account integration cannot be tested any other way
    // (`PortalAuth.diagnostics` is the rest of that instrument). A page full of guests is
    // the symptom of a slow host, a refusing server and a working guest visit alike.
    const why = identity.error ? `${identity.outcome} (${identity.error})` : identity.outcome;
    clientLog()?.log('warn', 'portal', `identity gate: ${why}`);
  }

  game.start();

  installPerf(app, {
    overlay: parseGameQueryParams(location.search).perf,
    onSnapshot: (s) => game.observePerfWindow(s.window),
  });
  document.getElementById('boot-loading')?.remove();

  // The ticker callback is added AFTER `game.start()` for the same reason `installPerf`'s
  // brackets are: it then runs outside every listener the game registered, so what it
  // observes is the phase the frame ended in.
  app.ticker.add(() => portal.update());
  // The rest of the SDK chain, which the gate deliberately does NOT wait for: an invite being
  // walked through moves the player off the menu, and doing that before there is a menu is a
  // race with no upside. `.catch` rather than a bare `void`, because this is now the only
  // consumer of a chain that can reject, and an unhandled rejection on a portal page is a
  // console error a platform reviewer reads.
  void signedIn
    .then(() => {
      portalRooms.start();
      return applyPortalBootIntent(sdk);
    })
    .catch((e: unknown) => {
      clientLog()?.log('warn', 'portal', `boot intent: ${e instanceof Error ? e.message : String(e)}`);
    });

  // (3c) The one thing the portal cannot derive from the phase stream: the rewarded-ad
  // OFFER on the results screen, which has to be drawn by a screen the game owns and paid
  // into the meta layer. `platform/rewardedAd.ts`'s header has the full reasoning; the
  // install is here because an entry point is where a capability gets declared, and every
  // other entry point declaring nothing is what keeps the offer off every other target.
  // After `portal.start()`, deliberately: `probe()` runs in there, and `available()` is
  // what decides whether the button is drawn at all.
  setRewardedAd(portalRewardedAd(portal.ads));

  // Expose for debugging — `__portal` alongside `__game` so a live portal page can be
  // interrogated from a console (`__portal.diagnostics()`), which is the only place any of
  // the SDK half of this file can be verified at all.
  Object.assign(globalThis, { __game: game, __portal: portal, __auth: portalAuth, __rooms: portalRooms });
}

boot().catch(reportWebBootFailure);
