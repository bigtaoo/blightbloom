/**
 * THE SHIPPER NEVER BREAKS ITS CALLER, AND IS NEVER SILENT ABOUT ITS OWN FAILURE
 * (src/lokiPush.ts).
 *
 * Both halves matter and they pull in opposite directions, which is why this file exists.
 * A log shipper that can reject, throw or hang would turn a dead log store into a broken
 * game; a log shipper that swallows everything is how funny ran for months with an empty
 * Grafana that looked exactly like a quiet week.
 */
import { describe, it, expect, vi } from 'vitest';
import { lokiPushUrl, pushToLoki } from '../src/lokiPush';
import { createLogger, type Level } from '../src/log';

function capture(): { lines: Array<{ level: Level; line: string }>; log: ReturnType<typeof createLogger> } {
  const lines: Array<{ level: Level; line: string }> = [];
  return { lines, log: createLogger('t', { level: 'debug', sink: { write: (l, line) => lines.push({ level: l, line }) } }) };
}

const ok = (): Response => new Response('', { status: 204 });

describe('lokiPushUrl', () => {
  it('reads BB_LOKI_PUSH_URL, and treats blank as unset', () => {
    expect(lokiPushUrl({ BB_LOKI_PUSH_URL: 'http://x/push' } as NodeJS.ProcessEnv)).toBe('http://x/push');
    expect(lokiPushUrl({ BB_LOKI_PUSH_URL: '   ' } as NodeJS.ProcessEnv)).toBeNull();
    expect(lokiPushUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('the push itself', () => {
  it('POSTs JSON to the configured URL', async () => {
    const { log } = capture();
    const fetchImpl = vi.fn(async () => ok());
    await pushToLoki({ url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch }, { streams: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://loki/push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ streams: [] });
  });

  it('carries an abort signal, so a hung store cannot hold a socket forever', async () => {
    // Nothing awaits this call, so a request with no timeout leaks a socket per batch for as
    // long as the store stays unresponsive.
    const { log } = capture();
    const fetchImpl = vi.fn(async () => ok());
    await pushToLoki({ url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch }, {});
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('RESOLVES rather than rejecting when fetch throws', async () => {
    // Every call site is `void pushToLoki(...)`. A rejection there is an unhandled rejection,
    // which on Node 22 ends the process — a dead log store would take the server with it.
    const { log } = capture();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      pushToLoki({ url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch }, {}),
    ).resolves.toBeUndefined();
  });

  it('resolves on a non-2xx too', async () => {
    const { log } = capture();
    const fetchImpl = vi.fn(async () => new Response('too old', { status: 400 }));
    await expect(
      pushToLoki({ url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch }, {}),
    ).resolves.toBeUndefined();
  });
});

describe('it complains, once', () => {
  it('warns the FIRST time the URL is unset, naming the variable', async () => {
    const { lines, log } = capture();
    const deps = { url: null, log, complainEveryMs: 60_000, now: () => 0 };
    await pushToLoki(deps, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    // The variable NAME is the whole value of the line: without it, "logs are being
    // dropped" is a sentence nobody can act on.
    expect(lines[0]!.line).toContain('BB_LOKI_PUSH_URL');
  });

  it('does NOT warn again inside the window — one line per client report is its own outage', async () => {
    const { lines, log } = capture();
    const deps = { url: null, log, complainEveryMs: 60_000, now: () => 0 };
    for (let i = 0; i < 50; i += 1) await pushToLoki(deps, {});
    expect(lines).toHaveLength(1);
  });

  it('warns again once the window has passed, so a lasting outage is not forgotten', async () => {
    const { lines, log } = capture();
    let t = 0;
    const deps = { url: null, log, complainEveryMs: 60_000, now: () => t };
    await pushToLoki(deps, {});
    t = 59_999;
    await pushToLoki(deps, {});
    expect(lines).toHaveLength(1);
    t = 60_000;
    await pushToLoki(deps, {});
    expect(lines).toHaveLength(2);
  });

  it('reports a REFUSAL and an UNREACHABLE store as different complaints', async () => {
    // They share a window per KIND, not one window overall — otherwise a store that first
    // refuses and then dies reports only the first, and the reason on screen is stale.
    const { lines, log } = capture();
    let mode: 'refuse' | 'throw' = 'refuse';
    const fetchImpl = vi.fn(async () => {
      if (mode === 'throw') throw new Error('ECONNREFUSED');
      return new Response('entry too far behind', { status: 400 });
    });
    const deps = { url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch, complainEveryMs: 60_000, now: () => 0 };
    await pushToLoki(deps, {});
    mode = 'throw';
    await pushToLoki(deps, {});
    expect(lines).toHaveLength(2);
    // Loki's 400 body says WHICH constraint was violated, which is the difference between
    // "rejected" and "rejected because the entry was too old" — so it is kept, bounded.
    expect(lines[0]!.line).toContain('status=400');
    expect(lines[0]!.line).toContain('entry too far behind');
    expect(lines[1]!.line).toContain('ECONNREFUSED');
  });

  it('bounds the refusal detail rather than logging a whole error page', async () => {
    const { lines, log } = capture();
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(10_000), { status: 500 }));
    await pushToLoki(
      { url: 'http://loki/push', log, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 },
      {},
    );
    expect(lines[0]!.line.length).toBeLessThan(600);
  });

  it('keeps its complaint state PER shipper, so one does not silence another', async () => {
    // The complaint window is keyed on the deps object rather than being module-global: two
    // services in one test process (or one process, later) must each get their first warning.
    const a = capture();
    const b = capture();
    await pushToLoki({ url: null, log: a.log, now: () => 0 }, {});
    await pushToLoki({ url: null, log: b.log, now: () => 0 }, {});
    expect(a.lines).toHaveLength(1);
    expect(b.lines).toHaveLength(1);
  });
});
