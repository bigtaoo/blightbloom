/**
 * `RunLifecycle` — the five ways into a run, the one way out, and the reset they share.
 *
 * Not a pure module (see `pureLayerBoundary.test.ts`'s note on why it is deliberately off
 * that list): it hands geometry to `RoomBuilder` and destroys children on the fx layer, so it
 * is a renderer collaborator. Its arithmetic and its ORDER are testable with fakes anyway,
 * which is why it is tested here rather than only through the browser.
 *
 * The order is most of what matters. Every entry point does the same four things — reset,
 * build an engine, flip the phase, hand the screen over — and each of them has a documented
 * reason to happen when it does:
 *
 *  - the reset must not destroy the PARTICLE SYSTEM, only the transient flashes parented
 *    beside it. Getting that wrong kills particles for the rest of the session, silently.
 *  - a dungeon run must NOT prime the room, because tick 1 does it at the real spawn; an
 *    arena/tutorial/replay run MUST, because no `room_enter` ever fires for them.
 *  - `recorder.end()` on an online run is what stops F9 exporting the previous OFFLINE run's
 *    stream, which would hand a bug report a file of the wrong match entirely.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LocalInputSource, type EngineConfig, type PlayerCommand } from '@dd/engine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { defaultMetaState, type MetaStore } from '../../meta';
import { buildDungeonRunConfig } from '../match/offlineConfig';
import { packRunSave } from '../match/runSave';
import { clearSavedRun, loadSavedRun, resetRunSaveCacheForTests, writeSavedRun } from '../match/runSaveStore';
import { RunState } from '../runState';
import { RunLifecycle, type RunLifecycleDeps } from './RunLifecycle';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

/** A child of `layers.fx` that records whether it was destroyed. */
function fxChild(tag: string) {
  return { tag, destroyed: false, destroy(this: { destroyed: boolean }) { this.destroyed = true; } };
}

function make(over: Partial<RunLifecycleDeps> & {
  recordedConfig?: EngineConfig | null;
  recordedStream?: PlayerCommand[] | null;
} = {}) {
  const { recordedConfig = null, recordedStream = null, ...depsOver } = over;
  const run = new RunState(store);
  const particlesView = fxChild('particles');
  const transient = [fxChild('flash'), fxChild('trail')];
  const order: string[] = [];
  const note = (name: string) => vi.fn(() => void order.push(name));

  let gateOpen = true;
  const deferred: Array<() => void> = [];

  const deps: RunLifecycleDeps = {
    run,
    layers: { fx: { children: [particlesView, ...transient] } } as never,
    scene: { clear: note('scene.clear') } as never,
    fx: { particles: { view: particlesView }, resetForNewRun: note('fx.reset') } as never,
    roomBuilder: { clear: note('roomBuilder.clear'), build: note('roomBuilder.build') } as never,
    gameLoop: {
      resetForNewRun: note('gameLoop.reset'),
      resetOnlinePrediction: note('gameLoop.resetPrediction'),
    } as never,
    screenFlow: { hideSettingsButton: note('screenFlow.hideSettingsButton') } as never,
    nav: { showMenu: note('nav.showMenu'), showForge: note('nav.showForge') } as never,
    artGate: {
      defer: (retry: () => void) => {
        if (gateOpen) return false;
        deferred.push(retry);
        return true;
      },
    } as never,
    recorder: {
      begin: vi.fn((label: string) => {
        order.push(`recorder.begin(${label})`);
        return { take: () => null };
      }),
      end: note('recorder.end'),
      // `saveMarkedReplay` marks the tick and then packs; `pack` returning null is what the
      // "no run" toast is driven by, so the fake packs only once an engine exists.
      mark: vi.fn((tick: number) => void order.push(`recorder.mark(${tick})`)),
      pack: vi.fn(() => (run.engine ? { label: 'dungeon', engineVersion: 1 } : null)),
      // The save/resume path (ENGINE_VERSION 61). `resume` pre-loads the stream and must hand
      // back a REAL source, because `resumeSavedRun` builds a real engine off it and advances
      // it — the fast-forward is the thing under test, so it cannot be stubbed out.
      resume: vi.fn((label: string, _cfg: unknown, cmds: readonly unknown[]) => {
        order.push(`recorder.resume(${label},${cmds.length})`);
        const src = new LocalInputSource();
        for (const c of cmds as PlayerCommand[]) src.submit(c);
        return src;
      }),
      get runConfig() { return recordedConfig; },
      recordedCommands: vi.fn(() => recordedStream),
    } as never,
    tutorialHints: { reset: note('tutorialHints.reset') } as never,
    hud: { toast: vi.fn() } as never,
    hudView: { visible: false } as never,
    forge: { hide: note('forge.hide') } as never,
    mainMenu: { hide: note('mainMenu.hide') },
    matchmaking: { hide: note('matchmaking.hide') } as never,
    partyScreen: { hide: note('partyScreen.hide') } as never,
    pauseMenu: { hide: note('pauseMenu.hide') } as never,
    screens: { hide: note('screens.hide') } as never,
    allySkinId: () => 'ally-skin',
    ...depsOver,
  };
  return {
    runs: new RunLifecycle(deps),
    run, deps, order, particlesView, transient,
    closeGate: () => { gateOpen = false; },
    releaseGate: () => { gateOpen = true; for (const fn of deferred.splice(0)) fn(); },
  };
}

