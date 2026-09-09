/**
 * Foreground auto-reload for the deployed web client — ported from funny's
 * client/src/entries/web.ts version check.
 *
 * A tab that has been open across a deploy keeps running the old JS forever. So: whenever
 * the player returns to the tab, re-fetch /version.json (emitted by
 * build/versionManifestPlugin.mjs) and, if its hash no longer matches the one this page
 * booted with, reload.
 *
 * Two deliberate differences from funny's version:
 *  - funny compares against a version string baked in at compile time (NW_BUILD_VERSION).
 *    Our hash is computed *after* bundling, so it can't be baked in; instead the baseline is
 *    fetched once at boot, the same way tools/desktop-shell's contentUpdatePoller does with
 *    confirmBaseline(). Until that first fetch succeeds there is nothing to compare against
 *    and the watcher stays quiet — it never reloads on the fetch that establishes a baseline.
 *  - funny reloads unconditionally. A run here is client-side state, so a reload mid-run
 *    would throw it away: `canReload` lets the caller hold the update back until the player
 *    is somewhere losable-free (see main.ts). The pending update isn't forgotten — the next
 *    foreground return re-checks and reloads once the phase allows it.
 */

const VERSION_URL = '/version.json';

export interface VersionWatcherDeps {
  /** Reads the deployed build hash. Returns null when unavailable (offline, dev server, 404). */
  fetchHash: () => Promise<string | null>;
  /** Applies the update. */
  reload: () => void;
  /** Optional veto: return false to defer the reload to a later foreground return. */
  canReload?: () => boolean;
}

export interface VersionWatcher {
  /** Fetch and compare once. Never rejects — a failed check is simply skipped. */
  check: () => Promise<void>;
  /** The hash this page is treated as running, or null before the first successful fetch. */
  baseline: () => string | null;
}

export function createVersionWatcher(deps: VersionWatcherDeps): VersionWatcher {
  let baseline: string | null = null;

  return {
    baseline: () => baseline,
    async check() {
      let hash: string | null;
      try {
        hash = await deps.fetchHash();
      } catch {
        return; // offline / network error, ignore
      }
      if (!hash) return;
      if (baseline === null) {
        baseline = hash;
        return;
      }
      if (hash === baseline) return;
      if (deps.canReload && !deps.canReload()) return;
      deps.reload();
    },
  };
}

/** Default fetchHash: cache-busted, no-store GET of /version.json. */
export async function fetchDeployedHash(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`${VERSION_URL}?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const body = (await res.json()) as { hash?: string };
  return body?.hash ?? null;
}

/**
 * Wire the watcher to the document's visibility. Fires once immediately to establish the
 * baseline, then re-checks on every return to the foreground. No-op outside production
 * builds — the dev server emits no version.json (the plugin is `apply: 'build'`) and Vite's
 * own HMR already covers that case.
 */
export function installAutoReload(canReload?: () => boolean): void {
  if (!import.meta.env.PROD) return;

  const watcher = createVersionWatcher({
    fetchHash: () => fetchDeployedHash(),
    reload: () => window.location.reload(),
    canReload,
  });
  installed = watcher;

  void watcher.check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void watcher.check();
  });
}

let installed: VersionWatcher | null = null;

/**
 * The build hash this page is running, or `null` — the same baseline the reload watcher
 * already fetched, exposed rather than re-fetched.
 *
 * This exists for `net/clientLog.ts`, which stamps every batch of browser logs with a build
 * version so a dashboard can answer "is this error only on the new build?". That question is
 * the entire point of the field, and without a source it answered `unknown` for every real
 * client — a panel that looked populated and said nothing.
 *
 * Deliberately reuses the watcher's fetch instead of doing its own: `/version.json` is
 * already fetched at boot and on every foreground return, and a second poller for the same
 * file would be two requests answering one question.
 *
 * Honestly `null` in three cases, all of which degrade to `unknown` rather than break: a dev
 * build (the manifest plugin is `apply: 'build'`), the WeChat mini-game (whose config does
 * not run the plugin at all), and before the first fetch resolves. The portal build is the
 * interesting one — it is served from a SUB-PATH while `VERSION_URL` is absolute, so the
 * fetch 404s there; that is a pre-existing property of the reload watcher, and this function
 * inherits it rather than papering over it.
 */
export function deployedVersion(): string | null {
  return installed?.baseline() ?? null;
}
