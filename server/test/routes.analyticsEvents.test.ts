/**
 * `POST /client/events`, DRIVEN OVER REAL HTTP (src/routes/telemetry.ts).
 *
 * `analyticsIngest.test.ts` covers the pure validation and `analyticsStore.test.ts` covers
 * the documents. This file covers what only a real request can show:
 *
 *   - **The account id comes from the bearer token, never from the body.** Asserted by
 *     reading the stored document back — the one field that says whose visit this was is
 *     also the one field a client must not be able to write, and a handler-level test that
 *     inspects the parsed batch cannot see the difference.
 *   - **Every outcome is `200 {ok, accepted}`.** A refused batch, a rate-limited request, a
 *     body over the limit and a process with analytics switched off all answer the same
 *     shape with `accepted: 0`. Any 4xx here teaches a client to retry, and a client
 *     retrying a malformed batch retries it forever.
 *   - **Analytics being OFF is a supported state, not a broken one.** With no database the
 *     route still answers, and nothing about the game changes.
 *
 * Two things changed with the MongoDB port. The server is handed a `Db` rather than a file
 * path, so this file no longer needs a scratch directory or the best-effort Windows cleanup
 * that went with it — the harness drops the databases. And the write is AWAITED rather than
 * synchronous, so the `/metrics` case waits for the first rollup cycle to land instead of
 * assuming it finished before `createMatchsvcServer` returned.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from 'mongodb';
import { createMatchsvcServer } from '../src/matchsvc';
import { dailyActiveOf, ensureAnalyticsIndexes, eventsOf } from '../src/analytics/db';
import { CLIENT_EVENTS_BODY_LIMIT, RATE_LIMIT } from '../src/routes/telemetry';
import { freshAccounts, openTestMongo, type MongoTestContext } from './mongoHarness';

const NOW = 1_800_000_000_000;
const servers: Server[] = [];
const contexts: MongoTestContext[] = [];

const silentLog = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child: () => ({}) as never };

interface Harness {
  base: string;
  /** The analytics database the server is writing, so a test can read it back — or null
   *  when this deployment collects nothing. */
  db: Db | null;
  rows: () => Promise<{ name: string; install: string; accountId: string | null; day: string }[]>;
  active: () => Promise<{ day: string; install: string; host: string }[]>;
}

async function start(opts: { analytics?: boolean } = {}): Promise<Harness> {
  let db: Db | null = null;
  if (opts.analytics !== false) {
    const ctx = await openTestMongo();
    contexts.push(ctx);
    db = ctx.db('analytics');
    // The caller's obligation, stated in `MatchsvcServerOptions.analyticsDb`: the cohort
    // collection's exactly-once claim IS its unique index, and nothing in the route can
    // check for it per request.
    await ensureAnalyticsIndexes(db);
  }

  const server = createMatchsvcServer({
    store: await freshAccounts(),
    analyticsDb: db,
    lokiUrl: null,
    log: silentLog,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    db,
    rows: async () =>
      (await eventsOf(db!)
        .find({}, { projection: { _id: 0, name: 1, install: 1, accountId: 1, day: 1 } })
        // `_id` is an ObjectId now, not an autoincrementing integer — it still sorts in
        // creation order, which is all the old `ORDER BY id` ever meant here.
        .sort({ _id: 1 })
        .toArray()) as never,
    active: async () =>
      (await dailyActiveOf(db!)
        .find({}, { projection: { _id: 0, day: 1, install: 1, host: 1 } })
        .sort({ day: 1 })
        .toArray()) as never,
  };
}

const batch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  install: 'i-abc',
  session: 'v-1',
  host: 'web',
  build: '1.2.3',
  locale: 'en',
  sentAt: NOW,
  events: [{ name: 'session_start', at: NOW }],
  ...over,
});

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/client/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Register an account and return its bearer token, through the real routes. */
async function register(base: string, username: string): Promise<string> {
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct horse battery' }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const c of contexts.splice(0)) await c.dispose();
});

