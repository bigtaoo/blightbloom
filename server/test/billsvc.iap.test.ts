/**
 * The IAP layer (design/19-server-platform.md §5): the dev stub, the four real adapters,
 * and the factory's FIRST fail-closed defence.
 *
 * The cases that matter here are not the happy path — the happy path is one line. They are
 * the refusals, because every one of them is a branch whose *line* runs on every call
 * while only the taken side is normally exercised:
 *
 *   - `NODE_ENV=production` + `BB_BILLING_DEV_STUB=1` must be INERT, not enabled. That is
 *     one boolean's ordering, and getting it backwards ships a production billing plane
 *     that grants any SKU to anyone who can name it.
 *   - Missing credentials must FAIL, never fall back to the stub. The fallback is the
 *     tempting version ("so local dev works"), and it is the one design/19 forbids.
 *   - A real adapter must RETURN a failure rather than throw, so one unconfigured platform
 *     cannot 500 the shared webhook route for the others.
 */
import { describe, it, expect } from 'vitest';
import { asIapPlatform, missingCredentials, type IapVerifyResult } from '../src/billsvc/iap/types';
import {
  DEV_RECEIPT_PREFIX,
  devStubReceiptFor,
  isDevStubReceipt,
  verifyDevStubReceipt,
} from '../src/billsvc/iap/devStub';
import { createReceiptVerifier, devStubEnabled, isProductionEnv } from '../src/billsvc/iap/factory';
import { verifyAppleReceipt } from '../src/billsvc/iap/apple';
import { verifyGoogleReceipt } from '../src/billsvc/iap/google';
import { verifyWechatReceipt } from '../src/billsvc/iap/wechat';
import { verifyStripeReceipt } from '../src/billsvc/iap/stripe';

const reason = (r: IapVerifyResult): string => (r.ok ? '<ok>' : r.reason);

// ─────────────────────────────────────────────────────────────────────────────
// types.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('asIapPlatform', () => {
  it('accepts exactly the five known platforms', () => {
    for (const p of ['apple', 'google', 'wechat', 'stripe', 'dev']) {
      expect(asIapPlatform(p)).toBe(p);
    }
  });

  it.each([['paypal'], [''], ['Apple'], ['APPLE']])('rejects the unknown platform %j', (p) => {
    expect(asIapPlatform(p)).toBeUndefined();
  });

  it('rejects non-strings, which is how a JSON body arrives', () => {
    expect(asIapPlatform(undefined)).toBeUndefined();
    expect(asIapPlatform(null)).toBeUndefined();
    expect(asIapPlatform(7)).toBeUndefined();
    expect(asIapPlatform({ platform: 'apple' })).toBeUndefined();
  });

  it('does not resolve an inherited Array method name as a platform', () => {
    // `PLATFORMS.includes` is the check; a prototype-key probe must not sneak past it.
    expect(asIapPlatform('includes')).toBeUndefined();
    expect(asIapPlatform('constructor')).toBeUndefined();
  });
});

