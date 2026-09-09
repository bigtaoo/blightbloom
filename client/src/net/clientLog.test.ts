/**
 * THE BROWSER'S RING BUFFER AND ITS FLUSH (net/clientLog.ts).
 *
 * Two properties carry almost all the value here, and both are invisible in a passing
 * game:
 *
 *  - **The request that leaves is one CORS can actually deliver.** `credentials: 'omit'`
 *    is not a style choice: matchsvc answers `Access-Control-Allow-Origin: *`, which by
 *    specification cannot be combined with credentials, and the client is on a different
 *    origin from the server. A credentialed send is blocked outright and the crash report
 *    silently never lands — which is exactly what `navigator.sendBeacon` would do here, and
 *    why it is not used. Nothing in the game goes red when this is wrong.
 *  - **Nothing on this path can affect the player.** A rejected fetch, a thrown
 *    `JSON.stringify`, a server that never answers — all of it stays inside `flush()`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClientLogger, RING_CAPACITY, FLUSH_INTERVAL_MS } from './clientLog';
import { resetHostKind, setHostKind } from '../platform/hostKind';

afterEach(() => resetHostKind());

interface Sent {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function harness(over: Record<string, unknown> = {}): {
  sent: Sent[];
  logger: ReturnType<typeof createClientLogger>;
  tick: () => void;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) as Record<string, unknown> });
    return new Response('{"ok":true}', { status: 200 });
  });
  const timers: Array<() => void> = [];
  const logger = createClientLogger({
    baseUrl: 'https://bb.example',
    sessionId: 'sess-fixed',
    now: () => 1_800_000_000_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    setIntervalImpl: (fn) => {
      timers.push(fn);
      return 1;
    },
    clearIntervalImpl: () => {},
    ...over,
  });
  return { sent, logger, fetchImpl, tick: () => timers.forEach((f) => f()) };
}

describe('the ring buffer', () => {
  it('records every level, regardless of what will be SENT', () => {
    // The lines leading up to a failure are the ones worth having, and at the time they are
    // recorded nothing knows a failure is coming.
    const { logger } = harness({ minLevel: 'error' });
    logger.log('debug', 'render', 'a');
    logger.log('info', 'net', 'b');
    expect(logger.snapshot().map((e) => e.msg)).toEqual(['a', 'b']);
  });

  it('drops the OLDEST once full, keeping exactly the capacity', () => {
    const { logger } = harness();
    for (let i = 0; i < RING_CAPACITY + 25; i += 1) logger.log('info', 't', `m${i}`);
    const snap = logger.snapshot();
    expect(snap).toHaveLength(RING_CAPACITY);
    expect(snap[0]!.msg).toBe('m25');
    expect(snap[snap.length - 1]!.msg).toBe(`m${RING_CAPACITY + 24}`);
  });

  it('trims a message and a tag to the caps the server would apply anyway', () => {
    const { logger } = harness();
    logger.log('error', 'x'.repeat(200), 'y'.repeat(5000));
    expect(logger.snapshot()[0]!.msg).toHaveLength(1000);
    expect(logger.snapshot()[0]!.tag).toHaveLength(48);
  });
});

describe('the request that leaves', () => {
  it('omits credentials and sets keepalive — the pair that makes an exit flush land', () => {
    const { logger, sent } = harness();
    logger.log('error', 'boot', 'boom');
    void logger.flush();
    return vi.waitFor(() => {
      expect(sent).toHaveLength(1);
      expect(sent[0]!.init.credentials).toBe('omit');
      expect(sent[0]!.init.keepalive).toBe(true);
    });
  });

  it('POSTs to /client/log under the given base URL', async () => {
    const { logger, sent } = harness();
    logger.log('error', 'boot', 'boom');
    await logger.flush();
    expect(sent[0]!.url).toBe('https://bb.example/client/log');
    expect(sent[0]!.init.method).toBe('POST');
  });

  it('labels the batch with the CURRENT host kind, not the default', async () => {
    // The portal entry declares its host before installing the logger for exactly this
    // reason: a batch labelled `web` from a CrazyGames build attributes a portal-only
    // failure to the wrong build target.
    setHostKind('crazygames');
    const { logger, sent } = harness();
    logger.log('error', 'boot', 'boom');
    await logger.flush();
    expect(sent[0]!.body.host).toBe('crazygames');
  });

  it('sends the session id, the version and the client clock', async () => {
    const { logger, sent } = harness({ version: () => 'abc123' });
    logger.log('error', 'boot', 'boom');
    await logger.flush();
    expect(sent[0]!.body).toMatchObject({ session: 'sess-fixed', ver: 'abc123', now: 1_800_000_000_000 });
  });

  it('sends `unknown` rather than omitting a version that cannot be known', async () => {
    const { logger, sent } = harness();
    logger.log('error', 'boot', 'boom');
    await logger.flush();
    expect(sent[0]!.body.ver).toBe('unknown');
  });

  it('attaches the bearer token when there is a session, and no header when there is not', async () => {
    const withToken = harness({ token: () => 'tok-1' });
    withToken.logger.log('error', 'b', 'm');
    await withToken.logger.flush();
    expect((withToken.sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');

    const guest = harness();
    guest.logger.log('error', 'b', 'm');
    await guest.logger.flush();
    expect((guest.sent[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('reads the token PER FLUSH, so logging in mid-visit starts attributing', async () => {
    let token: string | null = null;
    const { logger, sent } = harness({ token: () => token });
    logger.log('error', 'b', 'before');
    await logger.flush();
    token = 'tok-later';
    logger.log('error', 'b', 'after');
    await logger.flush();
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((sent[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-later');
  });
});

describe('what gets flushed', () => {
  it('sends only entries at or above minLevel, defaulting to warn', async () => {
    const { logger, sent } = harness();
    logger.log('debug', 't', 'd');
    logger.log('info', 't', 'i');
    logger.log('warn', 't', 'w');
    logger.log('error', 't', 'e');
    await logger.flush();
    expect((sent[0]!.body.entries as Array<{ msg: string }>).map((e) => e.msg)).toEqual(['w', 'e']);
  });

  it('sends nothing at all when there is nothing sendable', async () => {
    const { logger, fetchImpl } = harness();
    logger.log('debug', 't', 'd');
    await logger.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears the buffer so the next flush does not resend', async () => {
    const { logger, sent } = harness();
    logger.log('error', 't', 'once');
    await logger.flush();
    logger.log('error', 't', 'twice');
    await logger.flush();
    expect((sent[0]!.body.entries as Array<{ msg: string }>).map((e) => e.msg)).toEqual(['once']);
    expect((sent[1]!.body.entries as Array<{ msg: string }>).map((e) => e.msg)).toEqual(['twice']);
  });

  it('does not RETRY a failed send — an outage must not become a request storm', async () => {
    // Deliberate: buffering through an outage means a growing buffer and a burst the moment
    // the server comes back, from every client at once.
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    const { logger } = harness({ fetchImpl: failing as unknown as typeof fetch });
    logger.log('error', 't', 'lost');
    await logger.flush();
    expect(logger.snapshot()).toHaveLength(0);
    await logger.flush();
    expect(failing).toHaveBeenCalledOnce();
  });

  it('sends at most one request at a time', async () => {
    // Without the guard, a slow network plus the 30s timer plus a `pagehide` send the same
    // entries several times over.
    let release = (): void => {};
    const slow = vi.fn(
      () =>
        new Promise<Response>((r) => {
          release = () => r(new Response('', { status: 200 }));
        }),
    );
    const { logger } = harness({ fetchImpl: slow as unknown as typeof fetch });
    logger.log('error', 't', 'a');
    const first = logger.flush();
    logger.log('error', 't', 'b');
    await logger.flush();
    expect(slow).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('flushes on the interval, and the interval is 30s', () => {
    const { logger, tick, fetchImpl } = harness();
    logger.log('error', 't', 'm');
    tick();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(FLUSH_INTERVAL_MS).toBe(30_000);
  });
});

describe('failure never reaches the caller', () => {
  it('RESOLVES when the network throws', async () => {
    const { logger } = harness({
      fetchImpl: (async () => {
        throw new Error('DNS');
      }) as unknown as typeof fetch,
    });
    logger.log('error', 't', 'm');
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it('RESOLVES on a server error status', async () => {
    const { logger } = harness({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    logger.log('error', 't', 'm');
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});

describe('the session id', () => {
  it('is generated when not injected, and differs between loggers', () => {
    const a = createClientLogger({ baseUrl: 'x', setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
    const b = createClientLogger({ baseUrl: 'x', setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
    expect(a.session).not.toBe(b.session);
    expect(a.session.length).toBeGreaterThan(8);
  });

  it('falls back to a random string where crypto.randomUUID is missing', () => {
    // Reachable on an older WeChat shell and on an http:// origin. Refusing to log there
    // would cost the logs from precisely the environments that break most.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const logger = createClientLogger({ baseUrl: 'x', setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
      expect(logger.session).toMatch(/^s-/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
