/**
 * The ASSEMBLY table (`gameAssembly.ts`) — until 2026-09-17 it had no tests at all, and a
 * mutation battery over the lobby's CONTINUE RUN pass is what said so out loud.
 *
 * Two mutants survived the whole client suite (`src/game/{match,ui,screens,controllers}`,
 * ~1,600 tests):
 *
 *   SURVIVED  `p.mainMenu.resumableRun = () => null`      — the lobby wired to nothing
 *   SURVIVED  `p.loadout.savedRun = () => null`           — the pre-run screen never offering
 *                                                           CONTINUE (it was the Forge's own
 *                                                           field until the 2026-09-21 split)
 *
 * Both are the same hole. `MainMenu.test.ts` and `Forge.test.ts` each drive their screen from
 * an INJECTED provider, which is the right way to test a screen and is exactly why neither can
 * see the provider the product actually installs. The screens were tested; the sentence that
 * makes them agree — *both fields are assigned the same function* — was a claim in a comment.
 *
 * So this file asserts the wiring by BEHAVIOUR rather than by reading the source: put a real
 * save in the real slot, assemble, and ask both providers. A `grep`-shaped test would pass
 * against `() => resumableRunSummary()` written twice with one of them typo'd into
 * `savedRunSummary`, which is the precise regression this exists to stop.
 *
 * ## Why the parts are a cast stub rather than a real graph
 *
 * `assembleGame` constructs eleven collaborators that all just STORE their deps, and reaches
 * into only a handful of the 31 parts while doing it (`run.matchBaseUrl`, `layers.menu.mount`,
 * and the `.view` of each screen it mounts). Standing up a real `Layers`/`Scene`/`HudView`
 * would need a WebGL renderer and would test Pixi rather than the table. `mainMenu` and
 * `loadout` are REAL, because they are the two this file is actually about.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assembleGame, type AssemblyParts, type GameShellHost } from './gameAssembly';
import { MainMenu } from '../screens/MainMenu';
import { Forge } from '../screens/Forge';
import { Loadout } from '../screens/Loadout';
import { Matchmaking } from '../screens/Matchmaking';
import { RunState } from '../runState';
import { defaultMetaState, MemoryMetaStore } from '../../meta';
import { packRunSave, type SavedRun } from '../match/runSave';
import { writeSavedRun, clearSavedRun, resetRunSaveCacheForTests } from '../match/runSaveStore';
import { resetResumableCacheForTests } from '../match/resumableRun';
import { buildDungeonRunConfig } from '../match/offlineConfig';
import { ENGINE_VERSION } from '@dd/engine';

/** An in-memory save slot, so nothing here touches `localStorage`. */
function memRunSaveStore() {
  let held: unknown = null;
  return {
    load: () => held,
    save: (v: SavedRun) => { held = JSON.parse(JSON.stringify(v)); return true; },
    clear: () => { held = null; },
  };
}

/** A save of a run this build would produce today — resumable by construction. */
function freshSave(): SavedRun {
  const config = buildDungeonRunConfig({
    seed: 11, coop: false,
    localSeat: { skinId: defaultMetaState().selectedSkin, loadout: [] },
    allySkinId: 'x',
  });
  return packRunSave({ config, commands: [], ticks: 120, floorIndex: 2, score: 5, nowMs: 42 });
}

function build(over: { matchmaking?: unknown } = {}) {
  const mainMenu = new MainMenu();
  const loadout = new Loadout();
  const stub = { view: {} };
  const parts = {
    run: new RunState(new MemoryMetaStore()),
    layers: { menu: { mount: vi.fn() }, world: {} },
    mainMenu,
    loadout,
    forge: new Forge(),
    settingsBtn: stub,
    pvpPreview: stub,
    matchmaking: over.matchmaking ?? stub,
    screens: stub,
    settingsScreen: stub,
    pauseMenu: stub,
  } as unknown as AssemblyParts;
  const host = {
    screenSize: () => ({ w: 800, h: 600 }),
    settingsState: () => ({}),
    allySkinId: () => 'ally',
    confirm: () => {},
    endRunAsDefeat: () => {},
  } as unknown as GameShellHost;
  const assembled = assembleGame(parts, host);
  return { mainMenu, loadout, assembled };
}

