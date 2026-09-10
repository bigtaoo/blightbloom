/**
 * The portal BUILD, as opposed to the portal runtime the rest of this directory tests.
 *
 * Three things decide whether an upload works at all, and none of them is reachable from a
 * unit test of any module: which entry module the page loads, whether the SDK script is in
 * it, and whether asset paths come out relative. Get any of them wrong and the result is not
 * an error — it is a game that boots to a black screen on a host this repository cannot open,
 * with nothing in any log naming the cause.
 *
 * So this file tests the BUILD ARTEFACTS' inputs: the real `index.html`, the real config's
 * own HTML transform, and the real entry module's source order. The technique is the same one
 * `render/wechatPhasedBoot.test.ts` and `audio/audioPipeline.test.ts` already use for the
 * other two entry points, and the same reasoning `server/deploy`'s bundle tests record — a
 * 100%-covered source tree said nothing about whether the thing that ships is assembled
 * correctly.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import portalConfig, { portalHtml, rewritePortalHtml } from '../../../vite.crazygames.config.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ENTRY = read('../../main.crazygames.ts');
const INDEX_HTML = read('../../../index.html');

/** The config's own rewrite, imported rather than re-implemented so the test exercises the
 *  SHIPPED transform and not a copy of its string surgery. */
const htmlTransform = (): ((html: string) => string) =>
  rewritePortalHtml as (html: string) => string;

interface PortalPlugin {
  name: string;
  enforce?: string;
  transform: (code: string, id: string) => string | null;
  transformIndexHtml: (h: string) => string;
  closeBundle: () => void;
}

/** A FRESH plugin instance. The `closeBundle` guard is per-build state, so sharing the one
 *  instance the config already built would let an earlier test's successful rewrite satisfy
 *  a later test's "no rewrite happened" case — which is exactly what it did the first time
 *  this file was written. */
const portalPlugin = (): PortalPlugin => (portalHtml as () => PortalPlugin)();

/** ...and the one the exported config actually carries, for the wiring assertions. */
function configuredPlugin(): PortalPlugin {
  const plugins = (portalConfig as { plugins?: unknown[] }).plugins ?? [];
  const plugin = plugins.find(
    (p) => typeof p === 'object' && p !== null && (p as { name?: string }).name === 'crazygames-html',
  );
  if (!plugin) throw new Error('vite.crazygames.config.js no longer defines the crazygames-html plugin');
  return plugin as PortalPlugin;
}

