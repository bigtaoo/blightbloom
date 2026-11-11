/**
 * The Playgama BUILD, as `crazygames/portalBuild.test.ts` tests that portal's: the real
 * `index.html` through the real config's own transform, and the real entry's source order.
 *
 * What would fail silently, each a black screen or a refused upload on a host this repository
 * cannot open: the Bridge script after the entry module (the entry awaits `bridge.initialize()`,
 * and Vite hoists the module into `<head>`), the wrong entry, a missing config file (no
 * interstitial cooldown), a policy page or `_headers` in the upload, and an entry that touches
 * storage before Bridge storage is adopted.
 */
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import playgamaConfig, {
  BRIDGE_CONFIG, DROPPED_FILES, gameVersion, playgamaHtml, rewritePlaygamaHtml,
} from '../../../vite.playgama.config.js';
import { AD_PLACEMENTS } from './PlaygamaSession';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const ENTRY = read('../../main.playgama.ts');
const INDEX_HTML = read('../../../index.html');

interface Plugin {
  name: string;
  enforce?: string;
  transform: (code: string, id: string) => string | null;
  transformIndexHtml: (h: string) => string;
  configResolved: (c: { root: string; build: { outDir: string } }) => void;
  configureServer: (s: { middlewares: { use: (path: string, fn: (req: unknown, res: unknown) => void) => void } }) => void;
  generateBundle: (this: { emitFile: (f: unknown) => void }) => void;
  closeBundle: () => void;
}

const fresh = (): Plugin => (playgamaHtml as () => Plugin)();

/** The `playgama-bridge-config.json` the build emits, parsed — the bytes Bridge fetches. */
function emitConfig(): Record<string, unknown> {
  const emitted: { fileName?: string; source?: string }[] = [];
  fresh().generateBundle.call({ emitFile: (f) => void emitted.push(f as never) });
  return JSON.parse(emitted[0]!.source!) as Record<string, unknown>;
}

