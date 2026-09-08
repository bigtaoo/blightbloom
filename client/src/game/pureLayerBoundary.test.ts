/**
 * Guards the boundary of the client's PURE layer — the modules that carry run logic and must
 * stay loadable, and testable, with no browser behind them.
 *
 * ## Why the 90% coverage gate cannot do this job
 *
 * The gate's headroom is `covered / 0.9 - total`. The client sits at ~96% lines, so hundreds
 * of uncovered lines can be added before the number crosses the bar — and the headroom GROWS
 * as the tests improve. A file that imports `pixi.js` and drops into `runState.ts`'s
 * neighbourhood therefore lands inside the gated scope, adds untested lines, and the gate
 * stays comfortably green. The percentage measures how much is tested; it says nothing about
 * whether the thing is testable at all.
 *
 * The concrete failure it prevents: `runState.ts` exists because `Game.ts` could not be
 * unit-tested without a WebGL renderer (see that file's header). One `import { Container }
 * from 'pixi.js'` added to it for convenience re-creates that problem silently — every
 * existing test keeps passing, because they are already running in an environment where the
 * import happens to resolve, and the cost only shows up the next time someone tries to add a
 * test and finds they cannot.
 *
 * ## What "pure" means here, operationally
 *
 * TWO halves, and the second is the one an import-graph check alone misses:
 *
 *   (a) no runtime import may reach a module that needs a browser, transitively;
 *   (b) the file may not touch a browser global itself.
 *
 * (a) alone is a hole you can drive through — a module needs no imports at all to call
 * `document.createElement`. Type-only imports are exempt from (a): they are erased before the
 * bundle exists, and `import type { GameEngine }` costs nothing. That is why the check parses
 * import FORMS rather than grepping for the word "pixi": `import type` of a Pixi module is
 * fine and a bare `import { Container }` is not, and no substring search can tell them apart.
 *
 * Adapted from the sibling project `funny`'s `client/test/pureLayerBoundary.test.ts`, whose
 * own header records the motivating case: a scene input module that built hidden DOM
 * `<input>` overlays while importing nothing but a type, which the import-graph check alone
 * called pure.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * The pure modules. Not a directory yet, on purpose: this is the boundary as it actually
 * stands after the 2026-09-03 Game.ts split, and inventing a `logic/` directory to hold four
 * files whose callers all live one level up would be renaming rather than structuring.
 *
 * The list is short and every entry is load-bearing:
 *
 *   runState.ts        the shared lower layer the whole split rests on.
 *   ScreenNav.ts       the phase writes.
 *   OnlineMatch.ts     the queue-mode fields and the failure paths.
 *   ForgeInput.ts      the key table.
 *   weaponSlotSelect.ts the slot-picker → toggle bridge (pure since it was written).
 *
 * `gameWiring.ts` is deliberately ABSENT even though most of it qualifies: `wireWindow`
 * registers the two real `window` listeners, so the file IS the DOM adapter for the table.
 * The rule it carries — that pause and F9 are offline-only — was extracted into
 * `keydownAction`, a pure function in that same file, precisely so the rule could be tested
 * without a window even though its caller cannot be. `gameWiring.test.ts` is where that
 * happens.
 *
 * `RunLifecycle.ts` is absent for a different reason, and it is the interesting one: it imports
 * `Container` from pixi as a type only, but it also calls `child.destroy()` on the fx layer
 * and hands geometry to `RoomBuilder`, so it is a renderer collaborator whose arithmetic
 * happens to be testable with fakes — not a pure module. Listing it would make this guard a
 * lie in exactly the way it exists to prevent. Same call `funny` made for
 * `WorldMapRenderer/viewport.ts`.
 */
