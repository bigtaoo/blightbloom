/**
 * `gameWiring` — the callback table, and the key rule inside it.
 *
 * Two halves, tested differently on purpose.
 *
 * `keydownAction` is a pure function and gets ordinary cases. It carries the rule that pause
 * and F9 are OFFLINE-ONLY, which is the one thing in this file that fails invisibly: a
 * shared online match cannot be frozen from one client without server reconciliation, so an
 * Escape that started working online would desync everyone else in the room while looking,
 * to the player who pressed it, like the pause finally worked.
 *
 * `wireScreens`/`wireHud` are assignment tables, so the useful assertion is COVERAGE of the
 * table rather than the behaviour behind each entry: every callback slot the screens expose
 * must end up pointing at something. A slot left null is a dead button — it does nothing, it
 * logs nothing, and it is only findable by pressing it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { resetHostKind, setHostKind } from '../../platform/hostKind';
import { notifySessionChanged, resetSessionEvents } from '../../platform/sessionEvents';
import { onlineEntry, setOnlineEntry } from '../../platform/onlineEntry';
import { keydownAction, wireHud, wireScreens, type WiringDeps } from './gameWiring';
import { setPublicFlags, setPublicFlagsListener } from '../../net/clientFlags';
import { PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

describe('keydownAction', () => {
  it('closes the settings screen on Escape or O, from the settings phase only', () => {
    expect(keydownAction('Escape', 'settings', false)).toBe('closeSettings');
    expect(keydownAction('KeyO', 'settings', false)).toBe('closeSettings');
    // O in the FORGE opens it instead — that is ForgeInput's table, so this one must not
    // claim the key there.
    expect(keydownAction('KeyO', 'forge', false)).toBe('forge');
  });

  it('closes settings even during an online match', () => {
    // Settings is a client-local overlay, unlike pause: it does not stop the sim, so the
    // online guard must not swallow it. The ordering of the two checks is what decides this.
    expect(keydownAction('Escape', 'settings', true)).toBe('closeSettings');
  });

  it('toggles pause with Escape or P, in the right direction for each phase', () => {
    expect(keydownAction('Escape', 'playing', false)).toBe('pause');
    expect(keydownAction('KeyP', 'playing', false)).toBe('pause');
    expect(keydownAction('Escape', 'paused', false)).toBe('resume');
    expect(keydownAction('KeyP', 'paused', false)).toBe('resume');
  });

  it('saves a replay on F9 from any offline phase', () => {
    // Deliberately not phase-guarded: an offline run stays packable after it ends, and the
    // moment worth recording is one nobody planned for.
    for (const phase of ['menu', 'forge', 'playing', 'paused', 'victory', 'defeat']) {
      expect(keydownAction('F9', phase, false), phase).toBe('saveReplay');
    }
  });

  it('makes pause, resume and F9 NO-OPS while online', () => {
    // The rule this file exists to pin. Each returns `forge`, i.e. "not a shell hotkey" —
    // ForgeInput's own phase guard then ignores it too.
    for (const code of ['Escape', 'KeyP', 'F9']) {
      expect(keydownAction(code, 'playing', true), code).toBe('forge');
      expect(keydownAction(code, 'paused', true), code).toBe('forge');
    }
  });

  it('passes every other key through to the forge handler', () => {
    for (const code of ['Digit1', 'KeyC', 'KeyB', 'ArrowUp', 'Enter', 'Space']) {
      expect(keydownAction(code, 'forge', false), code).toBe('forge');
    }
  });

  it('does not pause from a phase that is not a live run', () => {
    for (const phase of ['menu', 'forge', 'victory', 'matchmaking']) {
      expect(keydownAction('Escape', phase, false), phase).toBe('forge');
    }
  });
});

/** A recorder for every callback slot the wiring assigns. */
function screenStub(...slots: string[]) {
  const obj: Record<string, unknown> = { refreshAccountLabel: vi.fn() };
  for (const s of slots) obj[s] = null;
  return obj;
}

