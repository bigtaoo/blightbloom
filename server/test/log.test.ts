/**
 * THE LOG LINE IS PARSEABLE (src/log.ts).
 *
 * Every assertion here exists because `monitoring/alloy/config.alloy` regex-parses this
 * format into the `level` label, and Grafana's panels then parse the tail with `| logfmt`.
 * Both are text-matching a shape nothing in TypeScript checks — so the file that produces
 * the shape is where it has to be pinned, and the Alloy regex is re-stated below rather
 * than described, so a change to either side fails here instead of in production where the
 * only symptom is a label quietly going missing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLogger, formatFields, formatTime, levelFromEnv, LEVELS, type Level } from '../src/log';

/** The exact expression in monitoring/alloy/config.alloy's `stage.regex`. */
const ALLOY_REGEX = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+([A-Z]+)\s+\[([^\]]+)\]/;

function capture(level: Level = 'debug'): { lines: Array<{ level: Level; line: string }>; log: ReturnType<typeof createLogger> } {
  const lines: Array<{ level: Level; line: string }> = [];
  const log = createLogger('matchsvc', {
    level,
    sink: { write: (l, line) => lines.push({ level: l, line }) },
    now: () => new Date(Date.UTC(2026, 8, 9, 1, 2, 3, 45)),
  });
  return { lines, log };
}

describe('the line Alloy actually parses', () => {
  it('matches the collector regex, and yields the level and tag it labels by', () => {
    const { lines, log } = capture();
    log.warn('store refused', { status: 502 });
    const m = ALLOY_REGEX.exec(lines[0]!.line);
    expect(m, lines[0]!.line).not.toBeNull();
    expect(m![1]).toBe('WARN');
    expect(m![2]).toBe('matchsvc');
  });

  it('matches for EVERY level, not just the one that happened to be tested', () => {
    // The padding differs per level (`INFO ` vs `ERROR`), which is exactly the kind of
    // difference a single-level test cannot see.
    for (const level of LEVELS) {
      const { lines, log } = capture();
      log[level]('a message');
      expect(ALLOY_REGEX.exec(lines[0]!.line)?.[1], level).toBe(level.toUpperCase());
    }
  });

  it('puts a child tag in the same bracket, so a sub-area is still one parseable line', () => {
    const { lines, log } = capture();
    log.child('store').info('proxied');
    expect(ALLOY_REGEX.exec(lines[0]!.line)?.[2]).toBe('matchsvc:store');
  });

  it('formats the time as UTC, not as the box happens to be configured', () => {
    // A local time here would be a number that cannot be lined up with anything a client
    // reported, and the box's timezone is not this project's to choose.
    expect(formatTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).toBe('03:04:05.006');
  });
});

describe('a line is one line', () => {
  it('collapses a newline in the MESSAGE, so a multi-line throw is not N logs', () => {
    const { lines, log } = capture();
    log.error('boom\nat foo()\nat bar()');
    expect(lines[0]!.line).not.toContain('\n');
    expect(lines[0]!.line).toContain('boom at foo() at bar()');
  });

  it('collapses a newline in a FIELD VALUE — a stack trace is a normal thing to pass', () => {
    const { lines, log } = capture();
    log.error('failed', { stack: 'Error: x\n    at a\n    at b' });
    expect(lines[0]!.line).not.toContain('\n');
  });

  it('strips other control characters too, not only the newline', () => {
    // A carriage return alone rewrites the line in a terminal and truncates it in some log
    // readers; a NUL can end the line entirely. `\n` is the common case, not the only one.
    const { lines, log } = capture();
    log.error(`a${String.fromCharCode(13)}b${String.fromCharCode(0)}c${String.fromCharCode(127)}d`);
    expect(lines[0]!.line.endsWith('a b c d')).toBe(true);
  });

  it('bounds a very long message rather than emitting it whole', () => {
    const { lines, log } = capture();
    log.info('x'.repeat(5000));
    expect(lines[0]!.line.length).toBeLessThan(2200);
  });
});

describe('a field value is one logfmt token', () => {
  it('leaves a simple value bare', () => {
    expect(formatFields({ status: 502, route: '/store/order', ok: false })).toBe(
      'status=502 route=/store/order ok=false',
    );
  });

  it('quotes a value containing a space, so the NEXT key is still a key', () => {
    // Unquoted, `| logfmt` reads `msg=two` and then treats `words` as a valueless key —
    // which silently drops the rest of the line's fields, not just this one.
    const out = formatFields({ msg: 'two words', status: 500 });
    expect(out).toBe('msg="two words" status=500');
    expect(out).toContain('status=500');
  });

  it('quotes a value containing a quote, and escapes it', () => {
    expect(formatFields({ msg: 'he said "no"' })).toBe('msg="he said \\"no\\""');
  });

  it('renders an EMPTY value as `key=""` rather than a bare key', () => {
    // A bare `key` is not a logfmt pair; the field would vanish and, worse, the parse of
    // everything after it on the line shifts.
    expect(formatFields({ note: '' })).toBe('note=""');
  });

  it('drops an undefined field but KEEPS an explicit null', () => {
    // The distinction is load-bearing for a query: "the field was not applicable" and "the
    // value was null" are different answers, and only one of them should be absent.
    expect(formatFields({ a: undefined, b: null, c: 1 })).toBe('b=null c=1');
  });
});

describe('the level threshold', () => {
  it('drops everything less severe than the configured level', () => {
    const { lines, log } = capture('warn');
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn']);
  });

  it('a child inherits its parent level rather than resetting to the default', () => {
    // A child that silently reverted to `info` would make `BB_LOG_LEVEL=warn` a setting
    // that quiets the top-level logger and nothing else.
    const { lines, log } = capture('error');
    log.child('store').warn('w');
    expect(lines).toHaveLength(0);
  });

  it('reads BB_LOG_LEVEL, and falls back to info for anything unrecognised', () => {
    expect(levelFromEnv({ BB_LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe('debug');
    expect(levelFromEnv({ BB_LOG_LEVEL: ' WARN ' } as NodeJS.ProcessEnv)).toBe('warn');
    // Not `error`: a typo'd level must not be the one that hides everything.
    expect(levelFromEnv({ BB_LOG_LEVEL: 'verbose' } as NodeJS.ProcessEnv)).toBe('info');
    expect(levelFromEnv({} as NodeJS.ProcessEnv)).toBe('info');
  });
});

describe('the default sink', () => {
  it('sends error and warn to stderr and the rest to stdout', () => {
    // The split `docker logs` already understands, and the one Alloy turns into a `stream`
    // label — so a level routed to the wrong stream is a label that disagrees with itself.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('t', { level: 'debug' });
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(err).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
