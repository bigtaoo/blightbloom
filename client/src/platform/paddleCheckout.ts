// The web store's checkout handoff: Paddle.js's overlay, loaded only when a purchase opens it
// (design/22 §1.1).
//
// ## Why lazily
//
// Paddle.js is a third-party script of its own size and its own requests, and the first
// download is budgeted (`build/bundle-size-budget.json`). Nobody who never presses BUY needs
// it, and a remote script is not part of the bundle that budget measures anyway — so nothing
// loads it until `openPaddleCheckout` is called — and a portal build never calls
// it at all, because `storePlatform.ts` gives a portal no store.
//
// ## What this does NOT decide
//
// Whether the player paid. `'completed'` only means Paddle's overlay reported
// `checkout.completed`; the purchase is settled by the SIGNED `transaction.completed` webhook
// the server receives, and `StorePurchase` polls for that either way. So this module never
// grants, never shows "bought", and a lie from the page (or a forged event) buys nothing.
//
// Everything outside the browser — the script tag, `window.Paddle` — is injected, so every
// arm is reachable from a plain object in a test.

/** How the handoff ended, from the overlay's point of view (not the server's). */
export type CheckoutOutcome =
  /** Paddle reported `checkout.completed`: the money step is done, settlement is pending. */
  | 'completed'
  /** The player closed the overlay without completing. */
  | 'closed'
  /** The overlay could not be opened: the script failed to load (an ad blocker, a network
   * drop), or the payment block is missing a field Paddle.js needs. */
  | 'unavailable';

/** The payment block `server/src/billsvc/paymentParams.ts` returns for `paddle`. */
export interface PaddleParams {
  priceId?: string;
  customDataOrderId?: string;
  clientToken?: string;
  environment?: string;
}

/** The slice of Paddle.js v2's global this module calls. */
export interface PaddleGlobal {
  Environment: { set(env: 'sandbox'): void };
  Initialize(opts: { token: string; eventCallback: (event: { name?: string }) => void }): void;
  Checkout: {
    open(opts: { items: { priceId: string; quantity: number }[]; customData: Record<string, string> }): void;
  };
}

export const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

export interface PaddleCheckoutHost {
  /** Resolve the global once the script has loaded; reject if it could not. */
  load: () => Promise<PaddleGlobal>;
}

/** The slice of `document` the loader touches — structural, so a test needs no DOM. */
export interface ScriptDocument {
  createElement(tag: 'script'): { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null };
  head: { appendChild(node: never): unknown };
}

/** The real host: one `<script>` tag, added on first use. A failed load is NOT memoised, so a
 * player whose first attempt hit a dropped connection can press BUY again. Both globals are
 * read at the first load, not at construction, so the assembly can build this anywhere. */
export function browserPaddleHost(
  getDoc: () => ScriptDocument = () => document as unknown as ScriptDocument,
  win: { Paddle?: PaddleGlobal } = globalThis as { Paddle?: PaddleGlobal },
): PaddleCheckoutHost {
  let pending: Promise<PaddleGlobal> | null = null;
  return {
    load: () => {
      if (win.Paddle) return Promise.resolve(win.Paddle);
      const doc = getDoc();
      pending ??= new Promise<PaddleGlobal>((resolve, reject) => {
        const tag = doc.createElement('script');
        tag.src = PADDLE_JS_URL;
        tag.async = true;
        tag.onload = () => (win.Paddle ? resolve(win.Paddle) : reject(new Error('Paddle.js loaded without a Paddle global')));
        tag.onerror = () => reject(new Error('Paddle.js failed to load'));
        doc.head.appendChild(tag as never);
      }).catch((e: unknown) => {
        pending = null;
        throw e;
      });
      return pending;
    },
  };
}

/**
 * One checkout controller per page. Paddle.js may be initialised only ONCE and takes its event
 * callback at that moment, so the callback routes to whichever checkout is open now rather
 * than being bound to the first one.
 */
export class PaddleCheckout {
  private initialisedWith: string | null = null;
  private settle: ((o: CheckoutOutcome) => void) | null = null;

  constructor(private readonly host: PaddleCheckoutHost) {}

  async open(params: PaddleParams): Promise<CheckoutOutcome> {
    const { priceId, customDataOrderId: orderId, clientToken: token, environment } = params;
    if (!priceId || !orderId || !token) return 'unavailable';
    let paddle: PaddleGlobal;
    try {
      paddle = await this.host.load();
    } catch {
      return 'unavailable';
    }
    try {
      if (this.initialisedWith === null) {
        if (environment === 'sandbox') paddle.Environment.set('sandbox');
        paddle.Initialize({ token, eventCallback: (e) => this.onEvent(e.name) });
        this.initialisedWith = token;
      } else if (this.initialisedWith !== token) {
        // A different token means a different environment or seller; the page would need a
        // reload to switch, and checking out against the wrong one is a refused webhook.
        return 'unavailable';
      }
      // A checkout already open is superseded, not leaked: `StorePurchase` allows one
      // purchase at a time, so this only happens if that guard is bypassed.
      this.settle?.('closed');
      const done = new Promise<CheckoutOutcome>((resolve) => (this.settle = resolve));
      paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customData: { orderId } });
      return await done;
    } catch {
      this.settle = null;
      return 'unavailable';
    }
  }

  private onEvent(name: string | undefined): void {
    if (name === 'checkout.completed') this.finish('completed');
    else if (name === 'checkout.closed') this.finish('closed');
  }

  private finish(outcome: CheckoutOutcome): void {
    const settle = this.settle;
    this.settle = null; // the `closed` that follows a `completed` finds nothing to settle
    settle?.(outcome);
  }
}