function make() {
  const run = new RunState(store);
  const called: string[] = [];
  const track = (name: string) => vi.fn(() => void called.push(name));
  const nav = {
    showMenu: track('nav.showMenu'), showModeSelect: track('nav.showModeSelect'),
    showSquad: track('nav.showSquad'), showAccount: track('nav.showAccount'),
    openSettings: track('nav.openSettings'), showForge: track('nav.showForge'),
    showMatchmaking: track('nav.showMatchmaking'), openSettingsFromPause: track('nav.openSettingsFromPause'),
    resume: track('nav.resume'), pause: track('nav.pause'),
  };
  const runs = {
    beginTutorialRun: track('runs.beginTutorialRun'), beginQuickRun: track('runs.beginQuickRun'),
    finalizeOnlineRun: track('runs.finalizeOnlineRun'),
    quitRun: track('runs.quitRun'), saveReplay: track('runs.saveReplay'),
  };
  const net = {
    beginSoloQueue: vi.fn((pvp: boolean) => void called.push(`net.beginSoloQueue(${pvp})`)),
    beginSquadMatch: track('net.beginSquadMatch'), onCancelled: track('net.onCancelled'),
    syncMetaWithSession: vi.fn(() => Promise.resolve()),
  };
  const forgeInput = {
    cycleCharacter: track('forgeInput.cycleCharacter'), clear: track('forgeInput.clear'),
    craftAt: track('forgeInput.craftAt'),
    onKey: vi.fn(),
  };
  const builder = {
    requestConfirmExtract: track('builder.requestConfirmExtract'),
    requestConfirmDescend: track('builder.requestConfirmDescend'),
    requestPickup: track('builder.requestPickup'),
    suppressFireUntilRelease: track('builder.suppressFireUntilRelease'),
    requestSwap: track('builder.requestSwap'),
    requestCardVote: track('builder.requestCardVote'),
  };
  const d: WiringDeps = {
    run,
    nav: nav as never, runs: runs as never, net: net as never, forgeInput: forgeInput as never,
    builder: builder as never,
    input: { onSwitchWeapon: null } as never,
    hud: {
      weaponPickupPrompt: screenStub('onPick', 'onPressStart'),
      onPause: null, onSwapWeapon: null, onSaveReplay: null,
    } as never,
    portalPrompt: screenStub('onExtract', 'onDescend') as never,
    floorCardPrompt: screenStub('onVote', 'onPressStart') as never,
    mainMenu: { ...screenStub('onPlay', 'onModes', 'onSquad', 'onAccount', 'onSettings'),
      setQuickPlay: vi.fn(), setAccountEntry: vi.fn(), refreshBanner: vi.fn() } as never,
    modeSelect: screenStub('onSolo', 'onCoop', 'onPvpSolo', 'onTutorial', 'onBack') as never,
    pvpPreview: screenStub('onQueue', 'onBack') as never,
    matchmaking: screenStub('onConnected', 'onCancelled') as never,
    partyScreen: screenStub('onBack', 'onStartMatch') as never,
    loginScreen: screenStub('onBack', 'onSessionChange') as never,
    forge: screenStub('onBack', 'onCycleCharacter', 'onClear', 'onCraftAt', 'onStart', 'onStore') as never,
    storeScreen: screenStub('onBack') as never,
    screens: screenStub('onConfirm', 'onMenu') as never,
    pauseMenu: screenStub('onResume', 'onSettings', 'onQuit') as never,
    confirm: vi.fn(() => void called.push('confirm')),
    activeSlot: () => 0,
    ...{},
  };
  return { d, run, called, net, nav };
}

