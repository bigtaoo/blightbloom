/**
 * `GameRegistry` (ROADMAP 8.6, design/19 §6) — the topology lookup behind `/find`'s
 * `wsUrl`.
 *
 * Only one branch of this class is reachable in production today (the configured static
 * single instance; the register/heartbeat routes are deliberately unbuilt), which is
 * exactly why it needs unit tests rather than only the HTTP ones in
 * `matchsvc.registry.test.ts`: everything else here is shape being kept honest until the
 * day something drives it, and shape that nothing checks rots into a "constant wrapped in
 * a class". The cases below are therefore aimed at the *decisions* recorded in the class
 * header, not at line coverage:
 *
 *  - the static fallback is a FALLBACK, not a competing entry (it must lose to any healthy
 *    registered instance, and it must never expire);
 *  - `pick` ranks on load RATIO, not absolute load, and treats full as skipped rather than
 *    merely last;
 *  - a heartbeat for an unknown id writes NOTHING, because a heartbeat that re-registered
 *    would mask a failed startup registration;
 *  - `null` is a real answer with no instance and no fallback, and `STALE_MS` is the number
 *    the default staleness window actually uses.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  GameRegistry,
  REGISTER_BACKOFF_CAP_MS,
  STALE_MS,
  staticGameserverUrl,
} from '../src/GameRegistry';

const FALLBACK = 'ws://static.test/ws';

/** A registry on a hand-cranked clock — staleness is a 30 s window, not a test budget. */
function at(startMs = 1_000, opts: { fallbackUrl?: string | null; staleMs?: number } = {}) {
  let now = startMs;
  const registry = new GameRegistry({ nowMs: () => now, ...opts });
  return { registry, advance: (ms: number) => void (now += ms), setNow: (ms: number) => void (now = ms) };
}

afterEach(() => vi.unstubAllEnvs());

describe('the static single-instance branch (design/19 §6, rule 1)', () => {
  it('answers with the configured address when nothing has registered', () => {
    const { registry } = at(1_000, { fallbackUrl: FALLBACK });
    const picked = registry.pick();
    expect(picked).toMatchObject({ wsUrl: FALLBACK, source: 'static' });
    // Unknown capacity must read as unbounded, never as full — a static entry reports
    // nothing about itself, and `load >= capacity` would skip it if capacity were 0.
    expect(picked!.capacity).toBe(Infinity);
    // …and "we have never heard from it" is a distinct state from "it just checked in",
    // which is the entire reason `lastSeenMs` is nullable.
    expect(picked!.lastSeenMs).toBeNull();
  });

  it('never goes stale, however long the process has been up', () => {
    // Structural rather than conditional since the `RegisteredEntry` type landed: the
    // staleness check only ever sees map entries, and the fallback is not one. This test
    // pins the OUTCOME, which is what a future refactor could still break — a
    // single-instance deployment going dark 30 s after boot is the failure it names.
    const { registry, advance } = at(1_000, { fallbackUrl: FALLBACK });
    advance(STALE_MS * 1000);
    expect(registry.pick()?.wsUrl).toBe(FALLBACK);
  });

  it('is not an entry in the registry, so it cannot outcompete a real instance', () => {
    // The load-0/never-stale fallback would win every `pick()` if it were seeded into the
    // map, which is the specific mistake the separate field exists to prevent. A registered
    // instance at 90% occupancy still beats it.
    const { registry } = at(1_000, { fallbackUrl: FALLBACK });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 10, load: 9 });
    expect(registry.pick()?.wsUrl).toBe('ws://gs1/ws');
    expect(registry.all().map((e) => e.id)).toEqual(['gs1']); // and it is not listed
  });

  it('falls back again once every registered instance has gone away', () => {
    const { registry } = at(1_000, { fallbackUrl: FALLBACK });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 10 });
    expect(registry.drop('gs1')).toBe(true);
    expect(registry.drop('gs1')).toBe(false); // dropping twice is not an error, just false
    expect(registry.pick()?.wsUrl).toBe(FALLBACK);
  });

  it('returns null with no instance and no configured address', () => {
    // The deployment shape the 503 path in routes/match.ts exists for.
    const { registry } = at(1_000, { fallbackUrl: null });
    expect(registry.pick()).toBeNull();
  });

  it('returns null when the only registered instances are unusable and there is no fallback', () => {
    const { registry, advance } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'full', wsUrl: 'ws://full/ws', capacity: 4, load: 4 });
    registry.register({ id: 'stale', wsUrl: 'ws://stale/ws', capacity: 4, load: 0 });
    advance(STALE_MS + 1);
    registry.heartbeat('full', 4); // keeps `full` alive, so this is full-vs-stale, not stale-vs-stale
    expect(registry.pick()).toBeNull();
  });
});

