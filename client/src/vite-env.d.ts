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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** `import source from './file.ts?raw'` — Vite hands back the file's text unparsed.
 * Used by textMetrics.test.ts to assert an entry point still calls a boot-order-critical
 * function, which importing the entry itself cannot check (importing it runs `boot()`). */
declare module '*?raw' {
  const contents: string;
  export default contents;
}