describe('resetRenderState', () => {
  it('destroys the transient fx children and SPARES the particle system', () => {
    // `particles.view` is a persistent child added once at boot, not a `_life`-tagged flash.
    // Destroying it here kills particles for the whole session — and nothing errors, so the
    // only symptom is that the game gradually stops looking right after one restart.
    const t = make();
    t.runs.resetRenderState();
    expect(t.particlesView.destroyed).toBe(false);
    expect(t.transient.map((c) => c.destroyed)).toEqual([true, true]);
  });

  it('clears the scene, the room geometry, the score and the loop', () => {
    const t = make();
    t.run.score = 4200;
    t.runs.resetRenderState();
    expect(t.run.score).toBe(0);
    expect(t.order).toContain('scene.clear');
    expect(t.order).toContain('roomBuilder.clear');
    expect(t.order).toContain('fx.reset');
    expect(t.order).toContain('gameLoop.reset');
    expect(t.order).toContain('screenFlow.hideSettingsButton');
  });
});

describe('beginRun — the dungeon path', () => {
  it('resets, records under the dungeon label, and enters playing', () => {
    const t = make();
    t.runs.beginRun();
    expect(t.order).toContain('recorder.begin(dungeon)');
    expect(t.run.phase).toBe('playing');
    expect(t.run.engine).not.toBeNull();
    expect(t.deps.hudView.visible).toBe(true);
  });

  it('does NOT prime the room — tick 1 does that at the real spawn', () => {
    // Priming here would create the player's view at the placeholder centre and make it
    // visibly slide across the room on the first frame.
    const t = make();
    t.runs.beginRun();
    expect(t.order).not.toContain('roomBuilder.build');
  });

  it('CONSUMES the staged loadout, and persists that', () => {
    // design/05: crafted weapons are one run each. A death must not refund them, so they
    // leave the meta at run start rather than at run end.
    const saves: unknown[] = [];
    const t = make();
    t.run.meta = { ...t.run.meta, loadout: ['blade', 'gun'] };
    (t.run.store as { save: (m: unknown) => void }).save = (m) => saves.push(m);
    t.runs.beginRun();
    expect(t.run.meta.loadout).toEqual([]);
    expect(saves).toHaveLength(1);
  });

  it('advances the run counter, so the next run gets a different seed', () => {
    const t = make();
    const first = t.run.nextRunSeed();
    t.runs.beginRun();
    expect(t.run.nextRunSeed()).not.toBe(first);
  });

  it('clears the tutorial flag — a normal run after a tutorial is not one', () => {
    const t = make();
    t.run.tutorialActive = true;
    t.runs.beginRun();
    expect(t.run.tutorialActive).toBe(false);
  });

  it('DIVERTS to the arena demo when that dev harness is on', () => {
    const t = make();
    t.run.arenaDemo = 'landing_basic';
    t.runs.beginRun();
    expect(t.order).toContain('recorder.begin(arena)');
    expect(t.order).not.toContain('recorder.begin(dungeon)');
  });
});

