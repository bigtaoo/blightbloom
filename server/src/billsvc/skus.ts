/**
 * The SERVER-SIDE SKU table (design/19-server-platform.md §4). A content table of free
 * functions — CLAUDE.md's first split form.
 *
 * This file exists because of one rule: "Price comes from a server-side SKU table. An
 * `amount` in the request body is discarded." A client says WHICH SKU it wants and
 * nothing else; the money and the currency are read from here. `BillingService` never
 * looks at a caller-supplied amount, and there is no code path that could.
 *
 * WHAT A SKU GRANTS, AND WHAT IT DOES NOT. `design/14-meta-forging.md` locks bounded
 * direct purchase: RMB buys weapon blueprints (PvE-only, weapons never enter the arena)
 * and characters (PvP-relevant but side-grades only). There is NO wallet, no currency and
 * no gacha, so a SKU grants a named, finite thing and never a balance — `grants` is a
 * list of `(kind, id)` pairs, and there is deliberately nowhere to put a quantity.
 *
 * The blueprint ids below are the engine's real `source: 'purchase'` catalogue entries
 * (`engine/content/blueprints.ts`), not invented names; `skus.test.ts` asserts that every
 * grant id still exists in that catalogue with that source, so deleting or reclassifying
 * a blueprint fails a test rather than leaving a SKU that sells nothing.
 *
 * THE PRICES ARE PLACEHOLDER, AND SAYING SO IS THE POINT: no price is decided anywhere in
 * design/14 or design/19 beyond "a committed player tops out around a few thousand RMB".
 * These are round CNY numbers chosen to be obviously provisional, not a pricing proposal.
 *
 * CHARACTER SKUs (Task 8, "vanguard=free, skirmisher=paid, juggernaut=event", 2026-09-23):
 * design/14 left the 3-character launch roster's free-vs-paid split as "the store's job,
 * not decided here" — this is that decision. `vanguard` stays free (never sold, granted
 * to every account by `client/src/meta/MetaState.ts FREE_CHARACTERS`); `skirmisher` is
 * the one paid character SKU below; `juggernaut` is reserved for a future event-earned
 * path (a time-limited campaign grant, `ENTITLEMENT_SOURCES`'s `'event'`) that is not
 * built yet, so it is sold nowhere and granted nowhere — deliberately unobtainable this
 * pass, not an oversight (`server/test/billsvc.skus.test.ts` pins this three-way split).
 */

export type SkuGrantKind = 'blueprint' | 'character';

export interface SkuGrant {
  kind: SkuGrantKind;
  /** A `BLUEPRINT_CATALOG` key, or a `SKIN_DEFS` key — the id the entitlement stores. */
  id: string;
}

export interface SkuDef {
  /** Stable public id. Also the string a dev-stub receipt names (`product:<sku>`). */
  sku: string;
  /** Operator/store-facing label. The client renders its own localised name from `grants`. */
  title: string;
  /**
   * Minor units of `currency`. Never read from a request or a receipt — what we OFFER is
   * decided here. Since ROADMAP 9.2 it is a RECORD rather than an authority for Paddle: a
   * Merchant of Record owns localised pricing, currency and tax, so it alone knows what was
   * CHARGED, and a charged amount that differs from this one is a reconciliation finding
   * (`reconcile.ts`), never a reason to refuse a settlement.
   */
  amountCents: number;
  currency: 'CNY';
  grants: readonly SkuGrant[];
  /**
   * The Paddle price id this SKU is sold under (ROADMAP 9.2), as a static DEFAULT. Unset for
   * every SKU today — no Paddle Product/Price exists for this project yet (design/19 §9: ten
   * blueprint prices plus one character, each with quantity adjustment OFF). The per-
   * environment source is `BB_PADDLE_PRICE_IDS` (`paddle/config.ts`), which overrides this,
   * because sandbox and live price ids differ. A SKU with no price id in either place cannot
   * be bought on Paddle, and a webhook naming an unknown price id is REFUSED (fail closed).
   */
  paddlePriceId?: string;
}

const bp = (id: string): readonly SkuGrant[] => [{ kind: 'blueprint', id }];
const ch = (id: string): readonly SkuGrant[] => [{ kind: 'character', id }];

/**
 * Keyed by `sku`, so `findSku` is a lookup rather than a scan and a duplicate id is a
 * syntax-level impossibility rather than something a test has to catch.
 */
export const SKU_CATALOG: Readonly<Record<string, SkuDef>> = {
  'bp.cryobolt': { sku: 'bp.cryobolt', title: 'Blueprint — Cryobolt', amountCents: 1200, currency: 'CNY', grants: bp('cryobolt') },
  'bp.teslagun': { sku: 'bp.teslagun', title: 'Blueprint — Teslagun', amountCents: 1200, currency: 'CNY', grants: bp('teslagun') },
  'bp.venomspit': { sku: 'bp.venomspit', title: 'Blueprint — Venomspit', amountCents: 1200, currency: 'CNY', grants: bp('venomspit') },
  'bp.cannon': { sku: 'bp.cannon', title: 'Blueprint — Cannon', amountCents: 1800, currency: 'CNY', grants: bp('cannon') },
  'bp.seeker': { sku: 'bp.seeker', title: 'Blueprint — Seeker', amountCents: 1800, currency: 'CNY', grants: bp('seeker') },
  'bp.mortar': { sku: 'bp.mortar', title: 'Blueprint — Mortar', amountCents: 1800, currency: 'CNY', grants: bp('mortar') },
  'bp.novaburst': { sku: 'bp.novaburst', title: 'Blueprint — Novaburst', amountCents: 1800, currency: 'CNY', grants: bp('novaburst') },
  'bp.carom': { sku: 'bp.carom', title: 'Blueprint — Carom', amountCents: 1800, currency: 'CNY', grants: bp('carom') },
  'bp.leech': { sku: 'bp.leech', title: 'Blueprint — Leech', amountCents: 1800, currency: 'CNY', grants: bp('leech') },
  'bp.cinderscatter': { sku: 'bp.cinderscatter', title: 'Blueprint — Cinderscatter', amountCents: 1200, currency: 'CNY', grants: bp('cinderscatter') },
  // A whole character is PvP-relevant (design/15's fairness wall lets a chosen character
  // carry in, unlike a weapon blueprint), so it is priced well above a single blueprint —
  // still a round, obviously-provisional CNY number, same discipline as every price above.
  'char.skirmisher': { sku: 'char.skirmisher', title: 'Character — Skirmisher', amountCents: 3800, currency: 'CNY', grants: ch('skirmisher') },
};

/** The store listing. Stable order (catalogue declaration order), so a client can cache it. */
export function listSkus(): readonly SkuDef[] {
  return Object.values(SKU_CATALOG);
}

/**
 * The authoritative price lookup. `undefined` for anything not sold — including a SKU a
 * client invents, which is why every caller must treat the miss as a rejection rather
 * than defaulting an amount.
 */
export function findSku(sku: unknown): SkuDef | undefined {
  if (typeof sku !== 'string') return undefined;
  // `hasOwnProperty.call` rather than a plain `in`/index read: a SKU id arrives
  // straight off a request body, and `'__proto__'` or `'constructor'` would otherwise
  // resolve to an inherited value and be treated as a sellable product.
  return Object.prototype.hasOwnProperty.call(SKU_CATALOG, sku) ? SKU_CATALOG[sku] : undefined;
}
