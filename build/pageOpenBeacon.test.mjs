// build/pageOpenBeacon.mjs — the inline `page_open` beacon (design/21 §2.9).
//
// The script is RUN here, in a `node:vm` context with a fake window, rather than matched as
// text: what matters is the request it makes and the hand-off it leaves, and both fail
// silently — a beacon that throws, or posts a body the server refuses, leaves the funnel's
// first step empty while the game works perfectly.
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { HANDOFF_GLOBAL, INSTALL_KEY, beaconScript, injectBeacon, pageOpenBeacon } from './pageOpenBeacon.mjs';

/** Run the script against a fake browser and return what it did. */
function run(script, { stored = null, uuid = 'uuid-1', storageThrows = false, fetchThrows = false, reject = false } = {}) {
  const posts = [];
  const window = {
    crypto: uuid === null ? undefined : { randomUUID: () => uuid },
  };
  const ctx = {
    window,
    Date: { now: () => 1_700_000_000_000 },
    Math,
    JSON,
    localStorage: {
      getItem: (k) => {
        if (storageThrows) throw new Error('SecurityError');
        return k === INSTALL_KEY ? stored : null;
      },
    },
    fetch: (url, init) => {
      if (fetchThrows) throw new Error('no fetch');
      posts.push({ url, init, body: JSON.parse(init.body) });
      return reject ? Promise.reject(new Error('offline')) : Promise.resolve({});
    },
  };
  vm.runInNewContext(script, ctx);
  return { posts, handoff: window[HANDOFF_GLOBAL] };
}

describe('beaconScript', () => {
  it('posts page_open to the events route and leaves the hand-off', () => {
    const { posts, handoff } = run(beaconScript('https://bb.gamestao.com/', 'web'));
    expect(posts).toHaveLength(1);
    const [p] = posts;
    expect(p.url).toBe('https://bb.gamestao.com/client/events');
    expect(p.init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true, headers: { 'content-type': 'application/json' } });
    expect(p.body).toEqual({
      install: 'uuid-1',
      session: 'uuid-1',
      host: 'web',
      build: 'unknown',
      locale: 'unknown',
      sentAt: 1_700_000_000_000,
      events: [{ name: 'page_open', at: 1_700_000_000_000 }],
    });
    expect(handoff).toEqual({ session: 'uuid-1', at: 1_700_000_000_000 });
  });

  it('joins a returning player\'s stored install id, but not an oversized one', () => {
    expect(run(beaconScript('https://x.test', 'crazygames'), { stored: 'inst-7' }).posts[0].body).toMatchObject({ install: 'inst-7', session: 'uuid-1', host: 'crazygames' });
    expect(run(beaconScript('https://x.test', 'web'), { stored: 'x'.repeat(49) }).posts[0].body.install).toBe('uuid-1');
    expect(run(beaconScript('https://x.test', 'web'), { storageThrows: true }).posts[0].body.install).toBe('uuid-1');
  });

  it('mints a fallback id without crypto.randomUUID', () => {
    const { posts, handoff } = run(beaconScript('https://x.test', 'web'), { uuid: null });
    expect(handoff.session).toMatch(/^v-[a-z0-9]+-[a-z0-9]{1,8}$/);
    expect(posts[0].body.session).toBe(handoff.session);
  });

  it('never throws out of the page, whatever fails', () => {
    expect(() => run(beaconScript('https://x.test', 'web'), { fetchThrows: true })).not.toThrow();
    expect(() => run(beaconScript('https://x.test', 'web'), { reject: true })).not.toThrow();
  });

  it('is null for a non-https or missing origin, and refuses an unknown host', () => {
    expect(beaconScript(undefined, 'web')).toBeNull();
    expect(beaconScript('', 'web')).toBeNull();
    expect(beaconScript('http://localhost:8787', 'web')).toBeNull();
    expect(beaconScript('https://x.test/"><script>', 'web')).toBeNull();
    expect(() => beaconScript('https://x.test', 'wechat')).toThrow(/unknown host/);
  });
});

describe('injectBeacon', () => {
  const HTML = '<!doctype html><html><head>\n    <meta charset="UTF-8" />\n    <title>t</title><script type="module" src="/src/main.ts"></script></head></html>';

  it('puts the script straight after <meta charset>, before every other script', () => {
    const out = injectBeacon(HTML, 'X()');
    expect(out.indexOf('<script>X()</script>')).toBeGreaterThan(out.indexOf('<meta charset'));
    expect(out.indexOf('<script>X()</script>')).toBeLessThan(out.indexOf('<title>'));
    expect(out.indexOf('<script>X()</script>')).toBeLessThan(out.indexOf('type="module"'));
  });

  it('leaves the page alone with no script, and fails the build with no charset tag', () => {
    expect(injectBeacon(HTML, null)).toBe(HTML);
    expect(() => injectBeacon('<html><head></head></html>', 'X()')).toThrow(/no <meta charset>/);
  });
});

describe('pageOpenBeacon (plugin)', () => {
  it('takes the origin from the resolved env when none is passed', () => {
    const p = pageOpenBeacon({ host: 'web' });
    p.configResolved({ env: { VITE_MATCHSVC_URL: 'https://bb.gamestao.com' } });
    expect(p.transformIndexHtml('<meta charset="utf-8">')).toContain('https://bb.gamestao.com/client/events');
  });

  it('an explicit origin wins over the env, and no origin injects nothing', () => {
    const p = pageOpenBeacon({ host: 'crazygames', baseUrl: 'https://a.test' });
    p.configResolved({ env: { VITE_MATCHSVC_URL: 'https://b.test' } });
    expect(p.transformIndexHtml('<meta charset="utf-8">')).toContain('https://a.test/client/events');
    const none = pageOpenBeacon({ host: 'web' });
    none.configResolved({});
    expect(none.transformIndexHtml('<meta charset="utf-8">')).toBe('<meta charset="utf-8">');
    expect(pageOpenBeacon().name).toBe('page-open-beacon');
  });
});
