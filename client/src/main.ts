import { Game } from './game/Game';
import { setUiAudio } from './audio/uiSound';
import { setMusicAudio } from './game/musicDirector';
import type { Phase } from './game/phase';
import { WebPlatform } from './platform/web/WebPlatform';
import { installAutoReload, deployedVersion } from './platform/web/autoReload';
import { beginDeferredArt, preloadLobbyArt } from './render/preloadArt';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWebBootFailure } from './bootError';
import { installPerf } from './perf';
import { parseGameQueryParams } from './game/match/gameQueryParams';
import { resolveMatchBaseUrl } from './game/runState';
import { installClientLog } from './net/clientLogInstall';
import { installAnalytics } from './net/analyticsInstall';
import { getLocale } from './i18n';
import { getSession } from './net/session';

// Web entry. The WeChat entry is client/src/main.wechat.ts (loaded by client/wechat/game.js).
// Both reuse the Game core; only the Platform differs — including the art preload, which
// is now the SHARED render/preloadArt.ts rather than a table inlined here. That inlining
// was the mechanism behind "the mini-game renders Graphics placeholders only": there was
// no preload for the other entry to call. Web needs no AssetHost of its own — the default
// in render/assetHost.ts is the web one.
/** The bearer token of the logged-in session, or null for a guest. Read per flush rather
 *  than captured once, so a player who logs in mid-visit starts being attributable without
 *  the logger having to be told. */
function sessionToken(): string | null {
  return getSession()?.token ?? null;
}

async function boot() {
  // Browser logs, on their way to the same store the backend writes to (design/19 §10).
  // FIRST, before anything else in boot() can fail: this wraps console.error/warn and the
  // global error handlers, so a throw from any line below is captured rather than only
  // being visible to whoever happens to have devtools open. Failure of the logger itself is
  // silent by construction (net/clientLog.ts).
  installClientLog({
    baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)),
    token: sessionToken,
    // Read per flush, not captured now: `installAutoReload` runs at the END of boot and its
    // first fetch resolves later still, while the first flush is 30s away — so by the time
    // it matters the baseline is there.
    version: deployedVersion,
  });

  // Retention and funnel instrumentation (design/21 §2.6). AFTER the logger, deliberately:
  // if this throws during boot the logger is already up to record it, and the reverse order
  // would lose exactly the failure worth having. `build` and `locale` are getters for the
  // same reason the logger's `version` is — the manifest arrives after boot, and a player
  // can change language mid-visit.
  installAnalytics({
    baseUrl: resolveMatchBaseUrl(parseGameQueryParams(location.search)),
    token: sessionToken,
    host: 'web',
    build: deployedVersion,
    locale: getLocale,
  });

  // Before any Text exists — Pixi caches its measurement canvas on first use (see
  // render/textMetrics.ts for why the default offscreen one mis-measures Cyrillic).
  pinTextMeasurementToPaintCanvas();
  // ...and turn off Pixi's letter-spacing fast path where the host's own `letterSpacing` property
  // breaks the context it is set on (render/textMetrics.ts — it is what blanked every WeChat
  // label). A no-op on a host whose property works, so both entries run the same check.
  disableBrokenLetterSpacing();
  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();
  // The SFX set (design/11) — deliberately NOT awaited. It is 95 kB and usually lands well
  // before the first shot, and every cue has a procedural voice to fall back on meanwhile,
  // so blocking boot on it would buy nothing. Failure is logged per file inside SampleBank.
  void audio.preload();
  // The other half of design/11's cue vocabulary: the cues a SCREEN makes (button taps), as
  // opposed to the ones an engine event makes. `EventReactor` gets the bus from `Game`; the
  // ~20 widget/screen classes take no dependencies at all, so they reach it through this one
  // module sink instead (audio/uiSound.ts explains the choice). Boot is where the device is
  // created, so boot is where it is attached.
  setUiAudio(audio);
  // ...and the third road to the bus (design/11 "Music & ambience"): the same module-sink
  // shape, for the same reason plus one — its per-frame caller is `GameLoop`, which would have
  // to be handed the device by `Game.ts`, and that file's length is pinned by the drift gate.
  // Nothing plays yet: `game/musicDirector.ts` derives the track from the situation on the
  // first frame `Game` renders.
  setMusicAudio(audio);

  // Phase one of design/12's two asset phases: the `lobby` pack and the UI loader, which is
  // everything a menu-shaped screen draws. Everything a RUN draws is kicked below, after the
  // lobby is live. No progress screen is created here — web already has one that paints EARLIER
  // than Pixi can, before the WebGL context even exists (`index.html`'s `#boot-loading`, removed
  // further down); the Pixi `LoadingScreen` is for the WeChat entry, which has no DOM, and for
  // the run gate on both.
  await preloadLobbyArt();

  // Phase two, kicked and not awaited: the rig/weapon/biome/environment art and the music,
  // downloaded while the player is reading the menu. `Game.artGate` awaits it at the run
  // boundary, so nothing downstream has to know whether it has landed.
  //
  // BEFORE `new Game(...)`, not after `start()`, and that ordering is load-bearing: this call is
  // what ARMS the gate (`isRunArtReady()` answers true until something has actually deferred, so
  // that no test which never opted in ever sees a gate). `start()` can enter a run on its very
  // first line — the `?replay=` path does — and a gate that is not armed yet would let that run
  // begin with placeholder art. Pinned in render/wechatPhasedBoot.test.ts.
  beginDeferredArt();

  const game = new Game(app, input, audio);
  game.start();

  // Frame-timing monitor (src/perf, ported from `funny` — see that folder's README for the
  // deviations). Installed after `start()` so its two ticker brackets sit outside every
  // listener the game added, which is what lets it split a frame into "our update" vs
  // "the renderer" without Game or GameLoop knowing it exists. The monitor runs in every
  // session (a sustained stutter leaves a `[perf]` console warning naming the expensive
  // half); `?perf=1` adds the on-screen readout and the WebGL draw-call probe on top.
  installPerf(app, {
    overlay: parseGameQueryParams(location.search).perf,
    // Feed each closed window to the quality watchdog (render/qualityWatchdog.ts),
    // which drops the renderer to the low tier if this device cannot sustain the
    // frame. Same stream the `[perf]` console warning already uses.
    onSnapshot: (s) => game.observePerfWindow(s.window),
  });
  document.getElementById('boot-loading')?.remove();

  // Pick up a new deploy when the player tabs back in (production builds only). Held back
  // while a run or a network session is live — those phases hold state a reload would throw
  // away; the check simply runs again on the next foreground return.
  const RELOAD_UNSAFE_PHASES: ReadonlySet<Phase> = new Set<Phase>(['playing', 'paused', 'matchmaking']);
  installAutoReload(() => !RELOAD_UNSAFE_PHASES.has(game.getPhase()) && !game.isOnline());

  // Expose for debugging
  (globalThis as unknown as { __game: Game }).__game = game;
}

boot().catch(reportWebBootFailure);
