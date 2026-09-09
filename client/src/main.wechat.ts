// WeChat forbids eval / new Function (unsafe-eval). Pixi v8 generates uniform/UBO/
// shader upload code via new Function by default; this side-effect import swaps in
// eval-free polyfills and neuters Pixi's _unsafeEvalCheck. Must load before the
// renderer is constructed. Web keeps the faster eval path (not imported there).
import 'pixi.js/unsafe-eval';
import { Game } from './game/Game';
import { setUiAudio } from './audio/uiSound';
import { setMusicAudio } from './game/musicDirector';
import { WeChatPlatform } from './platform/wechat/WeChatPlatform';
import { weChatAssetHost } from './platform/wechat/weChatAssetHost';
import { setAssetHost } from './render/assetHost';
import { beginDeferredArt, preloadLobbyArt } from './render/preloadArt';
import { showBootLoading } from './game/ui/loadingScreen';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWeChatBootFailure } from './bootError';
import { installPerf } from './perf';
import { setHostKind } from './platform/hostKind';
import { installClientLog } from './net/clientLogInstall';
import { installAnalytics } from './net/analyticsInstall';
import { installPublicFlags } from './net/clientFlags';
import { setIdentityStore } from './net/identity';
import { createWeChatIdentityStore } from './platform/wechat/weChatStorage';
import { createWeChatFetch } from './platform/wechat/weChatFetch';
import { resolveMatchBaseUrl } from './game/runState';
import { getLocale } from './i18n';
import { getSession } from './net/session';

// WeChat mini-game entry, loaded by client/wechat/game.js. There is no weapp-adapter (an
// older version of this comment claimed there was): the bundle installs Pixi's own
// DOMAdapter itself, in WeChatPlatform.createApp, before Application.init.

/** The bearer token of the logged-in session, or null for a guest. Read per flush rather
 *  than captured once, so a player who logs in mid-visit starts being attributable. */
function sessionToken(): string | null {
  return getSession()?.token ?? null;
}

