/**
 * The one shape a server log line has (design/19 §8's "the logger *shape* is worth
 * taking", now taken).
 *
 * Before this, all four processes wrote free-form `console.log`/`warn`/`error` — perfectly
 * readable over `docker compose logs`, and completely opaque to a log store. "Show me
 * every error from billsvc in the last hour" had no answer, because nothing in a line said
 * which service wrote it or how bad it was.
 *
 * ## The format
 *
 * ```
 * 12:34:56.789 WARN  [matchsvc] store: billing plane refused route=/store/order status=502
 * └ time       └level └tag      └ message                     └ key=value fields
 * ```
 *
 * Deliberately NOT JSON on stdout. `docker compose logs -f` and `ssh` remain the first
 * thing anybody reaches for when the box is misbehaving, and a screen of JSON is a screen
 * nobody reads. `monitoring/alloy/config.alloy` regex-parses the prefix into the `level`
 * label; the `key=value` tail is left in the line body and parsed at query time with
 * `| logfmt`, which is what keeps the label cardinality bounded (see that file's header).
 *
 * ## Two rules this module enforces so call sites cannot break the parse
 *
 * 1. **A line is one line.** Newlines and control characters in a message or a field value
 *    are collapsed to spaces. A stack trace pasted straight into a message would otherwise
 *    arrive as N log entries, N-1 of which have no level, no tag and no context.
 * 2. **A field value is one token.** Values containing a space or a quote are quoted, so
 *    `| logfmt` sees `msg="two words"` rather than a truncated `msg=two` plus a stray key.
 *
 * ## Deliberately no dependency
 *
 * `deploy/package.json` has exactly one runtime dependency (`ws`), and every entry point is
 * an esbuild bundle. A logging library would be the second, for something that is 80 lines.
 * funny reached the same conclusion for the same reason (`server/shared/src/logger.ts`).
 */

/** Ordered most severe to least; `BB_LOG_LEVEL` names the least severe one that prints. */
export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

/** Structured fields appended as `key=value`. `undefined` values are dropped, not printed. */
export type Fields = Record<string, string | number | boolean | null | undefined>;

/** The sink, injected so a test can read what was written without spying on the console. */
export interface LogSink {
  write(level: Level, line: string): void;
}

const consoleSink: LogSink = {
  write(level, line) {
    // stderr for the two levels an operator greps for, stdout for the rest — the split
    // `docker logs` already understands, and the one Alloy turns into a `stream` label.
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
};

/**
 * `BB_LOG_LEVEL` (default `info`). Read once per logger construction rather than per line:
 * every process here builds its loggers at startup, so a per-line read would be a
 * `process.env` lookup on the hot path buying a reconfigurability nothing uses.
 */
export function levelFromEnv(env: NodeJS.ProcessEnv = process.env): Level {
  const raw = (env.BB_LOG_LEVEL ?? '').trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : 'info';
}

/** `12:34:56.789`, UTC. The box is in one timezone and the players are not, so a local
 *  time would be a number nobody can correlate with anything a client reported. */
export function formatTime(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(at.getUTCHours())}:${p(at.getUTCMinutes())}:${p(at.getUTCSeconds())}.${p(at.getUTCMilliseconds(), 3)}`;
}

/**
 * Collapse anything that would end the line early, and bound the length.
 *
 * Stripping control characters is the half that matters. A newline inside an error message
 * turns one entry into several, and every line after the first arrives with no timestamp,
 * no level and no tag — precisely the lines wanted when something is wrong. A stack trace
 * is the common case and passing one as a field value is normal, so this is a property of
 * the formatter rather than a rule every call site has to remember.
 *
 * Written as a `charCodeAt` scan rather than the obvious regex character class, for a
 * reason about this repo rather than about style: a LITERAL control character in the
 * source makes the file BINARY to git — `tsc`, the tests and the coverage run all stay
 * green through that, and the only tell is `Bin` in `git diff --stat` — while the `\\u`
 * escape that would avoid it does not survive an editor round-trip here, coming back as
 * the literal character it was written to replace. A comparison against `0x20` has
 * neither problem.
 */
function oneLine(s: string, max: number): string {
  let flat = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    flat += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  flat = flat.replace(/[ \t]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `key=value`, quoted when the value would otherwise not survive `| logfmt`. */
export function formatFields(fields: Fields): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    const value = oneLine(raw === null ? 'null' : String(raw), 512);
    // An empty value still has to produce a token — `key=` parses, a bare `key` does not.
    parts.push(/^[\w./:@+-]+$/.test(value) && value !== '' ? `${key}=${value}` : `${key}=${JSON.stringify(value)}`);
  }
  return parts.join(' ');
}

export interface Logger {
  error(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
  /** A logger for a sub-area of the same process — `log.child('store')` tags `svc:store`.
   *  The tag is cosmetic (Alloy labels by CONTAINER, not by this), so nesting is free. */
  child(tag: string): Logger;
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: Level;
  now?: () => Date;
}

/**
 * Build the logger for a service. `tag` is what appears in `[brackets]` — the process name
 * at the top level (`matchsvc`), a sub-area below it (`matchsvc:store`).
 */
export function createLogger(tag: string, opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? consoleSink;
  const min = opts.level ?? levelFromEnv();
  const now = opts.now ?? ((): Date => new Date());
  const threshold = LEVELS.indexOf(min);
  // Padded so the `[tag]` column lines up across levels; `debug` is the longest at 5.
  const emit = (level: Level, msg: string, fields?: Fields): void => {
    if (LEVELS.indexOf(level) > threshold) return;
    const tail = fields ? formatFields(fields) : '';
    const head = `${formatTime(now())} ${level.toUpperCase().padEnd(5)} [${tag}] ${oneLine(msg, 2000)}`;
    sink.write(level, tail ? `${head} ${tail}` : head);
  };
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (sub) => createLogger(`${tag}:${sub}`, { sink, level: min, now }),
  };
}
