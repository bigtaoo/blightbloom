/**
 * Per-test-file setup: closes the client `freshAccounts()` shares within this worker.
 *
 * An open `MongoClient` keeps the worker's event loop alive, and vitest answers that by
 * HANGING rather than failing — the worst failure mode to leave lying around in a suite that
 * gates merges. This is the one piece of bookkeeping `freshAccounts()` cannot do for itself,
 * so it lives here and applies to every file automatically.
 */
import { afterAll } from 'vitest';
import { closeSharedTestClient } from './mongoHarness';

afterAll(async () => {
  await closeSharedTestClient();
});
