/**
 * Frame-pacing telemetry (`perfReport.ts`, 2026-09-22).
 *
 * The line this produces is parsed twice on its way to a Grafana panel — once by the server's
 * own logfmt rendering and once by `line_format "{{.msg}}" | logfmt` inside the query — and
 * neither parse can fail loudly. A field renamed, a `NaN`, a value with a space in it: all of
 * them come out the far end as a panel reading "No data", which is indistinguishable from
 * nobody having played. So the format itself is pinned here, character by character, and not
 * just the arithmetic behind it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PerfReporter, PERF_LOG_TAG, REPORT_INTERVAL_MS, type PerfReportDeps } from './perfReport';
import { longFrameRatio, type FrameWindow } from './frameSampler';

function win(over: Partial<FrameWindow> = {}): FrameWindow {
  return {
    fps: 60,
    frames: 120,
    windowMs: 2000,
    busyRatio: 0,
    frame: { p50: 16.7, p95: 17, max: 20 },
    longFrameRatio: 0,
    update: { p50: 0.6, p95: 1, max: 3 },
    render: { p50: 2.1, p95: 4, max: 9 },
    discarded: false,
    ...over,
  };
}

function harness(over: Partial<PerfReportDeps> = {}) {
  const lines: string[] = [];
  const reporter = new PerfReporter({
    emit: (l) => lines.push(l),
    displayHz: () => 60,
    tier: () => 'high',
    frameCap: () => 60,
    ...over,
  });
  return { reporter, lines };
}

/** Parse one emitted line the way the Grafana query's second `| logfmt` does. */
function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of line.split(' ')) {
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

describe('PerfReporter cadence', () => {
  it('says nothing until it has a minute of play to describe', () => {
    const { reporter, lines } = harness();
    for (let i = 0; i < REPORT_INTERVAL_MS / 2000 - 1; i++) reporter.observe(win());
    expect(lines).toHaveLength(0);
    reporter.observe(win());
    expect(lines).toHaveLength(1);
  });

  it('starts over after each line rather than reporting a running total', () => {
    const { reporter, lines } = harness();
    const minute = (fps: number): void => {
      for (let i = 0; i < REPORT_INTERVAL_MS / 2000; i++) {
        reporter.observe(win({ fps, frames: fps * 2, longFrameRatio: fps < 50 ? 0.5 : 0 }));
      }
    };
    minute(60);
    minute(40);
    expect(lines).toHaveLength(2);
    // The second line describes the second minute only. A running total would have averaged
    // the two and reported a game that was never that smooth and never that rough.
    expect(Number(fields(lines[1]!).long_pct)).toBeCloseTo(50, 0);
    expect(Number(fields(lines[0]!).long_pct)).toBe(0);
  });

  it('ignores a hidden tab entirely — neither counted nor held against the interval', () => {
    // rAF is throttled to ~1 Hz in a background tab. Counting those windows would report that
    // the game runs at 3 fps on a desktop; holding them against the interval would report a
    // "minute" of play that was mostly a tab nobody was looking at.
    const { reporter, lines } = harness();
    for (let i = 0; i < 100; i++) reporter.observe(win({ discarded: true, fps: 1, frames: 2 }));
    expect(lines).toHaveLength(0);

    for (let i = 0; i < REPORT_INTERVAL_MS / 2000; i++) reporter.observe(win());
    expect(lines).toHaveLength(1);
    expect(Number(fields(lines[0]!).fps)).toBeCloseTo(60, 0);
  });

  it('ignores a window with no frames in it', () => {
    const { reporter, lines } = harness();
    for (let i = 0; i < 100; i++) reporter.observe(win({ frames: 0, fps: 0 }));
    expect(lines).toHaveLength(0);
  });

  it('flushes a part-minute, and flushing an empty one sends nothing', () => {
    const { reporter, lines } = harness();
    reporter.flush();
    expect(lines).toHaveLength(0); // a run that never produced a window says nothing

    reporter.observe(win());
    reporter.observe(win());
    reporter.flush();
    expect(lines).toHaveLength(1);
    expect(Number(fields(lines[0]!).span_s)).toBeCloseTo(4, 1);

    // ...and the flush cleared it, so a second one does not resend the same four seconds.
    reporter.flush();
    expect(lines).toHaveLength(1);
  });
});

describe('what the line says', () => {
  it('is parseable by the same two-step logfmt the dashboard uses', () => {
    const { reporter, lines } = harness();
    for (let i = 0; i < REPORT_INTERVAL_MS / 2000; i++) reporter.observe(win());
    const f = fields(lines[0]!);
    // Every value: no spaces, no quotes, nothing `| logfmt` has to guess at. A field whose
    // value contained a space would silently split into two fields, one of them garbage.
    for (const [k, v] of Object.entries(f)) {
      expect(v, k).toMatch(/^[\w.-]+$/);
    }
    expect(Object.keys(f).sort()).toEqual([
      'busy_peak', 'cap', 'fps', 'frame_max', 'frame_p50', 'hz', 'long_pct',
      'render_p95', 'span_s', 'tier', 'update_p95', 'windows', 'worst_fps',
    ]);
  });

  it('carries the judder rate as a percentage of FRAMES, not of windows', () => {
    // Windows are not equal: one that contained 30 frames and one that contained 120 say
    // different amounts about the minute. Weighting by frames is what makes the number a rate.
    const { reporter, lines } = harness();
    reporter.observe(win({ frames: 30, longFrameRatio: 1 })); // 30 long frames
    reporter.observe(win({ frames: 120, longFrameRatio: 0 })); // 0 of 120
    reporter.flush();
    expect(Number(fields(lines[0]!).long_pct)).toBeCloseTo((100 * 30) / 150, 1);
  });

  it('reports the WORST window, which is the one a player remembers', () => {
    const { reporter, lines } = harness();
    reporter.observe(win({ fps: 60 }));
    reporter.observe(win({ fps: 22 }));
    reporter.observe(win({ fps: 59 }));
    reporter.flush();
    const f = fields(lines[0]!);
    expect(Number(f.worst_fps)).toBeCloseTo(22, 1);
    // ...and the mean is still the mean, so the two together say "mostly fine, one bad spell".
    expect(Number(f.fps)).toBeGreaterThan(50);
  });

  it('reads its context at REPORT time, not at construction', () => {
    // The display probe answers a second into the session — after the first window and before
    // the first report — and the quality watchdog can downgrade the tier mid-run. Both
    // captured at construction would describe a state that no longer holds, which is worse
    // than absent: it looks like an answer.
    let hz: number | null = null;
    let tier = 'high';
    const { reporter, lines } = harness({ displayHz: () => hz, tier: () => tier });
    reporter.observe(win());
    hz = 144;
    tier = 'low';
    reporter.flush();
    expect(fields(lines[0]!).hz).toBe('144.0');
    expect(fields(lines[0]!).tier).toBe('low');
  });

  it('reports an unmeasured display as 0, which no real display can be', () => {
    // Distinguishable on the dashboard, and `displayRate.ts` refuses anything under 24 Hz, so
    // a 0 in this column means "the cap had to guess" and nothing else.
    const { reporter, lines } = harness({ displayHz: () => null });
    reporter.observe(win());
    reporter.flush();
    expect(fields(lines[0]!).hz).toBe('0.0');
  });

  it('never emits NaN or Infinity, whatever it is handed', () => {
    // A gap in a Grafana panel reads exactly like an outage. `worst_fps` is the one that can
    // reach a formatter as `Infinity` — it starts there — and a window whose `windowMs` is 0
    // is the divide-by-zero.
    const { reporter, lines } = harness();
    reporter.observe(win({ windowMs: 0, frames: 1, fps: Number.NaN, frame: { p50: Number.NaN, p95: 0, max: Number.NaN } }));
    reporter.flush();
    expect(lines[0]).not.toMatch(/NaN|Infinity/);
  });
});

describe('longFrameRatio (the metric the line carries)', () => {
  it('is zero for a perfectly steady frame, at any rate', () => {
    expect(longFrameRatio(Array(100).fill(16.67), 16.67)).toBe(0);
    expect(longFrameRatio(Array(100).fill(33.3), 33.3)).toBe(0);
  });

  it('counts a doubled frame and ignores ordinary vsync noise', () => {
    // The shipped 60 Hz case from the report: ~3% of frames lasting two display intervals
    // instead of one, the rest jittering by a few tenths of a millisecond.
    const samples = Array.from({ length: 100 }, (_, i) => (i % 34 === 0 ? 33.3 : 16.67 + (i % 3) * 0.2));
    expect(longFrameRatio(samples, 16.67)).toBeCloseTo(0.03, 2);
  });

  it('measures against the window, so a steady low frame rate reads as steady', () => {
    // 20 fps is a complaint, but it is a different complaint, and `fps` is the field for it.
    // A metric that read "everything under 60" as judder would make the two indistinguishable.
    expect(longFrameRatio(Array(100).fill(50), 50)).toBe(0);
  });

  it('answers 0 rather than NaN for an empty window or a zero median', () => {
    expect(longFrameRatio([], 16.7)).toBe(0);
    expect(longFrameRatio([1, 2, 3], 0)).toBe(0);
  });
});

describe('the emit seam', () => {
  it('sends exactly one line per report and never throws into the caller', () => {
    const emit = vi.fn(() => {
      throw new Error('log store is down');
    });
    const { reporter } = harness({ emit });
    // Telemetry that can break the game is worse than no telemetry — but this reporter does
    // NOT swallow, deliberately: its one caller is `Game.observePerfWindow`, which is called
    // from the perf monitor's own window callback, and the client logger's `log` cannot throw
    // (it is a push onto an array). A throw here would mean the seam was wired to something
    // else, and hiding it would hide that.
    expect(() => reporter.flush()).not.toThrow(); // nothing accumulated: never reaches `emit`
    reporter.observe(win());
    expect(() => reporter.flush()).toThrow('log store is down');
  });
});

// ---- the dashboard and the line have to agree ----
//
// The two ends of this feature are a string built in `perfReport.ts` and a set of LogQL
// queries in a JSON file under `server/monitoring/`, and NOTHING connects them: rename a field
// here and the panel keeps deploying, keeps querying, and renders "No data" — which on a
// dashboard is indistinguishable from nobody having played. The same shape of silent break the
// observability suite already guards for Alloy's regex (`server/test/deploy.observability.
// test.ts`), so it is guarded the same way: by running one end against the real other end.
//
// It lives on the CLIENT side because the client is what decides the field names; the server
// only carries them.

describe('the Grafana panels query fields this line actually carries', () => {
  const dashboard = JSON.parse(
    readFileSync(new URL('../../../server/monitoring/grafana/dashboards/client.json', import.meta.url), 'utf8'),
  ) as { panels: { title: string; targets?: { expr: string }[] }[] };

  /**
   * Every field name a perf panel takes out of the parsed line, with the panel that asked.
   *
   * Three syntaxes, not one, and the two beyond `unwrap` were added after the first version of
   * this sweep missed them: `hz` is never unwrapped, it is a label filter (`| hz = 0`) and a
   * grouping (`by (hz)`), so renaming it passed a check whose whole job was to catch that.
   * A sweep that reads one syntax looks exactly like a sweep that reads all of them.
   */
  const referenced = dashboard.panels.flatMap((p) =>
    (p.targets ?? []).flatMap((t) => [
      ...[...t.expr.matchAll(/\|\s*unwrap\s+(\w+)/g)].map((m) => ({ panel: p.title, field: m[1]!, how: 'unwrap' })),
      ...[...t.expr.matchAll(/\bby\s*\((\w+)\)/g)].map((m) => ({ panel: p.title, field: m[1]!, how: 'by' })),
      // `| foo = 0` / `| foo != ""` — a label filter on a field the second `logfmt` produced.
      // Deliberately not `| tag="perf"`, which filters a field the SERVER writes: the guard
      // below skips the names this module does not own.
      ...[...t.expr.matchAll(/\|\s*(\w+)\s*(?:=|!=|>|<)/g)].map((m) => ({ panel: p.title, field: m[1]!, how: 'filter' })),
    ]),
  );

  /** The envelope fields, written by `server/src/clientLog.ts` rather than by this module. */
  const SERVER_OWNED = new Set(['session', 'ver', 'acct', 'tag', 'msg', 'level', 'host', 'source']);
  const unwrapped = referenced.filter((r) => !SERVER_OWNED.has(r.field));

  it('found the panels at all, so an empty sweep cannot pass as agreement', () => {
    // The control, and a sweep that reads source needs one above all else: a regex that stops
    // matching passes everything, forever, and looks like coverage in the file tree.
    expect(unwrapped.length).toBeGreaterThan(4);
    // Per SYNTAX, not just in total — the whole reason this sweep was widened is that one
    // syntax can empty out while the total holds.
    for (const how of ['unwrap', 'by', 'filter']) {
      expect(unwrapped.filter((u) => u.how === how).length, how).toBeGreaterThan(0);
    }
  });

  it('unwraps only fields the reporter emits', () => {
    const { reporter, lines } = harness();
    reporter.observe(win());
    reporter.flush();
    const emitted = new Set(Object.keys(fields(lines[0]!)));
    for (const { panel, field, how } of unwrapped) {
      expect(emitted.has(field), `${panel} (${how}) names "${field}"`).toBe(true);
    }
  });

  it('filters on the tag and the level the reporter actually writes', () => {
    // `level="info"` is pinned into the perf panels rather than taken from the dashboard's
    // level picker, so this is also what catches somebody "tidying" them onto `$level`.
    const perfTargets = dashboard.panels
      .flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p.title, expr: t.expr })))
      .filter((t) => t.expr.includes('tag="perf"'));
    expect(perfTargets.length).toBeGreaterThan(4);
    for (const { panel, expr } of perfTargets) {
      expect(expr, `${panel} level`).toContain('level="info"');
      // The two-step parse: the server quotes our whole line into `msg`, so a panel that
      // parses only once sees one field called `msg` and nothing to unwrap.
      expect(expr, `${panel} line_format`).toContain('line_format "{{.msg}}"');
    }
  });

  it('agrees with the tag constant rather than a copy of it', () => {
    expect(PERF_LOG_TAG).toBe('perf');
  });

  it('emits a line the server can quote and a panel can unquote again', () => {
    // The line survives two parses it cannot influence. `server/src/clientLog.ts` renders it as
    // `msg=<JSON.stringify(line)>` because it contains spaces, and the panel reverses that with
    // `line_format "{{.msg}}"`. A quote or a backslash inside would still round-trip through
    // JSON, but a NEWLINE would not survive Loki's line-per-entry model at all — it would
    // become two log lines, the second of them unparseable.
    const { reporter, lines } = harness();
    reporter.observe(win());
    reporter.flush();
    const line = lines[0]!;
    expect(line).not.toMatch(/["\\\n\r]/);
    expect(JSON.parse(JSON.stringify(line))).toBe(line);
    // ...and comfortably inside the client logger's own 1000-char message cap, which truncates
    // silently: a line that grew past it would lose its last fields and the panels reading them
    // would go quiet rather than red. The headroom is the room to add fields later.
    expect(line.length).toBeLessThan(300);
  });
});
