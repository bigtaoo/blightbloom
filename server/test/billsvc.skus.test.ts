/**
 * The server-side SKU table (design/19-server-platform.md §4's "price comes from a
 * server-side SKU table") and its payment-parameter dispatch.
 *
 * The interesting case is the CONSISTENCY one at the bottom: every SKU's grant id is
 * checked against the engine's REAL content catalogues, so a SKU naming a blueprint that
 * was deleted or reclassified out of `source: 'purchase'` fails here instead of shipping as
 * a product that sells nothing. That check reads the production catalogue directly rather
 * than re-deriving the SKU list from it — a sweep that generated its own input would pass
 * unchanged no matter what this table said.
 */
import { describe, it, expect } from 'vitest';
import { findSku, listSkus, SKU_CATALOG } from '../src/billsvc/skus';
import { paymentParamsFor } from '../src/billsvc/paymentParams';
import { BLUEPRINT_CATALOG } from '@dd/engine/content/blueprints';
import { SKIN_DEFS } from '@dd/engine/content/skins';

describe('the SKU catalogue', () => {
  it('is not empty — an empty store is a silently broken one', () => {
    expect(listSkus().length).toBeGreaterThan(0);
  });

  it('lists in a stable order, so a client can cache the response', () => {
    expect(listSkus().map((s) => s.sku)).toEqual(Object.keys(SKU_CATALOG));
  });

  it('keys every entry by its own `sku`, so a lookup and a listing cannot disagree', () => {
    for (const [key, def] of Object.entries(SKU_CATALOG)) expect(def.sku).toBe(key);
  });

  it('prices everything in positive minor units of a single currency', () => {
    for (const def of listSkus()) {
      expect(def.amountCents).toBeGreaterThan(0);
      expect(Number.isInteger(def.amountCents)).toBe(true);
      expect(def.currency).toBe('CNY');
      expect(def.title.length).toBeGreaterThan(0);
    }
  });

  it('grants at least one named thing per SKU, and never a quantity', () => {
    // design/14 locks bounded direct purchase with no wallet: a SKU is own-or-not, so
    // there is deliberately nowhere on a grant to put an amount. If a `qty`/`count`/
    // `coins` field ever appears here, an economy came with it.
    for (const def of listSkus()) {
      expect(def.grants.length).toBeGreaterThan(0);
      for (const g of def.grants) {
        expect(['blueprint', 'character']).toContain(g.kind);
        expect(g.id.length).toBeGreaterThan(0);
        expect(Object.keys(g).sort()).toEqual(['id', 'kind']);
      }
    }
  });
});

describe('findSku', () => {
  it('finds a real SKU', () => {
    expect(findSku('bp.cannon')?.sku).toBe('bp.cannon');
  });

  it('misses an invented one, rather than defaulting a price', () => {
    expect(findSku('bp.nope')).toBeUndefined();
  });

  it('misses non-strings, which is how an id arrives off a JSON body', () => {
    expect(findSku(undefined)).toBeUndefined();
    expect(findSku(null)).toBeUndefined();
    expect(findSku(42)).toBeUndefined();
    expect(findSku(['bp.cannon'])).toBeUndefined();
  });

  it('does not resolve an inherited Object key as a product', () => {
    // A plain `SKU_CATALOG[sku]` would hand back `Object.prototype.constructor` here and
    // then read `.amountCents` off a function.
    expect(findSku('__proto__')).toBeUndefined();
    expect(findSku('constructor')).toBeUndefined();
    expect(findSku('toString')).toBeUndefined();
    expect(findSku('hasOwnProperty')).toBeUndefined();
  });
});

