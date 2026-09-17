/**
 * The one answer both CONTINUE controls are drawn from (design/10, 2026-09-17).
 *
 * What these tests are really pinning is the DIFFERENCE between "a save exists" and "a save
 * this build can rebuild" — the gap that shipped a Forge button which could only drop the
 * save and apologise. So every refusal case below asserts BOTH sides: that
 * `savedRunSummary` still says yes (the save is there, well-formed, parseable) and that this
 * module says no. A test that only asserted the null would pass just as happily against a
 * save that failed to parse, which is a different bug wearing the same answer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ENGINE_VERSION } from '@dd/engine';
import { contentHashOf, packRunSave, type RunSaveStore, type SavedRun } from './runSave';
import {
  loadSavedRun, savedRunSummary, writeSavedRun, clearSavedRun, resetRunSaveCacheForTests,
} from './runSaveStore';
import { buildDungeonRunConfig } from './offlineConfig';
import { resumableRunSummary, refuseResume, resetResumableCacheForTests } from './resumableRun';

/** The same in-memory store shape `runSaveStore.test.ts` uses — no localStorage anywhere. */
function memStore(): RunSaveStore {
  let held: unknown = null;
  return {
    load: () => held,
    save: (v) => { held = JSON.parse(JSON.stringify(v)); return true; },
    clear: () => { held = null; },
  };
}

let store: RunSaveStore;

/** A save of a run this build would produce today, so it is resumable by construction. */
function freshSave(): SavedRun {
  const config = buildDungeonRunConfig({
    seed: 7, coop: false, localSeat: { skinId: 'juggernaut', loadout: ['cryobolt'] }, allySkinId: 'x',
  });
  return packRunSave({ config, commands: [], ticks: 40, floorIndex: 1, score: 12, nowMs: 1000 });
}

beforeEach(() => {
  store = memStore();
  resetRunSaveCacheForTests();
  resetResumableCacheForTests();
});

/** `loadSavedRun`'s process-wide slot is what both this module and the screens read, so the
 *  fixture goes in through the real writer and the cache is reset around it. */
function put(save: SavedRun): void {
  writeSavedRun(save, store);
}

describe('resumableRunSummary', () => {
  it('offers a save this build can rebuild, with the fields a screen draws', () => {
    put(freshSave());
    expect(resumableRunSummary()).toEqual({ floorIndex: 1, ticks: 40, savedAtMs: 1000 });
  });

  it('offers nothing when there is no save at all', () => {
    clearSavedRun(store);
    expect(resumableRunSummary()).toBeNull();
  });

  it('refuses a save from another ENGINE_VERSION — while the save itself is still THERE', () => {
    put({ ...freshSave(), engineVersion: ENGINE_VERSION - 1 });
    // The control the old Forge drew: a save exists, is well-formed, and parses.
    expect(savedRunSummary(store)).not.toBeNull();
    expect(loadSavedRun(store)).not.toBeNull();
    // The question a CONTINUE button is actually asking.
    expect(refuseResume(loadSavedRun(store)!)).toBe('engine-version');
    expect(resumableRunSummary()).toBeNull();
  });

  it('refuses a save whose content fingerprint no longer matches today\'s dungeon', () => {
    put({ ...freshSave(), contentHash: 0 });
    expect(savedRunSummary(store)).not.toBeNull();
    expect(refuseResume(loadSavedRun(store)!)).toBe('content');
    expect(resumableRunSummary()).toBeNull();
  });

  it('checks against a config rebuilt from TODAY\'s content, not the save\'s own claim', () => {
    // The whole point of `contentHash`: a save cannot vouch for itself. Proven by taking a
    // save that IS resumable and showing the hash it is compared against is the one this
    // build derives right now, for the save's own seed and loadout.
    const save = freshSave();
    put(save);
    const todayConfig = buildDungeonRunConfig({
      seed: save.seed, coop: false,
      localSeat: { skinId: save.skinId, loadout: save.loadout }, allySkinId: '',
    });
    expect(save.contentHash).toBe(contentHashOf(todayConfig));
    expect(resumableRunSummary()).not.toBeNull();
  });
});

describe('the memo', () => {
  it('re-answers for a DIFFERENT save rather than repeating the last verdict', () => {
    // The failure a cache-by-nothing would have: one lookup poisons every later one. Ordered
    // refusal -> ok on purpose, because the sticky direction that matters is a "no" that
    // outlives the save it was about and hides a run the player could have continued.
    put({ ...freshSave(), engineVersion: ENGINE_VERSION - 1 });
    expect(resumableRunSummary()).toBeNull();

    resetRunSaveCacheForTests();
    put(freshSave());
    expect(resumableRunSummary()).not.toBeNull();
  });

  it('answers the same save identically however many times it is asked', () => {
    put(freshSave());
    const first = resumableRunSummary();
    expect(resumableRunSummary()).toEqual(first);
    expect(resumableRunSummary()).toEqual(first);
  });
});

describe('what it deliberately does NOT do', () => {
  it('leaves a non-resumable save in storage rather than clearing it from a render path', () => {
    put({ ...freshSave(), engineVersion: ENGINE_VERSION - 1 });
    resumableRunSummary();
    resumableRunSummary();
    // Still there: this is a read, and a provider that mutates storage while a screen lays
    // itself out turns a re-render into a side effect. `RunLifecycle` owns the clearing.
    expect(store.load()).not.toBeNull();
  });
});
