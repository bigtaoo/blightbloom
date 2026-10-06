/**
 * `RunLifecycle` and PvE chapters (design/gameplay/04-chapters.md): which dungeon a NEW run is
 * built from, and which one a RESUMED run is rebuilt from. Two different questions with two
 * different answers — the lobby's pick for the first, the save's own chapter for the second —
 * and confusing them is either a run in a chapter the player never earned or a frost save
 * refused as stale content.
 *
 * Kept beside `RunLifecycle.test.ts` rather than in it: that file's harness is the full
 * screen-and-order fake, and every assertion here is about the config handed to the engine,
 * which the recorder's `begin`/`resume` see first.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CHAPTERS, LocalInputSource, type EngineConfig, type PlayerCommand } from '@dd/engine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { defaultMetaState, type MetaState, type MetaStore } from '../../meta';
import { buildDungeonRunConfig } from '../match/offlineConfig';
import { packRunSave } from '../match/runSave';
import { loadSavedRun, resetRunSaveCacheForTests, writeSavedRun } from '../match/runSaveStore';
import { resetResumableCacheForTests } from '../match/resumableRun';
import { RunState } from '../runState';
import { RunLifecycle, type RunLifecycleDeps } from './RunLifecycle';

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  resetRunSaveCacheForTests();
  resetResumableCacheForTests();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
});

/** Just enough of every collaborator for an entry point to run; the recorder keeps the config
 *  each run was built from, which is the thing under test. */
function make(meta: Partial<MetaState> = {}) {
  const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };
  const run = new RunState(store);
  run.meta = { ...defaultMetaState(), ...meta };
  const configs: EngineConfig[] = [];
  const hide = { hide: vi.fn() };
  const deps = {
    run,
    layers: { fx: { children: [] } },
    scene: { clear: vi.fn() },
    fx: { particles: { view: {} }, resetForNewRun: vi.fn() },
    roomBuilder: { clear: vi.fn(), build: vi.fn() },
    gameLoop: { resetForNewRun: vi.fn() },
    screenFlow: { hideSettingsButton: vi.fn() },
    nav: { showMenu: vi.fn(), showLoadout: vi.fn() },
    transitions: { deferRunBoundary: () => false },
    recorder: {
      begin: (_label: string, config: EngineConfig) => {
        configs.push(config);
        return new LocalInputSource();
      },
      resume: (_label: string, config: EngineConfig, cmds: readonly PlayerCommand[]) => {
        configs.push(config);
        const src = new LocalInputSource();
        for (const c of cmds) src.submit(c);
        return src;
      },
    },
    tutorialHints: { reset: vi.fn() },
    hud: { toast: vi.fn() },
    hudView: { visible: false },
    forge: hide, loadout: hide, mainMenu: hide, settingsScreen: hide,
    matchmaking: hide, partyScreen: hide, pauseMenu: hide, screens: hide,
    allySkinId: () => 'skirmisher',
  } as unknown as RunLifecycleDeps;
  return { runs: new RunLifecycle(deps), run, configs, deps };
}

describe('a NEW run starts in the lobby\'s pick', () => {
  it('builds chapter 1 for a fresh account — the same content objects as always', () => {
    const t = make();
    t.runs.beginRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.ember.config);
    expect(t.configs[0]!.dungeon!.library).toBe(CHAPTERS.ember.library);
  });

  it('builds chapter 2 once it is unlocked and picked', () => {
    const t = make({ clearedChapters: ['ember'], selectedChapter: 'frost' });
    t.runs.beginRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.frost.config);
    expect(t.configs[0]!.dungeon!.library).toBe(CHAPTERS.frost.library);
  });

  it('falls back to chapter 1 for a pick that is not unlocked (a hand-edited or half-synced save)', () => {
    const t = make({ clearedChapters: [], selectedChapter: 'frost' });
    t.runs.beginRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.ember.config);
  });

  it('the portal\'s one-click PLAY goes through the same pick', () => {
    const t = make({ clearedChapters: ['ember'], selectedChapter: 'frost' });
    t.runs.beginQuickRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.frost.config);
  });
});

describe('a RESUMED run is rebuilt in the save\'s own chapter', () => {
  const STREAM = Array.from({ length: 3 }, (_, i) => makeCommand({ owner: 0, tick: i + 1, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 }));

  function saveIn(chapterId: 'ember' | 'frost') {
    const config = buildDungeonRunConfig({
      seed: 77, chapterId, coop: false, localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: '',
    });
    return packRunSave({ config, commands: STREAM, ticks: 3, floorIndex: 0, score: 5, nowMs: 1 });
  }

  it('resumes a frost save in frost, even with the lobby pick on chapter 1', () => {
    writeSavedRun(saveIn('frost'));
    const t = make({ clearedChapters: ['ember'], selectedChapter: 'ember' });
    t.runs.resumeSavedRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.frost.config);
    expect(t.run.phase).toBe('playing');
    expect(t.run.engine!.state.tick).toBe(3);
    expect(t.deps.hud.toast).not.toHaveBeenCalled(); // not refused as stale content
  });

  it('resumes an ember save in ember, with the lobby pick on chapter 2', () => {
    writeSavedRun(saveIn('ember'));
    const t = make({ clearedChapters: ['ember'], selectedChapter: 'frost' });
    t.runs.resumeSavedRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.ember.config);
    expect(t.run.phase).toBe('playing');
  });

  it('resumes a save written before chapters existed (no chapter field) as chapter 1', () => {
    const { chapterId, ...old } = saveIn('ember');
    expect(chapterId).toBe('ember');
    writeSavedRun(old as never);
    resetRunSaveCacheForTests(); // re-read from storage, through the parser
    expect(loadSavedRun()!.chapterId).toBe('ember');
    const t = make();
    t.runs.resumeSavedRun();
    expect(t.configs[0]!.dungeon!.config).toBe(CHAPTERS.ember.config);
    expect(t.run.phase).toBe('playing');
  });
});
