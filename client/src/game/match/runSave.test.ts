/**
 * The save format, its two refusal checks, and the one claim the whole feature rests on:
 * **replaying a saved stream reconstructs the run byte-for-byte** (design/05 "Only the boss
 * floor ends a run", ENGINE_VERSION 61).
 *
 * That last one is the reason this file exists rather than a handful of round-trip
 * assertions. A save holds no state, so "did it work" cannot be checked field by field —
 * either the reconstructed sim is the same sim or the format is worthless, and the only
 * honest way to ask is to hash both (`@dd/engine`'s own `hashState`, the same digest the
 * golden gate and the anti-cheat re-judge compare). A test that only checked the JSON
 * survived a round trip would pass just as happily against a stream that replays into a
 * different world.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createGameEngine, hashState, ENGINE_VERSION, LocalInputSource, Button,
  type EngineConfig, type PlayerCommand,
} from '@dd/engine';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { BRAD_FULL } from '@dd/engine/math/trig';
import { buildDungeonRunConfig } from './offlineConfig';
import {
  checkResumable, contentHashOf, fnv1a, packRunSave, parseRunSave, savableRun, unpackCommands,
  RUN_SAVE_VERSION, type SavedRun,
} from './runSave';

function dungeonConfig(seed = 4242): EngineConfig {
  return buildDungeonRunConfig({
    seed,
    coop: false,
    localSeat: { skinId: 'vanguard', loadout: [] },
    allySkinId: 'skirmisher',
  });
}

/**
 * A varied, deterministic input script — a stick that actually walks, fires, and presses the
 * checkpoint buttons. Varied on purpose: a stream of identical idle commands would round-trip
 * through any format at all, including one that dropped every field but `tick`.
 */
function scriptedCommand(tick: number): PlayerCommand {
  return makeCommand({
    owner: 0,
    tick,
    moveBrad: ((tick * 617) % BRAD_FULL) as Brad,
    moveMag: 128 + (tick % 128),
    buttons: tick % 5 === 0 ? Button.FIRE : (tick % 37 === 0 ? Button.CONFIRM_DESCEND : 0),
    pickupTargetId: tick % 53 === 0 ? 1 : 0,
    cardVote: tick % 37 === 0 ? (tick % 3) + 1 : 0,
  });
}

/** Play `ticks` of a fresh run and hand back everything a save is made of. */
function playRun(config: EngineConfig, ticks: number): { commands: PlayerCommand[]; hash: number; floorIndex: number } {
  const source = new LocalInputSource();
  const engine = createGameEngine(config, source);
  for (let frame = 1; frame <= ticks; frame++) {
    engine.submit(scriptedCommand(frame));
    engine.advance(frame);
  }
  return { commands: source.recorded(), hash: hashState(engine.state), floorIndex: engine.state.floorIndex };
}