describe('wireScreens', () => {
  it('leaves NO callback slot unassigned', () => {
    // The whole point of the table. A slot still null after wiring is a button that does
    // nothing when pressed, with no error anywhere.
    const t = make();
    wireScreens(t.d);
    const screens = ['mainMenu', 'modeSelect', 'pvpPreview', 'matchmaking', 'partyScreen',
      'loginScreen', 'forge', 'screens', 'pauseMenu'] as const;
    for (const name of screens) {
      const obj = t.d[name] as unknown as Record<string, unknown>;
      for (const [slot, value] of Object.entries(obj)) {
        if (slot === 'refreshAccountLabel' || slot === 'setQuickPlay' || slot === 'refreshBanner') continue;
        if (slot === 'setAccountEntry') continue;
        // `onModes` is the one slot that is deliberately unwired on the default host: the
        // button it belongs to is hidden there, because PLAY already opens the mode list.
        // The portal branch below asserts the other half — that it IS wired when the button
        // is on screen — so between the two, neither shape can ship a dead button.
        if (slot === 'onModes') continue;
        expect(value, `${name}.${slot} is still unassigned`).toBeTypeOf('function');
      }
    }
  });

  it('routes each button to the verb its label promises', () => {
    const t = make();
    wireScreens(t.d);
    const fire = (screen: keyof WiringDeps, slot: string, ...args: unknown[]): void => {
      (t.d[screen] as unknown as Record<string, (...a: unknown[]) => void>)[slot]!(...args);
    };
    fire('mainMenu', 'onPlay');
    fire('mainMenu', 'onSquad');
    fire('mainMenu', 'onAccount');
    fire('modeSelect', 'onSolo');
    fire('modeSelect', 'onCoop');
    fire('modeSelect', 'onPvpSolo');
    fire('modeSelect', 'onTutorial');
    fire('pvpPreview', 'onQueue');
    fire('partyScreen', 'onStartMatch', 'p1');
    fire('pauseMenu', 'onQuit');
    fire('pauseMenu', 'onResume');
    expect(t.called).toEqual([
      'nav.showModeSelect', 'nav.showSquad', 'nav.showAccount',
      'nav.showForge', 'net.beginSoloQueue(false)', 'net.beginSoloQueue(true)',
      'runs.beginTutorialRun', 'nav.showMatchmaking', 'net.beginSquadMatch',
      'runs.quitRun', 'nav.resume',
    ]);
  });

  it('sends every BACK button to the main menu', () => {
    const t = make();
    wireScreens(t.d);
    for (const screen of ['modeSelect', 'pvpPreview', 'partyScreen', 'loginScreen', 'forge'] as const) {
      t.called.length = 0;
      (t.d[screen] as unknown as Record<string, () => void>).onBack!();
      // pvpPreview's BACK goes one step back, not all the way home — the exception, and the
      // reason this is a per-screen assertion rather than one loop with one expectation.
      expect(t.called, screen).toEqual([screen === 'pvpPreview' ? 'nav.showModeSelect' : 'nav.showMenu']);
    }
  });

  it('refreshes BOTH the account label and the meta store on a session change', () => {
    // Half of it is the visible "Hi, X"; the other half is which MetaStore backs the forge.
    // Dropping the second leaves a freshly logged-in player looking at guest blueprints.
    const t = make();
    wireScreens(t.d);
    (t.d.loginScreen as unknown as { onSessionChange: () => void }).onSessionChange();
    expect((t.d.mainMenu as unknown as { refreshAccountLabel: ReturnType<typeof vi.fn> }).refreshAccountLabel)
      .toHaveBeenCalledTimes(1);
    expect(t.net.syncMetaWithSession).toHaveBeenCalledTimes(1);
  });
});