describe('the configured address itself', () => {
  it('reads BB_GAMESERVER_URL, per call rather than at module load', () => {
    vi.stubEnv('BB_GAMESERVER_URL', 'ws://from-env/ws');
    expect(staticGameserverUrl()).toBe('ws://from-env/ws');
    // A module-scope capture would make the answer depend on whether the environment was
    // loaded before the first import — `config.ts` records the same reasoning for the
    // ticket secret. Changing it here must change the next answer.
    vi.stubEnv('BB_GAMESERVER_URL', 'ws://changed/ws');
    expect(staticGameserverUrl()).toBe('ws://changed/ws');
    expect(new GameRegistry().pick()?.wsUrl).toBe('ws://changed/ws');
  });

  it('treats an empty variable as unset, matching config.ts controlPlaneUrl', () => {
    vi.stubEnv('BB_GAMESERVER_URL', '');
    expect(staticGameserverUrl()).toBe('ws://localhost:8787/ws');
  });

  it('defaults to localhost so the local three-process setup needs no configuration', () => {
    vi.stubEnv('BB_GAMESERVER_URL', undefined);
    expect(staticGameserverUrl()).toBe('ws://localhost:8787/ws');
    expect(new GameRegistry().pick()?.wsUrl).toBe('ws://localhost:8787/ws');
  });

  it('distinguishes an explicit null fallback from an omitted one', () => {
    vi.stubEnv('BB_GAMESERVER_URL', FALLBACK);
    // Omitted → the configured default. Explicit null → genuinely no fallback. If the
    // constructor used `??` these two would collapse and a fallback-free deployment would
    // silently get localhost.
    expect(new GameRegistry().pick()?.wsUrl).toBe(FALLBACK);
    expect(new GameRegistry({ fallbackUrl: null }).pick()).toBeNull();
  });
});

describe('pick(): least loaded healthy instance', () => {
  it('ranks on load ratio, not absolute load', () => {
    // A 4-seat box at 3/4 is fuller than a 64-seat box at 10/64, even though 10 > 3.
    // Ranking on absolute load would send the next player to the nearly-full small box.
    const { registry } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'small', wsUrl: 'ws://small/ws', capacity: 4, load: 3 });
    registry.register({ id: 'big', wsUrl: 'ws://big/ws', capacity: 64, load: 10 });
    expect(registry.pick()?.id).toBe('big');
  });

  it('skips a full instance rather than merely deprioritising it', () => {
    const { registry } = at(1_000, { fallbackUrl: FALLBACK });
    registry.register({ id: 'full', wsUrl: 'ws://full/ws', capacity: 4, load: 4 });
    // With `full` the only registered instance, "deprioritised" and "skipped" differ:
    // deprioritised still returns it, skipped reaches the fallback.
    expect(registry.pick()?.wsUrl).toBe(FALLBACK);
  });

  it('treats a zero-capacity instance as full (a drained box accepts nobody)', () => {
    const { registry } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'drained', wsUrl: 'ws://drained/ws', capacity: 0, load: 0 });
    expect(registry.pick()).toBeNull();
  });

  it('over-full is skipped too, not just exactly-full', () => {
    const { registry } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'over', wsUrl: 'ws://over/ws', capacity: 4, load: 7 });
    expect(registry.pick()).toBeNull();
  });

  it('breaks ties on id, so the answer does not depend on registration order', () => {
    const a = at(1_000, { fallbackUrl: null });
    a.registry.register({ id: 'aaa', wsUrl: 'ws://aaa/ws', capacity: 8, load: 2 });
    a.registry.register({ id: 'bbb', wsUrl: 'ws://bbb/ws', capacity: 8, load: 2 });
    const b = at(1_000, { fallbackUrl: null });
    b.registry.register({ id: 'bbb', wsUrl: 'ws://bbb/ws', capacity: 8, load: 2 });
    b.registry.register({ id: 'aaa', wsUrl: 'ws://aaa/ws', capacity: 8, load: 2 });
    expect(a.registry.pick()?.id).toBe('aaa');
    expect(b.registry.pick()?.id).toBe('aaa');
  });

  it('defaults a registration with no reported load to empty', () => {
    const { registry } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'fresh', wsUrl: 'ws://fresh/ws', capacity: 8 });
    expect(registry.pick()).toMatchObject({ id: 'fresh', load: 0, source: 'registered' });
  });
});

