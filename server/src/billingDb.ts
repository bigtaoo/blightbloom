/**
 * The billing plane's store (design/19-server-platform.md §4) — an assembly shell.
 *
 * The module split three ways on 2026-09-15 when the plane moved from `node:sqlite` to
 * MongoDB, and this path stays alive because callers outside the billing plane import it:
 *
 *   billing/collections.ts   the six collections' document shapes and typed handles, and
 *                            the column→field mapping the port is built on.
 *   billing/schema.ts        the indexes and validators that hold the schema-level
 *                            guarantees — read this one first; it is where the port's one
 *                            genuinely dangerous difference (a PARTIAL unique index on
 *                            `orders.platformTxnId`) is argued out.
 *   billing/sqliteLegacy.ts  the retired file opener, still imported by the ops console and
 *                            the backup runner until their own stage of the migration.
 *
 * "Money gets its own process and its own database" is a locked decision, and it survives
 * the move as a separate logical DATABASE on the cluster (`mongo.ts`'s `billing` store),
 * reached through an injected `Db` rather than through a shared opener — which is exactly
 * how a later refactor would quietly re-merge the two planes.
 */
export * from './billing/collections';
export * from './billing/schema';
export * from './billing/sqliteLegacy';
