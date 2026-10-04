/**
 * The last line of defence for a service process: an exception nothing caught.
 *
 * Until 2026-10-04 no process here installed one, and the default Node behaviour is to
 * print a stack trace and exit. That trace is the problem, not the exit: it is several
 * lines with no timestamp, no level and no `[tag]`, so the Alloy pipeline (see `log.ts`)
 * files every line of it as a level-less fragment — the one moment a service dies is the
 * one moment its logs stop being queryable. The bad-Host crash found the same day
 * (design/roadmap volume 130) was exactly this shape in billsvc, adminsvc and the
 * gameserver's WebSocket handler.
 *
 * What this does: write ONE error line through the service's own logger, then exit 1.
 *
 * What it deliberately does NOT do is keep running. After an uncaught exception the process
 * is in a state nobody reasoned about — a half-applied room tick, a billing write whose
 * acknowledgement never ran — and compose's `restart: unless-stopped` gives back a clean
 * process in seconds. A guard that logged and carried on would trade a visible restart for
 * an invisible corruption.
 *
 * Only `uncaughtException` is listened to, and that covers rejected promises too: since
 * Node 15 an unhandled rejection is raised AS an uncaught exception, arriving here with
 * `origin === 'unhandledRejection'`. Adding an `unhandledRejection` listener as well would
 * switch that default off and leave the two paths to drift apart.
 *
 * Installed ONLY by `runAsEntry` (`entry.ts`), once a module is the entry script — never
 * from `main()`: the tests call `main()` inside the vitest worker, and a handler there that
 * exits the process would take the test runner down with it.
 */
import type { Logger } from './log';

export interface ProcessGuardDeps {
  /** Injected by tests; production gets `process.on`. */
  on?: (event: 'uncaughtException', listener: (err: unknown, origin: string) => void) => void;
  /** Injected by tests; production gets `process.exit`. */
  exit?: (code: number) => void;
}

/** The message and stack of whatever was thrown — which need not be an `Error`. */
export function describeThrown(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) return { error: err.message || err.name, stack: err.stack };
  try {
    return { error: typeof err === 'string' ? err : String(err) };
  } catch {
    // `String()` itself throws on an object whose `toString` throws, or on a null-prototype
    // object. The guard's job is to report, so it must not be the thing that fails.
    return { error: 'unprintable thrown value' };
  }
}

export function installProcessGuard(log: Logger, deps: ProcessGuardDeps = {}): void {
  const on = deps.on ?? ((event, listener) => void process.on(event, listener));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  on('uncaughtException', (err, origin) => {
    try {
      // The stack goes in as a field: `log.ts` flattens it to one line, so it arrives as
      // part of the same entry instead of as a dozen level-less ones.
      log.error('uncaught exception, exiting', { origin, ...describeThrown(err) });
    } finally {
      exit(1);
    }
  });
}