describe('wireHud', () => {
  it('leaves no HUD or portal slot unassigned', () => {
    const t = make();
    wireHud(t.d);
    const hud = t.d.hud as unknown as Record<string, unknown>;
    for (const slot of ['onPause', 'onSwapWeapon', 'onSaveReplay']) {
      expect(hud[slot], slot).toBeTypeOf('function');
    }
    const prompt = hud.weaponPickupPrompt as Record<string, unknown>;
    expect(prompt.onPick).toBeTypeOf('function');
    expect(prompt.onPressStart).toBeTypeOf('function');
    const portal = t.d.portalPrompt as unknown as Record<string, unknown>;
    expect(portal.onExtract).toBeTypeOf('function');
    expect(portal.onDescend).toBeTypeOf('function');
    const cards = t.d.floorCardPrompt as unknown as Record<string, unknown>;
    expect(cards.onVote).toBeTypeOf('function');
    expect(cards.onPressStart).toBeTypeOf('function');
  });

  it('a card tap is a VOTE, and never a descend', () => {
    // The two panels sit on top of each other at the same moment, and routing a card
    // tap to `requestConfirmDescend` would leave the floor the instant a player touched
    // a card — before they could even read the other two.
    const t = make();
    wireHud(t.d);
    const cards = t.d.floorCardPrompt as unknown as { onVote: (slot: number) => void };
    cards.onVote(3);
    expect(t.d.builder.requestCardVote).toHaveBeenCalledWith(3);
    expect(t.d.builder.requestConfirmDescend).not.toHaveBeenCalled();
  });

  it('the HUD pause button obeys the SAME offline+playing guard the key does', () => {
    // Two entry points to one verb; a guard on only one of them is how a touch player ends
    // up able to freeze a shared match that a keyboard player cannot.
    const t = make();
    wireHud(t.d);
    const onPause = (t.d.hud as unknown as { onPause: () => void }).onPause;

    t.run.phase = 'playing';
    t.run.online = true;
    onPause();
    expect(t.called).toEqual([]);

    t.run.online = false;
    t.run.phase = 'menu';
    onPause();
    expect(t.called).toEqual([]);

    t.run.phase = 'playing';
    onPause();
    expect(t.called).toEqual(['nav.pause']);
  });

  it('the swap chip only latches while playing', () => {
    const t = make();
    wireHud(t.d);
    const onSwap = (t.d.hud as unknown as { onSwapWeapon: () => void }).onSwapWeapon;
    t.run.phase = 'forge';
    onSwap();
    expect(t.called).toEqual([]);
    t.run.phase = 'playing';
    onSwap();
    expect(t.called).toEqual(['builder.requestSwap']);
  });

  it('the record button is NOT phase-guarded — a finished run stays packable', () => {
    const t = make();
    wireHud(t.d);
    t.run.phase = 'defeat';
    (t.d.hud as unknown as { onSaveReplay: () => void }).onSaveReplay();
    expect(t.called).toEqual(['runs.saveReplay']);
  });

  it('a weapon-slot button swaps only when it names the OTHER slot', () => {
    // `shouldSwapToSlot` is the bridge from "slot 2" to the engine's toggle. Without it,
    // pressing the button for the weapon already in hand toggles away from it.
    const t = make();
    wireHud(t.d);
    const onSwitch = (t.d.input as unknown as { onSwitchWeapon: (s: number) => void }).onSwitchWeapon;
    t.run.phase = 'playing';
    // The control names a ONE-based slot; `activeSlot()` here is the zero-based 0, i.e. the
    // player is already holding what button 1 names.
    onSwitch(1);
    expect(t.called).toEqual([]);
    onSwitch(2);
    expect(t.called).toEqual(['builder.requestSwap']);
  });

  it('...and not at all outside a run', () => {
    const t = make();
    wireHud(t.d);
    const onSwitch = (t.d.input as unknown as { onSwitchWeapon: (s: number) => void }).onSwitchWeapon;
    t.run.phase = 'forge';
    onSwitch(2);
    expect(t.called).toEqual([]);
  });
});

