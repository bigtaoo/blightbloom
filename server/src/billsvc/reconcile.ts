/**
 * Daily reconciliation (design/19-server-platform.md §7, ROADMAP 8.5) — a sibling module of
 * free functions, CLAUDE.md's first split form, deliberately not a `BillingService` method:
 * this reads the same collections but answers a different question, and it must be drivable
 * from a cron script with no HTTP server in the process.
 *
 * WHAT TEAR THIS COVERS. design/19 §4 argues that funny's verify-and-heal CAS saga is
 * unnecessary here because `orders`, `receipts` and `ledger` are three collections in one
 * store and one transaction makes a tear between them impossible; §4's closing paragraph
 * then names the tear that is still real — between the PLATFORM and the local transaction —
 * and hands it to this file. A payment that succeeded on the platform's side and whose
 * callback never arrived (or arrived and was refused) leaves NO local row at all, so nothing
 * inside this database can notice it. Only a comparison against the platform's own list can.
 *
 * THE HONEST SCOPE PROBLEM, AND WHAT IS DONE ABOUT IT — read this before trusting a green
 * report. This project has no merchant account on any of the four real platforms
 * (design/19 §9), so there is no platform order list to pull, and there will not be one until
 * a product decision is made. That is handled the same way ROADMAP 8.4 handled the same
 * problem for verification: "list the platform's recent orders" is an injected PORT
 * (`PlatformOrderLister`), the dev stub implements it against its own authored order book,
 * and the four real adapters each carry the call they would make and return
 * not-implemented.
 *
 * The consequence is stated in the report's own shape rather than in a comment. A platform
 * whose port refuses does NOT contribute zero differences — it lands in `unreconciled`, and
 * `ReconcileReport.complete` is false whenever that list is non-empty. There is no code path
 * that can report a clean reconciliation for a check that did not run.
 *
 * THE DIFFERENCE CLASSES, all three of them, joined on `platform_txn_id`:
 *
 *   'local-not-on-platform'  a settled local order the platform does not list. Either the
 *                            window is wrong, or something claimed a transaction that never
 *                            happened — the shape a forged callback would leave, which is
 *                            why this class is reported even though it is the rarest.
 *   'platform-not-local'     the platform charged and this server has nothing. THE tear §4
 *                            leaves open: the player paid and owns nothing. Loudest class.
 *   'amount-mismatch'        same transaction, different money.
 *   'sku-mismatch'           same transaction, different product. A receipt redeemed against
 *                            the wrong SKU is exactly what design/19 §4's rule 5 exists to
 *                            stop at settlement time; this is the same question asked later,
 *                            from the other side, where rule 5 cannot see it.
 *
 * (Four kinds, three classes: amount and SKU are both "present on both sides and disagreeing"
 * and are counted together as the third class, but reported separately because they mean
 * different things to whoever reads them.)
 *
 * NOTHING HERE ACTS. No order is changed, no entitlement is granted or revoked, no delivery
 * is retried. A difference is a finding, and design/19 §7's principle for the audit next door
 * applies here too: with no evidence, skip — never convict. Reconciliation's job is to make
 * the tear visible to a human, not to guess which side is right.
 */
import type { Db } from 'mongodb';
import { billingStore } from '../billing/collections';
import { asIapPlatform, type IapPlatform, type PlatformOrder, type PlatformOrderLister } from './iap/types';

/** The local side of the join: one SETTLED order, which is the only kind that can match. */
export interface LocalSettledOrder {
  orderId: string;
  accountId: string;
  sku: string;
  platform: IapPlatform;
  amountCents: number;
  currency: string;
  platformTxnId: string;
  settledAt: number;
}

export type ReconcileDifferenceKind =
  | 'local-not-on-platform'
  | 'platform-not-local'
  | 'amount-mismatch'
  | 'sku-mismatch';

export interface ReconcileDifference {
  kind: ReconcileDifferenceKind;
  platform: IapPlatform;
  /** The join key. Always present — a row with no transaction id cannot be reconciled. */
  platformTxnId: string;
  /** The local merchant order, when there is a local side. */
  orderId: string | null;
  accountId: string | null;
  /** One line, aimed at a person reading a cron mail. */
  detail: string;
}

/** What one platform's window produced. */
export interface PlatformReconcileReport {
  platform: IapPlatform;
  localCount: number;
  platformCount: number;
  /** Transactions present on both sides, whether or not their fields agreed. */
  matched: number;
  differences: ReconcileDifference[];
}

/** A platform that could not be asked. NOT a platform with nothing to report. */
export interface UnreconciledPlatform {
  platform: IapPlatform;
  reason: string;
}

