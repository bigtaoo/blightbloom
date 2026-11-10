import { Game } from './game/Game';
import { setUiAudio } from './audio/uiSound';
import { setMusicAudio } from './game/musicDirector';
import { WebPlatform } from './platform/web/WebPlatform';
import { setHostKind } from './platform/hostKind';
import { setRewardedAd } from './platform/rewardedAd';
import { PlaygamaBridge } from './platform/playgama/bridge';
import { adoptBridgeStorage } from './platform/playgama/bridgeStorage';
import { bridgeSender } from './platform/playgama/bridgeAnalytics';
import { attention } from './platform/keyFocus';
import { PlaygamaSession } from './platform/playgama/PlaygamaSession';
import { browserPerfHost, installPerfSample, PerfSampler, rendererClass, webglRenderer } from './platform/playgama/perfSample';
import { activeQuality } from './render/quality';
import { expectedPlayFps } from './game/powerBudget';
import { baseAssetHost, setAssetHost } from './render/assetHost';
import { beginDeferredArt, preloadLobbyArt } from './render/preloadArt';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWebBootFailure } from './bootError';
import { afterFirstRenderedFrame, hideBootSplash, setBootProgress } from './bootSplash';
import { installPerf } from './perf';
import { parseGameQueryParams } from './game/match/gameQueryParams';
import { installAnalytics } from './net/analyticsInstall';
import { trackFirstInput, type FirstInputTarget } from './net/firstInput';
import { appliedLocaleOr } from './i18n';
import { ensureLocale, prefetchLocales } from './i18n/loadLocale';
import { persistedLocale, setPreferredLanguages } from './settings';

// Game-portal entry (Playgama). The fourth entry point, built by `vite.playgama.config.js`,
// which puts the Bridge `<script>` in front of this module and ships its config file.
//
// The same game as `main.crazygames.ts` with less around it, because Playgama's frame cannot
// reach our server (its CSP admits only Playgama's origins):
//  - single-player only: `setHostKind('playgama')` makes `canPlayOnline()` false, and the lobby
//    draws no co-op, PvP or squad door; there is no sign-in, store, client log or flag fetch;
//  - progress lives in Bridge storage (`bridgeStorage.ts`) and analytics go through
//    `bridge.analytics.send` in the same event vocabulary our own ingest uses;
//  - the platform owns the language on a first visit, the pause, the sound switch and the
//    interstitial cooldown (`PlaygamaSession`'s header).
// No self-managed auto-reload, for `main.crazygames.ts` item 6's reason.
async function boot() {
  pinTextMeasurementToPaintCanvas();
  disableBrokenLetterSpacing();

  // (0) Bridge before anything else — its docs' required first step, and every store below
  // reads `webStorage()` once, when it is constructed. `init()` never rejects: without the
  // script (a blocked CDN, a plain local preview) the game runs as an offline browser build.
  const bridge = new PlaygamaBridge();
  await bridge.init(import.meta.env.VITE_GAME_VERSION);
  const storage = await adoptBridgeStorage({ bridge });

  // The platform's language decides a FIRST visit (the requirements' "follow
  // platform.language"); a language the player picked in Settings is persisted and wins.
  const lang = bridge.language();
  setPreferredLanguages(lang ? [lang] : null);
  const bootLocale = persistedLocale();
  const localeReady = ensureLocale(bootLocale);

  setAssetHost(baseAssetHost(import.meta.env.BASE_URL));
  setHostKind('playgama');
  // Asks for the keys (platform/keyFocus.ts) — before analytics, whose events carry `attention()`.
  const platform = new WebPlatform();

  // Analytics through Bridge. `baseUrl` and `token` are unused when `send` is given.
  installAnalytics({
    baseUrl: '',
    token: () => null,
    host: 'playgama',
    build: () => import.meta.env.VITE_GAME_VERSION ?? null,
    // Not `getLocale`: nothing applies a locale until the Game is constructed, and a flush before
    // that would report the default as this visit's language (i18n/index.ts `appliedLocaleOr`).
    locale: () => appliedLocaleOr(bootLocale),
    send: bridgeSender(bridge, attention),
    // Each event goes to Bridge as it happens: a portal frame is torn down with no reliable
    // `pagehide`, so a 30 s batch lost every visit shorter than that (design/22 §4.1).
    sendEachEvent: true,
    // No `page_open` beacon on this host (vite.playgama.config.js), so `boot_ms` runs from
    // the navigation start instead.
    bootStartedAt: globalThis.performance?.timeOrigin,
  });

  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();
  setBootProgress(0.2);
  setUiAudio(audio);
  setMusicAudio(audio);

  await preloadLobbyArt((done, total) => setBootProgress(0.2 + 0.7 * (done / total)), bootLocale);
  void audio.preload();
  beginDeferredArt();
  prefetchLocales();
  await localeReady;

  const game = new Game(app, input, audio);
  game.start();
  // A first-ever visit skips the menu into the run that teaches (game/controllers/firstRunAutostart.ts).
  game.startFirstRunIfNew();

  installPerf(app, {
    overlay: parseGameQueryParams(location.search).perf,
    onSnapshot: (s) => game.observePerfWindow(s.window),
  });

  // After `game.start()`, so the session observes the phase each frame ended in.
  const session = new PlaygamaSession(game, bridge, app.ticker);
  session.start();
  app.ticker.add(() => session.update());
  setRewardedAd(bridge.rewardedSupported() ? session.rewardedAd() : null);

  // Pending storage writes go out now rather than a tick later when the page may be gone.
  const flush = (): void => storage.flush();
  globalThis.addEventListener?.('pagehide', flush);
  bridge.onPause((paused) => {
    if (paused) flush();
  });

  Object.assign(globalThis, {
    __game: game,
    __portal: { diagnostics: () => `${bridge.describe()} · storage ${storage.outcome} · ${session.diagnostics()}` },
  });

  await afterFirstRenderedFrame(app.ticker);
  session.ready();
  // How long the player looks before touching anything — counted from here, not from the
  // download, so it is hesitation and not bandwidth (net/firstInput.ts).
  trackFirstInput(globalThis as unknown as FirstInputTarget, () => performance.now(), () => game.getPhase());
  session.watchViewport();
  // Hold the first run while its move lesson asks for a click the keys need (keyFocus.ts).
  session.watchKeys();
  // Playgama's `performance_sample`: frame times of live play only, per ~30 s (perfSample.ts).
  const perfSample = new PerfSampler((d) => bridge.track('performance_sample', d), import.meta.env.VITE_GAME_VERSION ?? 'unknown');
  const gl = rendererClass(webglRenderer((app.renderer as { gl?: Parameters<typeof webglRenderer>[0] }).gl));
  perfSample.context = () => ({ q: activeQuality().tier, gl });
  perfSample.targetFps = expectedPlayFps;
  installPerfSample(browserPerfHost(app.ticker, app.canvas, () => game.getPhase() === 'playing'), perfSample);
  await hideBootSplash();
}

boot().catch(reportWebBootFailure);
