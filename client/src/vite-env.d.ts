// Ambient declarations for the bits of Vite's own runtime API this codebase uses. The
// workspace tsconfigs set `"types": []` (tsconfig.base.json) and never pull in
// `vite/client`, so each one has to be declared here.

/** `import.meta.env` — Vite statically replaces these at build time. Only the flags this
 * codebase actually reads are declared; see autoReload.ts for PROD's use, runState.ts for
 * VITE_MATCHSVC_URL's (server/deploy/README.md §3). */
interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly VITE_MATCHSVC_URL: string | undefined;
  /** Vite's `base`, as a runtime value. `'/'` for the root-hosted build, `'./'` for the
   *  portal one (`vite.crazygames.config.js`) — `main.crazygames.ts` feeds it to
   *  `render/assetHost.ts`'s `baseAssetHost`, which is what rewrites this repository's own
   *  absolute asset paths. Vite always defines it. */
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The Vite build configs are plain JS with no declaration file, and one of them is
 * IMPORTED BY A TEST: `platform/crazygames/portalBuild.test.ts` exercises the config's own
 * `transformIndexHtml` against the real `index.html`, so that the entry swap and the SDK
 * script tag are asserted against the shipped transform rather than against a copy of its
 * regex. Declared as `unknown` on purpose — the test narrows what it reads, field by field,
 * which is what makes it fail when the config's shape changes. */
declare module '*/vite.crazygames.config.js' {
  const config: unknown;
  export default config;
  /** The HTML rewrite (entry swap + SDK tag), so the test exercises the shipped string
   *  surgery rather than a copy of it. */
  export const rewritePortalHtml: unknown;
  /** The plugin FACTORY. Its build guard is per-instance state, so a test that asserts
   *  "a build with no rewrite fails" needs a fresh one. */
  export const portalHtml: unknown;
}

/** `import source from './file.ts?raw'` — Vite hands back the file's text unparsed.
 * Used by textMetrics.test.ts to assert an entry point still calls a boot-order-critical
 * function, which importing the entry itself cannot check (importing it runs `boot()`). */
declare module '*?raw' {
  const contents: string;
  export default contents;
}