describe('the primed entry points', () => {
  it('the tutorial primes the room and hides the lobby, not the forge', () => {
    // Flat mode never fires `room_enter`, so nothing else would ever build the geometry —
    // the run would start on an empty screen.
    const t = make();
    t.runs.beginTutorialRun();
    expect(t.run.tutorialActive).toBe(true);
    expect(t.order).toContain('tutorialHints.reset');
    expect(t.order).toContain('roomBuilder.build');
    expect(t.order).toContain('mainMenu.hide');
    expect(t.order).not.toContain('forge.hide');
  });

  it('the arena demo primes the room and hides the forge', () => {
    const t = make();
    t.run.arenaDemo = 'landing_basic';
    t.runs.beginArenaDemoRun();
    expect(t.order).toContain('roomBuilder.build');
    expect(t.order).toContain('forge.hide');
    expect(t.run.phase).toBe('playing');
  });

  it('the quick run enters the dungeon and hides the MAIN MENU, not the forge', () => {
    // The portal's one-click entry (`docs.crazygames.com/requirements/gameplay`). It is a
    // second door to the SAME run `beginRun` starts — so the only thing that can be wrong
    // about it is which screen it takes down, and getting that wrong leaves the main menu
    // drawn on top of a live run.
    const t = make();
    t.runs.beginQuickRun();
    expect(t.run.phase).toBe('playing');
    expect(t.order).toContain('mainMenu.hide');
    expect(t.run.tutorialActive).toBe(false);
  });

  it('the quick run spends the staged loadout, exactly as START RUN does', () => {
    // It must not become a way to keep crafted weapons across runs — design/05's one-run
    // rule. Asserted through the shared `beginRun` rather than restated: this is a door,
    // not a mode.
    const t = make();
    t.run.setMeta({ ...t.run.meta, loadout: ['blaster'] });
    t.runs.beginQuickRun();
    expect(t.run.meta.loadout).toEqual([]);
  });

  it.each([
    ['beginTutorialRun', undefined],
    ['beginArenaDemoRun', 'landing_basic'],
    ['beginQuickRun', undefined],
  ] as const)('%s WAITS for run art before starting', (method, arena) => {
    // A run with no screen between it and the gate: starting before the art is in shows a
    // player placeholder squares for the whole first fight.
    const t = make();
    if (arena) t.run.arenaDemo = arena;
    t.closeGate();
    t.runs[method]();
    expect(t.run.phase).toBe('menu');
    expect(t.order).toEqual([]);

    t.releaseGate();
    expect(t.run.phase).toBe('playing');
  });
});

describe('finalizeOnlineRun', () => {
  it('adopts the session, re-anchors prediction, and hides every stale screen', () => {
    const t = make();
    const session = { close: vi.fn() };
    t.runs.finalizeOnlineRun(session as never);
    expect(t.run.session).toBe(session);
    expect(t.run.phase).toBe('playing');
    expect(t.order).toContain('gameLoop.resetPrediction');
    for (const hidden of ['matchmaking.hide', 'forge.hide', 'screens.hide', 'partyScreen.hide']) {
      expect(t.order, hidden).toContain(hidden);
    }
  });

  it('ENDS the previous offline recording, so F9 cannot export the wrong run', () => {
    // Online input arrives on the confirmed net stream and nothing records it. Leaving the
    // last offline stream open means the record button hands over a file of a different
    // match — which is worse than handing over nothing, because it looks valid.
    const t = make();
    t.runs.finalizeOnlineRun({ close: vi.fn() } as never);
    expect(t.order).toContain('recorder.end');
  });

  it('closes a session that was already live', () => {
    const t = make();
    const old = { close: vi.fn() };
    t.run.session = old as never;
    t.runs.finalizeOnlineRun({ close: vi.fn() } as never);
    expect(old.close).toHaveBeenCalledTimes(1);
  });
});

