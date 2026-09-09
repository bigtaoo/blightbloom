/**
 * The poll client (design/21 §4) — and the property the whole phase rests on: **there is no
 * arrangement of failures in which a service ends up on a value nobody configured.**
 *
 * That is a claim about a set of failure modes, so it is tested as one. Every case below is
 * a different way the poll can go wrong — unreachable, 401, 503, HTML instead of JSON, a
 * body missing a name, a value outside its range, a partly-good payload — and every one has
 * to leave the previous values in place. The control is the last describe block: a poll that
 * SUCCEEDS has to actually change something, or the whole file would pass against a client
 * that ignores its own responses.
 *
 * No real network and no real timers: `fetchImpl` is injected (`internalFetch` reads
 * `globalThis.fetch` at call time otherwise) and `poll()` is awaited directly rather than
 * driven through the interval.
 */
import { describe, it, expect, vi } from 'vitest';
import { FLAG_DEFS, FLAG_NAMES, defaultFlags } from '../src/flags/defs';
import {
  FLAG_POLL_INTERVAL_MS,
  INTERNAL_FLAGS_PATH,
  createFlagClient,
  parseFlagsResponse,
} from '../src/flags/client';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';

/** A logger that swallows everything. Not typed `as never` at the declaration, so the cases
 *  below can spread it and override one method — the shape is what those cases assert on. */
function silentLog(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    ...over,
  };
  base.child = () => base;
  return base;
}

const silent = silentLog() as never;

/** A full, valid payload with the named overrides applied. */
function payload(over: Record<string, unknown> = {}): { flags: Record<string, unknown> } {
  return { flags: { ...defaultFlags(), ...over } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchImpl: typeof fetch, log: unknown = silent) {
  return createFlagClient({
    baseUrl: 'http://adminsvc:8790',
    key: 'test-key',
    caller: 'matchsvc',
    log: log as never,
    fetchImpl,
  });
}

describe('before the first poll', () => {
  it('answers every flag from the compiled-in defaults, and reports itself unhealthy', () => {
    // The state a service is in for the first fraction of a second of its life, and the
    // state it stays in forever on a deployment with no console. `healthy()` being false is
    // what lets `/health` say "running on defaults" rather than leaving it to be inferred.
    const client = clientWith(vi.fn() as never);
    for (const name of FLAG_NAMES) expect(client.get(name), name).toBe(FLAG_DEFS[name].default);
    expect(client.healthy()).toBe(false);
  });

  it('polls NOTHING when there is no base URL, and stays on defaults', () => {
    // `BB_ADMINSVC_URL` unset is a complete, supported state — not a misconfiguration — so
    // the client must not even attempt a request. A localhost default would instead produce
    // a refused connection every 60 seconds on every developer machine.
    const fetchImpl = vi.fn();
    const client = createFlagClient({
      baseUrl: null,
      key: undefined,
      caller: 'matchsvc',
      log: silent,
      fetchImpl: fetchImpl as never,
    });
    return client.poll().then((changed) => {
      expect(changed).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(client.get('match.queueTimeoutMs')).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
    });
  });
});

describe('a successful poll — the CONTROL', () => {
  it('replaces the values, reports the change, and goes healthy', () => {
    // Without this case every "keeps its defaults" assertion in this file would also pass
    // against a client that never applies anything.
    const fetchImpl = vi.fn(async () => jsonResponse(payload({ 'match.queueTimeoutMs': 45_000 })));
    const client = clientWith(fetchImpl as never);
    return client.poll().then((changed) => {
      expect(changed).toBe(true);
      expect(client.get('match.queueTimeoutMs')).toBe(45_000);
      expect(client.healthy()).toBe(true);
    });
  });

  it('reports NO change when the values are the same as last time', () => {
    // So a service can log a transition rather than a line a minute.
    const fetchImpl = vi.fn(async () => jsonResponse(payload({ 'match.queueTimeoutMs': 45_000 })));
    const client = clientWith(fetchImpl as never);
    return client
      .poll()
      .then(() => client.poll())
      .then((changed) => expect(changed).toBe(false));
  });

  it('calls the right path and presents the internal key', () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string> });
      return jsonResponse(payload());
    });
    const client = clientWith(fetchImpl as never);
    return client.poll().then(() => {
      expect(seen[0]!.url).toBe(`http://adminsvc:8790${INTERNAL_FLAGS_PATH}`);
      expect(seen[0]!.headers[INTERNAL_KEY_HEADER]).toBe('test-key');
    });
  });

  it('does not double a slash when the base URL has a trailing one', () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(String(url));
      return jsonResponse(payload());
    });
    const client = createFlagClient({
      baseUrl: 'http://adminsvc:8790///',
      key: 'k',
      caller: 'matchsvc',
      log: silent,
      fetchImpl: fetchImpl as never,
    });
    return client.poll().then(() => expect(seen[0]).toBe(`http://adminsvc:8790${INTERNAL_FLAGS_PATH}`));
  });

  it('carries all three value shapes through, including the falsy ones', () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        payload({
          'ads.rewardedOfferEnabled': false,
          'match.pvpBotBackfillDelayMs': 0,
          'ui.maintenanceBanner': '',
        }),
      ),
    );
    const client = clientWith(fetchImpl as never);
    return client.poll().then(() => {
      expect(client.get('ads.rewardedOfferEnabled')).toBe(false);
      expect(client.get('match.pvpBotBackfillDelayMs')).toBe(0);
      expect(client.get('ui.maintenanceBanner')).toBe('');
      // `false`, `0` and `''` are all legitimate and all falsy; a truthiness check anywhere
      // in the parse would have silently substituted the default for each.
      expect(client.healthy()).toBe(true);
    });
  });
});

