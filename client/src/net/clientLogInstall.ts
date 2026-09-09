/**
 * Attaches {@link createClientLogger} to a real browser: the global error handlers, the
 * console, and the one event that fires when a page is going away.
 *
 * Split from `clientLog.ts` for the reason every seam in this codebase is split — the
 * buffer, the batching and the wire format are testable with no DOM, and this file, which
 * cannot be, holds nothing but wiring.
 *
 * ## Why the console is wrapped rather than call sites being changed
 *
 * There are ~100 `console.error`/`console.warn` calls across this client, in modules that
 * range from boot to render to audio, and most of them are exactly the lines worth having.
 * Rewriting all of them would be a large diff whose only failure mode is silence — a call
 * site missed is a class of error that never reports, and nothing goes red. Wrapping the
 * two methods captures every one of them, including those inside PixiJS and inside a
 * platform SDK, and keeps working for code written later that has never heard of this
 * module.
 *
 * The wrapper always calls through, so devtools is unchanged. It is also installed exactly
 * once and remembers the originals, because a double install would make each line log
 * twice and each one after that exponentially.
 *
 * ## What is captured
 *
 * `window.onerror` and `unhandledrejection` (the two ways a failure escapes without any
 * `console.error` at all — including a `boot()` that throws, which used to leave a player
 * staring at a spinner), plus everything routed through the wrapped console methods.
 * `console.log` is NOT wrapped: it is the noisy one, it carries almost no failure
 * information, and it would fill both the ring buffer and the log store with frame chatter.
 */
import { createClientLogger, type ClientLogger, type ClientLoggerDeps } from './clientLog';

let installed: ClientLogger | null = null;
let uninstall: (() => void) | null = null;

/** Flatten a console argument list into one message. */
function joinArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? ` | ${a.stack.split('\n')[1]?.trim() ?? ''}` : ''}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        // A circular object, a Proxy, a DOM node — `String()` never throws where
        // `JSON.stringify` does, and "[object HTMLCanvasElement]" is still better than
        // losing the line that contained it.
        return String(a);
      }
    })
    .join(' ');
}

export interface InstallOptions extends ClientLoggerDeps {
  /** The global to attach to. Injected so a test can pass a fake instead of `window`. */
  target?: {
    addEventListener?: (type: string, fn: (e: unknown) => void) => void;
    removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
  };
  consoleImpl?: Pick<Console, 'error' | 'warn'>;
}

/**
 * Install once and return the logger. A second call returns the first one untouched —
 * every entry point calls this, and two entry points can legitimately be loaded in one
 * test file.
 */
export function installClientLog(opts: InstallOptions): ClientLogger {
  if (installed) return installed;

  const logger = createClientLogger(opts);
  const con = opts.consoleImpl ?? console;
  const originalError = con.error.bind(con);
  const originalWarn = con.warn.bind(con);

  con.error = (...args: unknown[]): void => {
    logger.log('error', 'console', joinArgs(args));
    originalError(...args);
  };
  con.warn = (...args: unknown[]): void => {
    logger.log('warn', 'console', joinArgs(args));
    originalWarn(...args);
  };

  // `globalThis` rather than `window`: the WeChat mini-game shell has no `window`, and this
  // module is imported by that entry too.
  const target = opts.target ?? (globalThis as unknown as InstallOptions['target']);
  const onError = (e: unknown): void => {
    const ev = e as { message?: string; filename?: string; lineno?: number };
    logger.log('error', 'uncaught', `${ev.message ?? 'error'} @ ${ev.filename ?? '?'}:${ev.lineno ?? 0}`);
  };
  const onRejection = (e: unknown): void => {
    const reason = (e as { reason?: unknown }).reason;
    logger.log('error', 'unhandled-rejection', joinArgs([reason]));
  };
  // The last chance to hear anything at all. `pagehide` rather than `beforeunload`, which
  // iOS does not reliably fire; and `visibilitychange` is deliberately NOT used to flush —
  // a backgrounded tab on mobile is the normal case, and flushing there would send a batch
  // every time the player takes a phone call.
  const onPageHide = (): void => void logger.flush();

  target?.addEventListener?.('error', onError);
  target?.addEventListener?.('unhandledrejection', onRejection);
  target?.addEventListener?.('pagehide', onPageHide);

  uninstall = () => {
    con.error = originalError;
    con.warn = originalWarn;
    target?.removeEventListener?.('error', onError);
    target?.removeEventListener?.('unhandledrejection', onRejection);
    target?.removeEventListener?.('pagehide', onPageHide);
    logger.stop();
  };

  installed = logger;
  return logger;
}

/** The installed logger, or `null` before an entry point has installed one. */
export function clientLog(): ClientLogger | null {
  return installed;
}

/** Undo an install. For tests — nothing in production ever uninstalls. */
export function resetClientLog(): void {
  uninstall?.();
  uninstall = null;
  installed = null;
}