describe('a resumed run is the same run — the claim the format rests on', () => {
  it('replaying a saved stream reproduces the exact state the save was taken at', () => {
    const config = dungeonConfig();
    const played = playRun(config, 400);
    const save = packRunSave({
      config, commands: played.commands, ticks: 400, floorIndex: played.floorIndex, score: 17, nowMs: 1,
    });

    // The resume path, exactly as `RunLifecycle.resumeSavedRun` does it: a config rebuilt
    // from the save's own descriptor (NOT the object above — that would prove nothing about
    // the rebuild), a source pre-loaded with the unpacked stream, advance to the saved tick.
    const rebuilt = buildDungeonRunConfig({
      seed: save.seed, coop: false, localSeat: { skinId: save.skinId, loadout: save.loadout }, allySkinId: 'skirmisher',
    });
    const source = new LocalInputSource();
    for (const cmd of unpackCommands(save)) source.submit(cmd);
    const resumed = createGameEngine(rebuilt, source);
    for (let frame = 1; frame <= save.ticks; frame++) resumed.advance(frame);

    expect(resumed.state.tick).toBe(400);
    expect(hashState(resumed.state)).toBe(played.hash);
  });

  it('and keeps being the same run when play CONTINUES past the resume', () => {
    // The half a state-equality check at the save tick cannot see: the resumed engine has to
    // stay in step for the ticks AFTER it, which is what makes the resume a run rather than a
    // freeze-frame. A source that had, say, lost the last command would still match above.
    const config = dungeonConfig(99);
    const long = playRun(config, 500);
    const short = playRun(config, 300);
    const save = packRunSave({
      config, commands: short.commands, ticks: 300, floorIndex: short.floorIndex, score: 0, nowMs: 1,
    });

    const source = new LocalInputSource();
    for (const cmd of unpackCommands(save)) source.submit(cmd);
    const resumed = createGameEngine(config, source);
    for (let frame = 1; frame <= 300; frame++) resumed.advance(frame);
    // ...and now the live builder takes over, submitting the same script it would have.
    for (let frame = 301; frame <= 500; frame++) {
      resumed.submit(scriptedCommand(frame));
      resumed.advance(frame);
    }
    expect(hashState(resumed.state)).toBe(long.hash);
  });

  it('a stream that lost a single command diverges — the control on the two tests above', () => {
    // Without this, both assertions would also pass against an engine that ignored the
    // recording entirely and happened to be deterministic on idle input.
    const config = dungeonConfig(7);
    const played = playRun(config, 250);
    const save = packRunSave({
      config, commands: played.commands, ticks: 250, floorIndex: 0, score: 0, nowMs: 1,
    });
    const damaged: SavedRun = { ...save, commands: save.commands.slice(0, -1) };

    const source = new LocalInputSource();
    for (const cmd of unpackCommands(damaged)) source.submit(cmd);
    const engine = createGameEngine(config, source);
    for (let frame = 1; frame <= 250; frame++) engine.advance(frame);
    expect(hashState(engine.state)).not.toBe(played.hash);
  });
});

describe('the two refusals', () => {
  const config = dungeonConfig();
  const base = (): SavedRun => packRunSave({
    config, commands: [scriptedCommand(1)], ticks: 1, floorIndex: 0, score: 0, nowMs: 5,
  });

  it('accepts a save written by this build against this content', () => {
    expect(checkResumable(base(), config)).toBe(null);
  });

  it('refuses a save from another ENGINE_VERSION', () => {
    // The user-visible half of design/08's "fail loud, never replay garbage": the sim's
    // arithmetic moved, so the same inputs no longer describe the same run.
    expect(checkResumable({ ...base(), engineVersion: ENGINE_VERSION - 1 }, config)).toBe('engine-version');
    expect(checkResumable({ ...base(), engineVersion: ENGINE_VERSION + 1 }, config)).toBe('engine-version');
  });

  it('refuses a save whose dungeon content has changed under it', () => {
    // The hole ENGINE_VERSION does not cover — content is not versioned. An edited floor
    // library replays the same inputs against different geometry, which puts the player
    // somewhere the recording never sent them.
    expect(checkResumable({ ...base(), contentHash: 0 }, config)).toBe('content');
  });

  it('the content fingerprint actually tracks the dungeon, and only the dungeon', () => {
    // Otherwise the check above passes for the wrong reason: a hash over the WHOLE config
    // would also refuse a save whose seed or loadout differ, both of which are re-supplied
    // from the save itself and are not drift at all.
    const other = dungeonConfig(1234);
    expect(contentHashOf(other)).toBe(contentHashOf(config)); // different seed, same content
    const edited: EngineConfig = { ...config, dungeon: { ...config.dungeon!, library: [] } };
    expect(contentHashOf(edited)).not.toBe(contentHashOf(config));
  });
});

describe('savableRun', () => {
  const ok = {
    playing: true, online: false, coop: false, tutorial: false,
    arenaDemo: false, watchingReplay: false, dungeon: true,
  };

  it('admits a single-player offline dungeon run', () => {
    expect(savableRun(ok)).toBe(true);
  });

  // Each exclusion asserted on its own rather than as one "reject everything else" case: a
  // single combined assertion passes when the predicate is `false`, which would silently
  // retire the whole feature.
  it.each([
    ['not playing', { playing: false }],
    ['online', { online: true }],
    ['co-op', { coop: true }],
    ['the tutorial', { tutorial: true }],
    ['the arena harness', { arenaDemo: true }],
    ['replay playback', { watchingReplay: true }],
    ['a flat, non-dungeon level', { dungeon: false }],
  ])('refuses %s', (_why, override) => {
    expect(savableRun({ ...ok, ...override })).toBe(false);
  });
});