describe('vite.playgama.config.js', () => {
  it('serves from a relative base into its own outDir, with the plugin first', () => {
    const c = playgamaConfig as { base?: string; build?: { outDir?: string }; plugins?: { name?: string }[] };
    expect(c.base).toBe('./');
    expect(c.build?.outDir).toBe('dist-playgama');
    expect(c.plugins?.[0]?.name).toBe('playgama-html');
    expect((c.plugins?.[0] as { enforce?: string }).enforce).toBe('pre');
  });

  it('makes the Bridge script the FIRST thing in <head>, ahead of every module script', () => {
    const out = rewritePlaygamaHtml(INDEX_HTML);
    const head = out.slice(out.indexOf('<head>') + '<head>'.length).trimStart();
    expect(head.startsWith('<script src="https://bridge.playgama.com/v2/stable/playgama-bridge.js"></script>')).toBe(true);
    expect(out).not.toMatch(/bridge\.playgama\.com[^"]*"\s+(async|defer|type="module")/);
  });

  it('swaps the entry module, and the rewrite is idempotent', () => {
    const once = rewritePlaygamaHtml(INDEX_HTML);
    expect(once).toContain('/src/main.playgama.ts');
    expect(once).not.toContain('/src/main.ts');
    expect(rewritePlaygamaHtml(once)).toBe(once);
  });

  it('transforms html only, through both hooks', () => {
    const p = fresh();
    expect(p.transform('export {}', 'x.ts')).toBeNull();
    expect(p.transform(INDEX_HTML, '/abs/index.html')).toContain('main.playgama.ts');
    expect(p.transformIndexHtml(INDEX_HTML)).toContain('bridge.playgama.com');
  });

  // The two halves of the placement list live either side of the build/source line — the ids
  // the game sends are in `AD_PLACEMENTS`, the ids the platform can route are in the JSON this
  // config emits — and nothing at runtime would report a mismatch: an undeclared id just falls
  // back to `placementFallback`, so every pause would arrive under one name and the split
  // between them would quietly read as zero.
  //
  // Read back out of the EMITTED bytes rather than off `BRIDGE_CONFIG` directly: those are
  // what Bridge fetches, and the object this file imports is a `.js` export whose nested
  // members TypeScript does not see from a `.ts` test (no `allowJs` here, by design).
  it('declares exactly the placements the game sends, and preloads one of them', () => {
    const ad = emitConfig().advertisement as {
      interstitial: { preloadOnStart: string; placementFallback: string; placements: { id: string }[] };
    };
    const declared = ad.interstitial.placements.map((pl) => pl.id);
    expect([...declared].sort()).toEqual([...Object.values(AD_PLACEMENTS)].sort());
    expect(declared).toContain(ad.interstitial.preloadOnStart);
    expect(declared).toContain(ad.interstitial.placementFallback);
  });

  it('emits the Bridge config, and the dev server serves the same bytes', () => {
    const p = fresh();
    const emitted: { fileName?: string; source?: string }[] = [];
    p.generateBundle.call({ emitFile: (f) => void emitted.push(f as never) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toBe('playgama-bridge-config.json');
    expect(JSON.parse(emitted[0]!.source!)).toEqual(BRIDGE_CONFIG);
    expect(BRIDGE_CONFIG.advertisement.minimumDelayBetweenInterstitial).toBeGreaterThanOrEqual(60);

    let route = '';
    let handler: ((req: unknown, res: unknown) => void) | null = null;
    p.configureServer({ middlewares: { use: (path, fn) => { route = path; handler = fn; } } });
    expect(route).toBe('/playgama-bridge-config.json');
    const res = { headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: string) { this.body = b; } };
    handler!({}, res);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBe(emitted[0]!.source);
  });

  it('drops the files that have no place in the upload, and keeps the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'pg-build-'));
    mkdirSync(join(root, 'out'));
    for (const f of [...DROPPED_FILES, 'index.html']) writeFileSync(join(root, 'out', f), 'x');
    const p = fresh();
    p.configResolved({ root, build: { outDir: 'out' } });
    p.transformIndexHtml(INDEX_HTML);
    p.closeBundle();
    for (const f of DROPPED_FILES) expect(existsSync(join(root, 'out', f)), f).toBe(false);
    expect(existsSync(join(root, 'out', 'index.html'))).toBe(true);
    expect(DROPPED_FILES).toEqual(expect.arrayContaining(['_headers', 'privacy.html', 'terms.html']));
  });

  it('fails the build when index.html was never rewritten', () => {
    const p = fresh();
    p.configResolved({ root: tmpdir(), build: { outDir: 'pg-nothing-here' } });
    expect(() => p.closeBundle()).toThrow(/never rewritten/);
    p.transformIndexHtml('<html><head></head><body><script type="module" src="/src/other.ts"></script></body></html>');
    expect(() => p.closeBundle()).toThrow(/never rewritten/);
  });
});

describe('gameVersion', () => {
  it('is the package version plus the short commit', () => {
    expect(gameVersion(() => 'abc1234')).toMatch(/^\d+\.\d+\.\d+\+abc1234$/);
  });

  it('still builds without git', () => {
    expect(gameVersion(() => { throw new Error('not a repo'); })).toMatch(/\+unknown$/);
    expect(gameVersion(() => '')).toMatch(/\+unknown$/);
  });

  it('is defined into the bundle as import.meta.env.VITE_GAME_VERSION', () => {
    const define = (playgamaConfig as { define?: Record<string, string> }).define ?? {};
    expect(JSON.parse(define['import.meta.env.VITE_GAME_VERSION']!)).toMatch(/^\d+\.\d+\.\d+\+/);
  });
});

describe('main.playgama.ts — the boot order', () => {
  const at = (needle: string): number => {
    const i = ENTRY.indexOf(needle);
    expect(i, `main.playgama.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('awaits Bridge, then adopts its storage, before any store or the Game exists', () => {
    const init = at('await bridge.init(import.meta.env.VITE_GAME_VERSION)');
    const storage = at('await adoptBridgeStorage(');
    expect(init).toBeLessThan(storage);
    for (const later of ['persistedLocale()', 'installAnalytics(', 'new Game(']) {
      expect(at(later), later).toBeGreaterThan(storage);
    }
  });

  it('follows platform.language before it reads the persisted locale', () => {
    expect(at('setPreferredLanguages(')).toBeLessThan(at('persistedLocale()'));
  });

  it('sends analytics through Bridge, and never reaches for our server', () => {
    expect(ENTRY).toContain('send: bridgeSender(bridge, attention)');
    for (const banned of ['VITE_MATCHSVC_URL', 'installClientLog', 'fetchPublicFlags', 'pageOpenBeacon']) {
      expect(ENTRY, banned).not.toContain(banned);
    }
  });

  it('sends each event at once, since a portal frame dies without a pagehide to flush on', () => {
    expect(ENTRY).toContain('sendEachEvent: true');
  });

  it('asks for the keys before analytics, whose events carry attention, and holds on them after ready', () => {
    expect(at('new WebPlatform()')).toBeLessThan(at('installAnalytics('));
    expect(at('session.ready();')).toBeLessThan(at('session.watchKeys();'));
  });

  it('times the first input from game_ready, not from the download', () => {
    expect(at('session.ready();')).toBeLessThan(at('trackFirstInput('));
  });

  it('stamps the build version on Bridge and on the analytics batch', () => {
    expect(ENTRY).toContain('build: () => import.meta.env.VITE_GAME_VERSION ?? null');
  });

  it('watches the frame size only after game_ready, so a 0x0 frame cannot deadlock the boot', () => {
    // The ready signal waits for a rendered frame; a hold armed first would stop the ticker
    // that has to render it (PlaygamaSession.watchViewport).
    expect(at('await afterFirstRenderedFrame(')).toBeLessThan(at('session.ready();'));
    expect(at('session.ready();')).toBeLessThan(at('session.watchViewport();'));
  });

  it('auto-starts the first run right after start(), before the session exists', () => {
    // `game/controllers/firstRunAutostart.ts`: a first-time visitor skips the menu. Before the
    // session, so the first phase it observes is the run and `gameplay_started` is its first word.
    expect(at('game.start();')).toBeLessThan(at('game.startFirstRunIfNew();'));
    expect(at('game.startFirstRunIfNew();')).toBeLessThan(at('new PlaygamaSession('));
  });

  it('says game_ready only after the first rendered frame', () => {
    expect(at('await afterFirstRenderedFrame(')).toBeLessThan(at('session.ready()'));
  });
});
