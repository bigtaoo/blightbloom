/**
 * The transition gate (design/12) — its load-bearing properties and the wiring that uses them.
 *
 * Two waits share one screen here, and the tests split the same way: the ART boundary, which
 * is invisible almost always, and the RUN boundary's `MIN_TRANSITION_MS` floor, which is
 * deliberately visible and was asked for by name.
 *
 * Driven against the REAL `render/preloadArt.ts` module state rather than a mocked one, because
 * the properties this file is about are properties of that state: "inert until something
 * deferred" is `deferred === false`, and "synchronous when the art is in" is a promise that has
 * already resolved. A mock of `isRunArtReady` would let either one be wrong here and right
 * nowhere. The floor's clock IS injected — a suite that waits out three real seconds per case
 * is a suite nobody runs.
 *
 * The Pixi collaborators ARE faked (a Container and a Ticker are all this needs), same
 * convention as controllers/GameLoop.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container, Text, Ticker } from 'pixi.js';
import { readFileSync } from 'node:fs';
import { MIN_TRANSITION_MS, TransitionGate } from './TransitionGate';
import { setAssetHost, resetAssetHost, webAssetHost, type AssetHost } from '../../render/assetHost';
import { resetPackLoader } from '../../render/packLoader';
import {
  beginDeferredArt,
  ensureRunArt,
  isRunArtReady,
  resetPreloadArt,
  runArtUnitCount,
} from '../../render/preloadArt';
import { pinTextMeasurementToPaintCanvas } from '../../render/textMetrics';
import { LoadingScreen } from '../ui/loadingScreen';
import { t } from '../../i18n';

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

/** A host whose FIRST `settleFirst` pack downloads land immediately and whose rest block, so
 *  a gate can be opened against a load that is genuinely part-way done. `blockingHost` above
 *  cannot express that: it is all-or-nothing, and "already at 12 of 16" is the state the
 *  progress rule is about. */