describe('wireScreens — the portal host', () => {
  // A game portal allows a first-time visitor at most one click to gameplay, so PLAY starts
  // a run there and SELECT MODE moves to its own button. The pair of tests below is what
  // keeps both shapes honest: neither host may end up with a button that does nothing, and
  // the portal host may not lose the route to co-op / PvP / the tutorial.

  afterEach(() => resetHostKind());

  it('turns PLAY into a run and gives SELECT MODE its own button', () => {
    setHostKind('crazygames');
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as {
      onPlay: () => void;
      onModes: () => void;
      setQuickPlay: ReturnType<typeof vi.fn>;
    };
    expect(menu.setQuickPlay).toHaveBeenCalledWith(true);
    menu.onPlay();
    menu.onModes();
    expect(t.called).toEqual(['runs.beginQuickRun', 'nav.showModeSelect']);
  });

  it('leaves every other route exactly where it was', () => {
    // The portal branch must be one button's behaviour and not a different screen flow:
    // co-op, PvP and the tutorial all still hang off SELECT MODE.
    setHostKind('crazygames');
    const t = make();
    wireScreens(t.d);
    const modeSelect = t.d.modeSelect as unknown as Record<string, () => void>;
    modeSelect.onSolo!();
    modeSelect.onCoop!();
    modeSelect.onPvpSolo!();
    modeSelect.onTutorial!();
    expect(t.called).toEqual([
      'nav.showForge', 'net.beginSoloQueue(false)', 'net.beginSoloQueue(true)',
      'runs.beginTutorialRun',
    ]);
  });

  it('does not touch the quick-play switch on the default host', () => {
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as { setQuickPlay: ReturnType<typeof vi.fn> };
    expect(menu.setQuickPlay).not.toHaveBeenCalled();
  });

  it('removes the account entry on the portal host, and leaves onAccount UNWIRED', () => {
    // Both halves matter and neither implies the other. The switch is what stops the button
    // being drawn; the unwired slot is what makes a drawn one inert if the switch is ever
    // lost. The platform's rules do not allow a game's own credential login to be reachable
    // at all (`MainMenu.setAccountEntry` has the citation).
    setHostKind('crazygames');
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as {
      onAccount: (() => void) | null;
      setAccountEntry: ReturnType<typeof vi.fn>;
    };
    expect(menu.setAccountEntry).toHaveBeenCalledWith(false);
    expect(menu.onAccount).toBeNull();
    // ...and pressing it reaches nothing, rather than reaching the screen.
    menu.onAccount?.();
    expect(t.called).toEqual([]);
  });

  it('keeps the account entry on the default host', () => {
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as {
      onAccount: () => void;
      setAccountEntry: ReturnType<typeof vi.fn>;
    };
    expect(menu.setAccountEntry).not.toHaveBeenCalled();
    menu.onAccount();
    expect(t.called).toEqual(['nav.showAccount']);
  });
});

describe('wireScreens — the maintenance banner subscription', () => {
  afterEach(() => {
    setPublicFlagsListener(null);
    setPublicFlags(null);
  });

  it('refreshes the menu banner when a flag value actually CHANGES', () => {
    // design/21 §9's delivery path, live half. `MainMenu.show()` already re-reads the flag,
    // so this subscription exists for exactly one player: the one already sitting in the
    // menu when an operator puts a notice up — which is the player a notice about a
    // shutdown in twenty minutes is written for.
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as { refreshBanner: ReturnType<typeof vi.fn> };
    const before = menu.refreshBanner.mock.calls.length;

    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'down in 20 minutes' });
    expect(menu.refreshBanner.mock.calls.length).toBe(before + 1);
  });

  it('does NOT refresh on a poll that changed nothing', () => {
    // The control, and the reason `setPublicFlags` returns whether it changed anything: the
    // browser polls every five minutes forever, and an unconditional notification would
    // re-run a screen refresh every five minutes for the entire life of every session.
    const t = make();
    wireScreens(t.d);
    const menu = t.d.mainMenu as unknown as { refreshBanner: ReturnType<typeof vi.fn> };
    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'steady' });
    const after = menu.refreshBanner.mock.calls.length;

    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ui.maintenanceBanner': 'steady' });
    expect(menu.refreshBanner.mock.calls.length).toBe(after);
  });
});