export interface ReconcileReport {
  /** Half-open `[sinceMs, untilMs)`. */
  sinceMs: number;
  untilMs: number;
  platforms: PlatformReconcileReport[];
  unreconciled: UnreconciledPlatform[];
  /**
   * True only when EVERY platform asked for actually answered. The field exists so that
   * "no differences" and "reconciled" cannot be confused by a caller that only looked at
   * `differences.length` — which is the mistake this whole module is shaped to prevent.
   */
  complete: boolean;
  /** Total across platforms, for the one-line summary. */
  differenceCount: number;
}

/**
 * Read the local side: settled orders in `[sinceMs, untilMs)` for one platform.
 *
 * `settledAt` rather than `createdAt`, because the platform's list is keyed on when it
 * charged, not on when this server booked an intent — an order created at 23:59 and settled
 * at 00:01 belongs to the second day on both sides or to neither.
 *
 * `platformTxnId: { $type: 'string' }` is not defensive: `settle` writes the state and the
 * transaction id in one update, so a settled document always has one. It is here because the
 * field is the join key, and one missing (a hand-edited document — the posture design/19 §8
 * plans for) would otherwise join every such order to every other. It is also the exact
 * predicate the partial unique index in `billing/schema.ts` is filtered on, which is not a
 * coincidence: both mean "this order has actually claimed a platform payment".
 */
export async function localSettledOrders(
  db: Db,
  platform: IapPlatform,
  sinceMs: number,
  untilMs: number,
): Promise<LocalSettledOrder[]> {
  const docs = await billingStore(db)
    .orders.find({
      state: 'settled',
      platform,
      platformTxnId: { $type: 'string' },
      settledAt: { $gte: sinceMs, $lt: untilMs },
    })
    .sort({ settledAt: 1, _id: 1 })
    .toArray();
  return docs.map((d) => ({
    orderId: d._id,
    accountId: d.accountId,
    sku: d.sku,
    platform: d.platform as IapPlatform,
    amountCents: d.amountCents,
    currency: d.currency,
    platformTxnId: d.platformTxnId as string,
    settledAt: d.settledAt as number,
  }));
}

/**
 * THE PURE CORE. Two lists in, one report out — no database, no clock, no network. Every
 * branch in this function is reachable from a plain array literal, which is the entire reason
 * the platform side is a port rather than a fetch.
 */
export function diffOrders(
  platform: IapPlatform,
  local: readonly LocalSettledOrder[],
  platformOrders: readonly PlatformOrder[],
): PlatformReconcileReport {
  const byTxn = new Map<string, PlatformOrder>();
  for (const o of platformOrders) byTxn.set(o.platformTxnId, o);
  const seen = new Set<string>();
  const differences: ReconcileDifference[] = [];
  let matched = 0;

  for (const row of local) {
    const remote = byTxn.get(row.platformTxnId);
    if (!remote) {
      differences.push({
        kind: 'local-not-on-platform',
        platform,
        platformTxnId: row.platformTxnId,
        orderId: row.orderId,
        accountId: row.accountId,
        detail:
          `order '${row.orderId}' is settled locally for '${row.sku}' (${row.amountCents} ${row.currency}) ` +
          `but the platform does not list transaction '${row.platformTxnId}'`,
      });
      continue;
    }
    seen.add(row.platformTxnId);
    matched += 1;

    if (remote.product !== row.sku) {
      differences.push({
        kind: 'sku-mismatch',
        platform,
        platformTxnId: row.platformTxnId,
        orderId: row.orderId,
        accountId: row.accountId,
        detail: `transaction '${row.platformTxnId}': local SKU '${row.sku}', platform product '${remote.product}'`,
      });
    }
    // A platform that does not report an amount on its list call produces NO amount finding.
    // Comparing against a missing value would turn every WeChat row into a difference, and a
    // reconciliation that always fires is one nobody reads. `undefined` means "not asked and
    // not answered", which is silence, not agreement — recorded here because the two are easy
    // to confuse and only one of them is a bug.
    if (remote.amountCents !== undefined && remote.amountCents !== row.amountCents) {
      differences.push({
        kind: 'amount-mismatch',
        platform,
        platformTxnId: row.platformTxnId,
        orderId: row.orderId,
        accountId: row.accountId,
        detail:
          `transaction '${row.platformTxnId}': local ${row.amountCents} ${row.currency}, ` +
          `platform ${remote.amountCents}${remote.currency === undefined ? '' : ` ${remote.currency}`}`,
      });
    }
  }

  for (const remote of platformOrders) {
    if (seen.has(remote.platformTxnId)) continue;
    differences.push({
      kind: 'platform-not-local',
      platform,
      platformTxnId: remote.platformTxnId,
      orderId: remote.merchantOrderId ?? null,
      // The platform does not know this server's account ids. Left null on purpose rather
      // than guessed from the merchant order — the order may not exist here at all, which is
      // the whole finding.
      accountId: null,
      detail:
        `the platform charged for '${remote.product}'${remote.amountCents === undefined ? '' : ` (${remote.amountCents})`} ` +
        `under transaction '${remote.platformTxnId}'${remote.merchantOrderId === undefined ? '' : `, order '${remote.merchantOrderId}'`} ` +
        'and this server has no settled order for it — the player may have paid and received nothing',
    });
  }

  return { platform, localCount: local.length, platformCount: platformOrders.length, matched, differences };
}