describe('parseRunSave — untrusted storage', () => {
  const good = (): unknown => JSON.parse(JSON.stringify(packRunSave({
    config: dungeonConfig(), commands: [scriptedCommand(1), scriptedCommand(2)],
    ticks: 2, floorIndex: 1, score: 9, nowMs: 42,
  })));

  it('round-trips a save it wrote itself', () => {
    const parsed = parseRunSave(good());
    expect(parsed).not.toBeNull();
    expect(parsed!.ticks).toBe(2);
    expect(parsed!.floorIndex).toBe(1);
    expect(parsed!.score).toBe(9);
    expect(parsed!.savedAtMs).toBe(42);
    expect(parsed!.commands).toHaveLength(2);
  });

  it('the unpacked commands are the commands that went in', () => {
    const original = [scriptedCommand(11), scriptedCommand(53)];
    const parsed = parseRunSave(JSON.parse(JSON.stringify(packRunSave({
      config: dungeonConfig(), commands: original, ticks: 53, floorIndex: 0, score: 0, nowMs: 0,
    }))))!;
    expect(unpackCommands(parsed)).toEqual(original);
  });

  it.each([
    ['not an object', 7],
    ['null', null],
    ['an array', []],
    ['a save from a different reader', { ...(good() as object), saveVersion: RUN_SAVE_VERSION + 1 }],
    ['a non-integer engineVersion', { ...(good() as object), engineVersion: 'x' }],
    ['a negative tick count', { ...(good() as object), ticks: -1 }],
    ['a negative floorIndex', { ...(good() as object), floorIndex: -1 }],
    ['a non-string skinId', { ...(good() as object), skinId: 3 }],
    ['a commands field that is not an array', { ...(good() as object), commands: 'nope' }],
    ['a command of the wrong arity', { ...(good() as object), commands: [[1, 0, 0]] }],
    ['a non-integer inside a command', { ...(good() as object), commands: [[1, 0, 0, 0, 0, 0, 'x']] }],
    ['a tick below 1', { ...(good() as object), commands: [[0, 0, 0, 0, 0, 0, 0]] }],
    ['a brad past the table', { ...(good() as object), commands: [[1, 0, BRAD_FULL, 0, 0, 0, 0]] }],
    ['a negative brad', { ...(good() as object), commands: [[1, 0, -1, 0, 0, 0, 0]] }],
    ['a moveMag over 255', { ...(good() as object), commands: [[1, 0, 0, 256, 0, 0, 0]] }],
    ['a negative button field', { ...(good() as object), commands: [[1, 0, 0, 0, -1, 0, 0]] }],
  ])('rejects %s', (_why, value) => {
    expect(parseRunSave(value)).toBeNull();
  });

  it('tolerates a missing score / savedAtMs rather than rejecting the whole save', () => {
    // These two are render metadata, not sim input — a save with either missing replays
    // correctly, so refusing it would throw away a good run over a cosmetic field. Every
    // field the SIM reads is strict (above); these are the deliberate exceptions.
    const { score, savedAtMs, ...rest } = good() as Record<string, unknown>;
    expect(score).toBeDefined();
    expect(savedAtMs).toBeDefined();
    const parsed = parseRunSave(rest);
    expect(parsed).not.toBeNull();
    expect(parsed!.score).toBe(0);
    expect(parsed!.savedAtMs).toBe(0);
  });

  it('drops ill-typed loadout entries instead of carrying them into a run config', () => {
    const parsed = parseRunSave({ ...(good() as object), loadout: ['cryobolt', 5, null, 'saber'] });
    expect(parsed!.loadout).toEqual(['cryobolt', 'saber']);
  });
});