describe('missingCredentials', () => {
  it('is a failure that names the platform and says nothing was granted', () => {
    const r = missingCredentials('wechat', 'merchant id');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('wechat');
    expect(r.reason).toContain('merchant id');
    expect(r.reason).toContain('nothing granted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// devStub.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('the dev receipt stub', () => {
  it('resolves `product:<sku>` to that SKU', () => {
    const r = verifyDevStubReceipt('product:bp.cannon');
    expect(r).toEqual({ ok: true, product: 'bp.cannon' });
  });

  it('round-trips devStubReceiptFor', () => {
    const receipt = devStubReceiptFor('bp.leech');
    expect(receipt).toBe(`${DEV_RECEIPT_PREFIX}bp.leech`);
    expect(verifyDevStubReceipt(receipt)).toEqual({ ok: true, product: 'bp.leech' });
  });

  it('supplies no platformTxnId — which is exactly why settle() also claims the receipt row', () => {
    const r = verifyDevStubReceipt('product:bp.cannon');
    expect(r.ok && r.platformTxnId).toBeUndefined();
  });

  it('refuses a receipt with the prefix but no SKU rather than resolving to the empty product', () => {
    // Resolving to '' would sail through and surface two layers up as a confusing
    // product-mismatch against whatever order it was posted at.
    expect(verifyDevStubReceipt('product:')).toEqual({ ok: false, reason: 'dev: stub receipt names no SKU' });
    expect(verifyDevStubReceipt('product:   ')).toEqual({ ok: false, reason: 'dev: stub receipt names no SKU' });
  });

  it('refuses anything not carrying the prefix', () => {
    expect(reason(verifyDevStubReceipt('bp.cannon'))).toContain('not a "product:<sku>" stub receipt');
    expect(reason(verifyDevStubReceipt(''))).toContain('not a');
    // The prefix has to be at the START; a receipt merely containing it is not a stub receipt.
    expect(verifyDevStubReceipt('MIIabc-product:bp.cannon').ok).toBe(false);
  });

  it('isDevStubReceipt says nothing about policy — only about the prefix', () => {
    expect(isDevStubReceipt('product:x')).toBe(true);
    expect(isDevStubReceipt('MIIabc')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// factory.ts — fail-closed defence #1
// ─────────────────────────────────────────────────────────────────────────────

describe('isProductionEnv', () => {
  it('is true for exactly NODE_ENV=production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
  });

  it.each([[undefined], ['dev'], ['development'], ['test'], ['Production'], ['prod'], ['']])(
    'is false for NODE_ENV=%j',
    (v) => {
      expect(isProductionEnv({ NODE_ENV: v })).toBe(false);
    },
  );
});

describe('devStubEnabled', () => {
  it('is off with no flag set at all', () => {
    expect(devStubEnabled({})).toBe(false);
  });

  it.each([['1'], ['true']])('is on outside production with the flag set to %j', (flag) => {
    expect(devStubEnabled({ BB_BILLING_DEV_STUB: flag })).toBe(true);
    expect(devStubEnabled({ NODE_ENV: 'test', BB_BILLING_DEV_STUB: flag })).toBe(true);
  });

  it.each([['0'], ['false'], ['yes'], ['on'], ['']])('does not treat %j as on', (flag) => {
    expect(devStubEnabled({ BB_BILLING_DEV_STUB: flag })).toBe(false);
  });

  it('DEFENCE 1: a mis-set flag is inert under NODE_ENV=production', () => {
    // The production check must come FIRST and return without consulting the flag. If this
    // ever flips, a production billing plane hands out any SKU for a `product:` string.
    expect(devStubEnabled({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' })).toBe(false);
    expect(devStubEnabled({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: 'true' })).toBe(false);
  });
});

describe('createReceiptVerifier', () => {
  it('resolves a product: receipt on ANY platform while the stub is on', async () => {
    // This is the property that makes /webhook/apple drivable with no Apple account.
    const verify = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });
    for (const p of ['apple', 'google', 'wechat', 'stripe', 'dev'] as const) {
      await expect(verify(p, 'product:bp.cannon')).resolves.toEqual({ ok: true, product: 'bp.cannon' });
    }
  });

  it('DEFENCE 1, end to end: the same receipt is refused under production', async () => {
    const verify = createReceiptVerifier({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' });
    for (const p of ['apple', 'google', 'wechat', 'stripe', 'dev'] as const) {
      const r = await verify(p, 'product:bp.cannon');
      expect(r.ok).toBe(false);
    }
  });

  it('does NOT fall back to the stub when a platform has no credentials', async () => {
    // The tempting bug: "no Apple secret, so treat it as dev". design/19 §5 forbids it —
    // missing credentials mean verification FAILS and nothing is granted.
    const verify = createReceiptVerifier({});
    const r = await verify('apple', 'product:bp.cannon');
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('not configured');
  });

  it("routes a non-stub receipt to its own platform's adapter, and each fails closed", async () => {
    const verify = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });
    expect(reason(await verify('apple', 'MIIapple'))).toContain('apple:');
    expect(reason(await verify('google', '{"purchaseToken":"x"}'))).toContain('google:');
    expect(reason(await verify('wechat', '42000'))).toContain('wechat:');
    expect(reason(await verify('stripe', 'cs_test_1'))).toContain('stripe:');
  });

  it("the 'dev' platform refuses when the stub is disabled", async () => {
    const verify = createReceiptVerifier({});
    expect(reason(await verify('dev', 'product:bp.cannon'))).toContain('dev stub is disabled');
  });

  it("the 'dev' platform still validates the prefix when the stub IS enabled", async () => {
    // Reaching the 'dev' case with the stub on means the receipt was malformed for it.
    const verify = createReceiptVerifier({ BB_BILLING_DEV_STUB: '1' });
    expect(reason(await verify('dev', 'not-a-stub-receipt'))).toContain('not a');
  });

  it('reads credentials once at construction, not per call', async () => {
    // Constructed under a fully-credentialled env, so each adapter gets past its
    // missing-credential arm and lands on the not-implemented one.
    const verify = createReceiptVerifier({
      BB_APPLE_SHARED_SECRET: 's',
      BB_GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      BB_GOOGLE_PACKAGE_NAME: 'com.example',
      BB_WECHAT_MCH_ID: 'm',
      BB_WECHAT_API_V3_KEY: 'k',
      BB_STRIPE_SECRET_KEY: 'sk',
    });
    expect(reason(await verify('apple', 'MII'))).toContain('not implemented');
    expect(reason(await verify('google', '{}'))).toContain('not implemented');
    expect(reason(await verify('wechat', '4200'))).toContain('not implemented');
    expect(reason(await verify('stripe', 'cs'))).toContain('not implemented');
  });

  it('defaults to process.env when no env is passed', async () => {
    // The production default in vitest is NODE_ENV=test with no billing vars, so the
    // no-argument call must land on a refusal rather than throwing.
    const verify = createReceiptVerifier();
    expect((await verify('apple', 'MII')).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real adapters. Every outcome is a failure, and none of them throws.
// ─────────────────────────────────────────────────────────────────────────────

describe('the real platform adapters', () => {
  it('apple: no shared secret → a named failure', async () => {
    expect(reason(await verifyAppleReceipt('MII', {}))).toContain('shared secret not configured');
  });

  it('apple: secret present, empty receipt → a different failure', async () => {
    expect(reason(await verifyAppleReceipt('', { sharedSecret: 's' }))).toBe('apple: empty receipt');
  });

  it('apple: secret + receipt → unverified, NOT a fabricated success', async () => {
    // design/19 §9: no Apple credential exists in this project, so this adapter cannot be
    // verified and must never report ok.
    const r = await verifyAppleReceipt('MII', { sharedSecret: 's' });
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('not implemented');
  });

  it('google: both credentials are checked independently', async () => {
    expect(reason(await verifyGoogleReceipt('{}', {}))).toContain('service-account JSON not configured');
    expect(reason(await verifyGoogleReceipt('{}', { serviceAccountJson: '{}' }))).toContain(
      'package name not configured',
    );
    expect(reason(await verifyGoogleReceipt('', { serviceAccountJson: '{}', packageName: 'p' }))).toBe(
      'google: empty receipt',
    );
    expect((await verifyGoogleReceipt('{}', { serviceAccountJson: '{}', packageName: 'p' })).ok).toBe(false);
  });

  it('wechat: both credentials are checked independently', async () => {
    expect(reason(await verifyWechatReceipt('4200', {}))).toContain('merchant id not configured');
    expect(reason(await verifyWechatReceipt('4200', { mchId: 'm' }))).toContain('APIv3 key not configured');
    expect(reason(await verifyWechatReceipt('', { mchId: 'm', apiV3Key: 'k' }))).toBe('wechat: empty transaction id');
    expect((await verifyWechatReceipt('4200', { mchId: 'm', apiV3Key: 'k' })).ok).toBe(false);
  });

  it('stripe: the secret key gates it, the webhook secret does not', async () => {
    // The webhook signing secret authenticates the CALLER, which is a route concern —
    // its absence must not block a purchase lookup that has a usable API key.
    expect(reason(await verifyStripeReceipt('cs', { webhookSecret: 'whsec' }))).toContain(
      'secret API key not configured',
    );
    expect(reason(await verifyStripeReceipt('', { secretKey: 'sk' }))).toBe('stripe: empty session id');
    expect((await verifyStripeReceipt('cs', { secretKey: 'sk' })).ok).toBe(false);
  });

  it('none of them throws — one unconfigured platform must not 500 the shared webhook route', async () => {
    await expect(verifyAppleReceipt('', {})).resolves.toBeTruthy();
    await expect(verifyGoogleReceipt('', {})).resolves.toBeTruthy();
    await expect(verifyWechatReceipt('', {})).resolves.toBeTruthy();
    await expect(verifyStripeReceipt('', {})).resolves.toBeTruthy();
  });
});
