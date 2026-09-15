/**
 * One mongod for the whole test run (design/18-test-strategy.md "Layer 4").
 *
 * This repo's testing convention is REAL STORES, NEVER MOCKS — the old suite opened
 * `node:sqlite`'s `:memory:` rather than stubbing a database, and every assertion about a
 * constraint was therefore an assertion about the constraint SQLite actually enforces. The
 * move to MongoDB keeps that convention, and keeping it is the whole reason this file
 * exists instead of a hand-written fake driver.
 *
 * A fake would have passed the port's most dangerous test. MongoDB's unique index treats a
 * MISSING field as one `null` value and admits exactly one such document, where SQLite
 * treats every NULL as distinct — so `orders.platform_txn_id TEXT UNIQUE`, which billingDb
 * relied on to let any number of UNSETTLED orders coexist, rejects the second one with
 * E11000 under a naive translation. That difference is invisible to a fake written by
 * someone who believed the naive translation, and it only surfaces under concurrent
 * unsettled orders in production. It is caught here because the tests run against a real
 * server that really refuses.
 *
 * REPLICA SET, not a standalone: transactions are the replacement for `BEGIN IMMEDIATE`
 * and mongod refuses to start one outside a replica set. A single-node set is enough and
 * comes up in about half a second.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let replSet: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    // Pinned rather than "whatever is newest". The binary is downloaded on a cold CI
    // machine, so an unpinned version is a silent change to what the suite tests against
    // on a day nobody touched this repo.
    binary: { version: '7.0.14' },
  });
  // `provide` rather than `process.env`, because it is the one channel that works for
  // every vitest pool — a forked worker does not inherit an env var set in this process.
  project.provide('mongoUri', replSet.getUri());
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
  replSet = undefined;
}

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string;
  }
}