describe('quitRun', () => {
  it('hides the pause menu and returns to the forge', () => {
    const t = make();
    t.run.phase = 'paused';
    t.runs.quitRun();
    expect(t.order).toContain('pauseMenu.hide');
    expect(t.order).toContain('nav.showForge');
  });

  it('a tutorial SKIP marks it seen and returns to the lobby instead', () => {
    // A skip counts the same as a completion for `hasSeenTutorial` (never forced), and a
    // tutorial run never touched the loadout, so the forge is the wrong destination.
    const t = make();
    t.run.tutorialActive = true;
    t.runs.quitRun();
    expect(t.run.meta.hasSeenTutorial).toBe(true);
    expect(t.order).toContain('nav.showMenu');
    expect(t.order).not.toContain('nav.showForge');
  });

  it('leaves the run state consistent for whatever comes next', () => {
    // The bug `RunState.endRun` records: a quit that leaves `online` set makes the next
    // OFFLINE run render off a session that has already been closed.
    const t = make();
    const close = vi.fn();
    t.run.online = true;
    t.run.session = { close } as never;
    t.runs.quitRun();
    expect(close).toHaveBeenCalled();
    expect(t.run.online).toBe(false);
    expect(t.run.session).toBeNull();
  });
});

describe('saveReplay', () => {
  it('toasts the file name on success', () => {
    const t = make();
    t.run.engine = { state: { tick: 300 } } as never;
    t.runs.saveReplay();
    expect(t.deps.hud.toast).toHaveBeenCalledTimes(1);
  });

  it('toasts a REASON rather than failing silently when there is no run', () => {
    // The record button is always available (an offline run stays packable after it ends),
    // so pressing it before a run has started is an ordinary thing to do. A silent no-op
    // there reads as a broken button.
    const t = make();
    t.runs.saveReplay();
    expect(t.deps.hud.toast).toHaveBeenCalledTimes(1);
  });
});

describe('RunLifecycle — teaching a first-time player (design/20 onboarding)', () => {
  // A portal lands a new visitor in a run on their first click, so the run itself has to be
  // where the controls are explained — the menu route to the standalone tutorial still
  // exists, but nobody on their first click has taken it. The same fix applies on every
  // other target, which is why it is in `beginRun` and not behind a host branch.

  it('arms the hints for a player who has never been taught', () => {
    const t = make();
    expect(t.run.meta.hasSeenTutorial).toBe(false);
    t.runs.beginRun();
    expect(t.run.firstRunHints).toBe(true);
    expect(t.order).toContain('tutorialHints.reset');
  });

  it('does not arm them for a player who has', () => {
    const t = make();
    t.run.setMeta({ ...t.run.meta, hasSeenTutorial: true });
    t.runs.beginRun();
    expect(t.run.firstRunHints).toBe(false);
    expect(t.order).not.toContain('tutorialHints.reset');
  });

  it('arms them through the one-click portal entry too', () => {
    // `beginQuickRun` is the button the portal's one-click rule produced, and it is the one
    // path a first-time visitor takes — so this is the case that actually ships.
    const t = make();
    t.runs.beginQuickRun();
    expect(t.run.firstRunHints).toBe(true);
  });

  it('leaves the standalone tutorial on its own flag', () => {
    const t = make();
    t.runs.beginTutorialRun();
    expect(t.run.tutorialActive).toBe(true);
    expect(t.run.firstRunHints).toBe(false);
  });

  it('never arms them for an online match', () => {
    // `GameLoop.advanceOnline` does not consume hints at all, and a lockstep session is the
    // wrong place to be reading toasts about which key moves you.
    const t = make();
    t.runs.beginRun(); // arms them
    t.runs.finalizeOnlineRun({ close: () => {} } as never);
    expect(t.run.firstRunHints).toBe(false);
  });

  it('clears them when the run ends, so a quit mid-lesson does not leak into the next run', () => {
    const t = make();
    t.runs.beginRun();
    expect(t.run.firstRunHints).toBe(true);
    t.runs.quitRun();
    expect(t.run.firstRunHints).toBe(false);
  });
});

// ── save & continue (design/05 "Only the boss floor ends a run", ENGINE_VERSION 61) ───────
//
// `RunLifecycle` reaches the save slot through `runSaveStore`'s module-level default, the
// same way `net/session.ts` is reached — so these cases install a stand-in `localStorage`
// rather than injecting a store. Node has none (no DOM in this runner), and without one every
// write would report failure and the success path would never be exercised at all.

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  resetRunSaveCacheForTests();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
});

