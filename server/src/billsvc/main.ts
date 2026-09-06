/**
 * billsvc's process entry point (design/19-server-platform.md §4). Third process, own
 * port, own SQLite file. Kept separate from `server.ts` for the same reason `matchsvc.ts`
 * keeps `main()` beside `createMatchsvcServer` but only calls it when run directly: the
 * builder has to be importable by a test without binding a port.
 *
 * The first thing `main` does is `assertBillingStartupSafety`, which THROWS rather than
 * warns (`startupGuard.ts`). That is deliberate and it is the second of design/19 §5's two
 * fail-closed defences: a billing process whose dev receipt stub is reachable in
 * production must not come up at all.
 *
 * The last thing it does is `pump.start()`, and that ordering is the whole reason the
 * delivery outbox exists. A process that died between a settlement's COMMIT and its
 * entitlement grant left `deliveries` rows behind that nothing will ever re-trigger — no
 * webhook is coming a second time, and the platform considers the payment done. The startup
 * sweep is what picks them up (`deliveryPump.ts`, trigger 2), and it runs here rather than
 * in `createBillsvcServer` because a builder that arms a background interval cannot be
 * called by a test without leaving one running.
 */
import { fileURLToPath } from 'node:url';
import { createBillsvcServer, type BillsvcServer } from './server';
import { assertBillingStartupSafety, type StartupEnv } from './startupGuard';
import { devStubEnabled } from './iap/factory';
import { defaultBillingDbPath } from '../billingDb';

/**
 * design/19-server-platform.md's three-plane table: data plane 8787 (`index.ts`), control
 * plane 8788 (`matchsvc.ts`), billing plane 8789. Exported because it is an interface
 * contract rather than a tuning knob — the client's deploy config, the reverse proxy and
 * `dev:*` scripts all name it, and defaulting it onto one of the other two planes' ports
 * makes billsvc either fail to bind or shadow the process it was split away from. A
 * mutation battery on 2026-09-04 changed this to 8788 and no test noticed, because every
 * case binds port 0.
 */
export const DEFAULT_BILL_PORT = 8789;
/** The other two planes' defaults, so the "no collision" test has something to compare to. */
export const OTHER_PLANE_PORTS = { dataPlane: 8787, controlPlane: 8788 } as const;

const PORT = Number(process.env.BILL_PORT ?? DEFAULT_BILL_PORT);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Starts the billing plane. Throws `BillingStartupError` before opening anything at all if
 * the environment is a production one with a dev-only flag set — no port bound, no
 * database file created, nothing to clean up.
 *
 * Returns the whole handle rather than just the `Server`: the SQLite connection stays open
 * for the life of the process, so anything that shuts this down (a test, and eventually a
 * SIGTERM handler) needs the database as well as the socket. On Windows an unclosed
 * connection also keeps a lock on the file, which is how the test suite found this.
 */
export function main(env: StartupEnv = process.env, port = PORT, host = HOST): BillsvcServer {
  assertBillingStartupSafety(env);
  const handle = createBillsvcServer({ env });
  handle.server.listen(port, host, () => {
    const stub = devStubEnabled(env) ? '  [DEV RECEIPT STUB ENABLED]' : '';
    console.log(`blightbloom billsvc (billing plane) on http://${host}:${port}  db=${defaultBillingDbPath()}${stub}`);
  });
  // Sweeps whatever a previous process left owed, then arms the backstop interval. Started
  // AFTER `listen` for no functional reason (nothing in the pump touches the socket) but for
  // an operational one: the "on http://..." line is what an operator waits for, and a sweep
  // that logs a refused control plane ahead of it reads like a failure to start.
  handle.pump.start();
  return handle;
}

// Only auto-start when run directly (`node --import tsx/esm src/billsvc/main.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, same guard
// `matchsvc.ts` and `index.ts` use.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
