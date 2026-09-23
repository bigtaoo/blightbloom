// Assembly shell for the perf system. One call wires the monitor, the overlay and the
// console handle; the game layer knows nothing else about any of it.

import { UPDATE_PRIORITY, type Application } from 'pixi.js';
import { PerfMonitor, type PerfMonitorOptions, type PerfSnapshot } from './PerfMonitor';
import { PerfOverlay } from './PerfOverlay';
import { probeFrames, type ProbeOptions, type ProbeResult } from './frameProbe';
import { probeDisplayRate } from './displayRate';
import { setDisplayHz } from '../game/powerBudget';
import { defaultPerfWindowReporter } from '../game/perfReporting';
import type { FrameWindow } from './frameSampler';
import {
  attributeDraws,
  formatAttribution,
  formatCensus,
  graphicsCensus,
  type Attribution,
  type GraphicsInspector,
  type GraphicsRow,
  type ToggleableNode,
} from './drawAttribution';

export { PerfMonitor, type PerfSnapshot, type PerfMonitorOptions } from './PerfMonitor';
export { PerfOverlay, formatSnapshot } from './PerfOverlay';
export { FrameSampler, msStats, numFromStorage, type FrameWindow, type MsStats } from './frameSampler';
export { GlProbe, filterPasses, type GlCounts } from './glProbe';
export {
  estimateDisplayHz,
  probeDisplayRate,
  type DisplayRateEstimate,
  type DisplayRateProbeDeps,
} from './displayRate';
export {
  AUTO_BATCH_VERTEX_LIMIT,
  attributeDraws,
  formatAttribution,
  formatCensus,
  graphicsCensus,
  type Attribution,
  type AttributionRow,
  type DrawCost,
  type GraphicsRow,
  type ToggleableNode,
} from './drawAttribution';
export { countScene, heapMB, gpuTextureCount, NODE_WALK_CAP, type SceneCounts } from './sceneCounters';
export {
  diffFrames,
  frameRectOf,
  lumaPercentiles,
  meanLuma,
  probeFrames,
  readFrame,
  type Frame,
  type FrameDiff,
  type ProbeOptions,
  type ProbeResult,
} from './frameProbe';
export {
  GpuTimer,
  createGpuTimer,
  resolutionSplit,
  sweepTrust,
  type CostSplit,
  type GpuTimerOptions,
  type MsSample,
  type RenderOnce,
  type SweepPoint,
  type TimerGl,
} from './gpuTimer';

export interface InstalledPerf {
  monitor: PerfMonitor;
  overlay: PerfOverlay | null;
  /**
   * Per-group draw-call attribution (`drawAttribution.attributeDraws`), from the console:
   *
   * ```js
   * const L = window.__game.layers;
   * const walls = L.entities.children.filter((e) => e.children.length === 4);
   * console.log(window.__perf.attribute({ walls, ground: [L.ground], shadow: [L.shadow] }).text);
   * ```
   *
   * Needs `?perf=1` — without the GL probe there is nothing to count, and `text` says so.
   */
  attribute(groups: Readonly<Record<string, readonly ToggleableNode[]>>): AttributionReport;
  /** Every Graphics in the scene with Pixi's batching verdict (`drawAttribution.graphicsCensus`).
   *  Defaults to the whole stage. `console.log(window.__perf.census().text)`. */
  census(root?: ToggleableNode): CensusReport;
  /**
   * A/B/C frame probe bound to this app (`frameProbe.probeFrames`) — the "did my art change
   * actually do anything" loop, with the liveness control and restore check that keep a
   * broken reader from agreeing with you:
   *
   * ```js
   * const props = window.__game.roomBuilder.props;
   * window.__perf.probe({ change: () => { props.forEach(p => p.visible = false);
   *                                       return () => props.forEach(p => p.visible = true); } });
   * ```
   *
   * Read `trustworthy` before `diff`. A zero diff means nothing until the control has fired.
   */
  probe<T = undefined>(opts: ProbeOptions<T>): ProbeResult<T>;
  uninstall(): void;
}

export interface AttributionReport {
  /** Null when the GL probe is off — see `InstalledPerf.attribute`. */
  attribution: Attribution | null;
  /** The same thing laid out for reading in a console. */
  text: string;
}

export interface CensusReport {
  rows: GraphicsRow[];
  text: string;
}