const PURE_FILES = [
  'runState.ts',
  // The per-phase power budget (2026-09-08). It writes a Pixi display bit and a Pixi ticker
  // knob, and is listed here BECAUSE of that: both arrive as one-property structural
  // interfaces, so the policy — which phases draw the world, what each caps the frame rate
  // at — is decidable and testable with two plain objects. A `Container`/`Ticker` import
  // would make the same file need a renderer to answer a question about `phase`.
  'powerBudget.ts',
  'controllers/ScreenNav.ts',
  'controllers/OnlineMatch.ts',
  'controllers/ForgeInput.ts',
  'controllers/weaponSlotSelect.ts',
  // Two that predate the split and qualified all along — form-(1) free-function modules
  // carved out of EventReactor and RunOutcome on 2026-09-02. Added here when this guard's
  // own survey named them (see the last case in this file), which is the survey working.
  'controllers/attackShapes.ts',
  'controllers/localOutcome.ts',
  // Carved out of GameLoop.updateHud on 2026-09-05 (the floor-card pass). It decides
  // WHEN the checkpoint overlays are shown and touches the views only through injected
  // interfaces, so it qualifies — and being here is what makes "does the card offer show
  // on exactly the same condition as the portal" testable with no browser at all.
  'controllers/checkpointOverlays.ts',
  // The purchase flow (design/19 §4, 2026-09-05). Every dependency it has is injected — the
  // three wire calls, the session read, the platform gate, the ownership refresh and `sleep`
  // — so the whole create → poll → deliver chain, including its timed-out and
  // delivered-but-unrefreshed arms, runs with no network, no clock and no page. Being listed
  // here is what keeps it that way: money logic that can only be exercised through a live
  // fetch is money logic nobody exercises.
  'controllers/StorePurchase.ts',
] as const;

/**
 * Non-relative specifiers a pure module may import at RUNTIME: environment-free by
 * construction. Anything else non-relative fails and has to be classified here, which is the
 * point — adding a dependency to a pure layer should require saying so out loud.
 */
const ALLOWED_PACKAGES = new Set([
  '@dd/engine', // the deterministic sim core: no DOM, no renderer, its own 97% suite
]);

/**
 * Runtime globals whose presence means the module needs a browser (or WeChat) — the (b) half.
 *
 * Deliberately NOT a list of everything ambient. `setTimeout`, `performance` and `console`
 * exist in node too, so a pure module using them still loads and still tests, and banning
 * them would buy noise instead of safety. `Math.random`/`Date.now` are nondeterminism rather
 * than environment dependence — a different problem, handled per-test where it matters. What
 * is listed is what makes a module unloadable or untestable off a page.
 */
const BROWSER_GLOBALS = [
  'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Image', 'Audio', 'alert', 'wx',
] as const;

/**
 * Source with comments and string/template literals blanked out, so a global's NAME appearing
 * in prose ("...the document is torn down...") or in a message string does not fail the
 * check. Blanks rather than deletes, to keep byte offsets — and therefore reported line
 * numbers — honest.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const c2 = src.slice(i, i + 2);
    if (c2 === '//') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c2 === '/*') {
      while (i < n && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

interface Imp {
  spec: string;
  typeOnly: boolean;
}

/**
 * The module's import specifiers, each flagged type-only. Regex rather than a real parser on
 * purpose: these are hand-written ES modules, and a parser dependency for a guard is a worse
 * trade than a check that over-reports on exotic syntax — over-reporting fails loudly and
 * gets fixed, while a parser that silently disagrees with the bundler does not.
 */
function importsOf(src: string): Imp[] {
  const out: Imp[] = [];
  const re = /^\s*import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[2] ?? '';
    // `import { type A, type B } from 'x'` is also fully erased, so treat an all-type
    // named clause as type-only too.
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    const allNamedAreTypes =
      named !== null &&
      named[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
    out.push({ spec: m[3]!, typeOnly: Boolean(m[1]) || allNamedAreTypes });
  }
  // A bare side-effect import (`import 'x'`) has no `from` and is never erased.
  const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
  while ((m = bare.exec(src)) !== null) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** Resolve a relative specifier against a file, trying the extensions this repo uses. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Walk the RUNTIME import graph from `entry`, returning every reachable file. */
function runtimeGraph(entry: string): { files: string[]; foreign: string[] } {
  const seen = new Set<string>();
  const foreign: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const imp of importsOf(src)) {
      if (imp.typeOnly) continue;
      if (!imp.spec.startsWith('.')) {
        if (!ALLOWED_PACKAGES.has(imp.spec) && !imp.spec.startsWith('@dd/engine/')) {
          foreign.push(`${file.slice(GAME_ROOT.length + 1)} -> ${imp.spec}`);
        }
        continue;
      }
      const resolved = resolveRelative(file, imp.spec);
      // An unresolvable relative import is a bug in this check, not in the module — fail
      // loudly rather than quietly treating it as clean.
      expect(resolved, `${file}: cannot resolve '${imp.spec}'`).not.toBeNull();
      queue.push(resolved!);
    }
  }
  return { files: [...seen], foreign };
}