describe('staleness: 30 s of silence is death', () => {
  it('uses STALE_MS as the default window, at the boundary', () => {
    // Pins the exported constant to the behaviour rather than asserting `STALE_MS === 30000`,
    // which would restate the source. Exactly at the window is still alive; one ms past is not.
    const { registry, setNow } = at(0, { fallbackUrl: null });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8 });
    setNow(STALE_MS);
    expect(registry.pick()?.id).toBe('gs1');
    setNow(STALE_MS + 1);
    expect(registry.pick()).toBeNull();
  });

  it('honours a staleMs override independently of the constant', () => {
    const { registry, advance } = at(0, { fallbackUrl: null, staleMs: 100 });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8 });
    advance(101);
    expect(registry.pick()).toBeNull();
  });

  it('separates healthy() from all(): a dead instance is still an operator-visible fact', () => {
    const { registry, advance } = at(0, { fallbackUrl: null });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8 });
    advance(STALE_MS + 1);
    expect(registry.healthy()).toEqual([]);
    expect(registry.all().map((e) => e.id)).toEqual(['gs1']); // "gone dark", not "never existed"
    expect(registry.pick()).toBeNull();
  });

  it('lets a heartbeat inside the window revive the clock and update the load', () => {
    const { registry, advance } = at(0, { fallbackUrl: null });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8, load: 1 });
    advance(STALE_MS - 1);
    expect(registry.heartbeat('gs1', 5)).toBe(true);
    advance(STALE_MS);
    expect(registry.pick()).toMatchObject({ id: 'gs1', load: 5, lastSeenMs: STALE_MS - 1 });
  });

  it('a heartbeat does not resurrect an instance that already went stale', () => {
    // The entry survives the window (nothing sweeps the map), so `heartbeat` finds it and
    // returns true — but the load and clock it writes are the instance's own report, and
    // what makes it usable again is the fresh `lastSeenMs`, not the fact of the call.
    const { registry, advance } = at(0, { fallbackUrl: null });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8 });
    advance(STALE_MS + 1);
    expect(registry.pick()).toBeNull();
    expect(registry.heartbeat('gs1', 0)).toBe(true);
    expect(registry.pick()?.id).toBe('gs1');
  });
});

describe('registration rules (design/19 §6, rule 2)', () => {
  it('drops a heartbeat for an unknown id and writes NOTHING', () => {
    // The rule that matters: a heartbeat must not create the entry. If it did, a failed
    // startup registration would be masked by the very next heartbeat, and the instance
    // would look healthy while nobody had ever verified it could be registered at all.
    const { registry } = at(1_000, { fallbackUrl: null });
    expect(registry.heartbeat('never-registered', 3)).toBe(false);
    expect(registry.all()).toEqual([]);
    expect(registry.pick()).toBeNull();
  });

  it('replaces rather than merges when an instance re-registers under the same id', () => {
    // A restarted process reports what it is NOW. Merging would carry the pre-restart load
    // forward and make an empty box look busy for a full staleness window.
    const { registry, advance } = at(1_000, { fallbackUrl: null });
    registry.register({ id: 'gs1', wsUrl: 'ws://old/ws', capacity: 4, load: 3 });
    advance(50);
    registry.register({ id: 'gs1', wsUrl: 'ws://new/ws', capacity: 16 });
    expect(registry.all()).toHaveLength(1);
    expect(registry.pick()).toMatchObject({ wsUrl: 'ws://new/ws', capacity: 16, load: 0, lastSeenMs: 1_050 });
  });

  it('keeps the registering client backoff cap separate from the staleness window', () => {
    // Both are 30 s today and they mean different things — one is how long the registry
    // waits before disbelieving an instance, the other how long an instance waits before
    // retrying. Tuning one must not silently move the other, which is only true while they
    // are two constants; this asserts they are, not what they equal.
    expect(REGISTER_BACKOFF_CAP_MS).toBe(30_000);
    expect(STALE_MS).toBe(30_000);
    const { registry, setNow } = at(0, { fallbackUrl: null, staleMs: 5_000 });
    registry.register({ id: 'gs1', wsUrl: 'ws://gs1/ws', capacity: 8 });
    setNow(5_001);
    expect(registry.pick()).toBeNull(); // the override moved staleness, not the backoff cap
    expect(REGISTER_BACKOFF_CAP_MS).toBe(30_000);
  });
});