describe('wireScreens — a session that did not come from a screen', () => {
  // Every `wireScreens` call in every case ABOVE also subscribed, and the registry is
  // module state — so these cases clear it first or they are counting other tests'
  // listeners. `sessionEvents.ts` exports the reset for exactly this.
  beforeEach(() => resetSessionEvents());
  afterEach(() => {
    resetSessionEvents();
    resetHostKind();
  });

  /** The two things a session change has to cause, whichever side it arrived from. */
  const reaction = (t: ReturnType<typeof make>) => ({
    label: (t.d.mainMenu as unknown as { refreshAccountLabel: ReturnType<typeof vi.fn> })
      .refreshAccountLabel.mock.calls.length,
    sync: (t.d.net as unknown as { syncMetaWithSession: ReturnType<typeof vi.fn> })
      .syncMetaWithSession.mock.calls.length,
  });

  it('reacts to notifySessionChanged exactly as it reacts to the login screen', () => {
    // The portal's silent login lands in `net/session.ts` from the entry point, so the
    // main-menu label and the account-bound meta re-sync have to be reachable without a
    // screen having been touched. Asserted as EQUALITY with the login-screen path, because
    // the failure worth catching is the two drifting apart.
    const viaScreen = make();
    wireScreens(viaScreen.d);
    (viaScreen.d.loginScreen as unknown as { onSessionChange: () => void }).onSessionChange();

    resetSessionEvents();
    const viaPortal = make();
    wireScreens(viaPortal.d);
    notifySessionChanged();

    expect(reaction(viaPortal)).toEqual(reaction(viaScreen));
    expect(reaction(viaPortal)).toEqual({ label: 1, sync: 1 });
  });

  it('delivers a login that landed BEFORE the screens were wired', () => {
    // The race `sessionEvents.ts` exists for: a boot-time exchange can resolve either side
    // of screen assembly, and the losing order used to leave the player logged in on the
    // server with a menu that says LOGIN.
    notifySessionChanged();
    const t = make();
    wireScreens(t.d);
    expect(reaction(t)).toEqual({ label: 1, sync: 1 });
  });

  it('delivers a pre-wire login ONCE, not on every later notification', () => {
    notifySessionChanged();
    notifySessionChanged();
    const t = make();
    wireScreens(t.d);
    expect(reaction(t)).toEqual({ label: 1, sync: 1 });
  });
});

describe('wireScreens — the two multiplayer doors a host can push (design/20)', () => {
  // Every `wireScreens` call in every case above installed one too — the registry is
  // module state, so these cases clear it first or they are observing another test's.
  beforeEach(() => setOnlineEntry(null));
  afterEach(() => {
    setOnlineEntry(null);
    resetHostKind();
  });

  it('installs the capability on every host, because the registry is inert unused', () => {
    // Installed rather than host-branched: nothing on our own domain calls it, and a
    // branch here would mean a portal-only wiring path to keep correct. Same shape as
    // `rewardedAd.ts`, opposite direction.
    expect(onlineEntry()).toBeNull();
    wireScreens(make().d);
    expect(onlineEntry()).not.toBeNull();
  });

  it('routes queueCoop to the co-op queue, not the PvP one', () => {
    // An instant-multiplayer visitor consented to playing WITH people, not to being
    // dropped into a battle royale against them.
    const t = make();
    wireScreens(t.d);
    onlineEntry()!.queueCoop();
    expect(t.called).toEqual(['net.beginSoloQueue(false)']);
  });

  it('shows the squad screen BEFORE joining, so the join is not discarded as stale', () => {
    // `PartyScreen.show()` is what clears the previous visit's attempt token; joining
    // first would have the answer thrown away.
    const t = make();
    wireScreens(t.d);
    const joins: string[] = [];
    (t.d.partyScreen as unknown as { joinWithCode: (c: string) => void }).joinWithCode = (c) => joins.push(c);
    onlineEntry()!.joinPartyByCode('ABCD');
    expect(t.called).toEqual(['nav.showSquad']);
    expect(joins).toEqual(['ABCD']);
  });
});
