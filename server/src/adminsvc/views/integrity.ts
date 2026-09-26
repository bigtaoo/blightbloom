/**
 * The integrity view (design/15, "PvP integrity", decided 2026-09-26) — "which PvP matches
 * did not settle cleanly, and which accounts keep being named?".
 *
 * Two reads over the `accounts` database through the console's read-only handle: the newest
 * records from `integrityReports`, and the most-named accounts from `suspicion`, each joined
 * to `accounts` for a readable name. Nothing here writes, and nothing here decides anything:
 * a count is shown, never acted on. That is the whole of "record, never auto-ban".
 *
 * The archived input log is summarised as its size rather than served. Downloading it is a
 * replay tool's job, and no replay tool judges these yet.
 */
import type { Db } from 'mongodb';
import type { AccountDoc, IntegrityReportDoc, SuspicionDoc } from '../../db';

/** How many of each list one page shows. The console is for noticing a pattern, not for
 *  exporting the collection. */
export const INTEGRITY_PAGE_SIZE = 50;

export interface IntegrityReportRow {
  roomId: string;
  receivedAtMs: number;
  verdict: IntegrityReportDoc['verdict'];
  bounds: string | null;
  playerCount: number;
  seed: number;
  engineVersion: number;
  settleFrame: number;
  suspects: { seat: number; accountId: string | null; name: string | null; dissented: boolean; kicked: boolean }[];
  /** Bytes of gzipped log archived; null when the sender dropped it for size. */
  logBytes: number | null;
}

export interface SuspicionRow {
  accountId: string;
  /** The account's display name, or its username; null when the account no longer exists. */
  name: string | null;
  count: number;
  lastRoomId: string;
  lastAtMs: number;
}

export interface IntegrityView {
  reports: IntegrityReportRow[];
  suspects: SuspicionRow[];
}

/** Every account id the two lists mention, resolved to a name in one query. */
async function namesFor(accounts: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const docs = await accounts
    .collection<AccountDoc>('accounts')
    .find({ _id: { $in: [...new Set(ids)] } })
    .toArray();
  for (const d of docs) out.set(d._id, d.displayName ?? d.username);
  return out;
}

export async function integrityView(accounts: Db, limit: number = INTEGRITY_PAGE_SIZE): Promise<IntegrityView> {
  const [reports, suspicion] = await Promise.all([
    accounts
      .collection<IntegrityReportDoc>('integrityReports')
      .find({})
      // `_id` breaks the tie so a reload never reshuffles two records received together.
      .sort({ receivedAt: -1, _id: 1 })
      .limit(limit)
      .toArray(),
    accounts.collection<SuspicionDoc>('suspicion').find({}).sort({ count: -1, _id: 1 }).limit(limit).toArray(),
  ]);

  const ids: string[] = suspicion.map((s) => s._id);
  for (const r of reports) for (const s of r.suspects) if (s.accountId !== undefined) ids.push(s.accountId);
  const names = await namesFor(accounts, ids);

  return {
    reports: reports.map((r) => ({
      roomId: r._id,
      receivedAtMs: r.receivedAt,
      verdict: r.verdict,
      bounds: r.bounds ?? null,
      playerCount: r.playerCount,
      seed: r.seed,
      engineVersion: r.engineVersion,
      settleFrame: r.settleFrame,
      suspects: r.suspects.map((s) => ({
        seat: s.seat,
        accountId: s.accountId ?? null,
        name: s.accountId === undefined ? null : (names.get(s.accountId) ?? null),
        dissented: s.dissented,
        kicked: s.kicked,
      })),
      logBytes: r.log === undefined ? null : r.log.length(),
    })),
    suspects: suspicion.map((s) => ({
      accountId: s._id,
      name: names.get(s._id) ?? null,
      count: s.count,
      lastRoomId: s.lastRoomId,
      lastAtMs: s.lastAt,
    })),
  };
}
