/**
 * `runAsEntry`, with the entry check, the guard and the exit code injected.
 *
 * Its whole reason to exist is that the run-as-main block it replaced could not be covered:
 * inside the vitest worker the condition is false by construction. So both arms are driven
 * here; `deploy.bundle.test.ts` proves each SHIPPED bundle reaches the true one, by booting
 * them against a cluster that is not there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createLogger, type Level } from '../src/log';
import { runAsEntry } from '../src/entry';

const SCRIPT = join(process.cwd(), 'dist', 'svc.mjs');
const URL_ = pathToFileURL(SCRIPT).href;

/** Lets the `Promise.resolve().then(start).catch(...)` chain settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness() {
  const lines: { level: Level; line: string }[] = [];
  const log = createLogger('svc', { sink: { write: (level, line) => lines.push({ level, line }) }, level: 'info' });
  const events: string[] = [];
  const exitCodes: number[] = [];
  const deps = {
    argv1: SCRIPT,
    log,
    guard: { on: (event: string) => void events.push(event), exit: () => {} },
    setExitCode: (c: number) => void exitCodes.push(c),
  };
  return { lines, events, exitCodes, deps };
}

describe('runAsEntry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing when the module is not the script node was started on', async () => {
    const { lines, events, exitCodes, deps } = harness();
    const start = vi.fn();
    expect(runAsEntry(URL_, 'svc', start, { ...deps, argv1: join(process.cwd(), 'dist', 'other.mjs') })).toBe(false);
    await settle();
    expect(start).not.toHaveBeenCalled();
    // The guard especially: installed in a module a test merely imported, it would exit the
    // vitest worker on the first stray throw.
    expect(events).toEqual([]);
    expect(lines).toEqual([]);
    expect(exitCodes).toEqual([]);
  });

  it('installs the guard, then boots with no arguments so `main`’s defaults read the environment', async () => {
    const { lines, events, exitCodes, deps } = harness();
    const order: string[] = [];
    const start = vi.fn((...args: unknown[]) => void order.push(`start(${args.length})`));
    deps.guard.on = (event: string) => void order.push(`guard:${event}`);
    expect(runAsEntry(URL_, 'svc', start, deps)).toBe(true);
    await settle();
    expect(order).toEqual(['guard:uncaughtException', 'start(0)']);
    expect(lines).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a boot that rejects is ONE error line through the service logger, and exit code 1', async () => {
    const { lines, exitCodes, deps } = harness();
    runAsEntry(URL_, 'svc', () => Promise.reject(new Error('no cluster')), deps);
    await settle();
    expect(exitCodes).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    expect(lines[0]!.line).toContain('ERROR [svc] failed to start error="no cluster" stack="Error: no cluster');
    expect(lines[0]!.line).not.toMatch(/[\r\n]/);
  });

  it('a boot that throws synchronously takes the same path rather than escaping', async () => {
    const { lines, exitCodes, deps } = harness();
    expect(
      runAsEntry(
        URL_,
        'svc',
        () => {
          throw new Error('bad config');
        },
        deps,
      ),
    ).toBe(true);
    await settle();
    expect(exitCodes).toEqual([1]);
    expect(lines.map((l) => l.line).join('\n')).toContain('failed to start error="bad config"');
  });

  it('a boot that resolves leaves the exit code alone', async () => {
    const { exitCodes, lines, deps } = harness();
    runAsEntry(URL_, 'svc', () => Promise.resolve('up'), deps);
    await settle();
    expect(exitCodes).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('with nothing injected, wires the real process: guard on `process`, logger to stderr, `process.exitCode`', async () => {
    // The production defaults, which otherwise only a spawned bundle exercises. `process.on`
    // and `process.exit` are stubbed so the guard cannot actually arm in the worker.
    const on = vi.spyOn(process, 'on').mockImplementation(() => process);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    try {
      runAsEntry(URL_, 'svc', () => Promise.reject(new Error('down')), { argv1: SCRIPT });
      await settle();
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]![0])).toContain('ERROR [svc] failed to start error=down');
      // The guard landed on the real `process.on`, and its exit goes to the real `process.exit`.
      expect(on).toHaveBeenCalledTimes(1);
      expect(on.mock.calls[0]![0]).toBe('uncaughtException');
      const listener = on.mock.calls[0]![1] as (err: unknown, origin: string) => void;
      listener(new Error('later'), 'uncaughtException');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(stderr.mock.calls[1]![0])).toContain('ERROR [svc] uncaught exception, exiting');
    } finally {
      process.exitCode = before;
    }
  });
});
