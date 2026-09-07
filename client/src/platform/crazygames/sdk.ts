// The CrazyGames SDK, wrapped so that nothing in the game can be broken by it.
//
// ## Why a wrapper at all
//
// The SDK arrives as a `<script>` from `sdk.crazygames.com` (see `vite.crazygames.config.js`),
// which means it is the one dependency in this client that is BOTH required by the platform's
// own rules and reliably absent in three normal situations: local development, an adblocked
// player (the requirements page's own words are "games must function even when the user has
// an adblock"), and every unit test in this repository. A direct
// `window.CrazyGames.SDK.game.gameplayStart()` at a call site is therefore a crash in three
// of the four environments the code runs in.
//
// So every method here is a no-op when the SDK is missing, and every call is wrapped: a
// missing global, a missing method, a synchronous throw and a rejected promise all land in
// the same place and none of them reaches the caller. There is no `strict` mode and no way
// to make one of these throw, on purpose — an ad network is not allowed to be able to end a
// run.
//
// ## What is deliberately NOT verified here
//
// This file is written against the published API surface (`docs.crazygames.com/sdk/html5-v2`)
// and cannot be exercised against the real SDK from this repository — the same position
// `server/src/billsvc/iap/`'s adapters are in, and it takes the same honest shape they do:
// the real call each method would make, tested against a fake that mimics the documented
// shape, and failing closed rather than throwing. What that leaves unproven is whether the
// documented names are the shipped names. `environment()` is the tell — on a real portal
// page it returns `'crazygames'` — and `PortalSession.diagnostics()`, exposed on the page as
// `__portal.diagnostics()`, prints it together with the adblock probe and the live brackets,
// so a wrong method name is one console line away rather than silent.
//
// The v2 script is the one this targets (`crazygames-sdk-v2.js`). Its methods accept a
// node-style `(error, result)` callback OR return a promise; we use the promise form and
// the void form only, because the callback form's error arm is the same arm as a rejected
// promise and having one path to test is worth more than symmetry with the docs.

/** What the SDK says about the page it is running in. `'local'` is a developer machine,
 *  `'crazygames'` a real portal page, `'disabled'` an environment where the SDK declines to
 *  do anything. We add no fourth value for "the script never loaded": that answers
 *  `'disabled'` too, because it is the same thing from a caller's point of view. */
export type CgEnvironment = 'local' | 'crazygames' | 'disabled';

/** The two ad kinds the platform allows (`docs.crazygames.com/requirements/ads`). */
export type CgAdType = 'midgame' | 'rewarded';

export interface CgAdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (error: unknown, data?: unknown) => void;
}

/**
 * The SDK as this client uses it. Structural, and every member optional — which is not
 * defensive style for its own sake: the shape below is a REMOTE artifact that can change
 * without this repository being touched, so a method we call has to be treated as absent
 * until proven present, exactly like a texture that may not have downloaded yet.
 */
export interface CgSdkShape {
  /** v3's shape: a property. */
  environment?: string;
  /**
   * v2's shape: a method on the prototype returning a PROMISE.
   *
   * Both halves of that were found on a live page and neither is in the documentation, which
   * says only `SDK.environment`. The shipped `crazygames-sdk-v2.js` (2.9.0) has no such
   * property at all — `'environment' in SDK` is `false` — and `getEnvironment()` hands back
   * a `Promise<'local' | 'crazygames' | 'disabled'>`, so a synchronous read of either name
   * reported `disabled` on a page whose own console was logging `environment: local`. The
   * integration then did nothing whatsoever, silently: no brackets, no banner, no ads, no
   * error. This is exactly the risk the module header names, so `init` tries both shapes and
   * awaits this one.
   */
  getEnvironment?: () => unknown;
  init?: () => unknown;
  game?: {
    sdkGameLoadingStart?: () => unknown;
    sdkGameLoadingStop?: () => unknown;
    gameplayStart?: () => unknown;
    gameplayStop?: () => unknown;
    happytime?: () => unknown;
    inviteLink?: (params: Record<string, string>) => unknown;
    getInviteParam?: (name: string) => unknown;
  };
  ad?: {
    requestAd?: (type: CgAdType, callbacks: CgAdCallbacks) => unknown;
    hasAdblock?: () => unknown;
  };
  banner?: {
    requestBanner?: (opts: { id: string; width: number; height: number }) => unknown;
    requestResponsiveBanner?: (containerId: string) => unknown;
    clearBanner?: (containerId: string) => unknown;
    clearAllBanners?: () => unknown;
  };
}

