/**
 * THE WIRING (net/clientLogInstall.ts).
 *
 * Everything here is about capture and about not breaking anything: that a
 * `console.error` written years before this module existed still reaches the log store,
 * that devtools is unchanged, that a throw escaping into `window.onerror` is recorded, and
 * that installing twice does not double every line.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installClientLog, clientLog, resetClientLog } from './clientLogInstall';

interface FakeTarget {
  handlers: Map<string, Array<(e: unknown) => void>>;
  addEventListener: (type: string, fn: (e: unknown) => void) => void;
  removeEventListener: (type: string, fn: (e: unknown) => void) => void;
  emit: (type: string, e?: unknown) => void;
}

function fakeTarget(): FakeTarget {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  return {
    handlers,
    addEventListener: (type, fn) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== fn)),
    emit: (type, e) => (handlers.get(type) ?? []).forEach((h) => h(e)),
  };
}

type FakeConsole = { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

function install(): { target: FakeTarget; con: FakeConsole; logger: ReturnType<typeof installClientLog> } {
  const target = fakeTarget();
  const con = { error: vi.fn((..._a: unknown[]) => {}), warn: vi.fn((..._a: unknown[]) => {}) };
  const logger = installClientLog({
    baseUrl: 'https://bb.example',
    target,
    consoleImpl: con as unknown as Console,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
  });
  return { target, con, logger };
}

afterEach(() => resetClientLog());

describe('the console wrapper', () => {
  it('captures console.error and console.warn without changing what devtools shows', () => {
    // The call-through is the half that makes this safe to install everywhere: a wrapper
    // that swallowed the original would take away the tool everybody actually debugs with.
    const { con, logger } = install();
    con.error('boom', 42);
    con.warn('careful');
    expect(logger.snapshot().map((e) => ({ level: e.level, msg: e.msg }))).toEqual([
      { level: 'error', msg: 'boom 42' },
      { level: 'warn', msg: 'careful' },
    ]);
  });

  it('captures the ~100 call sites that were never rewritten, which is the point', () => {
    // The reason this is a wrapper and not a codemod: it also catches lines inside PixiJS
    // and inside a platform SDK, and it keeps working for code written later.
    const { con, logger } = install();
    con.error('blightbloom: boot failed', new Error('no WebGL'));
    const line = logger.snapshot()[0]!;
    expect(line.msg).toContain('blightbloom: boot failed');
    expect(line.msg).toContain('Error: no WebGL');
  });

  it('does NOT wrap console.log — frame chatter would fill the buffer and the store', () => {
    const { logger } = install();
    // eslint-disable-next-line no-console
    console.log('a busy per-frame line');
    expect(logger.snapshot()).toHaveLength(0);
  });

  it('formats an Error with its message and the first stack frame', () => {
    const { con, logger } = install();
    con.error(new Error('kaboom'));
    expect(logger.snapshot()[0]!.msg).toContain('Error: kaboom');
  });

  it('survives an argument JSON.stringify cannot handle', () => {
    // A circular object, a Proxy or a DOM node is a normal thing to log, and losing the
    // whole line over it would lose the line that contained the interesting one.
    const { con, logger } = install();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => con.error('ctx', circular)).not.toThrow();
    expect(logger.snapshot()[0]!.msg).toContain('ctx');
  });
});

describe('the global handlers', () => {
  it('records an uncaught error with its location', () => {
    const { target, logger } = install();
    target.emit('error', { message: 'x is not a function', filename: 'main.js', lineno: 12 });
    expect(logger.snapshot()[0]).toMatchObject({ level: 'error', tag: 'uncaught' });
    expect(logger.snapshot()[0]!.msg).toContain('x is not a function @ main.js:12');
  });

  it('records an unhandled rejection — the way a failed boot() used to vanish entirely', () => {
    const { target, logger } = install();
    target.emit('unhandledrejection', { reason: new Error('platform init failed') });
    expect(logger.snapshot()[0]!.tag).toBe('unhandled-rejection');
    expect(logger.snapshot()[0]!.msg).toContain('platform init failed');
  });

  it('tolerates an event with no fields rather than throwing inside a handler', () => {
    // A throw here is an error inside the error handler, which is how one bug becomes two.
    const { target, logger } = install();
    expect(() => target.emit('error', {})).not.toThrow();
    expect(logger.snapshot()[0]!.msg).toContain('error @ ?:0');
  });

  it('flushes on pagehide — the last chance to hear about a crash', () => {
    const { target, logger } = install();
    const flush = vi.spyOn(logger, 'flush');
    target.emit('pagehide');
    expect(flush).toHaveBeenCalled();
  });

  it('does NOT flush on visibilitychange', () => {
    // A backgrounded tab is the normal case on a phone; flushing there would send a batch
    // every time the player takes a call.
    const { target } = install();
    expect(target.handlers.has('visibilitychange')).toBe(false);
  });
});

describe('installing', () => {
  it('is idempotent — a second call returns the first logger and does not double-wrap', () => {
    // Every entry point calls this, and two entry points can be loaded in one test file.
    // Double-wrapping makes each line log twice, and thrice on the third install.
    const { con, logger } = install();
    const again = installClientLog({ baseUrl: 'x', target: fakeTarget(), consoleImpl: con as unknown as Console });
    expect(again).toBe(logger);
    con.error('once');
    expect(logger.snapshot()).toHaveLength(1);
  });

  it('exposes the installed logger, and nothing before an entry point installs one', () => {
    expect(clientLog()).toBeNull();
    const { logger } = install();
    expect(clientLog()).toBe(logger);
  });

  it('restores the original console methods on reset', () => {
    const { con } = install();
    const wrapped = con.error;
    resetClientLog();
    expect(con.error).not.toBe(wrapped);
    con.error('after reset');
    expect(clientLog()).toBeNull();
  });

  it('detaches its listeners on reset', () => {
    const { target } = install();
    expect(target.handlers.get('error')).toHaveLength(1);
    resetClientLog();
    expect(target.handlers.get('error')).toHaveLength(0);
  });

  it('works on a host with no addEventListener at all', () => {
    // The WeChat mini-game shell has no `window`; this module is imported by that entry
    // too, and a missing global must cost the global handlers, not the whole logger.
    const con = { error: vi.fn((..._a: unknown[]) => {}), warn: vi.fn((..._a: unknown[]) => {}) };
    const logger = installClientLog({
      baseUrl: 'x',
      target: {},
      consoleImpl: con as unknown as Console,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
    });
    con.error('still captured');
    expect(logger.snapshot()).toHaveLength(1);
    expect(() => resetClientLog()).not.toThrow();
  });
});