describe('packRunSave', () => {
  it('reads the loadout off the RUN CONFIG, which is where it still exists', () => {
    // `beginRun` spends the account's crafted loadout at run start, so by save time the meta
    // copy is empty and the config is the only surviving record of what the run carries.
    const config = buildDungeonRunConfig({
      seed: 5, coop: false, localSeat: { skinId: 'juggernaut', loadout: ['cryobolt'] }, allySkinId: 'skirmisher',
    });
    const save = packRunSave({ config, commands: [], ticks: 0, floorIndex: 0, score: 0, nowMs: 0 });
    expect(save.skinId).toBe('juggernaut');
    expect(save.loadout).toEqual(['cryobolt']);
    expect(save.engineVersion).toBe(ENGINE_VERSION);
  });

  it('stores the stream positionally — the size budget in the header is real', () => {
    // Not a style assertion. The tuple form is what keeps a long run inside localStorage's
    // ~5 MB origin budget, which the account save shares; a refactor back to keyed objects
    // would quintuple it and start losing saves on quota with nothing else turning red.
    const config = dungeonConfig();
    const commands = Array.from({ length: 200 }, (_, i) => scriptedCommand(i + 1));
    const save = packRunSave({ config, commands, ticks: 200, floorIndex: 0, score: 0, nowMs: 0 });
    expect(Array.isArray(save.commands[0])).toBe(true);
    expect(save.commands[0]).toHaveLength(7);
    expect(JSON.stringify(save.commands).length / commands.length).toBeLessThan(30);
  });
});

describe('fnv1a', () => {
  it('is stable, order-sensitive, and unsigned 32-bit', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('acb'));
    expect(fnv1a('')).toBeGreaterThanOrEqual(0);
    for (const s of ['', 'a', 'the quick brown fox', '一二三']) {
      expect(fnv1a(s)).toBeGreaterThanOrEqual(0);
      expect(fnv1a(s)).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

// `beforeEach` is a no-op guard: nothing in this file touches the process-wide slot (that is
// `runSaveStore.test.ts`), and this makes a future addition that DOES fail loudly here
// instead of leaking into the next case.
beforeEach(() => {
  expect(typeof localStorage).toBe('undefined');
});

/**
 * The absent-field fallbacks, asserted rather than assumed.
 *
 * These are the branches CLAUDE.md names as the column that bites: the LINE runs on every
 * call, so line coverage says nothing about them, and the taken side is the only one a
 * dungeon-config test ever exercises. Each one below is a real config shape — a flat-mode
 * run, a run with no crafted loadout, a hand-edited save — not a hypothetical.
 */
describe('the fallbacks for a field that is simply not there', () => {
  it('fingerprints a config with no dungeon at all, rather than throwing on it', () => {
    // A flat `floors` config, or the tutorial level. `checkResumable` is reached with one
    // whenever a save's own rebuild produces it, and `JSON.stringify(undefined)` is
    // `undefined` — which `fnv1a` would read as the four characters of the word.
    const flat: EngineConfig = { seed: 1, worldW: 800, worldH: 600, waves: [] };
    expect(contentHashOf(flat)).toBe(contentHashOf({ ...flat, seed: 2 }));
    expect(contentHashOf(flat)).not.toBe(contentHashOf(dungeonConfig()));
  });

  it('packs a config carrying neither skinId nor loadout', () => {
    // The shape `buildDungeonRunConfig` produces for a co-op run (they move into `players`)
    // and the shape a bare test fixture has. Empty string / empty list, not `undefined`,
    // because those two go straight back into a rebuilt config on resume.
    const bare: EngineConfig = { seed: 3, worldW: 800, worldH: 600, waves: [] };
    const save = packRunSave({ config: bare, commands: [], ticks: 0, floorIndex: 0, score: 0, nowMs: 0 });
    expect(save.skinId).toBe('');
    expect(save.loadout).toEqual([]);
  });

  it('parses a save whose loadout field is missing entirely', () => {
    const { loadout, ...rest } = JSON.parse(JSON.stringify(packRunSave({
      config: dungeonConfig(), commands: [], ticks: 0, floorIndex: 0, score: 0, nowMs: 0,
    }))) as Record<string, unknown>;
    expect(loadout).toEqual([]); // it was there, as an empty list
    expect(parseRunSave(rest)!.loadout).toEqual([]);
  });
});