/** The ambient global the script installs. Passed in rather than read off `globalThis` so a
 *  test drives a plain object (`storePlatform.ts`'s `StoreHost` convention). */
export interface CgGlobal {
  CrazyGames?: { SDK?: CgSdkShape };
}

/** Milliseconds `init` waits for the script before giving up and reporting `'disabled'`.
 *  A budget, not a retry count: the failure mode being waited out is a blocked request,
 *  which never arrives, and boot may not be held hostage to it. */
export const SDK_WAIT_MS = 3000;
const POLL_MS = 50;

function isEnvironment(v: unknown): v is CgEnvironment {
  return v === 'local' || v === 'crazygames' || v === 'disabled';
}



/**
 * Everything the game asks of the portal.
 *
 * One class rather than free functions because there is one piece of real state — whether
 * the script ever showed up — and every method's no-op branch keys off it.
 */
export class CrazyGamesSdk {
  private sdk: CgSdkShape | null = null;
  private env: CgEnvironment = 'disabled';
  private adblock: boolean | null = null;

  constructor(
    private readonly global: CgGlobal = globalThis as CgGlobal,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Wait for the script, call `init()`, and record what environment we are in.
   *
   * Resolves `'disabled'` rather than rejecting on every failure path there is, so the one
   * caller (`main.crazygames.ts`) needs no error handling and boot has no new way to fail.
   */
  async init(): Promise<CgEnvironment> {
    const deadline = this.now() + SDK_WAIT_MS;
    // 1. Wait for the script. The failure being waited out is a BLOCKED request (an
    //    adblocker, an offline machine), which never arrives at all.
    for (;;) {
      const sdk = this.global.CrazyGames?.SDK;
      if (sdk) {
        this.sdk = sdk;
        break;
      }
      if (this.now() >= deadline) return 'disabled';
      await this.sleep(POLL_MS);
    }

    // 2. Its own `init()`, BOUNDED. It talks to the parent frame, so it is allowed to fail —
    //    and, as observed on a real page, allowed to simply never settle. An unbounded await
    //    here is the worst bug this file can have: `PortalSession.start()` would never
    //    resolve, so `loadingStop()` would never be called, and the portal would show a
    //    loading spinner over a game that had been playable for minutes.
    await this.until(deadline, this.settle(() => this.sdk?.init?.()));

    // 3. Read the environment, polling for it. It is not set synchronously by the script:
    //    on a live page the SDK object initially carries only `sdkInitializer` and a few
    //    throttled wrappers, and `environment` appears once its own init has run. Reading it
    //    exactly once — which this did at first — reports `disabled` for a page that is
    //    about to answer `local` or `crazygames`, and the whole integration then silently
    //    does nothing.
    for (;;) {
      // v3's property first (it is the forward-looking shape and is free to read), then v2's
      // promise-returning method — see `CgSdkShape.getEnvironment` for what the live SDK
      // actually does and what reading only the documented name cost.
      const prop = this.sdk?.environment;
      if (isEnvironment(prop)) {
        this.env = prop;
        return prop;
      }
      const asked = await this.until(deadline, this.settle(() => this.sdk?.getEnvironment?.()));
      if (isEnvironment(asked)) {
        this.env = asked;
        return asked;
      }
      if (this.now() >= deadline) return 'disabled';
      await this.sleep(POLL_MS);
    }
  }

  /** Await `work` and hand back its value, but give up at `deadline` and hand back
   *  `undefined`. The bound is the point: every promise here comes from a remote script, and
   *  one that never settles must not be able to stall boot (see `init`'s step 2). */
  private async until(deadline: number, work: Promise<unknown>): Promise<unknown> {
    let done = false;
    let value: unknown;
    void work.then((v) => {
      value = v;
      done = true;
    });
    for (;;) {
      // A microtask turn, so a promise that is ALREADY settled costs no sleep at all.
      await Promise.resolve();
      if (done || this.now() >= deadline) return value;
      await this.sleep(POLL_MS);
    }
  }

  /** Where we are. `'disabled'` until `init()` has succeeded — every method below is a
   *  no-op in that state, so nothing has to check this except diagnostics and the ad policy. */
  environment(): CgEnvironment {
    return this.env;
  }

  /**
   * True when the SDK will actually do something — a real portal page (`crazygames`) OR a
   * whitelisted developer domain (`local`), where it serves test creatives.
   *
   * This is the gate on every call that has an OBSERVABLE failure rather than a silent one:
   * an ad request and a banner request. Both log a console error when the environment is
   * `disabled`, and a console error is something a reviewer looks at — the first live run of
   * this integration produced exactly one ("no available banner size has been found"), from
   * a banner requested on a `disabled` page.
   *
   * `local` is deliberately INCLUDED rather than treated as production-only. Testing ads is
   * the entire purpose of that environment, and a gate that excluded it would mean the ad
   * paths could only ever be exercised for the first time in production.
   */
  isEnabled(): boolean {
    return this.env === 'local' || this.env === 'crazygames';
  }

  // ---- game module: the loading and gameplay brackets ----
  //
  // These four are what the platform measures. `sdkGameLoading*` brackets the boot download,
  // and the span from page open to the first `gameplayStart` is what its "initial download"
  // size rule is measured over (`docs.crazygames.com/requirements/technical`) — which is why
  // design/12's phased art loading matters here and must not regress into one eager preload.

  loadingStart(): void {
    void this.settle(() => this.sdk?.game?.sdkGameLoadingStart?.());
  }

  loadingStop(): void {
    void this.settle(() => this.sdk?.game?.sdkGameLoadingStop?.());
  }

  /** The player is now PLAYING — a run, not a menu. Also the platform's cue to capture
   *  keyboard input for the frame, which is why a menu must not claim it. */
  gameplayStart(): void {
    void this.settle(() => this.sdk?.game?.gameplayStart?.());
  }

  /** The player is out of gameplay: a menu, a pause, a result screen, an ad. Required
   *  before requesting any ad — an ad during gameplay is the single rule the requirements
   *  page states most often. */
  gameplayStop(): void {
    void this.settle(() => this.sdk?.game?.gameplayStop?.());
  }

  /** A real achievement (this game: surviving an extraction). Fires the portal's own
   *  celebration; harmless everywhere else. */
  happytime(): void {
    void this.settle(() => this.sdk?.game?.happytime?.());
  }

  // ---- ad module ----

  /**
   * Request one ad. Resolves `true` only if it actually FINISHED — which is the answer a
   * rewarded ad's caller needs, and the only answer that may unlock a reward.
   *
   * `adStarted`/`adFinished` are forwarded so the caller can mute and freeze around the ad
   * (`AdController` does both). An unfilled request arrives as `adError`, which the docs are
   * explicit is normal rather than exceptional, so it resolves `false` like a dismissal.
   */
  async requestAd(type: CgAdType, hooks: CgAdCallbacks = {}): Promise<boolean> {
    const fn = this.sdk?.ad?.requestAd;
    if (typeof fn !== 'function') return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        fn.call(this.sdk?.ad, type, {
          adStarted: () => this.guard(hooks.adStarted),
          adFinished: () => {
            this.guard(hooks.adFinished);
            finish(true);
          },
          adError: (error: unknown, data?: unknown) => {
            this.guard(() => hooks.adError?.(error, data));
            finish(false);
          },
        });
      } catch {
        // A synchronous throw means no callback will ever come. `adError` has to be
        // synthesised here or the caller waits forever with the game muted and frozen.
        this.guard(() => hooks.adError?.(new Error('requestAd threw')));
        finish(false);
      }
    });
  }

  /**
   * Whether this player blocks ads. Cached after the first successful answer.
   *
   * Used to decide whether to OFFER a rewarded ad at all, never to restrict play: the
   * requirement is that an adblocked player plays normally, and that a rewarded offer is
   * hidden rather than shown disabled-but-clickable. An unanswerable probe reports `false`
   * (offer it, let the request fail into the reward's non-ad alternative), because the other
   * default would silently delete the offer for every player in a local build.
   */
  async hasAdblock(): Promise<boolean> {
    if (this.adblock !== null) return this.adblock;
    const fn = this.sdk?.ad?.hasAdblock;
    if (typeof fn !== 'function') return false;
    const result = await this.settle(() => fn.call(this.sdk?.ad));
    this.adblock = result === true;
    return this.adblock;
  }

  // ---- banner module ----

  /**
   * Fill a DOM container with a banner of an EXPLICIT size.
   *
   * The explicit form rather than `requestResponsiveBanner`, and the reason is a live
   * finding: the responsive call has to pick a creative that fits the container, and on a
   * `local` page it answered "no available banner size has been found for container
   * cg-banner-crazygames-inner" even with the container sized. The explicit form is the one
   * the documentation's own example uses and asks no such question.
   *
   * See `BannerHost.ts` for the container, the size and the placement rules that decide WHEN
   * this may be called at all.
   */
  async requestBanner(containerId: string, width: number, height: number): Promise<void> {
    await this.settle(() => this.sdk?.banner?.requestBanner?.({ id: containerId, width, height }));
  }

  clearBanner(containerId: string): void {
    void this.settle(() => this.sdk?.banner?.clearBanner?.(containerId));
  }

  clearAllBanners(): void {
    void this.settle(() => this.sdk?.banner?.clearAllBanners?.());
  }

  // ---- invites (the portal's own multiplayer link) ----

  /**
   * A portal link that carries our party id, so a squad can be assembled through the
   * portal's own share affordance instead of a code the player has to retype.
   *
   * `null` on every failure path, which the caller renders as "no link" rather than as an
   * error: the party invite CODE (`PartyScreen`) is the mechanism, and this is a nicer way
   * to hand it over, never the only way.
   */
  async inviteLink(params: Record<string, string>): Promise<string | null> {
    const link = await this.settle(() => this.sdk?.game?.inviteLink?.(params));
    return typeof link === 'string' && link.length > 0 ? link : null;
  }

  /** Read a parameter out of the invite link this session was opened with, if any. */
  async getInviteParam(name: string): Promise<string | null> {
    const v = await this.settle(() => this.sdk?.game?.getInviteParam?.(name));
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  // ---- the two wrappers every call above goes through ----

  /** Run `fn`, awaiting it if it returned a promise, and swallow every failure. Returns
   *  `undefined` on any failure path, which is indistinguishable from a method that
   *  legitimately returns nothing — and that is the point: no caller branches on it. */
  private async settle(fn: () => unknown): Promise<unknown> {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  }

  /** Synchronous version, for forwarding an SDK callback into game code. A throw inside a
   *  hook must not propagate back into the SDK's own callback dispatch, which would leave
   *  the remaining hooks unrun (this is the failure that makes an ad end with the game
   *  still muted). */
  private guard(fn: (() => void) | undefined): void {
    try {
      fn?.();
    } catch {
      /* a hook's failure is the hook's problem, never the ad's */
    }
  }
}
