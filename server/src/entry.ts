/**
 * The run-as-main block every service entry point shares: "if this file is the one `node`
 * was started on, install the process guard and boot".
 *
 * It used to be five hand-copied `if (process.argv[1] && fileURLToPath(...) === ...)`
 * blocks, each with its own idea of what a failed boot looks like — a one-line
 * `console.error` in matchsvc and adminsvc, a bare `console.error(e)` (a multi-line stack)
 * in billsvc, nothing at all in backup and the gameserver. None of it could be covered: the
 * condition is false inside the vitest worker by construction, and a spawned child's
 * coverage is not collected. Lifting it into a function with the entry check as a parameter
 * makes both arms testable, and gives every service the same failed-boot line.
 *
 * A failed boot is logged through the service's own logger, as one ERROR line, for the same
 * reason the guard is (see `processGuard.ts`): it is the line an operator most needs to find
 * in Loki, and a stack printed raw arrives there as a dozen level-less fragments. It sets
 * `exitCode` rather than calling `exit` so whatever the failed boot already opened can still
 * flush; what keeps the process alive past that is the bug the exit code reports.
 */
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from './log';
import { describeThrown, installProcessGuard, type ProcessGuardDeps } from './processGuard';

export interface EntryDeps {
  /** The script `node` was started on; production reads `process.argv[1]`. */
  argv1?: string;
  /** Production gets `createLogger(tag)`. */
  log?: Logger;
  /** Passed through to `installProcessGuard`; production gets the real `process`. */
  guard?: ProcessGuardDeps;
  /** Production sets `process.exitCode`. */
  setExitCode?: (code: number) => void;
}

/**
 * Boots `start` when `moduleUrl` (the caller's `import.meta.url`) is the process's entry
 * script, and returns whether it did. `start` is called with no arguments, so each service
 * passes its `main` and lets its parameter defaults read the environment.
 */
export function runAsEntry(moduleUrl: string, tag: string, start: () => unknown, deps: EntryDeps = {}): boolean {
  // No `argv1 &&` guard needed: an absent `argv[1]` (a REPL, `node -e`) is just not equal.
  if (fileURLToPath(moduleUrl) !== (deps.argv1 ?? process.argv[1])) return false;
  const log = deps.log ?? createLogger(tag);
  installProcessGuard(log, deps.guard);
  const setExitCode = deps.setExitCode ?? ((code: number): void => void (process.exitCode = code));
  // Through a promise so a synchronous throw and a rejection take the same path.
  void Promise.resolve()
    .then(() => start())
    .catch((e: unknown) => {
      log.error('failed to start', describeThrown(e));
      setExitCode(1);
    });
  return true;
}
