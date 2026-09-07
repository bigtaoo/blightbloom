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

// Game-portal entry (CrazyGames). The third entry point, beside `main.ts` (our own domain)
// and `main.wechat.ts` (the mini-game). Built by `vite.crazygames.config.js`, which is what
// puts the SDK `<script>` in the page and sets `base: './'`.
//
// It is the SAME game: the platform is `WebPlatform`, the input is `WebInput`, the renderer
// and the whole of `src/game/` are untouched. Four things differ, and each one is a rule of
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
//  4. **No self-managed auto-reload.** `main.ts` polls `/version.json` so a tab left open
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

  const game = new Game(app, input, audio);
  game.start();

  installPerf(app, {
    overlay: parseGameQueryParams(location.search).perf,
    onSnapshot: (s) => game.observePerfWindow(s.window),
  });
  document.getElementById('boot-loading')?.remove();

  // (3b) The portal session. Its ticker callback is added AFTER `game.start()` for the same
  // reason `installPerf`'s brackets are: it then runs outside every listener the game
  // registered, so what it observes is the phase the frame ended in.
  //
  // `adSuspension(app.ticker)` is the mute-and-freeze an ad needs. Note that it stops the
  // very ticker this callback runs on, which is correct and not a deadlock: the release is
  // driven by the SDK's own `adFinished`/`adError` callback, which is a DOM event and does
  // not need our clock to arrive.
  const portal = new PortalSession(game, { sdk, suspension: adSuspension(app.ticker) });
  app.ticker.add(() => portal.update());
  void portal.start();

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
  Object.assign(globalThis, { __game: game, __portal: portal });
}

boot().catch(reportWebBootFailure);
