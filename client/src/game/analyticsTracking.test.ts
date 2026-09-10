/**
 * The derived analytics events — `analyticsTracking.ts`.
 *
 * Everything here is about the two ways derived events go wrong, and both produce plausible
 * numbers rather than errors:
 *
 *   - **Double-counting.** A run that ends in victory must emit ONE `run_end`, from
 *     `RunOutcome`. If this module also called it an abandon, the same run would be both
 *     won and abandoned — a funnel that cannot be repaired afterwards because the raw rows
 *     disagree with each other.
 *   - **Missing a transition.** Pausing must not end a run and un-pausing must not start
 *     one, or every player who opens the pause menu contributes a phantom run.
 *
 * The screen id table gets its own cases because its failure is the quietest of all: an id
 * outside the server's `[a-z0-9_.:-]` charset is dropped at the boundary, so the step simply
 * never appears and the funnel has a hole in it with nothing anywhere going red.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TICK_RATE as ENGINE_TICK_RATE } from '@dd/engine';
import { ID_RE, type AnalyticsBatch, type AnalyticsEventName, type PropValue } from '../net/analyticsEvents';
import { createAnalytics, resetAnalyticsForTests, setAnalytics } from '../net/analytics';
import {
  SCREEN_IDS,
  TICK_RATE,
  reportFrame,
  resetAnalyticsTrackingForTests,
  runSeconds,
  trackedRunFrom,
} from './analyticsTracking';
import type { Phase } from './phase';

/** Every event the module emitted, in order. */
let sent: { name: AnalyticsEventName; props?: Readonly<Record<string, PropValue>> }[];

beforeEach(() => {
  sent = [];
  resetAnalyticsForTests();
  resetAnalyticsTrackingForTests();
  const batches: AnalyticsBatch[] = [];
  const analytics = createAnalytics({
    install: 'i',
    session: 's',
    host: 'web',
    build: () => 'b',
    locale: () => 'en',
    now: () => 0,
    send: (b) => void batches.push(b),
  });
  // Read the queue by flushing into the recorder after each step rather than inspecting it:
  // `pending()` is a count and the assertions here are about names and props.
  setAnalytics({
    track: (name, props) => {
      sent.push({ name, props });
      analytics.track(name, props);
    },
    flush: analytics.flush,
    pending: analytics.pending,
  });
});

const names = (): string[] => sent.map((e) => e.name);
const run = (over: { tick?: number; floorIndex?: number; character?: string } = {}) => ({
  tick: over.tick ?? 0,
  floorIndex: over.floorIndex ?? 0,
  ...(over.character === undefined ? {} : { character: over.character }),
});

describe('screen_view', () => {
  it('emits on the FIRST call, because the phase a visit starts on is a funnel step', () => {
    expect(reportFrame('menu', null)).toBe(true);
    expect(sent).toEqual([{ name: 'screen_view', props: { screen: 'menu' } }]);
  });

  it('emits once per change and nothing on a repeated phase', () => {
    reportFrame('menu', null);
    expect(reportFrame('menu', null)).toBe(false);
    expect(reportFrame('menu', null)).toBe(false);
    reportFrame('forge', null);
    expect(names()).toEqual(['screen_view', 'screen_view']);
  });

  it('reports the mapped id, not the phase name', () => {
    reportFrame('pvpPreview', null);
    reportFrame('store', null);
    expect(sent.map((e) => e.props?.screen)).toEqual(['pvp_preview', 'store']);
  });
});