describe('vite.crazygames.config.js', () => {
  it('serves from a relative base', () => {
    // Half of the "use only relative paths" requirement — the half that covers the paths
    // VITE writes (the script tag, the hashed chunks). The other half is `baseAssetHost`,
    // asserted in `render/assetHost.test.ts`, and neither covers the other.
    expect((portalConfig as { base?: string }).base).toBe('./');
  });

  it('emits to its own directory so it cannot overwrite the Cloudflare build', () => {
    expect((portalConfig as { build?: { outDir?: string } }).build?.outDir).toBe('dist-crazygames');
  });

  it('swaps in the portal entry module', () => {
    const out = htmlTransform()(INDEX_HTML);
    expect(out).toContain('/src/main.crazygames.ts');
    expect(out).not.toContain('/src/main.ts"');
  });

  it('injects the v3 SDK specifically, because the VERSION is load-bearing', () => {
    // Not a preference. The shipped v2 game module has no `updateRoom`, no `leftRoom` and no
    // `isInstantMultiplayer` — the whole of the platform's room requirement — and a missing
    // method on this SDK is a silent no-op by design (`settle`), so a downgrade would leave
    // that requirement unmet with nothing turning red anywhere else.
    // `vite.crazygames.config.js`'s `SDK_TAG` carries the full finding.
    expect(htmlTransform()(INDEX_HTML)).toContain('crazygames-sdk-v3.js');
  });

  it('injects the SDK script into the head', () => {
    const out = htmlTransform()(INDEX_HTML);
    const tag = out.indexOf('sdk.crazygames.com');
    expect(tag, 'the SDK script is missing').toBeGreaterThan(-1);
    // In `<head>`, and specifically BEFORE the entry module: the SDK installs
    // `window.CrazyGames` synchronously, and `CrazyGamesSdk.init` would otherwise spend its
    // whole 3-second budget polling for a script that is queued behind our own bundle.
    expect(tag).toBeLessThan(out.indexOf('</head>'));
    expect(tag).toBeLessThan(out.indexOf('/src/main.crazygames.ts'));
  });

  it('rewrites on the BUILD route, not only the dev one', () => {
    // The bug this pins, found by running the build rather than by reading it:
    // `vite:build-html` has already replaced the entry's `src` with the emitted chunk by the
    // time `transformIndexHtml` runs at `generateBundle`, so a `transformIndexHtml`-only
    // plugin cannot swap the entry in a production build at all. The `transform` hook (with
    // `enforce: 'pre'`) is the one that runs early enough.
    const plugin = configuredPlugin();
    expect(plugin.enforce).toBe('pre');
    const out = plugin.transform(INDEX_HTML, '/x/index.html');
    expect(out).toContain('/src/main.crazygames.ts');
    expect(out).toContain('sdk.crazygames.com');
    // ...and it leaves every other module alone.
    expect(plugin.transform('const a = 1;', '/x/foo.ts')).toBeNull();
  });

  it('is idempotent, because both hooks run in a dev session', () => {
    const once = htmlTransform()(INDEX_HTML);
    const twice = htmlTransform()(once);
    expect(twice).toBe(once);
    // Specifically: no second SDK tag, which would be two scripts racing to install the
    // same global.
    expect(twice.match(/sdk\.crazygames\.com/g)).toHaveLength(1);
  });

  it('fails the build loudly if index.html stops referencing the default entry', () => {
    // The failure mode this guards is the quiet one: a rewrite that silently matches nothing
    // ships a build with NONE of the portal integration in it, which looks entirely normal
    // and fails review for reasons no log would name. Checked at `closeBundle`, because the
    // rewrite now has two possible routes and "neither fired" is the real condition.
    const plugin = portalPlugin();
    plugin.transform('<html><head></head><body></body></html>', '/x/index.html');
    expect(() => plugin.closeBundle()).toThrow(/never rewritten/);
  });

  it('accepts the build once a rewrite has landed', () => {
    // The control for the case above — otherwise "it throws" would also pass for a guard
    // that throws unconditionally.
    const plugin = portalPlugin();
    plugin.transform(INDEX_HTML, '/x/index.html');
    expect(() => plugin.closeBundle()).not.toThrow();
  });

  it('points matchmaking at the deployed backend, not localhost', () => {
    // The one default that can never be right for an uploaded bundle. `runState.ts` falls
    // back to `http://localhost:8788`, which is correct for `npm run dev` and would make
    // co-op, PvP, the ladder and accounts fail to connect on a portal page — silently, on a
    // build that works perfectly on the machine that made it. Importing the config is what
    // sets it (see the note at the top of the config), so this asserts the side effect.
    expect(process.env.VITE_MATCHSVC_URL).toBe('https://bb.gamestao.com');
  });

  it('does not emit the version manifest the auto-reload feeds', () => {
    // `main.crazygames.ts` deliberately installs no auto-reload (the portal serves an
    // immutable versioned upload from its own CDN), so shipping `version.json` would ship a
    // file nothing reads.
    const names = ((portalConfig as { plugins?: Array<{ name?: string }> }).plugins ?? [])
      .map((p) => p?.name);
    expect(names).not.toContain('dd-version-manifest');
    expect(names).toEqual(['crazygames-html']);
  });
});

describe('index.html — the shell all three targets share', () => {
  it('declares English, which the portal requires', () => {
    // English localisation is mandatory there, and `lang` is what a screen reader and the
    // host page's own tooling read. It said `zh-CN` until this pass.
    expect(INDEX_HTML).toMatch(/<html lang="en">/);
  });

  it('suppresses selection, the long-press magnifier and touch scrolling', () => {
    // Asked for by name in the technical requirements, and correct on every target: every
    // drag in this game is a control input, so a browser gesture reading one as a selection
    // or a pan is a lost input rather than a feature.
    for (const rule of ['-webkit-user-select: none', 'user-select: none', 'touch-action: none']) {
      expect(INDEX_HTML, `index.html is missing ${rule}`).toContain(rule);
    }
  });

  it('carries no build-stage label in the title', () => {
    // The title is the browser-tab text and the portal's own fallback label. It read
    // "Blightbloom — Vertical Slice" until this pass.
    expect(INDEX_HTML).toMatch(/<title>Blightbloom<\/title>/);
  });
});

