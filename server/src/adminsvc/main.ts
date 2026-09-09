/**
 * adminsvc's process entry point (design/21 §3, decision B1) — the FIFTH process, and the
 * first one that holds no write handle to anything.
 *
 * Kept separate from `server.ts` for the reason every entry point in this repo is:
 * `createAdminsvcServer` has to be importable by a test without binding a port.
 *
 * ## Why a fifth process at all
 *
 * design/21 §3.1: matchsvc is the one service Caddy proxies wholesale, so a route added
 * there is public the moment it exists — `/metrics` had to explicitly refuse proxied
 * requests to avoid becoming a free readout of how many players are online. An admin
 * surface built on that server would make every future admin route inherit "public unless
 * it remembers not to be". A separate process inverts the default, and buys the property in
 * B1: this one opens `accounts.db`, `billing.db` and `analytics.db` with `readOnly: true`,
 * so it is not that the console *does not* write player data — it *cannot*, and that is a
 * sentence that survives a bug in it.
 *
 * ## The first thing `main` does is throw
 *
 * `assertAdminStartupSafety` runs before anything is opened or bound, so a box with no
 * `BB_ADMIN_PASSWORD` gets a process that exits with an explanation rather than a login
 * page with a compiled-in default. Same posture as `billsvc/main.ts`'s startup guard, whose
 * comment explains the general principle (design/19 §5's fail-closed rule); the specific
 * reason here is that this login page is on the public internet, beside Grafana's.
 */
import { fileURLToPath } from 'node:url';
import { createLogger } from '../log';
import { startHeartbeat } from '../heartbeat';
import { createAdminsvcServer, type AdminsvcServer } from './server';
import { AdminStartupError, type AdminEnv } from './credentials';

/**
 * design/19's three-plane table, extended: data plane 8787 (`index.ts`), control plane 8788
 * (`matchsvc.ts`), billing plane 8789 (`billsvc/main.ts`), ops console 8790.
 *
 * Exported because it is an interface contract rather than a tuning knob — `docker-compose.yml`,
 * the healthcheck and the Caddy block all name it, and defaulting it onto one of the other
 * three makes adminsvc either fail to bind or shadow a process that serves players. A
 * mutation battery on billsvc's equivalent constant changed it to a neighbour's port and no
 * test noticed, because every case binds port 0 — so the manifest gate compares this value
 * against compose and `OTHER_PLANE_PORTS` gives the collision test something to compare to.
 */
export const DEFAULT_ADMIN_PORT = 8790;
export const OTHER_PLANE_PORTS = { dataPlane: 8787, controlPlane: 8788, billingPlane: 8789 } as const;

/**
 * Where to listen, read PER CALL rather than captured at module scope.
 *
 * `config.ts` states the reason for the ticket secret and it applies identically here: a
 * module-scope `const PORT = Number(process.env.ADMIN_PORT ?? …)` makes the answer depend
 * on whether the environment was loaded before the first import — which is true in a
 * container and false under `--import tsx/esm` with a late `.env`, and silently wrong in
 * exactly one of them.
 *
 * `NaN` for a non-numeric value is deliberate rather than defended against: `listen(NaN)`
 * throws `ERR_SOCKET_BAD_PORT` immediately, which is a loud stop naming the variable. A
 * `?? DEFAULT_ADMIN_PORT` fallback would silently listen on 8790 while compose believed it
 * had set something else, and the healthcheck would then poll a port nothing answers.
 */
export function adminPort(env: AdminEnv & { ADMIN_PORT?: string } = process.env): number {
  const raw = env.ADMIN_PORT?.trim();
  return raw !== undefined && raw.length > 0 ? Number(raw) : DEFAULT_ADMIN_PORT;
}

export function adminHost(env: AdminEnv & { HOST?: string } = process.env): string {
  const raw = env.HOST?.trim();
  return raw !== undefined && raw.length > 0 ? raw : '0.0.0.0';
}

/**
 * Starts the ops console.
 *
 * Returns the whole handle rather than just the `Server`: the three SQLite connections stay
 * open for the life of the process, so anything that shuts this down needs them as well as
 * the socket.
 */
export function main(
  env: AdminEnv & { ADMIN_PORT?: string; HOST?: string } = process.env,
  port = adminPort(env),
  host = adminHost(env),
): AdminsvcServer {
  const log = createLogger('adminsvc');
  const handle = createAdminsvcServer({ env, log });
  handle.server.listen(port, host, () => {
    // The three booleans are the one posture fact worth being able to query months later
    // ("was the commerce tab even connected on the day of that order?"), and they are
    // FIELDS rather than prose in the message so `| logfmt` can see them.
    log.info('ops console listening', {
      addr: `http://${host}:${port}/admin/`,
      accounts: handle.dbs.accounts !== null,
      billing: handle.dbs.billing !== null,
      analytics: handle.dbs.analytics !== null,
      readOnly: true,
    });
    startHeartbeat({ log });
  });
  return handle;
}

/**
 * Runs `main`, turning a configuration refusal into an exit code and a readable line.
 *
 * Exported and separate from the guard below so it is reachable by a test: the guard itself
 * is three lines that only run when this file is the process entry point, and everything
 * worth asserting — that an `AdminStartupError` becomes exit 1 with its message, and that
 * any OTHER error is rethrown rather than swallowed into a misleading one — is in here.
 *
 * Rethrowing a startup error instead would print a stack trace whose first line is
 * `node:internal`, and the operator's next move is an `.env` edit, not a debugger. Exit
 * code 1 rather than 0 so compose's `restart: unless-stopped` reports a failure rather
 * than a clean stop.
 */
export function runMain(
  env: AdminEnv & { ADMIN_PORT?: string; HOST?: string } = process.env,
  exit: (code: number) => never = process.exit as (code: number) => never,
  report: (line: string) => void = console.error,
): AdminsvcServer {
  try {
    return main(env);
  } catch (e) {
    if (e instanceof AdminStartupError) {
      report(`[blightbloom] adminsvc refused to start: ${e.message}`);
      return exit(1);
    }
    throw e;
  }
}

// Only auto-start when run directly (`node --import tsx/esm src/adminsvc/main.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, the same guard every
// other entry point here uses.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMain();
}