describe('every way a poll can fail leaves the LAST GOOD values in place', () => {
  /** Applies one good poll, then one bad one, and returns what the client believes. */
  async function afterFailure(bad: () => Promise<Response> | Response): Promise<{ value: number; healthy: boolean }> {
    let phase = 0;
    const fetchImpl = vi.fn(async () => {
      phase += 1;
      return phase === 1 ? jsonResponse(payload({ 'match.queueTimeoutMs': 45_000 })) : bad();
    });
    const client = clientWith(fetchImpl as never);
    await client.poll();
    await client.poll();
    return { value: client.get('match.queueTimeoutMs'), healthy: client.healthy() };
  }

  it('an unreachable peer', async () => {
    expect(
      await afterFailure(() => {
        throw new Error('ECONNREFUSED');
      }),
    ).toEqual({ value: 45_000, healthy: false });
  });

  it('a 401 — the internal key rotated on one side only', async () => {
    expect(await afterFailure(() => jsonResponse({ error: 'unauthorized' }, 401))).toEqual({
      value: 45_000,
      healthy: false,
    });
  });

  it('a 503 — the console has no flag store', async () => {
    expect(await afterFailure(() => jsonResponse({ error: 'no flag store' }, 503))).toEqual({
      value: 45_000,
      healthy: false,
    });
  });

  it('an HTML error page from something in front of it', async () => {
    expect(
      await afterFailure(() => new Response('<html>502 Bad Gateway</html>', { status: 200 })),
    ).toEqual({ value: 45_000, healthy: false });
  });

  it('an empty body with a 200', async () => {
    expect(await afterFailure(() => new Response('', { status: 200 }))).toEqual({
      value: 45_000,
      healthy: false,
    });
  });

  it('a payload MISSING one flag name', async () => {
    const partial = payload();
    delete partial.flags['ui.maintenanceBanner'];
    expect(await afterFailure(() => jsonResponse(partial))).toEqual({ value: 45_000, healthy: false });
  });

  it('a payload with ONE value out of range — the whole poll is refused', async () => {
    // All-or-nothing, deliberately. A partial merge would let a garbled response turn one
    // flag off and leave the rest, which is a state nobody configured and nobody could
    // reproduce — including, in this case, silently reverting `queueTimeoutMs` to its
    // default because a DIFFERENT flag's value was corrupt.
    expect(await afterFailure(() => jsonResponse(payload({ 'match.pvpBotBackfillDelayMs': 1e9 })))).toEqual({
      value: 45_000,
      healthy: false,
    });
  });

  it('recovers on the next good poll', async () => {
    // Self-healing is the whole reason this is a poll and not a push, so it is asserted
    // rather than assumed.
    let phase = 0;
    const fetchImpl = vi.fn(async () => {
      phase += 1;
      if (phase === 1) return jsonResponse({ error: 'nope' }, 500);
      return jsonResponse(payload({ 'match.queueTimeoutMs': 45_000 }));
    });
    const client = clientWith(fetchImpl as never);
    await client.poll();
    expect(client.healthy()).toBe(false);
    await client.poll();
    expect(client.healthy()).toBe(true);
    expect(client.get('match.queueTimeoutMs')).toBe(45_000);
  });
});

