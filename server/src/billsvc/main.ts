/**
 * billsvc's process entry point (design/19-server-platform.md §4). Third process, own
 * port, own logical database. Kept separate from `server.ts` for the same reason
 * `matchsvc.ts` keeps `main()` beside `createMatchsvcServer` but only calls it when run
 * directly: the builder has to be importable by a test without binding a port.
 *
 * The first thing `main` does is `assertBillingStartupSafety`, which THROWS rather than
 * warns (`startupGuard.ts`). That is deliberate and it is the second of design/19 §5's two
 * fail-closed defences: a billing process whose dev receipt stub is reachable in
 * production must not come up at all. It runs before `connectMongo()`, so a misconfigured
 * deploy does not even open a connection, let alone bind a port.
 *
 * `main` is ASYNC since the MongoDB port: the cluster connection is awaited at boot rather
 * than made lazily on the first request (`mongo.ts` argues that one), and
 * `ensureBillingIndexes` runs immediately after it — which is what makes a freshly created
 * database correct with no separate migration step, and what puts the partial unique index
 * on `orders.platformTxnId` in place BEFORE the first callback can settle anything.
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
import { createLogger } from '../log';
import { startHeartbeat } from '../heartbeat';
import { createBillsvcServer, type BillsvcServer } from './server';
import { assertBillingStartupSafety, type StartupEnv } from './startupGuard';
import { devStubEnabled } from './iap/factory';
import { ensureBillingIndexes } from '../billing/schema';
import { connectMongo, dbName, store } from '../mongo';

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
 * the environment is a production one with a dev-only flag set — no cluster connection, no
 * port bound, nothing to clean up.
 *
 * Returns the whole handle rather than just the `Server`: the `Db` is what a caller needs to
 * read the outbox, and the pooled client stays open for the life of the process (a test that
 * shuts this down closes it with `closeMongo()`).
 */
export async function main(env: StartupEnv = process.env, port = PORT, host = HOST): Promise<BillsvcServer> {
  assertBillingStartupSafety(env);
  await connectMongo();
  const db = store('billing');
  // Idempotent, and before the listener: an index or validator that lands after the first
  // webhook is one the first webhook did not have.
  await ensureBillingIndexes(db);
  const handle = createBillsvcServer({ env, db });
  const log = createLogger('billsvc');
  handle.server.listen(port, host, () => {
    // `devStub` stays in the line as a FIELD rather than the old inline
    // "[DEV RECEIPT STUB ENABLED]" banner: it is the one posture fact worth being able to
    // query for months afterwards ("was the store real on the day of that order?"), and a
    // bracketed marker inside the message is invisible to `| logfmt`. The acceptance
    // checklist in server/deploy/README.md §4 greps for it either way.
    log.info('billing plane listening', {
      addr: `http://${host}:${port}`,
      db: dbName('billing'),
      devStub: devStubEnabled(env),
    });
    startHeartbeat({ log });
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
  // A rejected boot must kill the process rather than becoming an unhandled rejection: a
  // billsvc that logged a connection failure and kept running would serve a webhook it
  // cannot record.
  void main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
