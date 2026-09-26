/**
 * matchsvc's half of the PvP integrity record (design/15, "PvP integrity", decided
 * 2026-09-26): store what the gameserver reports and count, per account, how often it has
 * been named a suspect. Read back only by the ops console (`adminsvc/views/integrity.ts`).
 *
 * Record, never ban: nothing here or downstream acts on a count. It exists so an operator can
 * see that one account keeps turning up, and so a later replay has the input logs to judge.
 *
 * Same two-backend shape as `RatingStore`: the cluster when an `AccountsStore` is passed, an
 * in-memory stand-in otherwise, answering identically.
 */
import { Binary } from 'mongodb';
import type { AccountsStore, IntegrityReportDoc } from './db';
import type { IntegrityReportBody } from './integrityReport';

/** The accounts a record counts against: each suspect seat with a real account, once. A
 *  seat that both dissented and was kicked is one suspicion, not two. */
export function suspectAccounts(body: Pick<IntegrityReportBody, 'suspects'>): string[] {
  const ids = new Set<string>();
  for (const s of body.suspects) if (s.accountId !== undefined) ids.add(s.accountId);
  return [...ids].sort();
}

export class IntegrityStore {
  private readonly memReports = new Map<string, IntegrityReportDoc>();
  private readonly memSuspicion = new Map<string, number>();

  constructor(
    private readonly store?: AccountsStore,
    /** Injected only so a test can pin `receivedAt`. */
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /**
   * Store `body` and bump every suspect account's count, AT MOST ONCE per room.
   *
   * The report arrives at-least-once (the gameserver retries it with the settlement budget),
   * so the room id is claimed first, in the same transaction as the counts — the pattern
   * `RatingStore.applyMatchOnce` argues in full. A lost claim writes nothing and returns
   * false. The callback may run twice under `withTransaction`, so the clock is read once,
   * out here, and `recorded` is reset at the top of every attempt.
   */
  async recordOnce(body: IntegrityReportBody): Promise<boolean> {
    const receivedAt = this.nowMs();
    const doc = toDoc(body, receivedAt);
    const accounts = suspectAccounts(body);
    const store = this.store;
    if (!store) {
      if (this.memReports.has(doc._id)) return false;
      this.memReports.set(doc._id, doc);
      for (const id of accounts) this.memSuspicion.set(id, (this.memSuspicion.get(id) ?? 0) + 1);
      return true;
    }

    const session = store.client.startSession();
    try {
      let recorded = false;
      await session.withTransaction(async () => {
        recorded = false;
        const { _id, ...fields } = doc;
        const claim = await store.integrityReports.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true, session });
        if (claim.upsertedCount !== 1) return;
        for (const accountId of accounts) {
          await store.suspicion.updateOne(
            { _id: accountId },
            { $inc: { count: 1 }, $set: { lastRoomId: _id, lastAt: receivedAt } },
            { upsert: true, session },
          );
        }
        recorded = true;
      });
      return recorded;
    } finally {
      await session.endSession();
    }
  }

  /** How many records have named `accountId`; 0 for one never named. */
  async suspicionCount(accountId: string): Promise<number> {
    if (!this.store) return this.memSuspicion.get(accountId) ?? 0;
    return (await this.store.suspicion.findOne({ _id: accountId }))?.count ?? 0;
  }
}

function toDoc(body: IntegrityReportBody, receivedAt: number): IntegrityReportDoc {
  return {
    _id: body.roomId,
    receivedAt,
    verdict: body.verdict,
    ...(body.bounds !== undefined ? { bounds: body.bounds } : {}),
    playerCount: body.playerCount,
    seed: body.seed,
    engineVersion: body.engineVersion,
    settleFrame: body.settleFrame,
    suspects: body.suspects,
    absent: body.absent,
    // BSON document keys are strings; the seat index survives as one.
    seatAccounts: Object.fromEntries(Object.entries(body.seatAccounts)),
    ...(body.logGzipB64 !== undefined ? { log: new Binary(Buffer.from(body.logGzipB64, 'base64')) } : {}),
    ...(body.logDropped ? { logDropped: true } : {}),
  };
}