export interface ReconcileDeps {
  db: Db;
  listOrders: PlatformOrderLister;
  /** Which platforms to reconcile. Defaults to every platform the dispatch knows. */
  platforms?: readonly IapPlatform[];
}

/** Every platform `asIapPlatform` accepts, in a stable order so a report diffs cleanly. */
export const RECONCILED_PLATFORMS: readonly IapPlatform[] = ['apple', 'google', 'wechat', 'stripe', 'dev'];

/**
 * Run one window across every platform. `[sinceMs, untilMs)`, half-open, matching the port's
 * contract — two consecutive daily runs must not both claim an order settled exactly on the
 * boundary, or that order reports as a difference in one of them.
 *
 * A port that THROWS is an unreconciled platform, not a crash: a real adapter is an HTTPS
 * call, and one platform's DNS failure must not abandon the other four. Same reasoning as
 * `BillingService.settle`'s try around the verifier.
 */
export async function reconcileWindow(deps: ReconcileDeps, sinceMs: number, untilMs: number): Promise<ReconcileReport> {
  const platforms = deps.platforms ?? RECONCILED_PLATFORMS;
  const reports: PlatformReconcileReport[] = [];
  const unreconciled: UnreconciledPlatform[] = [];

  for (const platform of platforms) {
    let listing;
    try {
      listing = await deps.listOrders(platform, sinceMs, untilMs);
    } catch (e) {
      unreconciled.push({ platform, reason: `${platform}: listing threw — ${(e as Error).message}` });
      continue;
    }
    if (!listing.ok) {
      unreconciled.push({ platform, reason: listing.reason });
      continue;
    }
    reports.push(
      diffOrders(platform, await localSettledOrders(deps.db, platform, sinceMs, untilMs), listing.orders),
    );
  }

  return {
    sinceMs,
    untilMs,
    platforms: reports,
    unreconciled,
    complete: unreconciled.length === 0,
    differenceCount: reports.reduce((n, r) => n + r.differences.length, 0),
  };
}

/** ms in one day — the default window, and the "daily" in "daily reconciliation". */
export const DAY_MS = 86_400_000;

/**
 * The window a daily run should use: the `days` whole UTC days ending at the UTC midnight
 * before `nowMs`. Deliberately excludes today — a partial day would report every payment
 * still in flight as a difference, every single run.
 */
export function dailyWindow(nowMs: number, days = 1): { sinceMs: number; untilMs: number } {
  const untilMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { sinceMs: untilMs - days * DAY_MS, untilMs };
}

/**
 * Render a report as lines for a cron log. Separate from the computation so the report can be
 * asserted structurally and the wording changed without touching a test.
 *
 * The first line says whether the run was COMPLETE, before it says how many differences it
 * found, because "0 differences" from a run that asked nothing is the misreading this whole
 * module is shaped to prevent.
 */
export function formatReconcileReport(report: ReconcileReport): string[] {
  const window = `${new Date(report.sinceMs).toISOString()} .. ${new Date(report.untilMs).toISOString()}`;
  const lines = [
    report.complete
      ? `reconciliation ${window}: COMPLETE, ${report.differenceCount} difference(s)`
      : `reconciliation ${window}: INCOMPLETE — ${report.unreconciled.length} platform(s) could not be asked, ` +
        `${report.differenceCount} difference(s) among the rest`,
  ];
  for (const u of report.unreconciled) lines.push(`  not reconciled: ${u.reason}`);
  for (const p of report.platforms) {
    lines.push(`  ${p.platform}: ${p.localCount} local, ${p.platformCount} platform, ${p.matched} matched`);
    for (const d of p.differences) lines.push(`    [${d.kind}] ${d.detail}`);
  }
  return lines;
}

/** Narrow a CLI/env-supplied platform name, so a typo is refused rather than silently skipped. */
export function parsePlatformList(value: string | undefined): IapPlatform[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (names.length === 0) return undefined;
  const out: IapPlatform[] = [];
  for (const name of names) {
    const platform = asIapPlatform(name);
    if (!platform) throw new Error(`unknown platform '${name}'`);
    out.push(platform);
  }
  return out;
}
