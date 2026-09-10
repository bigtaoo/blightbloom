/**
 * The run-boundary art gate (design/12) — its two load-bearing properties and the wiring that
 * uses them.
 *
 * Driven against the REAL `render/preloadArt.ts` module state rather than a mocked one, because
 * both properties this file is about are properties of that state: "inert until something
 * deferred" is `deferred === false`, and "synchronous when the art is in" is a promise that has
 * already resolved. A mock of `isRunArtReady` would let either one be wrong here and right
 * nowhere.
 *
 * The Pixi collaborators ARE faked (a Container and a Ticker are all this needs), same
 * convention as controllers/GameLoop.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container, Ticker } from 'pixi.js';
import { readFileSync } from 'node:fs';
import { ArtGate } from './ArtGate';
import { setAssetHost, resetAssetHost, webAssetHost, type AssetHost } from '../../render/assetHost';
import { resetPackLoader } from '../../render/packLoader';
import { beginDeferredArt, resetPreloadArt, runArtUnitCount } from '../../render/preloadArt';
import { pinTextMeasurementToPaintCanvas } from '../../render/textMetrics';
import { LoadingScreen } from '../ui/loadingScreen';

/** A host whose pack downloads never settle until released — the only way to observe a gate
 *  that is actually waiting, rather than one that has already let go. */