describe('the pure layer', () => {
  it('canary: the list names files that exist', () => {
    // Every case below iterates PURE_FILES, so an emptied or misspelt list would pass them
    // all while guarding nothing — the same shape as the coverage gate's own canary.
    expect(PURE_FILES.length).toBeGreaterThanOrEqual(7);
    for (const rel of PURE_FILES) {
      expect(existsSync(join(GAME_ROOT, rel)), rel).toBe(true);
    }
  });

  it.each(PURE_FILES)('%s reaches no browser-dependent module, transitively', (rel) => {
    const { foreign } = runtimeGraph(join(GAME_ROOT, rel));
    expect(
      foreign,
      `${rel}: a pure module may only import '@dd/engine' and relative files. Add the package ` +
        "to ALLOWED_PACKAGES with the reason it is environment-free, or don't import it here.",
    ).toEqual([]);
  });

  it.each(PURE_FILES)('%s touches no browser global itself', (rel) => {
    // FILE-LOCAL, not transitive, and the difference is calibration rather than laziness.
    // Applied across the whole graph this check fails `OnlineMatch.ts` for reaching
    // `net/session.ts`, which reads `localStorage` — behind its own `typeof` guard, in a
    // module that already runs green in node under its own suite. Banning that would mean a
    // pure module could never call a storage-backed helper at all, which buys noise, not
    // safety. What the file-local rule catches is the thing that actually re-creates the
    // problem this layer exists to solve: a module that itself cannot run without a page.
    const src = stripCommentsAndStrings(readFileSync(join(GAME_ROOT, rel), 'utf8'));
    const hits: string[] = [];
    src.split('\n').forEach((line, i) => {
      for (const g of BROWSER_GLOBALS) {
        // Word boundary on both sides, and not preceded by a dot — `this.window` or
        // `opts.fetch` is a field name, not the global.
        if (new RegExp(`(^|[^.\\w$])${g}\\b`).test(line)) hits.push(`${rel}:${i + 1}: ${g}`);
      }
    });
    expect(hits, `${rel}: touches a browser global`).toEqual([]);
  });

  it('the guard can FAIL — a control against a module that is not pure', () => {
    // Without this, every assertion above would pass just as happily if `runtimeGraph` found
    // nothing or `importsOf` matched no lines. `Game.ts` imports pixi.js outright.
    const { foreign } = runtimeGraph(join(GAME_ROOT, 'Game.ts'));
    expect(foreign.length).toBeGreaterThan(0);
    expect(foreign.some((f) => f.includes('pixi.js'))).toBe(true);
  });

  it('names every file under controllers/ that is pure but unlisted', () => {
    // Not a failure — a REPORT, printed as an assertion message only when the answer is
    // surprising. The list above is meant to be the whole pure layer; a module that has
    // quietly become pure should either join it (and gain the guard) or have a reason not to.
    const dir = join(GAME_ROOT, 'controllers');
    const listed = new Set(PURE_FILES.map((f) => f.replace('controllers/', '')));
    const candidates: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || listed.has(name)) continue;
      const { foreign } = runtimeGraph(join(dir, name));
      if (foreign.length === 0) candidates.push(name);
    }
    // Known and deliberate: these reach no foreign package but are renderer/engine
    // collaborators rather than pure logic — see PURE_FILES' own note on RunLifecycle.
    const KNOWN = new Set(['ArtGate.ts', 'ForgeActions.ts', 'RunOutcome.ts', 'ScreenFlow.ts',
      'AllyController.ts', 'CommandBuilder.ts', 'EventReactor.ts', 'GameLoop.ts',
      'LocalPredictor.ts', 'PvpBotController.ts', 'TutorialHintController.ts',
      'RunLifecycle.ts', 'gameAssembly.ts', 'confirmEdge.ts', 'ai/tactics.ts',
      // Pure by import graph, but `wireWindow` registers the two real window listeners —
      // see PURE_FILES' own note.
      'gameWiring.ts']);
    expect(candidates.filter((c) => !KNOWN.has(c))).toEqual([]);
  });
});
