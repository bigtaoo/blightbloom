/**
 * `ScreenNav` — the phase writes and the art gate around them, over fake collaborators.
 *
 * Every screen object here is a recorder, not a Pixi container: what this file asserts is
 * WHICH transition ran and what `phase` became, never what got drawn. `ScreenFlow` already
 * has its own suite for the widget half, and the drawing is `test/render`'s problem.
 *
 * The two rules worth the file:
 *
 *  - the ART GATE wraps four transitions and not the other four. A screen that draws rig or
 *    weapon art and skips the gate shows placeholder squares on a cold cache — for one
 *    player in a hundred, on their first visit, which is the least likely bug to be reported.
 *  - `settingsReturnPhase` is a one-field memory of who opened the settings screen. Getting
 *    it wrong drops a paused player back to the main menu mid-run, abandoning the match.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { ScreenNav, type ScreenNavDeps } from './ScreenNav';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

/** Records every ScreenFlow call as `name(args…)`. */
function recorder() {
  const calls: string[] = [];
  const proxy = new Proxy(
    {},
    {
      get: (_t, name: string) => (...args: unknown[]) => {
        calls.push(`${name}(${args.filter((a) => typeof a !== 'function').join(',')})`);
      },
    },
  );
  return { calls, proxy: proxy as never };
}

function make(over: Partial<ScreenNavDeps> = {}) {
  const run = new RunState(store);
  const flow = recorder();
  // The art gate: `defer` returning true means "not yet, I'll call you back".
  let gateOpen = true;
  const deferred: Array<() => void> = [];
  const artGate = {
    defer: (retry: () => void) => {
      if (gateOpen) return false;
      deferred.push(retry);
      return true;
    },
  };
  const screen = () => ({ show: vi.fn(), resize: vi.fn(), render: vi.fn(), hide: vi.fn() });
  const deps: ScreenNavDeps = {
    run,
    layers: { menu: { fit: () => ({ w: 800, h: 600 }) } } as never,
    screenFlow: flow.proxy,
    artGate: artGate as never,
    backdrop: { resize: vi.fn() } as never,
    hud: { reposition: vi.fn() } as never,
    portalPrompt: { reposition: vi.fn() } as never,
    floorCardPrompt: { reposition: vi.fn() } as never,
    mainMenu: screen() as never,
    pvpPreview: screen() as never,
    matchmaking: screen() as never,
    partyScreen: screen() as never,
    loginScreen: screen() as never,
    forge: screen() as never,
    storeScreen: screen() as never,
    screens: screen() as never,
    settingsScreen: screen() as never,
    pauseMenu: screen() as never,
    screenSize: () => ({ w: 1600, h: 1200 }),
    settings: () => ({ quality: 'high' }) as never,
    connect: vi.fn(),
    onHubEntered: vi.fn(),
    ...over,
  };
  const nav = new ScreenNav(deps);
  return {
    nav,
    run,
    deps,
    calls: flow.calls,
    closeGate: () => {
      gateOpen = false;
    },
    releaseGate: () => {
      gateOpen = true;
      for (const fn of deferred.splice(0)) fn();
    },
  };
}

describe('the plain transitions', () => {
  it.each([
    ['showMenu', 'menu', 'showMenu'],
    ['showSquad', 'squad', 'showSquad'],
    ['showAccount', 'account', 'showAccount'],
    ['showForge', 'forge', 'showForge'],
    ['showStore', 'store', 'showStore'],
    ['showPvpPreview', 'pvpPreview', 'showPvpPreview'],
    ['showMatchmaking', 'matchmaking', 'showMatchmaking'],
  ])('%s sets phase %s and drives ScreenFlow.%s', (method, phase, flowCall) => {
    const t = make();
    (t.nav as unknown as Record<string, () => void>)[method]!();
    expect(t.run.phase).toBe(phase);
    expect(t.calls.some((c) => c.startsWith(`${flowCall}(`))).toBe(true);
  });

  it('tells the lobby whether the tutorial is still unseen', () => {
    // The prompt on the TUTORIAL button. Inverted, it nags a player who already played it.
    const t = make();
    t.nav.showMenu();
    expect(t.calls).toContain('showMenu(800,600,true)');

    t.run.meta = { ...t.run.meta, hasSeenTutorial: true };
    t.calls.length = 0;
    t.nav.showMenu();
    expect(t.calls).toContain('showMenu(800,600,false)');
  });
});

