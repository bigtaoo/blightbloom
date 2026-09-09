// The purchase flow: list → order → pay → poll → re-read what the server says you own.
//
// Split from `StoreScreen` for the reason every other controller here is split from its
// screen (CLAUDE.md form ②): the branches worth testing are all in this half, and this half
// constructs nothing that needs a renderer. Every dependency is injected — the three wire
// calls, the session, the platform gate, the ownership refresh and even `sleep` — so the
// timed-out, failed, delivered and refresh-failed arms are all reachable from a plain test
// with no network, no clock and no Pixi.
//
// ## What replaced what
//
// `ForgeActions.acquireBlueprint` used to hand the player the first purchasable blueprint
// for free and call it a store (ROADMAP 2.4's `demo: free grant` scaffold). Since the server
// began answering `/account/meta` from its own `entitlements` table (design/19 §2), that
// grant does not survive the next login: the client granted it to itself, so the server has
// never heard of it. This is the real thing in its place.
//
// ## The two refusals that are not errors
//
// A store that lies is worse than a store that is closed, so both of these are reported as
// their own outcome and neither is dressed up as success:
//
//   - `not-configured` — the order was BOOKED and the platform cannot take money for it
//     (`server/src/billsvc/paymentParams.ts` explains at length why it says so honestly
//     rather than returning an unsigned block that would fail inside the SDK). Nothing is
//     polled: there is no payment to wait for. The booked order is simply left open; there
//     is no cancel route in the wire protocol, an unpaid order settles nothing, and design/19
//     §7's reconciliation sweep is what sees it.
//   - `timed-out` — the poll budget ran out with the order still `created`. That is NOT
//     "the purchase failed": a slow platform callback can still settle it minutes later, and
//     the next login re-reads entitlements anyway. The copy has to say so.
import { getSession, type Session } from '../../net/session';
import * as billingApi from '../../net/billing';
import type { StoreOrder, StoreSku } from '../../net/billing';
import type { StorePlatform } from '../../platform/storePlatform';
import { track } from '../../net/analytics';
import { playUiCue } from '../../audio/uiSound';

/** The store network calls — injected (default: the real `net/billing.ts` functions), same
 * DI convention as `LoginScreen`'s `AuthApi` and `PartyScreen`'s `PartyApi`. */
export interface StorePurchaseApi {
  listSkus: typeof billingApi.listStoreSkus;
  createOrder: typeof billingApi.createStoreOrder;
  fetchOrder: typeof billingApi.fetchStoreOrder;
}

/** Why a purchase did not complete. Every value is a branch with its own test. */
export type PurchaseFailure =
  /** A second press while the first is still in flight — a payment button really does get
   * double-tapped, and the second tap must buy nothing. */
  | 'busy'
  /** A guest. Entitlements are account-bound (design/19 §2), so there is nothing to bind a
   * purchase to — and buying anyway would recreate the exact scaffold this replaced. */
  | 'not-logged-in'
  /** This build may not sell at all (`platform/storePlatform.ts`). Should be unreachable
   * from the UI, which does not render the entry — this is the fail-closed backstop. */
  | 'no-platform'
  | 'not-configured'
  | 'order-failed'
  /** The platform settled the order as failed/cancelled. */
  | 'payment-failed'
  | 'timed-out';

export type PurchaseResult =
  /** `refreshed: false` means the money moved and the entitlement was delivered, but this
   * client could not re-read it. The purchase is NOT in doubt — the caller must say
   * "bought, will appear on next login" rather than anything that reads as a failure. */
  | { ok: true; sku: string; refreshed: boolean }
  | { ok: false; code: PurchaseFailure; detail?: string };

export type CatalogFailure = 'busy' | 'not-logged-in' | 'no-platform' | 'list-failed';

export type CatalogResult = { ok: true; skus: StoreSku[] } | { ok: false; code: CatalogFailure; detail?: string };

export interface StorePurchaseDeps {
  /** Read lazily: `run.matchBaseUrl` is only final after Game's `?mm=` override lands. */
  baseUrl: () => string;
  /** Defaults to the real `net/session.ts` reader; injected so a test needs no localStorage. */
  session?: () => Session | null;
  platform: () => StorePlatform | null;
  api?: StorePurchaseApi;
  /**
   * Re-read this account's server-side ownership and apply it locally (the assembly wires
   * this to `pullAccountMeta` → `run.setMeta` → re-render the forge).
   *
   * MUST REJECT on failure rather than swallowing it. `OnlineMatch.syncMetaWithSession`
   * deliberately eats its own errors — best-effort background sync — and reusing that here
   * would make the refresh-failed arm unreportable: the player would be told the purchase
   * worked and then not see the weapon, with nothing on screen explaining why.
   */
  refreshOwnership: () => Promise<void>;
  /** Injected so the poll runs instantly under test. */
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** Deliberately generous. A card/wallet handoff plus the platform's server-to-server
 * callback is seconds-to-minutes, and `timed-out` is a "check back later", not a refusal. */
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 90_000;

export class StorePurchase {
  private readonly api: StorePurchaseApi;
  private readonly session: () => Session | null;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  /** In-flight guard, shared by the catalogue load and the buy — one screen, one operation
   * at a time, exactly as `LoginScreen`/`PartyScreen` do it. */
  private busy = false;

