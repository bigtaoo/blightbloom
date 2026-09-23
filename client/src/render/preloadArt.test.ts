/**
 * The phase functions themselves (design/12, "the first download is code only") — the claims
 * that live in `render/preloadArt.ts` and nowhere else.
 *
 * `wechatPhasedBoot.test.ts` drives the whole two-phase boot against a WeChat-shaped runtime and
 * is the place to assert ORDER — what exists when. It cannot see the things this file is about,
 * because its `beforeAll` performs the two calls that would otherwise be missing: it awaits
 * `ensureRunArt(cb)` itself, so the background kick inside `beginDeferredArt` is doing no work
 * that the test is not also doing by hand, and it registers its listener before the first unit
 * settles, so the progress replay is only ever observed at zero. Both mutants stayed green there.
 *
 * So this file drives the module through a COUNTING `AssetHost` instead, and each case is about
 * one thing that host makes visible:
 *
 *   - `loadPack` calls say whether a download happened at all, and how many times;
 *   - `readJson` calls say whether a LOADER pass happened — the one part of a re-run that is not
 *     free (two sidecars per rig bundle, see this module's header), and therefore the only
 *     evidence that the promise memo is doing its job. `packLoader` memoises packs on its own,
 *     so pack counts alone cannot tell a shared loader pass from a repeated one;
 *   - a blocking `loadPack` freezes the download mid-way, which is the only way to observe a
 *     listener that JOINS a download already in progress.
 *
 * Every asset load underneath fails here (no DOM, no reachable URL) and every loader is
 * best-effort per item by design (design/02/12), so nothing below asserts a texture — the
 * bookkeeping is the subject.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Assets } from 'pixi.js';
import { resetAssetHost, setAssetHost, type AssetHost } from './assetHost';
import { packsForPhase } from './assetManifest';
import { resetPackLoader } from './packLoader';
import {
  beginDeferredArt,
  ensureRunArt,
  preloadCoreArt,
  preloadLobbyArt,
  resetPreloadArt,
  runArtUnitCount,
} from './preloadArt';

interface CountingHost {
  host: AssetHost;
  /** Every subpackage fetch, in order, duplicates KEPT — a repeat is the thing being counted. */
  packLoads: string[];
  /** Every JSON sidecar read: the not-free half of a loader pass. */
  jsonReads: string[];
  /** Resolve the pack downloads still outstanding — all of them, or the one named. */
  release(name?: string): void;
}

function countingHost(opts: { blocking?: boolean } = {}): CountingHost {
  const packLoads: string[] = [];
  const jsonReads: string[] = [];
  const pending = new Map<string, () => void>();
  return {
    packLoads,
    jsonReads,
    release: (name?: string) => {
      for (const [key, resolve] of [...pending]) {
        if (name !== undefined && key !== name) continue;
        pending.delete(key);
        resolve();
      }
    },
    host: {
      // The same option the WeChat host ships, and for a related reason: Pixi's format detection
      // reaches for `document.createElement('video')`, and this suite has no DOM. See assetHost.
      assetsInit: { skipDetections: true },
      resolveUrl: (path) => path,
      readJson: async (path: string) => {
        jsonReads.push(path);
        // Rejecting is the honest answer — there is no sidecar to serve — and `loadRunArt` wraps
        // every rig in its own try/catch precisely so a failed bundle still ticks.
        throw new Error(`countingHost has no JSON for ${path}`);
      },
      readBinary: async (path: string): Promise<ArrayBuffer> => {
        throw new Error(`countingHost has no bytes for ${path}`);
      },
      loadPack: (name: string) => {
        packLoads.push(name);
        if (!opts.blocking) return Promise.resolve();
        return new Promise<void>((resolve) => pending.set(name, resolve));
      },
    },
  };
}

const runPackNames = (): string[] => packsForPhase('run').map((p) => p.name);
const backgroundPackNames = (): string[] => packsForPhase('background').map((p) => p.name);

beforeAll(async () => {
  // Initialised ONCE, up front, with the detections off. `Assets.init` is a no-op after the
  // first call (it warns and returns), so this makes every later `Assets.init` / implicit init
  // inside a loader harmless regardless of which case runs first — without it, the first case to
  // reach `Assets.load` would self-initialise WITH the DOM detections and reject there.
  await Assets.init({ skipDetections: true });
});

