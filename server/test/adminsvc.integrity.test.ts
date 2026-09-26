/**
 * The ops console's integrity tab (design/15, "PvP integrity", decided 2026-09-26): the view's
 * two queries against a real `accounts` database, and the renderer's formatting decisions on
 * hand-built rows — a guest suspect, a missing account, a dropped log, a hostile name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { accountsStore, ensureAccountsIndexes, type AccountDoc } from '../src/db';
import { IntegrityStore } from '../src/integrity';
import type { IntegrityReportBody } from '../src/integrityReport';
import { integrityView, type IntegrityView } from '../src/adminsvc/views/integrity';
import { integritySection } from '../src/adminsvc/page/integrity';
import { openTestMongo, type MongoTestContext } from './mongoHarness';

let ctx: MongoTestContext;
let db: Db;

beforeEach(async () => {
  ctx = await openTestMongo();
  db = ctx.db('accounts');
  await ensureAccountsIndexes(db);
});

afterEach(async () => {
  await ctx.dispose();
});

const account = (id: string, username: string, displayName?: string): AccountDoc =>
  ({ _id: id, username, passwordHash: 'h', provider: 'local', createdAt: 1, ...(displayName ? { displayName } : {}) }) as AccountDoc;

function report(roomId: string, over: Partial<IntegrityReportBody> = {}): IntegrityReportBody {
  return {
    roomId,
    verdict: 'dissent',
    playerCount: 4,
    seed: 3,
    engineVersion: 75,
    settleFrame: 900,
    suspects: [],
    seatAccounts: {},
    ...over,
  };
}

describe('integrityView', () => {
  it('lists records newest first and suspects most-named first, with names resolved', async () => {
    await db.collection<AccountDoc>('accounts').insertMany([account('a1', 'zoe'), account('a2', 'cg:9', 'Portal Pat')]);
    let now = 100;
    const store = new IntegrityStore(accountsStore(db), () => now);
    await store.recordOnce(report('r-old', { suspects: [{ seat: 0, accountId: 'a2', dissented: true, kicked: false }] }));
    now = 200;
    await store.recordOnce(
      report('r-new', {
        verdict: 'bounds',
        bounds: 'too_short',
        suspects: [
          { seat: 0, accountId: 'a2', dissented: false, kicked: true },
          { seat: 1, accountId: 'gone', dissented: true, kicked: false },
          { seat: 2, dissented: true, kicked: false },
        ],
        logGzipB64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'),
      }),
    );

    const view = await integrityView(db);
    expect(view.reports.map((r) => r.roomId)).toEqual(['r-new', 'r-old']);
    expect(view.reports[0]).toMatchObject({ verdict: 'bounds', bounds: 'too_short', receivedAtMs: 200, logBytes: 5 });
    expect(view.reports[1]).toMatchObject({ bounds: null, logBytes: null });
    expect(view.reports[0]!.suspects).toEqual([
      { seat: 0, accountId: 'a2', name: 'Portal Pat', dissented: false, kicked: true }, // display name wins
      { seat: 1, accountId: 'gone', name: null, dissented: true, kicked: false }, // no such account
      { seat: 2, accountId: null, name: null, dissented: true, kicked: false }, // a guest
    ]);
    expect(view.suspects).toEqual([
      { accountId: 'a2', name: 'Portal Pat', count: 2, lastRoomId: 'r-new', lastAtMs: 200 },
      { accountId: 'gone', name: null, count: 1, lastRoomId: 'r-new', lastAtMs: 200 },
    ]);
  });

  it('answers two empty lists on an empty database, without a name lookup', async () => {
    expect(await integrityView(db)).toEqual({ reports: [], suspects: [] });
  });

  it('honours the page size', async () => {
    const store = new IntegrityStore(accountsStore(db));
    for (const id of ['r1', 'r2', 'r3']) await store.recordOnce(report(id));
    expect((await integrityView(db, 2)).reports).toHaveLength(2);
  });
});

describe('integritySection', () => {
  it('says so when both lists are empty, rather than drawing empty tables', () => {
    const html = integritySection({ reports: [], suspects: [] });
    expect(html).toContain('No account has been named');
    expect(html).toContain('No PvP match has failed to settle cleanly');
    expect(html).not.toContain('<table>');
  });

  it('renders every shape of suspect and escapes player-chosen text', () => {
    const view: IntegrityView = {
      suspects: [
        { accountId: 'a1', name: '<b>zoe</b>', count: 3, lastRoomId: 'r1', lastAtMs: 0 },
        { accountId: 'a9', name: null, count: 1, lastRoomId: 'r1', lastAtMs: 0 },
      ],
      reports: [
        {
          roomId: 'r1',
          receivedAtMs: 0,
          verdict: 'dissent',
          bounds: null,
          playerCount: 4,
          seed: 3,
          engineVersion: 75,
          settleFrame: 900,
          suspects: [
            { seat: 0, accountId: 'a1', name: '<b>zoe</b>', dissented: true, kicked: true },
            { seat: 2, accountId: null, name: null, dissented: true, kicked: false },
          ],
          logBytes: 42,
        },
        {
          roomId: 'r2',
          receivedAtMs: 0,
          verdict: 'bounds',
          bounds: 'too_short',
          playerCount: 2,
          seed: 4,
          engineVersion: 75,
          settleFrame: 10,
          suspects: [],
          logBytes: null,
        },
      ],
    };
    const html = integritySection(view);
    expect(html).not.toContain('<b>zoe</b>');
    expect(html).toContain('&lt;b&gt;zoe&lt;/b&gt;');
    expect(html).toContain('<code>a9</code>'); // no name: the id alone
    expect(html).toContain('(dissented, kicked)');
    expect(html).toContain('guest/bot');
    expect(html).toContain('nobody');
    expect(html).toContain('<code>too_short</code>');
    expect(html).toContain('>42<');
    expect(html).toContain('dropped');
  });
});