  constructor(private readonly deps: StorePurchaseDeps) {
    this.api = deps.api ?? {
      listSkus: billingApi.listStoreSkus,
      createOrder: billingApi.createStoreOrder,
      fetchOrder: billingApi.fetchStoreOrder,
    };
    this.session = deps.session ?? (() => getSession());
    this.intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  /** True while an order or a listing is in flight — the screen disables its buttons on it. */
  get inFlight(): boolean {
    return this.busy;
  }

  /** The store listing, at the SERVER's prices (`net/billing.ts` explains why that matters). */
  async loadCatalog(): Promise<CatalogResult> {
    if (this.busy) return { ok: false, code: 'busy' };
    if (!this.deps.platform()) return { ok: false, code: 'no-platform' };
    const session = this.session();
    if (!session) return { ok: false, code: 'not-logged-in' };
    this.busy = true;
    try {
      return { ok: true, skus: await this.api.listSkus(this.deps.baseUrl(), session.token) };
    } catch (e) {
      return { ok: false, code: 'list-failed', detail: (e as Error).message };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Buy one SKU, end to end. Plays the outcome's cue itself — the same division of labour
   * `ForgeActions.craftAt` uses and the reason the button is built `sound: 'silent'`: only
   * the transaction knows whether the press did anything, so `ui.tap` vs `ui.denied` cannot
   * be decided at the widget (design/11 UI cues).
   */
  async buy(sku: string): Promise<PurchaseResult> {
    const result = await this.attempt(sku);
    playUiCue(result.ok ? 'ui.tap' : 'ui.denied');
    // Reported here rather than in `attempt`, and only on success: `attempt` has seven
    // failure arms and every one of them means no money moved, so a `store_purchase` event
    // covering them would count refusals as purchases. The conversion DENOMINATOR is the
    // store's own `screen_view` (design/21 §2.2 — there is no `store_open`), so a failed
    // attempt is visible as a view with no purchase after it, which is what it is.
    if (result.ok) track('store_purchase', { sku });
    return result;
  }

  private async attempt(sku: string): Promise<PurchaseResult> {
    // BEFORE `busy` is claimed: a rejected press must not lock the button out, and the
    // second of two rapid taps has to reach the `busy` arm rather than a stale guard.
    if (this.busy) return { ok: false, code: 'busy' };
    const platform = this.deps.platform();
    if (!platform) return { ok: false, code: 'no-platform' };
    const session = this.session();
    if (!session) return { ok: false, code: 'not-logged-in' };

    this.busy = true;
    try {
      const baseUrl = this.deps.baseUrl();
      let order: StoreOrder;
      let payment: billingApi.PaymentParams;
      try {
        ({ order, payment } = await this.api.createOrder(baseUrl, session.token, sku, platform));
      } catch (e) {
        return { ok: false, code: 'order-failed', detail: (e as Error).message };
      }
      // The order exists and cannot be paid for. See this file's header on why nothing is
      // polled and nothing is cancelled. `note` is operator-facing, so it is carried as
      // `detail` (logs/dev tooling) and never used as the player-facing line.
      if (!payment.configured) return { ok: false, code: 'not-configured', detail: payment.note };

      // Between here and the poll is where a real platform SDK handoff will go — Apple's
      // StoreKit purchase, or the web processor's checkout. There is none today (no merchant
      // credentials exist anywhere in this project, design/19 §9), so the only `configured`
      // platform is the dev stub, whose "payment" is a webhook someone posts by hand. The
      // poll below is unchanged either way: settlement is always reported by the server, never
      // by whatever the client thinks happened at the till.
      const settled = await this.poll(baseUrl, session.token, order.id);
      if (settled === 'failed') return { ok: false, code: 'payment-failed' };
      if (settled === 'timed-out') return { ok: false, code: 'timed-out' };

      try {
        await this.deps.refreshOwnership();
      } catch {
        // Delivered but not re-read. Still `ok` — see `PurchaseResult`.
        return { ok: true, sku, refreshed: false };
      }
      return { ok: true, sku, refreshed: true };
    } finally {
      this.busy = false; // always clears, whatever arm was taken
    }
  }

  /**
   * Poll `GET /store/order/:id` until it leaves `created`.
   *
   * A THROWN poll is retried rather than abandoned. The order may well have been paid for by
   * then, and treating one dropped request as a failed purchase is the worst answer available
   * — so a transient error only costs an attempt from the budget.
   *
   * The budget is a COUNT derived from the interval, not a wall-clock deadline, so the whole
   * loop is deterministic under an injected `sleep` and no test has to fake a clock.
   */
  private async poll(baseUrl: string, token: string, orderId: string): Promise<OrderOutcome> {
    const attempts = Math.max(1, Math.ceil(this.timeoutMs / this.intervalMs));
    for (let i = 0; i < attempts; i++) {
      await this.deps.sleep(this.intervalMs);
      let order: StoreOrder;
      try {
        order = await this.api.fetchOrder(baseUrl, token, orderId);
      } catch {
        continue;
      }
      if (order.state === 'settled') return 'settled';
      if (order.state === 'failed') return 'failed';
    }
    return 'timed-out';
  }
}

type OrderOutcome = 'settled' | 'failed' | 'timed-out';