describe('SCREEN_IDS', () => {
  it('maps every phase', () => {
    // `Record<Phase, string>` makes this a compile error too; asserted at runtime as well
    // because the compile error is what a new phase HITS, and this is what says why.
    const phases: Phase[] = [
      'menu', 'forge', 'pvpPreview', 'matchmaking', 'playing',
      'paused', 'victory', 'defeat', 'settings', 'squad', 'account', 'store',
    ];
    for (const p of phases) expect(SCREEN_IDS[p], p).toBeTruthy();
    expect(Object.keys(SCREEN_IDS).sort()).toEqual([...phases].sort());
  });

  it('every id survives the server id charset', () => {
    // The quiet failure: `pvpPreview` would be refused at the boundary and its funnel step
    // would never appear. This is the assertion that makes the mapping table load-bearing
    // rather than decorative.
    for (const [phase, id] of Object.entries(SCREEN_IDS)) {
      expect(ID_RE.test(id), `${phase} → ${id}`).toBe(true);
    }
  });

  it('maps distinct phases to distinct ids', () => {
    const ids = Object.values(SCREEN_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('run_start', () => {
  it('emits when the run phases are entered from outside', () => {
    reportFrame('forge', null);
    reportFrame('playing', run({ character: 'char_vanguard' }));
    expect(names()).toEqual(['screen_view', 'screen_view', 'run_start']);
    expect(sent[2]!.props).toEqual({ character: 'char_vanguard' });
  });

  it('emits on the first frame when a visit starts inside a run', () => {
    // The `?replay=` path and a resumed online match both land here.
    reportFrame('playing', run());
    expect(names()).toEqual(['screen_view', 'run_start']);
  });

  it('does NOT emit on paused → playing', () => {
    // A resumed run is not a new run. Getting this wrong would add a phantom run for every
    // player who opens the pause menu.
    reportFrame('playing', run());
    reportFrame('paused', run({ tick: 60 }));
    reportFrame('playing', run({ tick: 60 }));
    expect(names().filter((n) => n === 'run_start')).toHaveLength(1);
  });

  it('omits props rather than the event when the character is unknown', () => {
    reportFrame('playing', run());
    expect(sent.find((e) => e.name === 'run_start')?.props).toBeUndefined();
  });

  it('omits props when there is no state at all', () => {
    reportFrame('playing', null);
    expect(sent.find((e) => e.name === 'run_start')?.props).toBeUndefined();
  });
});

describe("run_end — the abandon half only", () => {
  it('emits when a run is left for a non-result screen', () => {
    reportFrame('playing', run({ tick: 90, floorIndex: 2 }));
    reportFrame('menu', run({ tick: 90, floorIndex: 2 }));
    const end = sent.find((e) => e.name === 'run_end');
    expect(end?.props).toEqual({ outcome: 'abandon', floor: 3, duration_s: 3 });
  });

  it('emits BEFORE the screen_view of the screen that replaced the run', () => {
    reportFrame('playing', run());
    sent = [];
    reportFrame('forge', run({ tick: 30 }));
    expect(names()).toEqual(['run_end', 'screen_view']);
  });

  it.each(['victory', 'defeat'] as const)('does NOT emit when the run ends on %s', (phase) => {
    // `RunOutcome` already reported this run with its real outcome. Emitting here as well
    // would make the same run both won and abandoned in the raw rows.
    reportFrame('playing', run({ tick: 300 }));
    sent = [];
    reportFrame(phase, run({ tick: 300 }));
    expect(names()).toEqual(['screen_view']);
  });

  it('does NOT emit on playing → paused', () => {
    reportFrame('playing', run());
    sent = [];
    reportFrame('paused', run({ tick: 10 }));
    expect(names()).toEqual(['screen_view']);
  });

  it('does NOT emit for a phase change that was never in a run', () => {
    reportFrame('menu', null);
    reportFrame('forge', null);
    reportFrame('store', null);
    expect(names().filter((n) => n === 'run_end')).toHaveLength(0);
  });

  it('KEEPS the floor and duration when the run has already been torn down', () => {
    // The bug the live run found: quitting to the forge destroys the engine, so by the frame
    // the phase change is observed `activeState()` is null — and reading the props from the
    // CURRENT state produced `{outcome:'abandon'}` and nothing else, on every abandon there
    // has ever been. The one number the event exists for is *how far did they get*.
    reportFrame('playing', run({ tick: 240, floorIndex: 1 }));
    sent = [];
    reportFrame('forge', null);
    expect(sent.find((e) => e.name === 'run_end')?.props).toEqual({
      outcome: 'abandon',
      floor: 2,
      duration_s: 8,
    });
  });

  it('snapshots on every run frame, not only on the ones that change phase', () => {
    // The snapshot has to be taken before the no-change early return, or it would hold the
    // state from the frame the run STARTED and every abandon would report duration 0.
    reportFrame('playing', run({ tick: 0, floorIndex: 0 }));
    reportFrame('playing', run({ tick: 300, floorIndex: 4 }));
    reportFrame('playing', run({ tick: 600, floorIndex: 4 }));
    sent = [];
    reportFrame('menu', null);
    expect(sent.find((e) => e.name === 'run_end')?.props).toEqual({
      outcome: 'abandon',
      floor: 5,
      duration_s: 20,
    });
  });

  it('reports the abandon without numbers only when there was never a live frame', () => {
    // Not reachable through `GameLoop`, but it is the honest answer for a caller that gets
    // there: an abandoned run whose floor is unknown is still an abandoned run.
    reportFrame('playing', null);
    sent = [];
    reportFrame('menu', null);
    expect(sent.find((e) => e.name === 'run_end')?.props).toEqual({ outcome: 'abandon' });
  });

  it('does not carry a snapshot across two runs', () => {
    // Otherwise a player who finishes one run and abandons the next reports the FIRST run's
    // floor, which is the kind of wrong number that reads as perfectly plausible.
    reportFrame('playing', run({ tick: 900, floorIndex: 8 }));
    reportFrame('victory', run({ tick: 900, floorIndex: 8 }));
    reportFrame('forge', null);
    reportFrame('playing', run({ tick: 30, floorIndex: 0 }));
    sent = [];
    reportFrame('forge', null);
    expect(sent.find((e) => e.name === 'run_end')?.props).toEqual({
      outcome: 'abandon',
      floor: 1,
      duration_s: 1,
    });
  });

  it('reports the abandon exactly once even across several later transitions', () => {
    reportFrame('playing', run({ tick: 60 }));
    reportFrame('menu', null);
    reportFrame('forge', null);
    reportFrame('store', null);
    expect(names().filter((n) => n === 'run_end')).toHaveLength(1);
  });
});

describe('runSeconds', () => {
  it('is whole seconds of simulated time at the engine tick rate', () => {
    expect(runSeconds({ tick: 0, floorIndex: 0 })).toBe(0);
    expect(runSeconds({ tick: TICK_RATE, floorIndex: 0 })).toBe(1);
    expect(runSeconds({ tick: TICK_RATE * 90 + 29, floorIndex: 0 })).toBe(90);
  });

  it('never reports a negative duration', () => {
    expect(runSeconds({ tick: -5, floorIndex: 0 })).toBe(0);
  });

  it('agrees with the ENGINE about the tick rate', () => {
    // The module duplicates the constant to stay free of engine imports, so the check has
    // to live here — and it has to compare against the engine's own value rather than
    // against a literal. Asserting `toBe(30)` would pass on the day the engine changes to
    // 60, and every reported duration would silently double.
    expect(TICK_RATE).toBe(ENGINE_TICK_RATE);
  });
});

describe('trackedRunFrom', () => {
  const state = (players: { atlasKey?: string }[]) => ({ tick: 120, floorIndex: 3, players });

  it('is null when there is no run', () => {
    expect(trackedRunFrom(null, 0)).toBeNull();
  });

  it('reads the character from the LOCAL seat, not the first one', () => {
    // The bug this signature exists to prevent: `players[0]` is right in every solo run and
    // silently wrong in every PvP match, reporting whichever seat the engine listed first as
    // the character this player chose.
    const s = state([{ atlasKey: 'char_vanguard' }, { atlasKey: 'char_skirmisher' }]);
    expect(trackedRunFrom(s, 1)).toEqual({ tick: 120, floorIndex: 3, character: 'char_skirmisher' });
    expect(trackedRunFrom(s, 0)!.character).toBe('char_vanguard');
  });

  it('omits character rather than sending undefined when the seat has no atlas key', () => {
    // The Graphics-placeholder case. `character: undefined` would serialise to a key with a
    // null value on some paths and to nothing on others; leaving it out is one behaviour.
    const out = trackedRunFrom(state([{}]), 0);
    expect(out).toEqual({ tick: 120, floorIndex: 3 });
    expect('character' in out!).toBe(false);
  });

  it('omits character when the seat index is out of range', () => {
    expect(trackedRunFrom(state([{ atlasKey: 'a' }]), 7)).toEqual({ tick: 120, floorIndex: 3 });
  });
});