export interface InstallPerfOptions extends PerfMonitorOptions {
  /** Show the on-screen readout and turn on the GL probe that feeds its draw-call line.
   *  Off in a normal session: the monitor alone is one ticker bracket and a windowed
   *  counter, the overlay costs a Text and a live-patched GL context. */
  overlay?: boolean;
  /** The platform's `requestAnimationFrame`, for the display-rate probe. Defaults to the
   *  global one where there is one; injected by tests, which run with none. */
  raf?: (cb: (t: number) => void) => unknown;
  /** Where the measured refresh rate goes. Defaults to `powerBudget`'s mirror, and that
   *  default is the point: the probe has to be wired in ONE place rather than in each of
   *  the three entry points, because a per-entry pin only exists where somebody thought of
   *  it — the same mistake `clientLog`'s `host` label made for weeks (design/19 §10). */
  onDisplayHz?: (hz: number | null) => void;
  /** Where each closed window goes for frame-pacing telemetry (`perf/perfReport.ts`). Defaults
   *  to the real one; injected by tests, and by any host that wants none. */
  reportWindow?: (w: FrameWindow) => void;
}

/**
 * Install the perf system on a running app.
 *
 * The monitor part is always safe to run — that is the point of porting funny's design
 * rather than writing a dev-only FPS counter: a player hitting a sustained stutter leaves
 * a console warning that names which half of the frame was to blame, without anyone having
 * to reproduce it with a flag on. `overlay: true` (wired to `?perf=1`) adds the live
 * readout and the draw-call probe on top.
 */
export function installPerf(app: Application, opts: InstallPerfOptions = {}): InstalledPerf {
  const wantOverlay = opts.overlay ?? false;
  const overlay = wantOverlay ? new PerfOverlay() : null;
  // Frame-pacing telemetry (2026-09-22). Wired here, once, rather than at each entry point —
  // `game/perfReporting.ts` carries the argument and the phase test.
  const reportWindow = opts.reportWindow ?? defaultPerfWindowReporter();
  const monitor = new PerfMonitor({
    ...opts,
    probeGl: opts.probeGl ?? wantOverlay,
    onSnapshot: (s: PerfSnapshot) => {
      overlay?.setSnapshot(s);
      reportWindow(s.window);
      opts.onSnapshot?.(s);
    },
  });
  monitor.install(app);

  // What refresh rate is this display running at? Nothing else in the client asks, and
  // `game/powerBudget.ts` cannot apply a frame cap evenly without the answer. Fire-and-
  // forget, one second, once per session — see `displayRate.ts` for why it is rAF and why
  // it may legitimately answer `null`.
  const globalRaf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => unknown })
    .requestAnimationFrame;
  probeDisplayRate({
    raf: opts.raf ?? (globalRaf ? (cb): unknown => globalRaf.call(globalThis, cb) : undefined),
    onResult: opts.onDisplayHz ?? setDisplayHz,
  });

  let tick: (() => void) | null = null;
  if (overlay) {
    // Added last, so it draws over every layer without needing the stage sorted.
    app.stage.addChild(overlay.view);
    overlay.toggle(true);
    tick = () => overlay.update(app.ticker, app.renderer.screen.width, app.renderer.screen.height);
    // UTILITY, i.e. after the render: the overlay describes the frame that just went out,
    // and refreshing it before the render would make it a cost inside its own numbers.
    app.ticker.add(tick, null, UPDATE_PRIORITY.UTILITY);
  }

  const handle: InstalledPerf = {
    monitor,
    overlay,
    attribute(groups): AttributionReport {
      const probe = (): ReturnType<PerfMonitor['measureFrame']> => monitor.measureFrame();
      if (probe() === null) {
        return { attribution: null, text: 'draw attribution needs the GL probe — reload with ?perf=1' };
      }
      const attribution = attributeDraws(() => probe()!, groups);
      return { attribution, text: formatAttribution(attribution) };
    },
    census(root): CensusReport {
      const inspector = (app.renderer as unknown as { graphicsContext: GraphicsInspector }).graphicsContext;
      const rows = graphicsCensus((root ?? app.stage) as ToggleableNode, inspector);
      return { rows, text: formatCensus(rows) };
    },
    probe<T = undefined>(opts: ProbeOptions<T>): ProbeResult<T> {
      return probeFrames(app, opts);
    },
    uninstall(): void {
      if (tick) app.ticker.remove(tick, null);
      if (overlay) {
        app.stage.removeChild(overlay.view);
        overlay.view.destroy({ children: true });
      }
      monitor.uninstall();
    },
  };
  // Same convention as `__game` in main.ts: reachable from the devtools console, so a
  // snapshot can be read (or the overlay toggled) without a reload.
  (globalThis as unknown as { __perf?: InstalledPerf }).__perf = handle;
  return handle;
}