describe('POST /client/events', () => {
  it('stores a batch and reports how many documents it accepted', async () => {
    const h = await start();
    const res = await post(
      h.base,
      batch({
        events: [
          { name: 'session_start', at: NOW },
          { name: 'run_end', at: NOW, props: { outcome: 'win', floor: 5 } },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });
    expect((await h.rows()).map((r) => r.name)).toEqual(['session_start', 'run_end']);
  });

  it('records the cohort document that retention is computed from', async () => {
    const h = await start();
    await post(h.base, batch());
    expect(await h.active()).toEqual([{ day: expect.any(String), install: 'i-abc', host: 'web' }]);
  });

  it('stores no account id for a guest', async () => {
    const h = await start();
    await post(h.base, batch());
    expect((await h.rows())[0]!.accountId).toBeNull();
  });

  it('takes the account id from the BEARER TOKEN', async () => {
    const h = await start();
    const token = await register(h.base, 'analytics_user');
    await post(h.base, batch(), { authorization: `Bearer ${token}` });
    const row = (await h.rows())[0]!;
    expect(row.accountId).toBeTruthy();
    expect(row.accountId).not.toBe('i-abc');
  });

  it('IGNORES an account id in the body', async () => {
    // The whole reason attribution is server-side. A body field would let any caller file
    // events against somebody else's account.
    const h = await start();
    await post(h.base, batch({ account_id: 'acct-victim', accountId: 'acct-victim', user_id: 'acct-victim' }));
    expect((await h.rows())[0]!.accountId).toBeNull();
  });

  it('ignores a bearer token that is not a session', async () => {
    const h = await start();
    await post(h.base, batch(), { authorization: 'Bearer not-a-real-token' });
    expect((await h.rows())[0]!.accountId).toBeNull();
  });

  it('answers 200 with accepted: 0 for a body that is not a batch', async () => {
    const h = await start();
    for (const body of ['not json at all', '[]', '{}', JSON.stringify(batch({ install: undefined }))]) {
      const res = await post(h.base, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, accepted: 0 });
    }
    expect(await h.rows()).toHaveLength(0);
  });

  it('drops the events it cannot parse and keeps the rest of the batch', async () => {
    const h = await start();
    const res = await post(
      h.base,
      batch({ events: [{ name: 'session_start', at: NOW }, { name: 'not_an_event', at: NOW }, 'garbage'] }),
    );
    expect(await res.json()).toEqual({ ok: true, accepted: 1 });
  });

  it('refuses a body over the limit without storing half of it', async () => {
    // The overflow tail is dropped, so what reaches JSON.parse is truncated and throws.
    const h = await start();
    const res = await post(h.base, batch({ locale: 'x'.repeat(CLIENT_EVENTS_BODY_LIMIT) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 0 });
    expect(await h.rows()).toHaveLength(0);
  });

  it('rate-limits per IP, and still answers 200', async () => {
    const h = await start();
    let accepted = 0;
    for (let i = 0; i < RATE_LIMIT.requests + 5; i += 1) {
      const res = await post(h.base, batch({ install: `i-${i}` }));
      expect(res.status).toBe(200);
      accepted += ((await res.json()) as { accepted: number }).accepted;
    }
    // The budget is shared with /client/log, so this asserts the cap held rather than an
    // exact figure — the point is that it is BELOW the number of requests made.
    expect(accepted).toBeLessThan(RATE_LIMIT.requests + 5);
    expect(accepted).toBeGreaterThan(0);
  });

  it('answers 200 with accepted: 0 when the WRITE fails', async () => {
    // Reached through a real refusal rather than a stub: a collection validator makes mongod
    // reject the insert inside the route's own transaction. What must not happen is a 500 —
    // a database problem is ours, and the client's only correct behaviour either way is to
    // carry on and drop the batch. It is also the one case that proves the rejected promise
    // is HANDLED: an unhandled one would take the process down instead of answering.
    const h = await start();
    await h.db!.command({ collMod: 'events', validator: { name: { $eq: '__nothing_matches__' } } });
    const res = await post(h.base, batch());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 0 });
    await h.db!.command({ collMod: 'events', validator: {} });
    expect(await h.rows()).toHaveLength(0);
  });

  it('answers a CORS preflight, since the client is on another origin', async () => {
    const h = await start();
    const res = await fetch(`${h.base}/client/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://b.gamestao.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('lets the browser CACHE that preflight, which is what makes the exit flush one trip', async () => {
    // Found in live traffic 2026-09-09: without `access-control-max-age` every flush was
    // preceded by its own OPTIONS. `keepalive` protects a request the page has already
    // started, so an uncached preflight turns the `pagehide` flush into two sequential round
    // trips against an unloading document — losing exactly `session_end`.
    const h = await start();
    const res = await fetch(`${h.base}/client/events`, {
      method: 'OPTIONS',
      headers: { origin: 'https://b.gamestao.com', 'access-control-request-method': 'POST' },
    });
    expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0);
  });
});

describe('POST /client/events with analytics switched off', () => {
  it('still answers, and collects nothing', async () => {
    // No `analyticsDb`. A deployment in this state must serve the game normally — the route
    // exists, answers the shape the client expects, and stores nothing.
    const h = await start({ analytics: false });
    const res = await post(h.base, batch());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 0 });
  });

  it('serves /metrics with no analytics gauges rather than zeroed ones', async () => {
    const h = await start({ analytics: false });
    const text = await (await fetch(`${h.base}/metrics`)).text();
    expect(text).toContain('bb_matchsvc_queue_waiting');
    expect(text).not.toContain('bb_dau');
    expect(text).not.toContain('bb_retention_ratio');
  });
});

describe('/metrics with analytics on', () => {
  it('reports DAU for the last complete day, and no retention it cannot answer', async () => {
    // A fresh database: DAU is a real zero (nobody played yesterday) and retention is
    // genuinely unknown, so one appears and the other must not.
    //
    // Waited for rather than read once: the first rollup cycle is a round trip to the
    // cluster now, so the gauge appears a moment after the server binds. "No gauges yet" is
    // the correct answer during that window (`analytics/job.ts`), which is exactly why this
    // has to poll rather than assume.
    const h = await start();
    await vi.waitFor(async () => {
      const text = await (await fetch(`${h.base}/metrics`)).text();
      expect(text).toContain('bb_dau{host="all"} 0');
      expect(text).not.toContain('bb_retention_ratio');
    });
  });
});