let store: ReturnType<typeof memRunSaveStore>;

beforeEach(() => {
  store = memRunSaveStore();
  resetRunSaveCacheForTests();
  resetResumableCacheForTests();
});

describe('the lobby and the loadout screen cannot disagree about a saved run', () => {
  it('installs a provider on BOTH screens — neither is left at its "no save" default', () => {
    // The default on each screen is `() => null` (fail-closed, so a screen nobody wired shows
    // no CONTINUE). That makes "the provider is missing" and "there is no save" the same
    // answer, which is why this case puts a real save in first: without one, a completely
    // unwired assembly would look identical to a correct one.
    writeSavedRun(freshSave(), store);
    const { mainMenu, loadout } = build();
    expect(mainMenu.resumableRun()).not.toBeNull();
    expect(loadout.savedRun()).not.toBeNull();
  });

  it('gives both the SAME answer, save by save', () => {
    writeSavedRun(freshSave(), store);
    const { mainMenu, loadout } = build();
    expect(mainMenu.resumableRun()).toEqual(loadout.savedRun());
    expect(mainMenu.resumableRun()).toEqual({ floorIndex: 2, ticks: 120, savedAtMs: 42 });
  });

  it('withdraws the offer from both when this build can no longer rebuild the save', () => {
    // The 2026-09-17 defect, in the shape it actually shipped: the screen asked "does a save
    // exist" and got yes, so it drew a full-size primary CONTINUE that could only drop the
    // save and apologise. Asserting BOTH here is the point — one screen answering `null`
    // while the other answers a summary is the disagreement the single provider exists to
    // make impossible.
    const save = freshSave();
    writeSavedRun({ ...save, engineVersion: ENGINE_VERSION - 1 }, store);
    const { mainMenu, loadout } = build();
    expect(mainMenu.resumableRun()).toBeNull();
    expect(loadout.savedRun()).toBeNull();
  });

  it('answers null on both with no save at all', () => {
    clearSavedRun(store);
    const { mainMenu, loadout } = build();
    expect(mainMenu.resumableRun()).toBeNull();
    expect(loadout.savedRun()).toBeNull();
  });

  it('is a PROVIDER, not a snapshot — a save written after assembly still reaches both', () => {
    // Why both fields are thunks: the assembly runs once at boot and a run is saved from the
    // pause menu much later. A value read here would leave the lobby denying a run the player
    // put away four minutes ago.
    clearSavedRun(store);
    const { mainMenu, loadout } = build();
    expect(mainMenu.resumableRun()).toBeNull();

    writeSavedRun(freshSave(), store);
    expect(mainMenu.resumableRun()).not.toBeNull();
    expect(loadout.savedRun()).not.toBeNull();
  });
});

describe('the per-frame lobby clocks', () => {
  it("drives the Matchmaking screen — its elapsed time and backfill countdown move", () => {
    // The 2026-09-26 defect: `Matchmaking.update` existed and was tested, and nothing in the
    // product ever called it, so the queue read "0s elapsed" for as long as it lasted.
    // `GameLoop.test.ts` pins that the loop ticks whatever `lobbyScreens` holds; this pins
    // that the assembly actually puts the Matchmaking screen (and the party lobby) in it.
    const matchmaking = new Matchmaking();
    const { assembled } = build({ matchmaking });
    let report!: (p: { botFillInMs?: number }) => void;
    matchmaking.show(800, 600, (_s, onQueued) => {
      report = onQueued!;
      return new Promise(() => {});
    });
    report({ botFillInMs: 5_000 });
    const lobbyScreens = (assembled.gameLoop as unknown as { deps: { lobbyScreens: { update(dt: number): void }[] } }).deps.lobbyScreens;
    expect(lobbyScreens).toContain(assembled.partyScreen);
    for (const screen of lobbyScreens) screen.update(2_500);
    const view = matchmaking as unknown as { statusText: { text: string }; hintText: { text: string } };
    expect(view.statusText.text).toBe('2s elapsed');
    expect(view.hintText.text).toBe('AI players fill empty seats in 3s');
  });
});
