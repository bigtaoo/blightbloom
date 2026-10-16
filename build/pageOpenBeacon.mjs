// The page-open beacon (design/21 §2.9): one inline `<script>` at the top of `<head>` that
// sends `page_open` the moment the HTML is parsed — before the bundle has even been
// requested — and leaves `window.__bbOpen = { session, at }` for `analyticsInstall.ts`.
//
// Why it exists: every other event is sent by the game, so a visitor who gave up while the
// bundle was still downloading left no trace at all, and "conversion to gameplay" — the first
// of the three numbers CrazyGames judges a launch on — had no denominator. With this, "opened
// but never booted" is a join by visit: the game's `session_start` reuses the session id the
// beacon sent under, and carries `boot_ms` measured from the beacon's own clock.
//
// Why a build plugin and not a line in `index.html`: the matchsvc origin is a build-time value
// (CI's `VITE_MATCHSVC_URL`, the portal config's default), and so is the host label. Baking
// them in here keeps the source `index.html` script-free apart from the entry module, which
// `bootSplash.test.ts` relies on.
//
// The script is ES5 and wrapped in try/catch end to end: it runs on every browser that
// can load the page at all, including ones the bundle itself will refuse, and a beacon that
// throws must never be the reason a page fails.

/** Where the beacon parks its hand-off for the bundle. Read by `analyticsInstall.ts`. */
export const HANDOFF_GLOBAL = '__bbOpen';

/** The install-id key `client/src/net/identity.ts` persists under (`IDENTITY_STORAGE_KEY`). */
export const INSTALL_KEY = 'daydayup.playerId.v1';

const HOSTS = ['web', 'crazygames'];

/**
 * The inline script's source, or null when there is nowhere to send to. Only an `https:`
 * origin is accepted: a dev build points at `http://localhost`, which a deployed page would
 * refuse as mixed content anyway, and an unset value must not become a request to nowhere.
 */
export function beaconScript(baseUrl, host) {
  if (typeof baseUrl !== 'string' || !/^https:\/\/[^\s"'<>\\]+$/.test(baseUrl)) return null;
  if (!HOSTS.includes(host)) throw new Error(`pageOpenBeacon: unknown host ${JSON.stringify(host)}`);
  const url = JSON.stringify(`${baseUrl.replace(/\/$/, '')}/client/events`);
  // The install id is read if one is already stored, so a returning player's opens join their
  // install; a first visit has none yet (the bundle mints it) and sends the visit id in its
  // place, which `store.ts` never turns into an active install.
  return (
    '(function(){try{' +
    'var t=Date.now(),c=window.crypto,' +
    "s=c&&c.randomUUID?c.randomUUID():'v-'+t.toString(36)+'-'+Math.random().toString(36).slice(2,10)," +
    'i=null;' +
    `try{i=localStorage.getItem(${JSON.stringify(INSTALL_KEY)})}catch(e){}` +
    `if(!i||i.length>48)i=s;window.${HANDOFF_GLOBAL}={session:s,at:t};` +
    `fetch(${url},{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',keepalive:true,` +
    `body:JSON.stringify({install:i,session:s,host:${JSON.stringify(host)},build:'unknown',locale:'unknown',sentAt:t,events:[{name:'page_open',at:t}]})})` +
    "['catch'](function(){})" +
    '}catch(e){}})();'
  );
}

/**
 * Put the script straight after `<meta charset>` — first in `<head>` would push the charset
 * declaration toward the 1024-byte window a browser sniffs it in, and anywhere later would
 * let the entry module's request start first. Fails the build if there is no charset tag,
 * rather than quietly shipping a page that never counts an open.
 */
export function injectBeacon(html, script) {
  if (script === null) return html;
  const charset = /<meta charset[^>]*>/i.exec(html);
  if (!charset) throw new Error('pageOpenBeacon: index.html has no <meta charset> to put the beacon after');
  const at = charset.index + charset[0].length;
  return `${html.slice(0, at)}
    <script>${script}</script>${html.slice(at)}`;
}

/** Vite plugin. `baseUrl` defaults to the resolved `VITE_MATCHSVC_URL`. */
export function pageOpenBeacon({ host, baseUrl } = {}) {
  let resolved = baseUrl;
  return {
    name: 'page-open-beacon',
    configResolved(config) {
      if (resolved === undefined) resolved = config.env?.VITE_MATCHSVC_URL;
    },
    transformIndexHtml(html) {
      return injectBeacon(html, beaconScript(resolved, host));
    },
  };
}
