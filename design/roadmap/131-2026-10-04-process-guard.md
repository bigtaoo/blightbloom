# Work log — 2026-10-04

Volume 131. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## An uncaught exception is one log line and exit 1 (2026-10-04, server + test + docs, no ENGINE_VERSION change)

The follow-up volume 130 left open. The bad-Host crash in billsvc, adminsvc and the gameserver
was found by probing for it, and no process here had an `uncaughtException` handler. The next
exception that escapes an error boundary would end its process the same way.

### What was wrong with the default

Node's default already exits, and exiting is right. The problem is the output: a multi-line
stack trace with no timestamp, no level and no `[tag]`. Alloy parses the level from the line
prefix (`log.ts`, `monitoring/alloy/config.alloy`), so every line of that trace reaches Loki as
a level-less fragment. The moment a service dies is the moment its logs stop answering "show me
every error from billsvc".

### The guard

`src/processGuard.ts` installs one `uncaughtException` handler that writes one ERROR line
through the service's own logger, with `origin`, `error` and the stack as fields, then exits 1.
`log.ts` flattens the stack, so it arrives in the same entry.

- **It exits rather than carrying on.** After an uncaught exception the process state is
  unknown, for example a half-applied tick or a billing write whose acknowledgement never ran.
  Compose's `restart: unless-stopped` brings back a clean process in seconds.
- **There is no `unhandledRejection` listener.** Since Node 15 an unhandled rejection is raised
  as an uncaught exception, arriving with `origin=unhandledRejection`. A second listener would
  switch that default off.
- **The logger failing does not stop the exit.** The exit is in a `finally`.
- **A thrown non-`Error` is still reported.** That includes a value `String()` cannot print.

All five entry points (gameserver, matchsvc, billsvc, adminsvc, backup) install it in their
run-as-main block, never in `main()`. Tests call `main()` inside the vitest worker, and a
handler there that exits would take the runner down.

### Tests

- `processGuard.test.ts` pins the contract with `process.on` and `process.exit` injected.
- `deploy.bundle.test.ts` proves each SHIPPED bundle installs it.
  - A `--import` preload arms a stdin listener before the bundle loads.
  - The test waits for the service's first heartbeat, then writes a line and the listener
    throws.
  - Each bundle must exit 1, print the tagged ERROR line, and print no `    at ...` trace line.
    The exit code alone proves nothing, since the default also exits 1.
  - A second case does the same with a rejected promise on the gameserver and expects
    `origin=unhandledRejection`.
- 11 of 11 mutants fail the suite:
  - each of the five installs removed;
  - `exit(0)`;
  - the exit moved out of the `finally`;
  - `origin` dropped;
  - the name fallback dropped;
  - the unprintable fallback blanked;
  - the listener switched to `unhandledRejection`.

### Not done

- No Grafana alert on the new line. `|= "uncaught exception"` in Loki now finds every crash,
  and the existing "service liveness" panel already shows a service that stopped beating.
- The billsvc boot-failure catch still prints `console.error(e)`, a multi-line trace. It runs
  only when boot fails, before the service is up.