const RUN_CONFIG = (seed = 4242): EngineConfig => buildDungeonRunConfig({
  seed, coop: false, localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: 'ally-skin',
});

/** A short, real stream — `resumeSavedRun` replays these through a real engine. */
const STREAM: PlayerCommand[] = Array.from({ length: 5 }, (_, i) => makeCommand({
  owner: 0, tick: i + 1, moveBrad: 0 as Brad, moveMag: 200, buttons: 0,
}));

describe('saveAndQuitRun', () => {
  function playing(over: Partial<Parameters<typeof make>[0]> = {}) {
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM, ...over });
    t.runs.beginRun();
    t.run.engine = { state: { tick: 5, floorIndex: 2 } } as never;
    t.run.score = 340;
    return t;
  }

  it('writes a save that describes the run, then leaves for the forge', () => {
    const t = playing();
    t.runs.saveAndQuitRun();

    const saved = loadSavedRun()!;
    expect(saved.ticks).toBe(5);
    expect(saved.floorIndex).toBe(2);
    expect(saved.score).toBe(340);
    expect(saved.commands).toHaveLength(5);
    expect(t.deps.nav.showForge).toHaveBeenCalled();
    expect(t.run.engine).toBeNull(); // the run really ended
  });

  it('does NOT clear the save on the way out — unlike a plain quit', () => {
    // The one line of difference between the two exits, and the whole reason they are
    // separate methods: `quitRun` drops the slot, this one has just filled it.
    const t = playing();
    t.runs.saveAndQuitRun();
    expect(loadSavedRun()).not.toBeNull();
  });

  it('refuses, and stays in the run, when the store cannot keep the save', () => {
    // Quota, or a host with no storage (WeChat today). Walking the player to the forge on a
    // promise that dies with the tab is the one outcome this must never produce.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    const t = playing();
    t.runs.saveAndQuitRun();
    expect(t.deps.hud.toast).toHaveBeenCalled();
    expect(t.deps.nav.showForge).not.toHaveBeenCalled();
    expect(t.run.engine).not.toBeNull(); // still playing
  });

  it('refuses when there is nothing recorded to save', () => {
    const t = make({ recordedConfig: null, recordedStream: null });
    t.run.engine = { state: { tick: 5, floorIndex: 0 } } as never;
    t.runs.saveAndQuitRun();
    expect(t.deps.hud.toast).toHaveBeenCalled();
    expect(t.deps.nav.showForge).not.toHaveBeenCalled();
    expect(loadSavedRun()).toBeNull();
  });

  it('refuses when no run is live at all', () => {
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.saveAndQuitRun(); // run.engine is null
    expect(t.deps.nav.showForge).not.toHaveBeenCalled();
    expect(loadSavedRun()).toBeNull();
  });
});

describe('the exits that drop a save', () => {
  function withSave() {
    writeSavedRun(packRunSave({
      config: RUN_CONFIG(), commands: STREAM, ticks: 5, floorIndex: 1, score: 0, nowMs: 1,
    }));
    expect(loadSavedRun()).not.toBeNull();
  }

  it('quitRun abandons the run AND its save', () => {
    withSave();
    make().runs.quitRun();
    expect(loadSavedRun()).toBeNull();
  });

  it('beginRun replaces it — a fresh run is what START RUN means with a save in the slot', () => {
    withSave();
    make().runs.beginRun();
    expect(loadSavedRun()).toBeNull();
  });

  it('and beginRun drops it before standing the engine up, not after', () => {
    // Ordering, because the alternative is a window in which a failure between the two
    // leaves a save pointing at a run that no longer exists.
    withSave();
    const t = make();
    t.runs.beginRun();
    expect(t.run.engine).not.toBeNull();
    expect(loadSavedRun()).toBeNull();
  });

  // The third exit is `RunOutcome.handle`, which lives on the other side of the host
  // interface — asserted in `RunOutcome.test.ts`, not here.
});