beforeEach(() => {
  // Every loader takes its best-effort warn branch here (see the header). That is the behaviour
  // under test elsewhere; here it is only noise, and a suite whose output is noise is a suite
  // nobody reads. Same convention as controllers/TransitionGate.test.ts.
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

describe('beginDeferredArt — the download nobody asked for', () => {
  it('starts the run phase itself, with no gate and no listener anywhere', async () => {
    // THE feature's central claim, and it was pinned by nothing: every other test that observes
    // the run phase calls `ensureRunArt()` itself first, so deleting the `void ensureRunArt()`
    // inside `beginDeferredArt` left the whole suite green. That mutant means no background
    // download at all — the player pays the full run-art wait at the forge instead of during the
    // menu, and the broadcast-listener design above it becomes dead weight.
    //
    // So: `beginDeferredArt()` and NOTHING else, then wait for the packs to arrive on their own.
    const h = countingHost();
    setAssetHost(h.host);

    beginDeferredArt();

    const expected = [...runPackNames(), ...backgroundPackNames()].sort();
    await vi.waitFor(() => expect([...h.packLoads].sort()).toEqual(expected));
    // ...and nothing the lobby already awaited is fetched a second time.
    expect(new Set(h.packLoads).size).toBe(h.packLoads.length);
    // Settle the chain this case started so it cannot bleed into the next one's counters. Asked
    // for AFTER the assertion above, which is what keeps it from being the thing that loads.
    await ensureRunArt();
  });

  it('runs the loader pass too, not just the downloads', async () => {
    // The other half of the same mutant: `beginDeferredArt` could fetch the packs and still leave
    // every rig/weapon/biome loader for the gate to run, which is where the seconds actually go.
    const h = countingHost();
    setAssetHost(h.host);

    beginDeferredArt();

    await vi.waitFor(() => expect(h.jsonReads.length).toBeGreaterThan(0));
    await ensureRunArt();
  });
});

describe('the run phase progress broadcast', () => {
  it('replays where the download IS to a listener that joins late', async () => {
    // "A gate that opens when 12 of 16 units are in should draw a bar at 12, not start at zero
    // and jump" (this module's own doc comment). Only observable with the download frozen
    // part-way: `wechatPhasedBoot.test.ts` registers before the first unit settles, so its replay
    // is 0 either way and `onProgress(runDone, ...)` → `onProgress(0, ...)` survived it.
    const h = countingHost({ blocking: true });
    setAssetHost(h.host);
    const early: Array<[number, number]> = [];

    beginDeferredArt();
    void ensureRunArt((done, total) => early.push([done, total]));
    // Nothing has settled yet, so the early listener's own replay is the zero case.
    expect(early).toEqual([[0, runArtUnitCount()]]);

    // Let exactly one unit land, and use the early listener as the witness that it did — asking
    // the module how far along it is would be asking the code under test.
    h.release(runPackNames()[0]);
    await vi.waitFor(() => expect(early.length).toBeGreaterThan(1));

    const late: Array<[number, number]> = [];
    void ensureRunArt((done, total) => late.push([done, total]));
    expect(late.length).toBe(1); // exactly one replay, immediately, before any further tick
    expect(late[0]![0]).toBeGreaterThan(0);
    expect(late[0]).toEqual(early[early.length - 1]);

    h.release();
    await ensureRunArt();
  });

  it('gives a listener that arrives after the download a full bar, exactly once', async () => {
    // The other end of the same replay: past the finish line there is nothing left to report, so
    // a caller that registers anyway must be handed a FULL bar rather than an empty one it will
    // never see move.
    //
    // What this case cannot see: whether that listener is also RETAINED (the `if (!runArtDone)`
    // guard, and the `runListeners.clear()` beside it). Removing either leaves a callback holding
    // a destroyed `LoadingScreen` for the rest of the session — but no tick can ever follow, so
    // the leak has no behavioural consequence to assert from out here, and the listener set is
    // module-private. It would need an inspection seam in the source to pin.
    const h = countingHost();
    setAssetHost(h.host);
    beginDeferredArt();
    await ensureRunArt();

    const late: Array<[number, number]> = [];
    await ensureRunArt((done, total) => late.push([done, total]));

    const total = runArtUnitCount();
    expect(late).toEqual([[total, total]]);
  });
});

describe('preloadLobbyArt — the one bar a player watches at boot', () => {
  it('ticks once per lobby pack and once for the UI loader, at a constant total', async () => {
    // Both existing callers pass no `onProgress` at all, so this bar was entirely unmeasured:
    // `ticker(lobby.length + 1, ...)` off by one, or the final `tick()` after `preloadUiArt`
    // deleted, and the WeChat boot bar stops at 1/2 and sits there until the screen is torn down.
    // It is the only progress a player sees before `new Game(...)`.
    const h = countingHost();
    setAssetHost(h.host);
    const ticks: Array<[number, number]> = [];

    await preloadLobbyArt((done, total) => ticks.push([done, total]));

    const total = packsForPhase('lobby').length + 1;
    expect(total).toBeGreaterThan(1); // a one-tick bar would make the ordering below vacuous
    expect(ticks.map(([done]) => done)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    for (const [, reported] of ticks) expect(reported).toBe(total);
    // Ends full: a bar left short of the end reads as a hang on exactly the boot that is slow
    // enough for anyone to be looking at it.
    expect(ticks[ticks.length - 1]).toEqual([total, total]);
    // ...and the ticks really did come from the lobby phase and nothing else.
    expect(h.packLoads).toEqual(packsForPhase('lobby').map((p) => p.name));
  });
});

describe('preloadCoreArt — the everything-now path', () => {
  it('shares the run memo, so a gate reached afterwards re-runs no loader', async () => {
    // `preloadCoreArt` deliberately routes through `ensureRunArt` rather than `loadRunArt`, and
    // the difference is invisible to a pack count (`packLoader` memoises packs on its own). The
    // JSON sidecars are what show it: swapped for a direct `loadRunArt()`, `runArt` stays null
    // and the gate below re-reads two sidecars for all seven rig bundles.
    const h = countingHost();
    setAssetHost(h.host);

    await preloadCoreArt();
    const afterCore = h.jsonReads.length;
    expect(afterCore).toBeGreaterThan(0); // the loader pass ran once, so "no second" means something

    await ensureRunArt();

    expect(h.jsonReads.length).toBe(afterCore);
  });
});
