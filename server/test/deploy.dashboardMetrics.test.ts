/**
 * GATE: every metric a Grafana panel queries is a metric this server actually emits.
 *
 * The failure this exists for has already happened once in this project, one layer away.
 * `fc60cbe` fixed a client log field that nothing ever populated: the "errors by build
 * version" panel was **fully populated and said nothing**, because every client reported
 * `unknown`. A dashboard is the one artefact whose broken state looks like its working
 * state — a panel querying `bb_dau_total` when the server emits `bb_dau` draws an empty
 * graph, and an empty graph is exactly what a quiet day looks like.
 *
 * So the check is a join, in the only direction that can be checked mechanically:
 *
 *   **every `bb_*` name a Prometheus panel asks for → a `bb_*` name some `src/**.ts` emits**
 *
 * The reverse direction is deliberately NOT asserted. A metric with no panel is a fine
 * state (it may be there for an ad-hoc query, or for an alert nobody has written yet),
 * whereas a panel with no metric is always a defect.
 *
 * Loki panels are skipped: their queries are label selectors and line filters over log
 * streams, which this file has no way to validate and which
 * `deploy.observability.test.ts` covers by running Alloy's real parser against a real line.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Derived here rather than imported from `scripts/build.mjs`, matching
 *  `deploy.manifests.test.ts` — a plain `.mjs` has no declarations to import a path from. */
const serverRoot = fileURLToPath(new URL('..', import.meta.url));

const DASHBOARD_DIR = join(serverRoot, 'monitoring/grafana/dashboards');
const SRC = join(serverRoot, 'src');

/** Anything shaped like one of our metric names. */
const METRIC_RE = /\bbb_[a-z0-9_]+/g;

interface Panel {
  type?: string;
  title?: string;
  datasource?: { type?: string; uid?: string };
  targets?: { datasource?: { type?: string }; expr?: string }[];
}

function dashboards(): { file: string; panels: Panel[] }[] {
  return readdirSync(DASHBOARD_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      panels: (JSON.parse(readFileSync(join(DASHBOARD_DIR, file), 'utf8')) as { panels?: Panel[] }).panels ?? [],
    }));
}

/** Every `bb_*` name a PROMETHEUS panel target asks for, with where it was asked. */
function queried(): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (const { file, panels } of dashboards()) {
    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        const kind = target.datasource?.type ?? panel.datasource?.type;
        if (kind !== 'prometheus') continue;
        for (const m of (target.expr ?? '').matchAll(METRIC_RE)) {
          out.push({ name: m[0], where: `${file} → "${panel.title ?? panel.type ?? '?'}"` });
        }
      }
    }
  }
  return out;
}

/** Every `bb_*` name that appears as a string literal anywhere under `src/`. */
function emitted(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(METRIC_RE)) names.add(m[0]);
      }
    }
  };
  walk(SRC);
  return names;
}

describe('dashboard metric names', () => {
  it('found dashboards, panels and metric names to compare — the scan is not vacuous', () => {
    // Without this the whole file passes trivially on a typo in DASHBOARD_DIR, which is
    // the way a gate like this stops working: silently, and while still green.
    expect(dashboards().length).toBeGreaterThan(2);
    expect(queried().length).toBeGreaterThan(5);
    expect(emitted().size).toBeGreaterThan(5);
  });

  it('every metric a Prometheus panel queries is one the server emits', () => {
    const known = emitted();
    for (const { name, where } of queried()) {
      expect([...known], `${where} queries ${name}, which nothing under src/ emits`).toContain(name);
    }
  });

  it('would catch a name that does not exist', () => {
    // The gate's own falsifiability, asserted rather than assumed: the comparison is a set
    // membership test, so a name absent from the source set fails it. Written as a check on
    // the SET rather than by mutating a dashboard file, because a test that edits a shipped
    // config and restores it has a way to leave the repo dirty.
    expect(emitted().has('bb_dau')).toBe(true);
    expect(emitted().has('bb_dau_total_typo')).toBe(false);
  });

  it('the analytics dashboard asks for every gauge the rollup publishes', () => {
    // The other direction, asserted for THIS dashboard only — because these four names are
    // the entire output of design/21 §2.5, and a rollup gauge with no panel is a number
    // nobody will ever look at. Not a general rule (see the file header), just a specific
    // one where the whole set is small and known.
    const names = new Set(queried().filter((q) => q.where.startsWith('analytics.json')).map((q) => q.name));
    expect([...names].sort()).toEqual([
      'bb_dau',
      'bb_events_day',
      'bb_retention_cohort_size',
      'bb_retention_ratio',
      'bb_screen_views_day',
    ]);
  });
});