describe('paymentParamsFor', () => {
  const order = { id: 'o1', sku: 'bp.cannon', amountCents: 1800, currency: 'CNY' };

  it('hands a dev client everything it needs to settle its own order', () => {
    const p = paymentParamsFor('dev', order, true);
    expect(p.configured).toBe(true);
    expect(p.params).toEqual({ orderId: 'o1', receipt: 'product:bp.cannon', txnId: 'devtxn-o1' });
  });

  it('hands out NO receipt when the dev stub is disabled', () => {
    // A receipt the verifier will refuse is worse than no receipt: the client would start a
    // payment flow that cannot possibly settle.
    const p = paymentParamsFor('dev', order, false);
    expect(p.configured).toBe(false);
    expect(p.params).toEqual({});
    expect(p.note).toContain('disabled');
  });

  it.each([['apple'], ['google'], ['wechat'], ['stripe']] as const)(
    '%s reports not-configured with an empty block, never a plausible unsigned one',
    (platform) => {
      const p = paymentParamsFor(platform, order, true);
      expect(p.configured).toBe(false);
      expect(p.params).toEqual({});
      expect(p.note).toContain(platform);
    },
  );

  it('the dev stub flag does not leak into a real platform either way', () => {
    for (const platform of ['apple', 'google', 'wechat', 'stripe'] as const) {
      expect(paymentParamsFor(platform, order, true)).toEqual(paymentParamsFor(platform, order, false));
    }
  });

  it("names google/wechat/stripe's real SDK fields, so filling them in is a bounded edit", () => {
    expect(paymentParamsFor('wechat', order, false).note).toContain('prepayId');
    expect(paymentParamsFor('google', order, false).note).toContain('obfuscatedAccountId');
    expect(paymentParamsFor('stripe', order, false).note).toContain('checkoutSessionId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consistency against the engine's real content
// ─────────────────────────────────────────────────────────────────────────────

describe('every SKU sells something that actually exists', () => {
  it('names only blueprints in the engine catalogue', () => {
    for (const def of listSkus()) {
      for (const g of def.grants) {
        if (g.kind !== 'blueprint') continue;
        expect(BLUEPRINT_CATALOG[g.id], `SKU '${def.sku}' grants unknown blueprint '${g.id}'`).toBeDefined();
      }
    }
  });

  it("sells only blueprints the engine marks source: 'purchase'", () => {
    // design/14: 'drop' blueprints are the free STARTER set, unlocked at account creation,
    // and 'event' ones are earned. Selling either is a double-grant at best.
    for (const def of listSkus()) {
      for (const g of def.grants) {
        if (g.kind !== 'blueprint') continue;
        expect(BLUEPRINT_CATALOG[g.id]!.source, `SKU '${def.sku}' sells a non-purchase blueprint`).toBe('purchase');
      }
    }
  });

  it('names only characters in the engine roster', () => {
    for (const def of listSkus()) {
      for (const g of def.grants) {
        if (g.kind !== 'character') continue;
        expect(SKIN_DEFS[g.id], `SKU '${def.sku}' grants unknown character '${g.id}'`).toBeDefined();
      }
    }
  });

  it('sells exactly one character — skirmisher (Task 8, "vanguard=free, skirmisher=paid, juggernaut=event", 2026-09-23)', () => {
    // Pinned so a roster change (a 4th character, or a different paid pick) is a
    // deliberate edit that has to come back through here and through design/14.
    const characters = listSkus().flatMap((s) => s.grants.filter((g) => g.kind === 'character'));
    expect(characters.map((g) => g.id)).toEqual(['skirmisher']);
    expect(Object.keys(SKIN_DEFS).length).toBe(3);
  });

  it('never sells vanguard (the free default) or juggernaut (reserved for an unbuilt event path)', () => {
    const soldCharacterIds = new Set(
      listSkus().flatMap((s) => s.grants.filter((g) => g.kind === 'character').map((g) => g.id)),
    );
    expect(soldCharacterIds.has('vanguard')).toBe(false);
    expect(soldCharacterIds.has('juggernaut')).toBe(false);
  });

  it('grants each blueprint from at most one SKU', () => {
    const ids = listSkus().flatMap((s) => s.grants.map((g) => `${g.kind}:${g.id}`));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
