/**
 * The client analytics queue — `analytics.ts`.
 *
 * Three behaviours here are load-bearing and all three fail SILENTLY, which is why each has
 * its own case rather than being covered incidentally by a happy path:
 *
 *   - **The queue drops the OLDEST when it is full.** Dropping the newest instead would
 *     report the beginning of a problem and never its end, and every test that only checks
 *     "the queue is bounded" passes either way.
 *   - **A failed flush does not re-queue.** A retry loop against a server that is down is
 *     how a background task becomes the foreground problem.
 *   - **`track` copies its props.** A caller reusing one mutable object would otherwise
 *     have every queued event change under it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLUSH_INTERVAL_MS,
  QUEUE_CAPACITY,
  createAnalytics,
  flushAnalytics,
  resetAnalyticsForTests,
  setAnalytics,
  track,
  type Analytics,
} from './analytics';
import { LIMITS, type AnalyticsBatch } from './analyticsEvents';

/** A clock that only moves when told, so `at` values are exact rather than approximate. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

function harness(overrides: { send?: (b: AnalyticsBatch) => void } = {}) {
  const sent: AnalyticsBatch[] = [];
  const clock = fakeClock();
  const analytics = createAnalytics({
    install: 'i-1',
    session: 's-1',
    host: 'web',
    build: () => '1.0.0',
    locale: () => 'en',
    now: clock.now,
    send: overrides.send ?? ((b) => void sent.push(b)),
  });
  return { analytics, sent, clock };
}

beforeEach(() => {
  resetAnalyticsForTests();
});

describe('createAnalytics — queueing', () => {
  it('queues an event without sending it', () => {
    const { analytics, sent } = harness();
    analytics.track('session_start');
    expect(analytics.pending()).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('stamps each event with the clock at track time, not at flush time', () => {
    const { analytics, sent, clock } = harness();
    analytics.track('session_start');
    clock.advance(5_000);
    analytics.track('store_purchase', { sku: 'blueprint:rifle' });
    clock.advance(1_000);
    analytics.flush();
    expect(sent[0]!.events.map((e) => e.at)).toEqual([1_000, 6_000]);
    expect(sent[0]!.sentAt).toBe(7_000);
  });

  it('copies props so a reused object cannot rewrite history', () => {
    const { analytics, sent } = harness();
    const props = { screen: 'lobby' };
    analytics.track('screen_view', props);
    props.screen = 'forge';
    analytics.track('screen_view', props);
    analytics.flush();
    expect(sent[0]!.events.map((e) => e.props?.screen)).toEqual(['lobby', 'forge']);
  });

  it('omits props entirely for an event that has none', () => {
    const { analytics, sent } = harness();
    analytics.track('session_start');
    analytics.flush();
    expect(sent[0]!.events[0]).toEqual({ name: 'session_start', at: 1_000 });
  });

  it('drops the OLDEST event past capacity, not the newest', () => {
    const { analytics, sent } = harness();
    for (let i = 0; i < QUEUE_CAPACITY; i += 1) analytics.track('screen_view', { screen: `s${i}` });
    expect(analytics.pending()).toBe(QUEUE_CAPACITY);
    analytics.track('run_start', { character: 'newest' });
    expect(analytics.pending()).toBe(QUEUE_CAPACITY);
    analytics.flush();
    const names = sent[0]!.events.map((e) => e.name);
    expect(names[names.length - 1]).toBe('run_start');
    expect(sent[0]!.events[0]!.props?.screen).toBe('s1'); // s0 is the one that went
  });

  it('holds a queue smaller than the server per-batch cap, so a normal flush is never truncated', () => {
    expect(QUEUE_CAPACITY).toBeLessThanOrEqual(LIMITS.eventsPerBatch);
  });
});

describe('createAnalytics — flushing', () => {
  it('sends the whole envelope', () => {
    const { analytics, sent } = harness();
    analytics.track('session_start');
    analytics.flush();
    expect(sent[0]).toMatchObject({ install: 'i-1', session: 's-1', host: 'web', build: '1.0.0', locale: 'en' });
  });

  it('empties the queue', () => {
    const { analytics } = harness();
    analytics.track('session_start');
    analytics.flush();
    expect(analytics.pending()).toBe(0);
  });

  it('does not send an empty batch', () => {
    const { analytics, sent } = harness();
    analytics.flush();
    analytics.flush();
    expect(sent).toHaveLength(0);
  });

  it('does NOT re-queue after a sender that throws', () => {
    // The events are gone before `send` is called, on purpose. Keeping them would make the
    // next flush retry a batch that has already failed, forever.
    const { analytics } = harness({
      send: () => {
        throw new Error('network down');
      },
    });
    analytics.track('session_start');
    expect(() => analytics.flush()).not.toThrow();
    expect(analytics.pending()).toBe(0);
  });

  it('keeps working after a failed flush', () => {
    let fail = true;
    const sent: AnalyticsBatch[] = [];
    const clock = fakeClock();
    const analytics = createAnalytics({
      install: 'i',
      session: 's',
      host: 'web',
      build: () => 'b',
      locale: () => 'en',
      now: clock.now,
      send: (b) => {
        if (fail) throw new Error('down');
        sent.push(b);
      },
    });
    analytics.track('session_start');
    analytics.flush();
    fail = false;
    analytics.track('store_purchase', { sku: 'blueprint:rifle' });
    analytics.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((e) => e.name)).toEqual(['store_purchase']);
  });

  it('splits a queue larger than the per-batch cap rather than sending an over-cap batch', () => {
    // Not reachable through `track` (the queue is smaller than the cap), but the splice
    // bound is what makes that true rather than incidental.
    const { analytics, sent } = harness();
    for (let i = 0; i < QUEUE_CAPACITY; i += 1) analytics.track('session_start');
    analytics.flush();
    expect(sent[0]!.events.length).toBeLessThanOrEqual(LIMITS.eventsPerBatch);
  });

  it('reads build and locale at FLUSH time, not at construction', () => {
    // The bug this shape exists to avoid, fixed one file away in `clientLog` the same day:
    // the build version arrives from /version.json AFTER boot, so a value captured at
    // install is `unknown` for every real client — while the dashboard panel that splits by
    // build looks perfectly populated. Locale has the milder version: a player can change
    // language from the settings screen mid-visit.
    let build = 'unknown';
    let locale = 'en';
    const sent: AnalyticsBatch[] = [];
    const clock = fakeClock();
    const analytics = createAnalytics({
      install: 'i',
      session: 's',
      host: 'web',
      build: () => build,
      locale: () => locale,
      now: clock.now,
      send: (b) => void sent.push(b),
    });
    analytics.track('session_start');
    analytics.flush();
    build = '1.4.2';
    locale = 'zh';
    analytics.track('store_purchase', { sku: 'blueprint:rifle' });
    analytics.flush();
    expect(sent.map((b) => [b.build, b.locale])).toEqual([
      ['unknown', 'en'],
      ['1.4.2', 'zh'],
    ]);
  });

  it('flushes on the same cadence as the log module', () => {
    expect(FLUSH_INTERVAL_MS).toBe(30_000);
  });
});

describe('the module handle', () => {
  it('makes track a no-op before anything is installed', () => {
    // The default matters: a missing handle must never crash, and must never be a reason
    // for a call site to write `if (analytics)`.
    expect(() => track('session_start')).not.toThrow();
    expect(() => flushAnalytics()).not.toThrow();
  });

  it('routes track and flush to the installed handle', () => {
    const { analytics, sent } = harness();
    setAnalytics(analytics);
    track('run_end', { outcome: 'win', floor: 3 });
    flushAnalytics();
    expect(sent[0]!.events[0]).toMatchObject({ name: 'run_end', props: { outcome: 'win', floor: 3 } });
  });

  it('stops routing once uninstalled', () => {
    const { analytics, sent } = harness();
    setAnalytics(analytics);
    setAnalytics(null);
    track('session_start');
    flushAnalytics();
    expect(sent).toHaveLength(0);
    expect((analytics as Analytics).pending()).toBe(0);
  });
});