describe('resumeSavedRun', () => {
  function saveOf(over: { seed?: number; ticks?: number; score?: number; floorIndex?: number } = {}) {
    return packRunSave({
      config: RUN_CONFIG(over.seed ?? 4242),
      commands: STREAM,
      ticks: over.ticks ?? 5,
      floorIndex: over.floorIndex ?? 0,
      score: over.score ?? 120,
      nowMs: 1,
    });
  }

  it('replays the stream into a live run and hands the screen over', () => {
    writeSavedRun(saveOf());
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.resumeSavedRun();

    expect(t.run.engine).not.toBeNull();
    expect(t.run.engine!.state.tick).toBe(5); // fast-forwarded to the saved tick
    expect(t.run.phase).toBe('playing');
    // The scene is primed by hand — a dungeon run's usual tick-1 `room_enter` was consumed
    // by the fast-forward, so nothing would ever build the geometry otherwise.
    expect(t.order).toContain('roomBuilder.build');
    expect(t.order).toContain('recorder.resume(dungeon,5)');
  });

  it('restores the render-side score, which the sim cannot reconstruct', () => {
    // `resetRenderState` zeroes it for a fresh run, so this has to happen after — an
    // ordering bug here silently reports half a run's score on the result screen.
    writeSavedRun(saveOf({ score: 777 }));
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.resumeSavedRun();
    expect(t.run.score).toBe(777);
  });

  it('leaves no stale events for the first rendered frame to replay', () => {
    // The fast-forward's LAST tick leaves its events sitting in `state.events` (step clears
    // at the top of the next tick, design/08), and `GameLoop` drains whatever is there on
    // its first frame — which would fire that tick's flashes, sounds and score all over again.
    writeSavedRun(saveOf({ ticks: 5 }));
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.resumeSavedRun();
    expect(t.run.engine!.state.events).toEqual([]);
  });

  it('does not re-spend the loadout — those weapons are already in the run', () => {
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.run.setMeta({ ...t.run.meta, loadout: ['cryobolt'] });
    writeSavedRun(saveOf());
    t.runs.resumeSavedRun();
    expect(t.run.meta.loadout).toEqual(['cryobolt']); // untouched, unlike beginRun
  });

  it('is not a first run, however new the player is', () => {
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    writeSavedRun(saveOf());
    t.runs.resumeSavedRun();
    expect(t.run.firstRunHints).toBe(false);
    expect(t.run.tutorialActive).toBe(false);
  });

  it('refuses a save from another ENGINE_VERSION, drops it, and says so', () => {
    const save = saveOf();
    writeSavedRun({ ...save, engineVersion: save.engineVersion - 1 });
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.resumeSavedRun();

    expect(t.run.engine).toBeNull();
    expect(loadSavedRun()).toBeNull(); // so the forge stops offering it
    expect(t.deps.nav.showForge).toHaveBeenCalled(); // re-rendered without the button
    expect(t.deps.hud.toast).toHaveBeenCalled();
  });

  it('refuses a save whose content no longer matches, drops it, and says so', () => {
    writeSavedRun({ ...saveOf(), contentHash: 0 });
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.runs.resumeSavedRun();
    expect(t.run.engine).toBeNull();
    expect(loadSavedRun()).toBeNull();
    expect(t.deps.hud.toast).toHaveBeenCalled();
  });

  it('does nothing at all when there is no save', () => {
    clearSavedRun();
    const t = make();
    t.runs.resumeSavedRun();
    expect(t.run.engine).toBeNull();
    expect(t.deps.hud.toast).not.toHaveBeenCalled(); // silent: the button was not there
  });

  it('waits for the art gate, like every other run with no screen in between', () => {
    // Without this the first room is drawn out of placeholder rectangles — the same reason
    // `beginTutorialRun`/`beginArenaDemoRun`/`beginReplayRun` all defer.
    writeSavedRun(saveOf());
    const t = make({ recordedConfig: RUN_CONFIG(), recordedStream: STREAM });
    t.closeGate();
    t.runs.resumeSavedRun();
    expect(t.run.engine).toBeNull();

    t.releaseGate();
    expect(t.run.engine).not.toBeNull();
    expect(t.run.engine!.state.tick).toBe(5);
  });
});