describe('main.crazygames.ts — the boot order that cannot be observed from a module', () => {
  const at = (needle: string): number => {
    const i = ENTRY.indexOf(needle);
    expect(i, `main.crazygames.ts: no ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  /**
   * Where a STATEMENT is, not where the string first appears.
   *
   * `at('game.start()')` was silently wrong the moment a comment in that file mentioned the
   * call — which the 2026-09-10 identity-gate pass did, in the paragraph explaining what the
   * old order got wrong. The first hit then landed in prose ABOVE the code, so an ordering
   * assertion could pass while the code it describes was in the opposite order. Anchoring on
   * the leading newline + the entry's two-space indent is what makes the needle a line.
   */
  const stmt = (line: string): number => at(`
  ${line}`);

  it('installs the base asset host BEFORE the first preload', () => {
    // The one ordering bug with a half-working symptom: a host installed after
    // `preloadLobbyArt` leaves the lobby art fetched from the wrong place and everything
    // after it fetched from the right one, i.e. a menu with no art and a game with art.
    expect(at('setAssetHost(baseAssetHost(')).toBeLessThan(at('await preloadLobbyArt()'));
  });

  it('declares the host BEFORE the game is assembled', () => {
    // `wireScreens` reads it once, during assembly, to decide what PLAY does; a declaration
    // after that is read too late rather than ignored — the menu would silently keep the
    // four-click route on a host that requires one click.
    expect(at("setHostKind('crazygames')")).toBeLessThan(at('new Game(app, input, audio)'));
  });

  it('opens the loading bracket before the art phase it is meant to measure', () => {
    expect(at('sdk.loadingStart()')).toBeLessThan(at('await preloadLobbyArt()'));
  });

  it('drives the portal session from the ticker, after start()', () => {
    // Same reason `installPerf` is installed after `start()`: the callback then runs outside
    // every listener the game added, so the phase it reads is the phase the frame ended in.
    expect(stmt('game.start();')).toBeLessThan(stmt('app.ticker.add(() => portal.update());'));
  });

  it('installs no auto-reload', () => {
    // Deliberately absent, not forgotten — and a source assertion because the absence of a
    // call is exactly what no runtime test can see.
    expect(ENTRY).not.toMatch(/installAutoReload/);
  });

  it('waits for the identity gate BEFORE the first frame and before the splash comes down', () => {
    // The 2026-09-10 ordering fix (design/10). Both halves matter and they fail differently:
    // starting the game first makes the account label paint as a guest and flip, and removing
    // the splash first means the ONE-CLICK menu (design/20) is live while the login is still
    // in flight — so the first click starts a run, and the session lands mid-run.
    //
    // A source assertion because there is no seam: an entry point runs `boot()` at import.
    expect(stmt('const identity = await settleIdentity(')).toBeLessThan(stmt('game.start();'));
    expect(stmt('const identity = await settleIdentity(')).toBeLessThan(
      stmt("document.getElementById('boot-loading')?.remove();"),
    );
  });

  it('does NOT make the boot intent part of that wait', () => {
    // An accepted invite moves the player off the menu; doing that before there IS a menu is
    // a race with no upside. So the gate waits for the login only, and the rooms/intent half
    // of the same chain is attached after `game.start()`.
    expect(stmt('game.start();')).toBeLessThan(at('return applyPortalBootIntent(sdk);'));
  });

  it('leaves nothing in the SDK chain unhandled', () => {
    // `portal.start()` can reject (it awaits `sdk.init()` and `ads.probe()`), and until this
    // pass the whole chain was a bare `void ...` with no catch — an unhandled rejection on a
    // page where the console is something a platform reviewer reads.
    expect(ENTRY).toMatch(/\.catch\(\(e: unknown\) =>/);
  });

  it('hands the ad suspension the real ticker', () => {
    // The freeze is `ticker.stop()`; handing it anything else would leave an ad playing over
    // a game that is still simulating, which is the one ad rule with a hard "ensure" in it.
    expect(ENTRY).toMatch(/adSuspension\(app\.ticker\)/);
  });
});
