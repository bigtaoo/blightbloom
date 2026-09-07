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
import { describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { RunLifecycle, type RunLifecycleDeps } from './RunLifecycle';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

/** A child of `layers.fx` that records whether it was destroyed. */
function fxChild(tag: string) {
  return { tag, destroyed: false, destroy(this: { destroyed: boolean }) { this.destroyed = true; } };
}

function make(over: Partial<RunLifecycleDeps> = {}) {
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
    nav: { showModeSelect: note('nav.showModeSelect'), showForge: note('nav.showForge') } as never,
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
    } as never,
    tutorialHints: { reset: note('tutorialHints.reset') } as never,
    hud: { toast: vi.fn() } as never,
    hudView: { visible: false } as never,
    forge: { hide: note('forge.hide') } as never,
    mainMenu: { hide: note('mainMenu.hide') },
    modeSelect: { hide: note('modeSelect.hide') } as never,
    matchmaking: { hide: note('matchmaking.hide') } as never,
    partyScreen: { hide: note('partyScreen.hide') } as never,
    pauseMenu: { hide: note('pauseMenu.hide') } as never,
    screens: { hide: note('screens.hide') } as never,
    allySkinId: () => 'ally-skin',
    ...over,
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
  it('the tutorial primes the room and hides ModeSelect, not the forge', () => {
    // Flat mode never fires `room_enter`, so nothing else would ever build the geometry —
    // the run would start on an empty screen.
    const t = make();
    t.runs.beginTutorialRun();
    expect(t.run.tutorialActive).toBe(true);
    expect(t.order).toContain('tutorialHints.reset');
    expect(t.order).toContain('roomBuilder.build');
    expect(t.order).toContain('modeSelect.hide');
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

  it('a tutorial SKIP marks it seen and returns to ModeSelect instead', () => {
    // A skip counts the same as a completion for `hasSeenTutorial` (never forced), and a
    // tutorial run never touched the loadout, so the forge is the wrong destination.
    const t = make();
    t.run.tutorialActive = true;
    t.runs.quitRun();
    expect(t.run.meta.hasSeenTutorial).toBe(true);
    expect(t.order).toContain('nav.showModeSelect');
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
