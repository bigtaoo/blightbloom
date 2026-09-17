/**
 * The one-time device merge over real HTTP, driven by the SHIPPED CLIENT (design/16 hole 1).
 *
 * ## What this catches, measured rather than asserted
 *
 * `routes.account.test.ts` drives the handlers with a hand-built request; `client/src/net/
 * auth.test.ts` and `entitlements.test.ts` drive the client against a `vi.fn()` fetch. Each
 * restates the contract instead of meeting the other half of it, so neither can see the two
 * halves disagree. Four string literals live on both sides of this wire. Renaming each one on
 * the SERVER only — which is what drift looks like — gives:
 *
 * | one-sided rename | client unit suites | `routes.account.test.ts` | this file |
 * | --- | --- | --- | --- |
 * | `guestMerged` -> `merged`   | green | RED   | RED |
 * | `claimed` -> `ok`           | green | RED   | RED |
 * | body `guestId` -> `installId` | green | RED | RED |
 * | header `x-guest-id` -> `x-install-id` | green | **green** | RED |
 *
 * **The client column is green on all four**, which is the honest summary: the client half of
 * this wire is tested entirely against a fetch that answers whatever the test says, so no
 * client suite can ever notice the server disagreeing. And the last row is why this file
 * exists on its own merits rather than as a belt on somebody else's braces — the server's own
 * suite imports `GUEST_ID_HEADER` from the source, so renaming the constant renames both
 * sides of its own assertion and it stays green over a header no browser will ever send. A
 * test that reads the value it writes cannot catch a rename of that value; only a second
 * party can.
 *
 * What that failure costs, in the shape it would actually take: `fetchAccountState` reads
 * `json?.guestMerged !== false`, so a server that stopped answering the field at all — or
 * stopped seeing the header that makes it meaningful — reports `undefined !== false`, i.e.
 * `true`, i.e. "this device has already been through the question", for every device
 * forever. The merge is silently never offered again and nothing anywhere turns red.
 *
 * It takes the same shape as `store.proxy.http.test.ts` and for the same reason: the caller
 * here is `client/src/net/*` itself, imported through the `@dd/net/*` alias, so what is
 * asserted is the shipped contract rather than a second copy of it.
 *
 * ## What is deliberately NOT here
 *
 * The merge arithmetic and the decision around it (`meta/guestMerge.ts`,
 * `OnlineMatch.resolveAccountMeta`) are the client's, are pure, and have their own suites.
 * `client/src/meta/` is not on the `@dd/*` alias map either — only `net` and `game` are —
 * which is a fair boundary rather than an obstacle: what needs a live server is the wire, and
 * what needs a live server is exactly what is here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import { freshAccounts } from './mongoHarness';
import { claimGuestMerge } from '@dd/net/auth';
import { fetchAccountState, type AccountState } from '@dd/net/entitlements';

let baseUrl: string;
let server: Server;
let ada: string;
let bob: string;

/** This browser, as `client/src/net/identity.ts`'s `getInstallId()` would answer. */
const DEVICE = 'install-e2e-7';
const OTHER_DEVICE = 'install-e2e-9';

async function register(username: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct horse battery' }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`register failed: ${body.error}`);
  return body.token;
}

/** `fetchAccountState` narrowed past its 401 arm — every call here holds a live session, and
 *  a 401 reaching one of these would be a failure of this file's own setup. */
async function state(token: string, guestId?: string): Promise<AccountState> {
  const result = await fetchAccountState(baseUrl, token, { guestId });
  if (typeof result === 'string') throw new Error(`unexpected 401 for a live session`);
  return result;
}

beforeAll(async () => {
  server = createMatchsvcServer({ store: await freshAccounts() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ada = await register('adamerge');
  bob = await register('bobmerge');
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    // undici keeps its sockets alive, so `close()` alone never fires its callback here.
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

describe('the guest-merge wire, end to end through the shipped client', () => {
  it('offers the merge once, then never again on that device', async () => {
    // The whole feature, in the order a player meets it. Every field crossing the wire here
    // is read by the client module that will read it in production.
    expect((await state(ada, DEVICE)).guestMerged).toBe(false);

    expect(await claimGuestMerge(baseUrl, ada, DEVICE)).toBe(true);
    expect((await state(ada, DEVICE)).guestMerged).toBe(true);

    // The second claim is the two-tabs race collapsed into sequence. `false` is what makes
    // the loser take the account's state instead of adding the same bank twice.
    expect(await claimGuestMerge(baseUrl, ada, DEVICE)).toBe(false);
    expect((await state(ada, DEVICE)).guestMerged).toBe(true);
  });

  it('is per-device: a second browser on the same account is still unmerged', async () => {
    expect((await state(ada, OTHER_DEVICE)).guestMerged).toBe(false);
  });

  it('is per-account: the same browser is still unmerged against a different account', async () => {
    // The shared computer, which is the case the whole "merge once" rule is shaped around —
    // and the one a device-only key would get wrong by handing the second player the first
    // player's materials.
    expect((await state(bob, DEVICE)).guestMerged).toBe(false);
  });

  it('answers true when the client sends no device id at all', async () => {
    // `pullAccountMeta`'s callers (the store's ownership refresh) pass no `guestId`, so this
    // is a real production shape rather than a defensive one. "Offer nothing" is the answer
    // that cannot lose data.
    expect((await state(ada)).guestMerged).toBe(true);
  });

  it('a rejected session comes back as ACCOUNT_UNAUTHORIZED rather than throwing', async () => {
    // Hole 2's check, against a real 401 from a real server rather than a stubbed status.
    // The client distinguishes this from a network failure and nothing else does.
    expect(await fetchAccountState(baseUrl, 'not-a-token', { guestId: DEVICE })).toBe('unauthorized');
  });

  it('a rejected session cannot claim a device either', async () => {
    await expect(claimGuestMerge(baseUrl, 'not-a-token', DEVICE)).rejects.toThrow();
    // ...and the refusal left no trace: the device is still claimable by its real owner.
    expect((await state(bob, DEVICE)).guestMerged).toBe(false);
  });
});