function blockingHost(): { host: AssetHost; release(): void } {
  const pending: Array<() => void> = [];
  return {
    host: { ...webAssetHost, loadPack: () => new Promise<void>((resolve) => pending.push(resolve)) },
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function gateWith(): { gate: ArtGate; overlay: Container; ticker: Ticker } {
  const overlay = new Container();
  const ticker = new Ticker();
  return {
    gate: new ArtGate({ overlay, ticker, screenSize: () => ({ w: 800, h: 600 }) }),
    overlay,
    ticker,
  };
}

beforeEach(() => {
  // `LoadingScreen` builds a `Text`, and Pixi memoises its measurement canvas on first use.
  pinTextMeasurementToPaintCanvas();
  // Releasing the fake host runs the REAL loaders, and the real web `AssetHost` cannot fetch a
  // root-relative path in Node — so every loader takes its best-effort warn branch. That is the
  // behaviour under test everywhere else (design/02/12, "gameplay is never blocked on art"); here
  // it is just noise, and a suite whose output is noise is a suite nobody reads.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetPreloadArt();
  resetPackLoader();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetAssetHost();
  resetPreloadArt();
  resetPackLoader();
});

describe('inert unless something actually deferred', () => {
  it('never defers, and never builds a screen, in a session that loaded art up front', () => {
    // This is what keeps the gate out of every existing test that drives `Game`: with no
    // `beginDeferredArt()` call the art is by definition already in, so the caller's transition
    // stays exactly as synchronous as it was before this class existed.
    const { gate, overlay } = gateWith();
    const retry = vi.fn();
    expect(gate.defer(retry)).toBe(false);
    expect(gate.waiting).toBe(false);
    expect(overlay.children.length).toBe(0);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('a genuine wait', () => {
  it('puts a screen up, and re-runs the transition once — after tearing it down', async () => {
    const { host, release } = blockingHost();
    setAssetHost(host);
    const { gate, overlay } = gateWith();
    beginDeferredArt();

    const retry = vi.fn();
    expect(gate.defer(retry)).toBe(true);
    expect(gate.waiting).toBe(true);
    expect(overlay.children.length).toBe(1);
    expect(retry).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    // Torn down BEFORE the retry ran, or the re-entrant `defer()` inside it would see a stale
    // screen and swallow the transition it was sent to make.
    expect(gate.waiting).toBe(false);
    expect(overlay.children.length).toBe(0);
  });

  it('swallows a repeat while the wait is up, and keeps the FIRST retry', async () => {
    // The overlay's scrim stops taps but not the keyboard, and `Game.confirm()` is reachable in
    // the phase the player is still standing in — so the same transition can be asked for twice.
    const { host, release } = blockingHost();
    setAssetHost(host);
    const { gate, overlay } = gateWith();
    beginDeferredArt();

    const first = vi.fn();
    const second = vi.fn();
    expect(gate.defer(first)).toBe(true);
    expect(gate.defer(second)).toBe(true);
    expect(overlay.children.length).toBe(1); // one screen, not two

    release();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();
  });

  it('is synchronous again once the art has landed', async () => {
    const { host, release } = blockingHost();
    setAssetHost(host);
    const { gate } = gateWith();
    beginDeferredArt();
    const retry = vi.fn();
    gate.defer(retry);
    release();
    await vi.waitFor(() => expect(retry).toHaveBeenCalled());
    // The state a player is in for the rest of the session: every later transition takes the
    // cheap branch.
    expect(gate.defer(vi.fn())).toBe(false);
  });

  it('opens the gate even when every download fails', async () => {
    // "Gameplay is never blocked on art" (design/02/12) has a worst reading — a spinner that
    // stays up for the rest of the session — and an offline player is the realistic way to reach
    // it. Every pack here rejects; `packLoader` swallows and warns, the loaders fall back, and the
    // player still gets into the forge with placeholder art.
    setAssetHost({ ...webAssetHost, loadPack: async () => { throw new Error('offline'); } });
    const { gate, overlay } = gateWith();
    beginDeferredArt();
    const retry = vi.fn();
    gate.defer(retry);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(gate.waiting).toBe(false);
    expect(overlay.children.length).toBe(0);
  });

  it('moves the bar with the download it is waiting on', async () => {
    // The progress wiring was pinned by nothing: replacing
    // `ensureRunArt((done, total) => screen.setProgress(done, total))` with a bare
    // `ensureRunArt()` left every other case here passing — the gate still opens, still tears the
    // screen down, still retries. The bar simply never moves, on the one screen whose entire job
    // is to say the wait is going somewhere.
    //
    // The zero calls are the decoy — `defer` sizes the bar itself, and `ensureRunArt` replays
    // where the download is as the listener registers (nowhere yet, since nothing has settled).
    // Both are asserted to be zero first, so the filter below cannot be satisfied by either.
    const setProgress = vi.spyOn(LoadingScreen.prototype, 'setProgress');
    const { host, release } = blockingHost();
    setAssetHost(host);
    const { gate } = gateWith();
    beginDeferredArt();

    gate.defer(() => {});
    const total = runArtUnitCount();
    expect(setProgress.mock.calls.length).toBeGreaterThan(0);
    for (const call of setProgress.mock.calls) expect(call).toEqual([0, total]);

    release();
    await vi.waitFor(() => expect(gate.waiting).toBe(false));

    const moved = setProgress.mock.calls.filter(([done]) => done > 0);
    expect(moved.length).toBeGreaterThan(0);
    // ...and it arrives at the end before the screen goes away, rather than being torn down
    // half-drawn.
    expect(moved[moved.length - 1]).toEqual([total, total]);
  });

  it('leaves no ticker callback behind when the wait ends', async () => {
    // A leaked callback keeps redrawing a Graphics that is no longer on the stage, for the rest
    // of the session — on the layer that invalidates `ui`'s render group when it changes.
    const { host, release } = blockingHost();
    setAssetHost(host);
    const { gate, ticker } = gateWith();
    beginDeferredArt();
    gate.defer(() => {});
    expect(ticker.count).toBe(1);
    release();
    await vi.waitFor(() => expect(gate.waiting).toBe(false));
    expect(ticker.count).toBe(0);
  });
});

describe('the transitions that are gated', () => {
  it('gates every screen that draws run art, and no screen that does not', () => {
    // A source assertion, because these transitions cannot be driven without a real WebGL
    // renderer behind them. What it protects is the list itself: adding a screen that draws
    // rig or weapon art and forgetting the gate is invisible until someone plays on a cold
    // cache.
    //
    // Two files since the 2026-09-03 Game.ts split — the screen transitions moved to
    // `ScreenNav`, the run entry points to `RunLifecycle`. Both are searched, and a name
    // found in NEITHER fails, so a method that moves again does not silently stop being
    // checked (the failure mode this sweep is most exposed to: `indexOf` returning -1 and
    // `slice(-1)` yielding a one-character body that contains nothing).
    const sources = ['./ScreenNav.ts', './RunLifecycle.ts'].map((rel) =>
      readFileSync(new URL(rel, import.meta.url), 'utf8'),
    );
    const bodyAfter = (name: string): string => {
      const hits = sources.filter((src) => src.includes(name));
      expect(hits.length, `${name} is in ${hits.length} of the controller files, want exactly 1`).toBe(1);
      const src = hits[0]!;
      const at = src.indexOf(name);
      return src.slice(at, src.indexOf('\n  }', at));
    };
    for (const gated of [
      'showForge(): void {',
      'showPvpPreview(): void {',
      'showMatchmaking(): void {',
      'beginTutorialRun(): void {',
      'beginArenaDemoRun(): void {',
      'async beginReplayRun(',
    ]) {
      expect(bodyAfter(gated), gated).toContain('artGate.defer(');
    }
    for (const ungated of ['showMenu(): void {', 'showAccount(): void {', 'showSquad(): void {']) {
      expect(bodyAfter(ungated), ungated).not.toContain('artGate');
    }
  });
});