describe('the art gate', () => {
  const GATED = ['showForge', 'showPvpPreview', 'showMatchmaking'] as const;
  const UNGATED = ['showMenu', 'showSquad', 'showAccount'] as const;

  it.each(GATED)('%s WAITS for run art, then completes when it arrives', (method) => {
    const t = make();
    t.closeGate();
    t.nav[method]();
    // Deferred: neither the phase nor the screen has moved yet. A transition that ran anyway
    // would draw the screen with placeholder art and never redraw it.
    expect(t.run.phase).toBe('menu');
    expect(t.calls).toEqual([]);

    t.releaseGate();
    expect(t.run.phase).not.toBe('menu');
    expect(t.calls.length).toBeGreaterThan(0);
  });

  it.each(UNGATED)('%s does NOT wait — it draws no run art', (method) => {
    const t = make();
    t.closeGate();
    t.nav[method]();
    expect(t.calls.length).toBeGreaterThan(0);
  });
});

describe('the hub hook (deferred meta sync, 2026-09-10)', () => {
  // What is on the other end of this is `OnlineMatch.flushPendingMetaSync` — an account
  // session that arrived mid-run and had its `setMeta` held back. See `phase.ts`'s
  // `isHubPhase` for the clobber it avoids.
  it('fires on the way into the menu and the forge', () => {
    for (const method of ['showMenu', 'showForge'] as const) {
      const onHubEntered = vi.fn();
      const t = make({ onHubEntered });
      t.nav[method]();
      expect(onHubEntered, method).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT fire on the screens that are not the hub', () => {
    // Naming them individually rather than asserting "not the two above": a new screen that
    // should flush is a decision somebody has to make, and a blanket assertion would make it
    // silently for them.
    for (const method of ['showSquad', 'showAccount', 'showPvpPreview', 'showMatchmaking'] as const) {
      const onHubEntered = vi.fn();
      const t = make({ onHubEntered });
      t.nav[method]();
      expect(onHubEntered, method).not.toHaveBeenCalled();
    }
  });

  it('waits for the art gate — a deferred forge flushes when the art lands, not before', () => {
    // The ordering the hook is placed after `artGate.defer` for: a flush during the loading
    // screen would apply the account's meta while the phase is still the one before it.
    const onHubEntered = vi.fn();
    const t = make({ onHubEntered });
    t.closeGate();
    t.nav.showForge();
    expect(onHubEntered).not.toHaveBeenCalled();
    t.releaseGate();
    expect(onHubEntered).toHaveBeenCalledTimes(1);
  });
});

describe('settings and pause', () => {
  it('remembers the forge as the return phase, and goes back there', () => {
    const t = make();
    t.run.phase = 'forge';
    t.nav.openSettings();
    expect(t.run.phase).toBe('settings');
    expect(t.run.settingsReturnPhase).toBe('forge');

    t.nav.closeSettings();
    expect(t.run.phase).toBe('forge');
  });

  it('remembers the menu the same way', () => {
    const t = make();
    t.run.phase = 'menu';
    t.nav.openSettings();
    expect(t.run.settingsReturnPhase).toBe('menu');
    t.nav.closeSettings();
    expect(t.run.phase).toBe('menu');
  });

  it('REFUSES to open from anywhere else — a mid-run open would strand the player', () => {
    // `closeSettings` only knows two destinations, so opening from a third phase would
    // return somewhere the player never was. The guard is what keeps that unreachable.
    for (const phase of ['playing', 'paused', 'victory', 'matchmaking', 'squad'] as const) {
      const t = make();
      t.run.phase = phase;
      t.nav.openSettings();
      expect(t.run.phase, phase).toBe(phase);
      expect(t.calls).toEqual([]);
    }
  });

  it('pauses and resumes around the playing phase', () => {
    const t = make();
    t.run.phase = 'playing';
    t.nav.pause();
    expect(t.run.phase).toBe('paused');
    t.nav.resume();
    expect(t.run.phase).toBe('playing');
  });

  it('returns to the PAUSE menu, not the forge, when settings was opened from a pause', () => {
    // The one that matters: `closeSettings` would send a paused player to the main menu and
    // abandon the run. The pause path uses its own return instead.
    const t = make();
    t.run.phase = 'paused';
    t.nav.openSettingsFromPause();
    expect(t.run.phase).toBe('settings');
    expect(t.run.settingsReturnPhase).toBe('paused');

    t.nav.openPauseFromSettings();
    expect(t.run.phase).toBe('paused');
  });

  it('labels the pause menu SKIP during a tutorial and QUIT otherwise', () => {
    // A tutorial is always skippable (design/10) and skipping counts as completing it. The
    // label is the only place a player learns that, so the two cases must differ.
    const t = make();
    t.nav.pause();
    const normal = t.calls.at(-1)!;
    expect(normal).toBe('pause(800,600,,false)'); // no label — the default QUIT; and not savable

    t.calls.length = 0;
    t.run.tutorialActive = true;
    t.nav.pause();
    const tutorial = t.calls.at(-1)!;
    expect(tutorial).not.toBe(normal);
    expect(tutorial.startsWith('pause(800,600,')).toBe(true);

    // ...and the same label reaches the pause menu when it is reopened from settings, which
    // is a second call site that could easily have been left passing `undefined`.
    t.calls.length = 0;
    t.nav.openPauseFromSettings();
    expect(t.calls.at(-1)).toBe(tutorial.replace('pause(', 'openPauseFromSettings('));
  });
});

describe('relayout', () => {
  it('repositions the viewport-space widgets whatever the phase', () => {
    // The backdrop and the in-run HUD are NOT in menu design space, so they get the raw
    // renderer size, not the fitted one. Passing the wrong pair leaves the HUD in a corner.
    const t = make();
    t.nav.relayout();
    expect(t.deps.backdrop.resize).toHaveBeenCalledWith(1600, 1200);
    expect(t.deps.hud.reposition).toHaveBeenCalledWith({ w: 1600, h: 1200 });
    expect(t.deps.portalPrompt.reposition).toHaveBeenCalledWith({ w: 1600, h: 1200 });
  });

  it.each([
    ['menu', 'mainMenu'],
    ['pvpPreview', 'pvpPreview'],
    ['squad', 'partyScreen'],
    ['account', 'loginScreen'],
    ['paused', 'pauseMenu'],
    ['settings', 'settingsScreen'],
  ] as const)('re-shows the %s screen', (phase, dep) => {
    const t = make();
    t.run.phase = phase;
    t.nav.relayout();
    expect((t.deps as unknown as Record<string, { show: ReturnType<typeof vi.fn> }>)[dep]!.show)
      .toHaveBeenCalled();
  });

  it('RESIZES the store screen rather than showing it', () => {
    // Same reason matchmaking is resized: `show()` re-lists the catalogue and clears the
    // status line, so a rotation mid-purchase would wipe "waiting for the payment…" off
    // the screen and start a second listing under a booked order.
    const t = make();
    t.run.phase = 'store';
    t.nav.relayout();
    expect(t.deps.storeScreen.resize).toHaveBeenCalled();
    expect(t.deps.storeScreen.show).not.toHaveBeenCalled();
  });

  it('RESIZES the matchmaking screen rather than showing it', () => {
    // `show()` restarts connect(). A resize during matchmaking would drop the queue entry
    // and start a second one — and the player would just see it take longer.
    const t = make();
    t.run.phase = 'matchmaking';
    t.nav.relayout();
    expect(t.deps.matchmaking.resize).toHaveBeenCalled();
    expect(t.deps.matchmaking.show).not.toHaveBeenCalled();
  });

  it('re-renders the forge with the CURRENT meta', () => {
    const t = make();
    t.run.phase = 'forge';
    t.nav.relayout();
    expect(t.deps.forge.render).toHaveBeenCalledWith(t.run.meta, 800, 600);
  });

  it('resizes the result screen for both outcomes', () => {
    for (const phase of ['victory', 'defeat'] as const) {
      const t = make();
      t.run.phase = phase;
      t.nav.relayout();
      expect(t.deps.screens.resize, phase).toHaveBeenCalled();
    }
  });

  it('lays out NO panel while playing — the HUD reposition above is the whole job', () => {
    const t = make();
    t.run.phase = 'playing';
    t.nav.relayout();
    for (const dep of ['mainMenu', 'forge', 'storeScreen', 'screens', 'pauseMenu'] as const) {
      const s = (t.deps as unknown as Record<string, { show: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }>)[dep]!;
      expect(s.show, dep).not.toHaveBeenCalled();
      expect(s.render, dep).not.toHaveBeenCalled();
      expect(s.resize, dep).not.toHaveBeenCalled();
    }
  });
});

describe('refreshForgeIfOpen', () => {
  it('re-renders only while the forge is the live screen', () => {
    // Called after an account sync changes the meta. Rendering the forge from another phase
    // would draw it over whatever is actually on screen.
    const t = make();
    t.run.phase = 'menu';
    t.nav.refreshForgeIfOpen();
    expect(t.deps.forge.render).not.toHaveBeenCalled();

    t.run.phase = 'forge';
    t.nav.refreshForgeIfOpen();
    expect(t.deps.forge.render).toHaveBeenCalledTimes(1);
  });
});

describe('showOutcome', () => {
  it('shows the result screen in menu design space', () => {
    const t = make();
    t.nav.showOutcome(true, 'Extracted', ['a', 'b']);
    expect(t.deps.screens.show).toHaveBeenCalledWith(800, 600, true, 'Extracted', ['a', 'b']);
  });
});

/**
 * Whether the pause menu offers SAVE & QUIT (design/05 "Only the boss floor ends a run",
 * ENGINE_VERSION 61).
 *
 * `savableRun` owns the rule and is asserted exhaustively next to the save format
 * (`match/runSave.test.ts`). What is tested HERE is the wiring — that the flags this file
 * feeds it come off the right places, which is the half a test of the predicate cannot see.
 * Two of them are the ones worth pinning: `dungeon` is read from the LIVE SIM STATE rather
 * than from any run flag (nothing on `RunState` distinguishes the flat-mode tutorial level
 * from the real dungeon), and every flag is recomputed per open rather than cached, so the
 * answer belongs to the run that is actually paused.
 */
describe('the pause menu only offers SAVE & QUIT for a savable run', () => {
  /** A run state whose `activeState()` reports a real dungeon, as `beginRun`'s does. */
  function dungeonRun(t: ReturnType<typeof make>): void {
    t.run.phase = 'playing';
    t.run.engine = { state: { dungeonEnabled: true } } as never;
  }

  /** The 4th argument `ScreenFlow.pause` is called with, as recorded by the flow proxy. */
  const savableArg = (call: string): string => call.split(',').at(-1)!.replace(')', '');

  it('offers it for a single-player offline dungeon run', () => {
    const t = make();
    dungeonRun(t);
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('true');
  });

  it('withholds it in a flat-mode level, which the run flags alone cannot tell apart', () => {
    // The tutorial is the live case: offline, single-player, not flagged `tutorialActive` by
    // anything this method reads except that flag — but ALSO not a dungeon, and a flat run
    // has no floors to come back to. Asserted with the tutorial flag DOWN so it is the
    // dungeon read being tested and not the tutorial one.
    const t = make();
    t.run.phase = 'playing';
    t.run.engine = { state: { dungeonEnabled: false } } as never;
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('false');
  });

  it('withholds it with no live state at all, rather than assuming a dungeon', () => {
    const t = make();
    t.run.phase = 'playing'; // engine still null
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('false');
  });

  it.each([
    ['online', (t: ReturnType<typeof make>) => { t.run.online = true; }],
    ['co-op', (t: ReturnType<typeof make>) => { t.run.coop = true; }],
    ['the tutorial', (t: ReturnType<typeof make>) => { t.run.tutorialActive = true; }],
    ['the arena harness', (t: ReturnType<typeof make>) => { t.run.arenaDemo = 'landing_basic'; }],
    ['replay playback', (t: ReturnType<typeof make>) => { t.run.replayStop = 500; }],
  ])('withholds it during %s', (_why, spoil) => {
    const t = make();
    dungeonRun(t);
    spoil(t);
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('false');
  });

  it('online reads the SESSION state, so an online dungeon is still refused', () => {
    // `activeState()` switches source with the online flag, so this also pins that the
    // dungeon read follows it rather than looking at the stale offline engine.
    const t = make();
    t.run.phase = 'playing';
    t.run.online = true;
    t.run.session = { state: { dungeonEnabled: true } } as never;
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('false');
  });

  it('recomputes per open — the previous run\'s answer never carries over', () => {
    const t = make();
    dungeonRun(t);
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('true');

    t.run.online = true;
    t.nav.pause();
    expect(savableArg(t.calls.at(-1)!)).toBe('false');
  });

  it('reaches the pause menu the same way when it is reopened from settings', () => {
    // A second call site that could easily have been left passing a hardcoded false — the
    // same shape of bug the SKIP label had (see the label case above).
    const t = make();
    dungeonRun(t);
    t.nav.openPauseFromSettings();
    expect(savableArg(t.calls.at(-1)!)).toBe('true');
  });

  it('and on a relayout, which redraws whichever screen is showing', () => {
    const t = make();
    dungeonRun(t);
    t.run.phase = 'paused';
    t.nav.relayout();
    expect(t.deps.pauseMenu.show).toHaveBeenCalledWith(800, 600, undefined, true);
  });
});