function partiallyBlockingHost(settleFirst: number): { host: AssetHost; release(): void } {
  const pending: Array<() => void> = [];
  let seen = 0;
  return {
    host: {
      ...webAssetHost,
      loadPack: () =>
        seen++ < settleFirst ? Promise.resolve() : new Promise<void>((resolve) => pending.push(resolve)),
    },
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

/** Where the shared background load has got to. There is no getter for it, and the replay
 *  `ensureRunArt` hands a listener as it registers IS the getter — the same fact the gate's
 *  bar is drawn from. Registered ONCE and read through the closure, so polling this does not
 *  pile up listeners on the shared load. */
function runArtProbe(): () => number {
  let done = 0;
  void ensureRunArt((d) => {
    done = d;
  });
  return () => done;
}

/** A floor that never elapses until it is told to — the only way to observe a gate that is
 *  still holding, rather than one that has already let go. */
function heldClock(): { sleep: (ms: number) => Promise<void>; slept: number[]; elapse(): void } {
  const waiting: Array<() => void> = [];
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    elapse: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

function gateWith(sleep?: (ms: number) => Promise<void>): {
  gate: TransitionGate;
  overlay: Container;
  ticker: Ticker;
} {
  const overlay = new Container();
  const ticker = new Ticker();
  return {
    gate: new TransitionGate({ overlay, ticker, screenSize: () => ({ w: 800, h: 600 }), sleep }),
    overlay,
    ticker,
  };
}

/** Arm the art phases and let them settle, so what is left to wait for is the floor alone.
 *  (The real web `AssetHost` cannot fetch a root-relative path in Node, so every loader takes
 *  its best-effort warn branch and `ensureRunArt` resolves — see `beforeEach`.) */
async function withArtAlreadyIn(): Promise<void> {
  beginDeferredArt();
  await vi.waitFor(() => expect(isRunArtReady()).toBe(true));
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

  it('opens the bar where the download already is, not at zero', async () => {
    // The gate can arrive mid-download — the background load starts the moment the lobby
    // paints — and a bar that appears at 0 and jumps to 12/16 reads as a restart. This is
    // `ensureRunArt`'s synchronous replay doing it, not the gate: the gate used to call
    // `setProgress(0, runArtUnitCount())` first, which was overwritten on the next statement
    // and, in exactly this case, was the wrong number. That line is deleted; this asserts the
    // behaviour it claimed, so nobody re-adds it.
    const { host, release } = partiallyBlockingHost(2);
    setAssetHost(host);
    const { gate } = gateWith();
    beginDeferredArt();                        // kicks the background load
    const settled = runArtProbe();
    // The fixture has to actually BE mid-download, or this case passes on nothing.
    await vi.waitFor(() => expect(settled()).toBeGreaterThan(0));

    const setProgress = vi.spyOn(LoadingScreen.prototype, 'setProgress');
    gate.defer(() => {});

    const first = setProgress.mock.calls[0];
    expect(first, 'the bar was never sized at all').toBeDefined();
    expect(first![0], 'the bar opened at zero part-way through the download').toBe(settled());
    expect(first![1]).toBe(runArtUnitCount());
    release();
    await vi.waitFor(() => expect(gate.waiting).toBe(false));
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
    // The ART-only transitions: a screen that draws run art, with no floor under it.
    for (const gated of [
      'showLoadout(): void {',
      "showForge(from: ForgeReturnPhase = 'menu'): void {",
      'showPvpPreview(): void {',
      'showMatchmaking(): void {',
    ]) {
      expect(bodyAfter(gated), gated).toContain('transitions.defer(');
    }
    // ...and the RUN boundary, which is held. Asserted on the METHOD NAME rather than on
    // `transitions.` alone, because the difference between the two is the whole point of this
    // pass: a plain `defer` here would silently take the floor back off the transition the
    // request was about, and every other test in this file would stay green.
    for (const held of [
      'beginRun(): void {',
      'beginTutorialRun(): void {',
      'beginArenaDemoRun(): void {',
      'resumeSavedRun(): void {',
      'async beginReplayRun(',
      "leaveRunTo(hub: 'menu' | 'loadout'): void {",
    ]) {
      expect(bodyAfter(held), held).toContain('deferRunBoundary(');
    }
    for (const ungated of ['showMenu(): void {', 'showAccount(): void {', 'showSquad(): void {']) {
      expect(bodyAfter(ungated), ungated).not.toContain('transitions');
    }
  });
});

describe('the run boundary, which is held on purpose', () => {
  it('is three seconds, which is the number that was asked for', () => {
    // Every other case here compares `clock.slept` against `MIN_TRANSITION_MS`, which is a
    // tautology over the one quantity the request actually named: "held for at least 3
    // seconds". Retuning the constant to 300 passed the whole suite until this line existed
    // (mutation battery, 2026-09-22). Asserted as a floor rather than an equality so a
    // deliberate lengthening is not a test edit, and a silent shortening is.
    expect(MIN_TRANSITION_MS).toBeGreaterThanOrEqual(3000);
    expect(MIN_TRANSITION_MS).toBe(3000);
  });

  it('holds the screen for MIN_TRANSITION_MS with the art already in', async () => {
    // The ask this whole pass is about: "a loading screen, shown for at least 3 seconds ...
    // the in-game screen switches, entering a map, returning to the lobby". The art is in, so
    // `defer` would answer synchronously — a jump cut — and this is the one call that does not.
    const clock = heldClock();
    const { gate, overlay } = gateWith(clock.sleep);
    await withArtAlreadyIn();

    const retry = vi.fn();
    expect(gate.deferRunBoundary('run', retry)).toBe(true);
    expect(overlay.children.length).toBe(1);
    expect(clock.slept).toEqual([MIN_TRANSITION_MS]);
    expect(retry).not.toHaveBeenCalled();

    clock.elapse();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(gate.waiting).toBe(false);
    expect(overlay.children.length).toBe(0);
  });

  it('is inert in a session that never armed the art phases', async () => {
    // The property that keeps this repo's ~7,000 tests synchronous: they drive `Game` through
    // `beginRun` and `leaveRunTo` directly, and a three-second floor in each of them would be
    // either a suite that hangs or one that silently swallows every transition it asserts on.
    const clock = heldClock();
    const { gate, overlay } = gateWith(clock.sleep);

    const retry = vi.fn();
    expect(gate.deferRunBoundary('run', retry)).toBe(false);
    expect(overlay.children.length).toBe(0);
    expect(clock.slept).toEqual([]);
    expect(retry).not.toHaveBeenCalled(); // NOT deferred: the caller carries straight on itself
  });

  it('waits for the art AND the floor, not whichever finishes first', async () => {
    // `Promise.race` in place of `Promise.all` passes both cases above and is wrong in the one
    // case that matters: a cold cache, where the floor elapses while the run art is still
    // downloading and the player is dropped into a room of placeholder rectangles.
    const { host, release } = blockingHost();
    setAssetHost(host);
    const clock = heldClock();
    const { gate } = gateWith(clock.sleep);
    beginDeferredArt();

    const retry = vi.fn();
    expect(gate.deferRunBoundary('run', retry)).toBe(true);

    clock.elapse(); // the floor is paid...
    // A FULL macrotask turn, not `await Promise.resolve()`. That single microtask was what
    // this case shipped with, and it is one link short of the `.then()` behind `Promise.race`
    // — so the mutant resolved on the next tick, after the assertion had already passed, and
    // survived (mutation battery, 2026-09-22). An assertion that a thing has NOT happened is
    // only worth its wording if it gave the thing every chance to happen.
    await new Promise((r) => setTimeout(r, 0));
    expect(retry).not.toHaveBeenCalled(); // ...and the art is not
    expect(gate.waiting).toBe(true);      // the screen is still up, which is what a player sees

    release();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });

  it('charges the floor once across a nested transition, not once per layer', async () => {
    // `beginQuickRun` -> `beginRun` -> `beginArenaDemoRun` all cross the same boundary, and
    // each one asks the gate. Without the pass-through a player would sit through three
    // separate three-second screens for one press, with every other test here green.
    const clock = heldClock();
    const { gate, overlay } = gateWith(clock.sleep);
    await withArtAlreadyIn();

    const inner = vi.fn();
    const outer = (): void => {
      // The nested ask, made from inside the released transition exactly as `beginRun` makes
      // it from inside `beginQuickRun`'s.
      expect(gate.deferRunBoundary('run', inner)).toBe(false);
    };
    gate.deferRunBoundary('run', outer);
    clock.elapse();

    await vi.waitFor(() => expect(gate.waiting).toBe(false));
    // ONE floor for the whole nested transition. `clock.slept` is the assertion that matters:
    // a second `sleep(MIN_TRANSITION_MS)` here is what charging per layer looks like.
    expect(clock.slept).toEqual([MIN_TRANSITION_MS]);
    expect(inner).not.toHaveBeenCalled(); // it returned false — the caller carried on itself
    expect(overlay.children.length).toBe(0);
  });

  it('says which way the player is crossing', async () => {
    // One screen, two captions. `t()` is synchronous and English is the source-of-truth
    // locale, so this reads the real table rather than a stub.
    const clock = heldClock();
    const { gate, overlay } = gateWith(clock.sleep);
    await withArtAlreadyIn();

    const captionOf = (): string => {
      const view = overlay.children[0] as Container;
      return (view.children.find((c) => c instanceof Text) as Text).text;
    };

    gate.deferRunBoundary('run', () => {});
    const entering = captionOf();
    clock.elapse();
    await vi.waitFor(() => expect(gate.waiting).toBe(false));

    gate.deferRunBoundary('hub', () => {});
    const returning = captionOf();
    clock.elapse();
    await vi.waitFor(() => expect(gate.waiting).toBe(false));

    expect(entering).toBe(t('loading.enteringRun'));
    expect(returning).toBe(t('loading.returningToHub'));
    expect(entering).not.toBe(returning); // a single shared caption would pass both lines above
  });
});