describe('the log lines', () => {
  it('warns ONCE on entering the failed state, not once per cycle', async () => {
    // A peer down for an hour would otherwise write sixty identical lines, which is how a
    // log store stops being read.
    const warns: string[] = [];
    const log = silentLog({ warn: (msg: string) => warns.push(msg) });
    let phase = 0;
    const fetchImpl = vi.fn(async () => {
      phase += 1;
      return phase === 1 ? jsonResponse(payload()) : jsonResponse({}, 500);
    });
    const client = clientWith(fetchImpl as never, log);
    await client.poll();
    await client.poll();
    await client.poll();
    await client.poll();
    expect(warns).toHaveLength(1);
  });

  it('does not warn at all when the FIRST poll fails', async () => {
    // A service starting up before the console does is normal, and a WARN on every boot is
    // a WARN people learn to ignore. It has never been healthy, so there is no transition.
    const warns: string[] = [];
    const log = silentLog({ warn: (msg: string) => warns.push(msg) });
    const client = clientWith((async () => jsonResponse({}, 500)) as never, log);
    await client.poll();
    expect(warns).toEqual([]);
  });

  it('logs the values when they CHANGE, and not when they do not', async () => {
    const infos: string[] = [];
    const log = silentLog({ info: (msg: string) => infos.push(msg) });
    const fetchImpl = vi.fn(async () => jsonResponse(payload({ 'match.queueTimeoutMs': 45_000 })));
    const client = clientWith(fetchImpl as never, log);
    await client.poll();
    expect(infos).toContain('flags changed');
    infos.length = 0;
    await client.poll();
    expect(infos).not.toContain('flags changed');
  });
});

describe('start / stop', () => {
  it('polls immediately and then on the interval, and stop() ends it', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(payload()));
      const client = createFlagClient({
        baseUrl: 'http://adminsvc:8790',
        key: 'k',
        caller: 'matchsvc',
        log: silent,
        intervalMs: 1000,
        fetchImpl: fetchImpl as never,
      });
      client.start();
      expect(fetchImpl).toHaveBeenCalledTimes(1); // the immediate one
      vi.advanceTimersByTime(2500);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      client.stop();
      vi.advanceTimersByTime(5000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() twice arms only one interval', async () => {
    // Two intervals would double the request rate for the life of the process, and nothing
    // would look wrong anywhere.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(payload()));
      const client = createFlagClient({
        baseUrl: 'http://adminsvc:8790',
        key: 'k',
        caller: 'matchsvc',
        log: silent,
        intervalMs: 1000,
        fetchImpl: fetchImpl as never,
      });
      client.start();
      client.start();
      vi.advanceTimersByTime(1000);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // one immediate + one tick
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the 60s default when no interval is given', () => {
    // The `opts.intervalMs ?? FLAG_POLL_INTERVAL_MS` arm, which every other case in this
    // file skips by pinning a short interval. A wrong default here would be invisible: the
    // poll would work, just at the wrong rate, forever.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(payload()));
      const client = clientWith(fetchImpl as never);
      client.start();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(FLAG_POLL_INTERVAL_MS - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is safe before start()', () => {
    expect(() => clientWith(vi.fn() as never).stop()).not.toThrow();
  });
});

describe('all()', () => {
  it('returns a snapshot that a caller cannot mutate into the client', () => {
    const client = clientWith(vi.fn() as never);
    const snapshot = client.all();
    (snapshot as Record<string, unknown>)['match.queueTimeoutMs'] = 1;
    expect(client.get('match.queueTimeoutMs')).toBe(FLAG_DEFS['match.queueTimeoutMs'].default);
  });
});

describe('parseFlagsResponse', () => {
  it('accepts a complete payload', () => {
    expect(parseFlagsResponse(payload())).toEqual(defaultFlags());
  });

  it('refuses anything that is not an object with a flags object in it', () => {
    for (const body of [null, undefined, 'string', 42, [], [1, 2], {}, { flags: null }, { flags: [] }, { flags: 'x' }]) {
      expect(parseFlagsResponse(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('refuses a payload carrying an EXTRA name it does not know', () => {
    // Not a rejection of the extra key itself — the loop walks the ALLOWLIST, never the
    // payload's own keys, which is the same rule `analytics/ingest.ts` follows for the same
    // reason: a loop over the caller's keys is a loop whose length the caller chooses.
    const extra = payload();
    (extra.flags as Record<string, unknown>)['billing.devStub'] = true;
    const parsed = parseFlagsResponse(extra);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual([...FLAG_NAMES].sort());
  });

  it('cannot be reached through the prototype chain', () => {
    // `flags` arriving as an object whose `match.queueTimeoutMs` lives on its prototype:
    // `hasOwnProperty` is what makes this a refusal rather than a value from somewhere the
    // sender did not put it.
    const proto = { 'match.queueTimeoutMs': 45_000 };
    const flags = Object.create(proto) as Record<string, unknown>;
    for (const name of FLAG_NAMES) {
      if (name !== 'match.queueTimeoutMs') flags[name] = FLAG_DEFS[name].default;
    }
    expect(parseFlagsResponse({ flags })).toBeNull();
  });
});
