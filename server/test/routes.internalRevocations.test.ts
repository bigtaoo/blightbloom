/**
 * `POST /internal/entitlements/revoke` (ROADMAP 9.3) through a real matchsvc — the receiving
 * end of a refund's revocation. The case worth reading first is 'does not take away what the
 * account holds for another reason': a refund gives back the money for ONE purchase, and an
 * entitlement that was also earned (a boss drop) or bought under another order must survive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMatchsvcServer } from '../src/matchsvc';
import type { AccountsStore } from '../src/db';
import { freshAccounts } from './mongoHarness';
import { EntitlementService } from '../src/EntitlementService';
import { INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { INTERNAL_REVOKE_PATH } from '../src/routes/internalRevocations';
import { REVOKE_PATH } from '../src/billsvc/deliveryPump';

const KEY = 'test-internal-key';

let server: Server;
let store: AccountsStore;
let baseUrl: string;
let entitlements: EntitlementService;

beforeEach(async () => {
  vi.stubEnv('BB_INTERNAL_KEY', KEY);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = await freshAccounts();
  entitlements = new EntitlementService(store);
  server = createMatchsvcServer({ store, secret: 'test-secret' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function revoke(body: unknown, key: string | null = KEY): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers[INTERNAL_KEY_HEADER] = key;
  const res = await fetch(`${baseUrl}${INTERNAL_REVOKE_PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const body = (over: Record<string, unknown> = {}) => ({
  deliveryId: 'reversal:paddle:txn_1',
  accountId: 'acc-1',
  sku: 'bp.cannon',
  orderId: 'o1',
  grants: [{ kind: 'blueprint', id: 'cannon' }],
  ts: 1,
  ...over,
});

describe('POST /internal/entitlements/revoke', () => {
  it('agrees with the pump about where it lives', () => {
    expect(INTERNAL_REVOKE_PATH).toBe(REVOKE_PATH);
  });

  it('removes the entitlement this purchase delivered', async () => {
    await entitlements.grant('acc-1', 'blueprint:cannon', 'purchase', { orderId: 'o1' });
    const res = await revoke(body());
    expect(res).toEqual({ status: 200, body: { ok: true, revoked: ['blueprint:cannon'], notHeld: [] } });
    expect(await entitlements.owns('acc-1', 'blueprint:cannon')).toBe(false);
  });

  it('is idempotent: revoking again answers 200 with notHeld', async () => {
    await entitlements.grant('acc-1', 'blueprint:cannon', 'purchase', { orderId: 'o1' });
    await revoke(body());
    const again = await revoke(body());
    expect(again).toEqual({ status: 200, body: { ok: true, revoked: [], notHeld: ['blueprint:cannon'] } });
  });

  it('does not take away what the account holds for another reason', async () => {
    await entitlements.grant('acc-1', 'blueprint:cannon', 'drop');
    await entitlements.grant('acc-1', 'character:skirmisher', 'purchase', { orderId: 'a-different-order' });
    const res = await revoke(body({ grants: [{ kind: 'blueprint', id: 'cannon' }, { kind: 'character', id: 'skirmisher' }] }));
    expect(res.body).toMatchObject({ revoked: [], notHeld: ['blueprint:cannon', 'character:skirmisher'] });
    expect(await entitlements.owns('acc-1', 'blueprint:cannon')).toBe(true);
    expect(await entitlements.owns('acc-1', 'character:skirmisher')).toBe(true);
  });

  it.each([
    ['a null body', null],
    ['no accountId', body({ accountId: '' })],
    ['no orderId', body({ orderId: undefined })],
    ['an empty grant list', body({ grants: [] })],
    ['a grant list that is not an array', body({ grants: 'cannon' })],
    ['an unknown grant kind', body({ grants: [{ kind: 'coin', id: 'x' }] })],
  ])('refuses %s with a 400 (terminal for the pump)', async (_l, b) => {
    expect((await revoke(b)).status).toBe(400);
  });

  it('refuses a missing or wrong internal key with a 401', async () => {
    expect((await revoke(body(), null)).status).toBe(401);
    expect((await revoke(body(), 'wrong')).status).toBe(401);
  });

  it('a failing write is a 500 (retryable), never a 4xx', async () => {
    vi.spyOn(EntitlementService.prototype, 'revokePurchase').mockRejectedValue(new Error('pool closed'));
    expect((await revoke(body())).status).toBe(500);
  });

  it('a body with no deliveryId still logs, as (none)', async () => {
    const res = await revoke(body({ deliveryId: undefined }));
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("revocation '(none)'"));
  });
});
