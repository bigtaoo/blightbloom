/**
 * `installProcessGuard` as a function, with `process.on` and `process.exit` injected.
 *
 * The guard can only be installed for real in a process of its own (a handler that exits
 * would take the vitest worker down), so this file pins the contract and
 * `deploy.bundle.test.ts` proves each SHIPPED bundle actually installs it, by throwing
 * inside a running one.
 */
import { describe, it, expect } from 'vitest';
import { createLogger, type Level } from '../src/log';
import { describeThrown, installProcessGuard } from '../src/processGuard';

function harness() {
  const lines: { level: Level; line: string }[] = [];
  const log = createLogger('svc', { sink: { write: (level, line) => lines.push({ level, line }) }, level: 'info' });
  const listeners: { event: string; fn: (err: unknown, origin: string) => void }[] = [];
  const exits: number[] = [];
  installProcessGuard(log, {
    on: (event, fn) => listeners.push({ event, fn }),
    exit: (code) => exits.push(code),
  });
  return { lines, listeners, exits };
}

describe('installProcessGuard', () => {
  it('listens to uncaughtException only — rejections reach it through Node’s default', () => {
    // An `unhandledRejection` listener would switch off the default that turns a rejection
    // into an uncaught exception, splitting one path into two.
    const { listeners } = harness();
    expect(listeners.map((l) => l.event)).toEqual(['uncaughtException']);
  });

  it('logs ONE error line carrying the origin, message and stack, then exits 1', () => {
    const { lines, listeners, exits } = harness();
    const err = new Error('boom');
    listeners[0]!.fn(err, 'uncaughtException');
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    const line = lines[0]!.line;
    expect(line).toContain('ERROR [svc] uncaught exception, exiting');
    expect(line).toContain('origin=uncaughtException');
    expect(line).toContain('error=boom');
    // The stack is in the SAME line — flattened, not split into level-less fragments.
    expect(line).toMatch(/stack="Error: boom +at /);
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('names a rejection as one', () => {
    const { lines, listeners, exits } = harness();
    listeners[0]!.fn(new Error('nope'), 'unhandledRejection');
    expect(exits).toEqual([1]);
    expect(lines[0]!.line).toContain('origin=unhandledRejection');
  });

  it('still exits when the logger itself throws', () => {
    const listeners: ((err: unknown, origin: string) => void)[] = [];
    const exits: number[] = [];
    const broken = createLogger('svc', {
      sink: {
        write: () => {
          throw new Error('stderr is gone');
        },
      },
    });
    installProcessGuard(broken, { on: (_e, fn) => listeners.push(fn), exit: (c) => exits.push(c) });
    expect(() => listeners[0]!(new Error('boom'), 'uncaughtException')).toThrow('stderr is gone');
    expect(exits).toEqual([1]);
  });
});

describe('describeThrown', () => {
  it('reads an Error’s message and stack', () => {
    const err = new Error('boom');
    expect(describeThrown(err)).toEqual({ error: 'boom', stack: err.stack });
  });

  it('falls back to the name for an Error with no message', () => {
    expect(describeThrown(new TypeError()).error).toBe('TypeError');
  });

  it('prints a thrown string or number as itself, with no stack', () => {
    expect(describeThrown('socket hang up')).toEqual({ error: 'socket hang up' });
    expect(describeThrown(42)).toEqual({ error: '42' });
    expect(describeThrown(undefined)).toEqual({ error: 'undefined' });
  });

  it('does not throw on a value that cannot be printed', () => {
    expect(describeThrown(Object.create(null))).toEqual({ error: 'unprintable thrown value' });
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(describeThrown(hostile)).toEqual({ error: 'unprintable thrown value' });
  });
});
