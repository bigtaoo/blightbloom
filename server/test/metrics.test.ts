/**
 * THE EXPOSITION PARSES, AND THE ONE PROXIED /metrics IS NOT PUBLIC
 * (src/metrics.ts, and the routes in matchsvc.ts / index.ts / billsvc/server.ts).
 *
 * Two different risks, both silent:
 *
 *  - A malformed exposition makes Prometheus fail the WHOLE scrape, which presents as
 *    "the target is down" — indistinguishable from the container being dead. The format
 *    rules below (one HELP/TYPE per name, a trailing newline, escaped label values) are
 *    each a way to produce that.
 *  - matchsvc is the one service Caddy proxies wholesale, so its `/metrics` is the one that
 *    would otherwise be a public readout of how many players are queued.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderMetrics, processMetrics, gauge, METRICS_CONTENT_TYPE, type Metric } from '../src/metrics';
import { createMatchsvcServer, matchsvcMetrics } from '../src/matchsvc';
import { createGameserver, gameserverMetrics } from '../src/index';
import { Matchmaker } from '../src/Matchmaker';
import { GameRegistry } from '../src/GameRegistry';
import { createBillsvcServer, billsvcMetrics } from '../src/billsvc/server';
import { openBillingDb } from '../src/billingDb';

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('renderMetrics — the format Prometheus will or will not accept', () => {
  it('emits HELP and TYPE once per NAME, even with several series under it', () => {
    // A repeated declaration makes Prometheus reject the entire scrape as a duplicate —
    // reported as a target that is down, not as a formatting complaint.
    const out = renderMetrics([
      gauge('bb_q', 'waiting', 1, { mode: 'coop' }),
      gauge('bb_q', 'waiting', 2, { mode: 'pvp' }),
    ]);
    expect(out.match(/# HELP bb_q/g)).toHaveLength(1);
    expect(out.match(/# TYPE bb_q/g)).toHaveLength(1);
    expect(out).toContain('bb_q{mode="coop"} 1');
    expect(out).toContain('bb_q{mode="pvp"} 2');
  });

  it('ends with a newline — without it the last sample is silently dropped', () => {
    expect(renderMetrics([gauge('bb_x', 'h', 1)]).endsWith('\n')).toBe(true);
  });

  it('renders an unlabelled metric with no empty brace pair', () => {
    expect(renderMetrics([gauge('bb_x', 'h', 3)])).toContain('\nbb_x 3\n');
  });

  it('escapes a label value that would otherwise end the line or the quote', () => {
    const out = renderMetrics([gauge('bb_x', 'h', 1, { note: 'a"b\\c\nd' })]);
    expect(out).toContain('note="a\\"b\\\\c\\nd"');
    // Exactly three lines: HELP, TYPE, sample. A leaked newline would make four.
    expect(out.trimEnd().split('\n')).toHaveLength(3);
  });

  it('renders a non-finite value as 0 rather than NaN or +Inf', () => {
    // Prometheus accepts both, and no panel can plot either — zero is the honest reading
    // for a gauge whose source failed.
    const out = renderMetrics([gauge('bb_x', 'h', Number.NaN), gauge('bb_y', 'h', Number.POSITIVE_INFINITY)]);
    expect(out).toContain('bb_x 0');
    expect(out).toContain('bb_y 0');
  });
});

describe('processMetrics', () => {
  it('reports uptime, RSS and heap, all labelled with the service', () => {
    const m = processMetrics('matchsvc');
    expect(m.map((x) => x.name)).toEqual([
      'bb_process_uptime_seconds',
      'bb_process_resident_memory_bytes',
      'bb_process_heap_used_bytes',
    ]);
    for (const x of m) expect(x.labels).toEqual({ svc: 'matchsvc' });
  });

  it('derives uptime from an injected start time when given one', () => {
    const m = processMetrics('t', () => 10_000, 4_000);
    expect(m[0]!.value).toBe(6);
  });

  it('reports real, non-zero memory — a gauge that is always 0 measures nothing', () => {
    const m = processMetrics('t');
    expect(m[1]!.value).toBeGreaterThan(0);
    expect(m[2]!.value).toBeGreaterThan(0);
  });
});

describe('the service-specific gauges', () => {
  it('matchsvc reports a queue depth per mode and whether a gameserver exists', () => {
    const matchmaker = new Matchmaker({
      nowMs: () => 0,
      nextSeed: () => 1,
      newRoomId: () => 'r',
      sign: () => 't',
    });
    const empty = matchsvcMetrics(matchmaker, new GameRegistry());
    const byName = (n: string): Metric[] => empty.filter((m) => m.name === n);
    expect(byName('bb_matchsvc_queue_waiting').map((m) => m.labels!.mode)).toEqual(['coop', 'pvp']);
    for (const m of byName('bb_matchsvc_queue_waiting')) expect(m.value).toBe(0);

    // ...and it MOVES. A gauge asserted only at zero is a gauge that could be reading a
    // constant: the enqueue below is what proves it is reading the queue.
    matchmaker.enqueue(2, 'coop');
    const after = matchsvcMetrics(matchmaker, new GameRegistry());
    expect(after.find((m) => m.name === 'bb_matchsvc_queue_waiting' && m.labels!.mode === 'coop')!.value).toBe(1);

    // `bb_matchsvc_gameservers_available`, BOTH ways — and getting the ZERO state needs
    // `fallbackUrl: null`, which is the finding here. A bare `new GameRegistry()` picks its
    // STATIC fallback (`staticGameserverUrl()`, `ws://localhost:8787/ws` when
    // `BB_GAMESERVER_URL` is unset), so it reports 1 with nothing registered. That means an
    // "empty registry" in a test is not the state this gauge exists to report: the zero is
    // what makes every `/find` answer 503 while every container stays green, and it is only
    // reachable with the fallback explicitly switched off.
    expect(after.find((m) => m.name === 'bb_matchsvc_gameservers_available')!.value).toBe(1);
    const none = matchsvcMetrics(matchmaker, new GameRegistry({ fallbackUrl: null }));
    expect(none.find((m) => m.name === 'bb_matchsvc_gameservers_available')!.value).toBe(0);
  });

  it('folds in the analytics rollup gauges when there IS one, and none when there is not', () => {
    // The `rollup?.metrics() ?? []` arm, both ways. `matchsvcMetrics` is called with two
    // arguments everywhere else in this file, so without this the third parameter's present
    // branch is untested — and the absent one is the state of every deployment that has not
    // switched analytics on, which must not add a `bb_dau` gauge of zero. A gauge that reads
    // 0 where the answer is "we do not collect this" is exactly design/21 §2.5's trap.
    const matchmaker = new Matchmaker({
      nowMs: () => 0,
      nextSeed: () => 1,
      newRoomId: () => 'r',
      sign: () => 't',
    });
    const withNone = matchsvcMetrics(matchmaker, new GameRegistry(), null);
    expect(withNone.some((m) => m.name.startsWith('bb_dau'))).toBe(false);

    const rollup = {
      metrics: () => [
        { name: 'bb_dau', help: 'h', type: 'gauge' as const, value: 7, labels: { host: 'all' } },
      ],
      stop: () => {},
    };
    const withRollup = matchsvcMetrics(matchmaker, new GameRegistry(), rollup as never);
    expect(withRollup.find((m) => m.name === 'bb_dau')?.value).toBe(7);
    // Copied rather than referenced, so a scrape cannot hand out the job's own live objects.
    expect(withRollup.find((m) => m.name === 'bb_dau')).not.toBe(rollup.metrics()[0]);
  });

  it('gameserver reports the rooms it is actually holding', () => {
    const { manager } = createGameserver();
    const rooms = (): number => gameserverMetrics(manager).find((m) => m.name === 'bb_gameserver_rooms')!.value;
    expect(rooms()).toBe(0);
    manager.join(
      { send: () => {}, close: () => {} } as never,
      'room-1',
      1,
      2,
    );
    expect(rooms()).toBe(1);
    manager.destroyAll();
  });
});

describe('the /metrics routes', () => {
  it('gameserver serves it on its own port, in the exposition content type', async () => {
    const { server } = createGameserver();
    const base = await listen(server);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(await res.text()).toContain('bb_gameserver_rooms');
  });

  it('matchsvc serves it to a DIRECT request', async () => {
    const base = await listen(createMatchsvcServer({ dbPath: ':memory:' }));
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('bb_matchsvc_queue_waiting');
  });

  it('matchsvc REFUSES a request that came through the proxy', async () => {
    // It is the one service Caddy proxies wholesale, so without this the queue depth and
    // account gauges are readable by anybody on the internet. Caddy stamps
    // `x-forwarded-for` on everything it proxies, which is what "from outside" means here.
    const base = await listen(createMatchsvcServer({ dbPath: ':memory:' }));
    const res = await fetch(`${base}/metrics`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    // A 404, not a 403: a 403 confirms the route is there.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('the refusal is by the header alone, not by its value looking public', async () => {
    // A private-range forwarded-for is still a proxied request — an allowlist of "external
    // looking" addresses would be a gate anybody can walk around.
    const base = await listen(createMatchsvcServer({ dbPath: ':memory:' }));
    const res = await fetch(`${base}/metrics`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(res.status).toBe(404);
  });
});

describe('billsvc — the two gauges nothing else can see', () => {
  it('counts the undelivered purchases in the outbox, and the count MOVES', () => {
    // The number that matters here: a purchase settles in billsvc and is delivered to the
    // control plane asynchronously, so a pending count that stops falling means players have
    // paid for things they do not own — with every container green and nothing failing.
    const db = openBillingDb(':memory:');
    const pending = (): number =>
      billsvcMetrics(db, false).find((m) => m.name === 'bb_billsvc_outbox_pending')!.value;
    expect(pending()).toBe(0);
    db.prepare(
      `INSERT INTO deliveries (id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at)
       VALUES ('d1', 'a1', 'bp.cannon', '[]', 'o1', 'r1', 'pending', 0, 1, NULL)`,
    ).run();
    expect(pending()).toBe(1);
    // ...and a DELIVERED row stops counting, which is the half that makes it a drain gauge
    // rather than a total.
    db.prepare("UPDATE deliveries SET state = 'delivered', delivered_at = 2 WHERE id = 'd1'").run();
    expect(pending()).toBe(0);
    db.close();
  });

  it('reports the dev-stub posture as 0/1, both ways round', () => {
    // "Was the store real on the day of that order?" is a question asked months after the
    // startup log that answered it has rotated away.
    const db = openBillingDb(':memory:');
    const stub = (on: boolean): number =>
      billsvcMetrics(db, on).find((m) => m.name === 'bb_billsvc_dev_stub')!.value;
    expect(stub(true)).toBe(1);
    expect(stub(false)).toBe(0);
    db.close();
  });

  it('serves /metrics on its own port', async () => {
    const { server, db } = createBillsvcServer({ db: openBillingDb(':memory:'), env: { NODE_ENV: 'test' } });
    const base = await listen(server);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('bb_billsvc_outbox_pending');
    expect(body).toContain('bb_billsvc_dev_stub');
    db.close();
  });
});