async function boot() {
  // The network adapter this whole entry point used to be missing (design/21 §9;
  // design/04-wechat.md item 19). This shell has no `fetch`, no `XMLHttpRequest` and no
  // `sendBeacon`; `wx.request` is the only road out, and `platform/wechat/weChatFetch.ts`
  // wraps it into the `fetchImpl` all three installs below already took. FIRST, because each
  // of them is handed it.
  //
  // `undefined` on a runtime without `wx.request` is a real and deliberate value: every
  // consumer treats it as "no network", which is exactly the state this host was in before —
  // the flags stay as compiled in, the log and event batches are dropped, and nothing throws.
  const wxFetch = createWeChatFetch();

  // ...and the persistence adapter, which is the one that changes what analytics MEANS here.
  // `net/identity.ts`'s default store reads `localStorage`, a global this shell does not
  // have, so its availability check was false on every boot: `load()` answered null,
  // `save()` dropped the write, and a FRESH install id was minted per visit. That is why
  // analytics was deliberately not installed on this entry point until now — retention would
  // have read 0% (bad) and DAU would have reported the number of VISITS while labelled
  // *distinct installs* (worse, because it is a plausible number nobody would question).
  //
  // BEFORE `installAnalytics` below, and that order is load-bearing: the install id is read
  // once, during the install, so a store swapped in afterwards would arrive one visit late
  // and the first-ever boot would still persist nothing.
  setIdentityStore(createWeChatIdentityStore());

  // The host declaration (`platform/hostKind.ts`). An older comment here claimed `hostKind`
  // was "already `wechat` because this entry point exists" — it is not: `current` defaults to
  // `web` and only a `setHostKind` call changes it, so this entry ran as `web` for as long as
  // it has existed. That was harmless only because nothing this host sent ever left it. It
  // stops being harmless on the line below: `clientLog` labels every batch with
  // `getHostKind()`, and that label is a Loki stream label the server allowlists — so an
  // undeclared host means every WeChat failure filed under `web` and `host="wechat"` never
  // appearing at all. The portal entry's own comment already spelled this out; this entry
  // simply never had the call. Nothing else changes: the two other readers ask
  // `isPortalHost()`, which is false either way.
  setHostKind('wechat');

  // Browser logs (design/19 §10). AFTER the declaration above, for the reason just given. No
  // `location` in this shell, so the base URL is the build-time default with no query
  // override; `parseGameQueryParams` is a web thing.
  //
  // No `version`: the WeChat build never runs the version-manifest plugin, so there is no
  // `/version.json` to read and a getter would report `unknown` while implying a source.
  installClientLog({
    baseUrl: resolveMatchBaseUrl({ matchBaseUrl: null }),
    token: sessionToken,
    fetchImpl: wxFetch,
  });

  // Retention and funnel instrumentation (design/21 §2.6), NOW INSTALLED on this host —
  // the decision of 2026-09-09 not to was about the install id above, not about analytics.
  // With a store that persists, the id survives a reload and this host answers the question
  // the whole subsystem exists for ("do people come back") the same way the other two do.
  //
  // AFTER the logger, deliberately, for the reason the web entry states: if this throws
  // during boot the logger is already up to record it.
  //
  // `build` is null for the same reason the logger has no `version` above. What is ABSENT
  // here, and stays absent on purpose, is `session_end`: this runtime never fires `pagehide`,
  // and the closest thing it has — `wx.onHide` — fires on every backgrounding and is followed
  // by `onShow` when the player returns, so routing it into the visit-ended event would
  // multiply the row the churn funnel counts and understate every duration. An absent event
  // is a gap in one funnel; a plausible wrong one is the trap this host was switched off for.
  // The queue is flushed on hide instead, below, which is the half of `pagehide` that is
  // honest here.
  const analytics = installAnalytics({
    baseUrl: resolveMatchBaseUrl({ matchBaseUrl: null }),
    token: sessionToken,
    host: 'wechat',
    build: () => null,
    locale: getLocale,
    fetchImpl: wxFetch,
  });

  // The public feature flags (design/21 §9's delivery path) — installed here since
  // 2026-09-09 and INERT until now, because there was no `fetch` for the poll to use, so
  // every flag stayed at the value this build was compiled with. That was the fail-safe
  // state rather than a wrong number, and the call was left in place precisely so that the
  // day an adapter over `wx.request` existed this host would deliver flags without anybody
  // having to remember a missing line. This is that day, and this is that line.
  installPublicFlags({ baseUrl: resolveMatchBaseUrl({ matchBaseUrl: null }), fetchImpl: wxFetch });

  // One line in DevTools for the build mistake that is otherwise invisible: `wx.request`
  // refuses plain http outright, and a plain `npm run build:wechat` bakes in
  // `http://localhost:8788` — `VITE_MATCHSVC_URL` is injected by the web deploy workflow and
  // there is no CI build for this target. Every consequence of getting it wrong is fail-safe
  // and silent (flags as compiled in, batches dropped), so nothing anywhere would say why the
  // events store has no `wechat` rows. AFTER `installClientLog`, so the line is in the ring
  // buffer a USER_DATA_PATH probe can read as well as on the console.
  if (!resolveMatchBaseUrl({ matchBaseUrl: null }).startsWith('https:')) {
    console.warn(
      `[wechat] matchsvc is ${resolveMatchBaseUrl({ matchBaseUrl: null })}, and wx.request refuses plain http — ` +
        'build with VITE_MATCHSVC_URL=https://... or no flags, logs or analytics will leave this device',
    );
  }

  // The exit flush, in the only form this platform offers. `installAnalytics` attaches its
  // own to `pagehide` on `globalThis` — which exists here (Pixi's `EventSystem` needs it) and
  // is never dispatched by this runtime, so that listener is dead weight rather than a
  // second flush. `wx.onHide` is the real signal, and a backgrounded mini-game can be killed
  // without any further notice, so a flush here is the last chance the queued events get.
  // Deliberately NOT `analytics.track('session_end')` — see the install above.
  if (typeof wx.onHide === 'function') wx.onHide(() => analytics.flush());

  const platform = new WeChatPlatform();
  const app = await platform.createApp();
  // Same measure-canvas/paint-canvas pinning as the web entry (render/textMetrics.ts), but it
  // MUST come after createApp(), not before it as it did until 2026-08-25: the pin allocates its
  // canvas through `DOMAdapter`, and the adapter is still Pixi's BrowserAdapter until
  // `createApp()` installs ours. Called first, it therefore reached for `document.createElement`
  // — which the DevTools simulator happens to answer (so this looked fine there) and a real
  // device does not have at all, making it a ReferenceError out of boot() on device. Ordering it
  // after the platform is up is what makes both hosts take the same wx canvas.
  //
  // Still ahead of the first `Text`: Pixi memoises the measurement canvas on first use, and
  // nothing between here and the Game constructor below builds one.
  pinTextMeasurementToPaintCanvas();
  // ...and turn off Pixi's letter-spacing fast path where the host's own `letterSpacing` property
  // breaks the context it is set on (render/textMetrics.ts — it is what blanked every WeChat
  // label). A no-op on a host whose property works, so both entries run the same check.
  disableBrokenLetterSpacing();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  // Real art, same core bundle as the web entry (design/12 "load a core bundle at boot").
  // The host swap has to happen BEFORE the first load: it is what turns a public-relative
  // '/skins/...' path into a code-package path, and what routes the JSON sidecars through
  // FileSystemManager instead of a `fetch` this runtime does not have. Everything under it
  // is best-effort, so a missing or unreadable asset degrades to the Graphics placeholder
  // this entry used to render exclusively, rather than failing boot.
  setAssetHost(weChatAssetHost);
  // The SFX set (design/11), same fire-and-forget as the web entry — but note the ordering:
  // it must come AFTER the host swap, because that is what turns '/audio/impact_00.mp3' into
  // a code-package path this runtime can read at all.
  void audio.preload();
  // UI cues (design/11), same one-line wiring as the web entry — and it matters more here:
  // `WeChatAudio` registers none of the window listeners `WebAudio` uses to clear the
  // autoplay gate, so a menu tap is this runtime's first chance to resume the context.
  setUiAudio(audio);
  // ...and the third road to the bus (design/11 "Music & ambience"): the same module-sink
  // shape, for the same reason plus one — its per-frame caller is `GameLoop`, which would have
  // to be handed the device by `Game.ts`, and that file's length is pinned by the drift gate.
  // Nothing plays yet: `game/musicDirector.ts` derives the track from the situation on the
  // first frame `Game` renders.
  setMusicAudio(audio);

  // Phase one of design/12's two asset phases, behind a progress screen. Unlike web there is no
  // DOM splash to fall back on, and unlike web this is a real wait: `lobby` is a subpackage that
  // `wx.loadSubpackage` has to fetch before any `/ui/` path names a file at all. Drawn with
  // Graphics + Text only, because at this point in boot there IS no art (ui/loadingScreen.ts).
  const loading = showBootLoading(app);
  await preloadLobbyArt(loading.onProgress);
  loading.done();

  // Phase two, kicked and not awaited — the `run` packs plus `music`. On this platform that is
  // where most of the game's bytes are: the main package is now js/game.js alone (~0.95 MB of the
  // 4.00 MB ceiling), and everything else arrives while the menu is up. `Game.artGate` awaits it
  // at the run boundary. Before `new Game(...)` for the same load-bearing reason as the web
  // entry: this call is what arms the gate. See main.ts.
  beginDeferredArt();

  const game = new Game(app, input, audio);
  game.start();

  // Same frame-timing monitor as the web entry (src/perf). No overlay here: there is no
  // `?query=` to turn one on in a mini-game, and this runtime has no PerformanceObserver,
  // so the long-task signal is absent and the sustained-low-fps path carries it alone —
  // which is exactly the fallback funny's original was built around.
  // Each closed window also feeds the quality watchdog (render/qualityWatchdog.ts). This
  // runtime is the reason that path exists at all: every perf number in design/01 was measured
  // on a desktop Chrome, and until 2026-08-25 a handset that could not hold the frame had
  // nothing to turn off.
  installPerf(app, { onSnapshot: (s) => game.observePerfWindow(s.window) });

  (GameGlobal as Record<string, unknown>).__game = game;
}

boot().catch(reportWeChatBootFailure);
