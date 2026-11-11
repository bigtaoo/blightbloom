/**
 * Playgama Bridge: the SDK the Playgama build talks to, behind a wrapper that never throws.
 *
 * The fourth host target (`main.playgama.ts`). Bridge is a remote `<script>` the page loads
 * ahead of the entry module (`vite.playgama.config.js` puts it there), so every member of it is
 * treated as optional and every call is settled: a blocked script, an old version or a member
 * that throws leaves the game running exactly as a plain browser build, never broken.
 *
 * Ported from Holy Kicker's integration (`D:/standing/client/src/platform/playgama/bridge.ts`),
 * which passed Playgama's sandbox; the leaderboard, clipboard and catalog-payload halves are
 * left out because nothing in this game uses them. Event and state names are Bridge's own.
 */

type Listener = (...args: unknown[]) => void;

interface Emitter {
  on?: (event: string, cb: Listener) => unknown;
}

/** The SDK as used here; every member optional because it is a remote script. */
export interface BridgeShape {
  initialize?: () => unknown;
  version?: string;
  /** Bridge 2.1+: sent as `game_version` on every event, Bridge's own included; set before
   *  `initialize()` (D:/jump does the same), so the dashboards can split by build. */
  gameVersion?: string;
  platform?: Emitter & {
    id?: string;
    language?: string;
    isAudioEnabled?: boolean;
    sendMessage?: (message: string) => unknown;
  };
  storage?: {
    get?: (keys: string[], tryParseJson?: boolean) => unknown;
    set?: (keys: string[], values: string[]) => unknown;
  };
  advertisement?: Emitter & {
    isInterstitialSupported?: boolean;
    isRewardedSupported?: boolean;
    showInterstitial?: (placement?: string) => unknown;
    showRewarded?: (placement?: string) => unknown;
  };
  device?: { type?: string };
  analytics?: { send?: (event: string, data?: Record<string, string | number | boolean>) => unknown };
}

export interface BridgeGlobal {
  bridge?: BridgeShape;
}

/** How long boot waits for `initialize()`; a blocked platform script never answers. */
export const BRIDGE_WAIT_MS = 5000;
/** How long an ad may take to OPEN before it counts as failed (no fill that never says so). */
export const AD_OPEN_MS = 10_000;
/** How long an opened ad may run before the game stops waiting for it. */
export const AD_RUN_MS = 120_000;

/** Bridge's ids for a page that is not a real portal: a local preview and the QA tool. */
const TEST_PLATFORMS: ReadonlySet<string> = new Set(['mock', 'qa_tool']);

export type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* the game's problem, never the SDK's */
  }
}

export class PlaygamaBridge {
  private sdk: BridgeShape | null = null;
  private inFlight: { event: string; listen: (state: unknown) => void } | null = null;
  private readonly subscribed = new Set<string>();

  constructor(
    private readonly global: BridgeGlobal = globalThis as BridgeGlobal,
    private readonly wait: Wait = realWait,
  ) {}

  /** Runs `initialize()`; false without the script, on a rejection or after `BRIDGE_WAIT_MS`. */
  async init(gameVersion?: string): Promise<boolean> {
    const sdk = this.global.bridge;
    if (!sdk || typeof sdk.initialize !== 'function') return false;
    if (gameVersion) sdk.gameVersion = gameVersion;
    const done = settle(async () => {
      await sdk.initialize?.();
      return true;
    });
    const ready = (await Promise.race([done, this.wait(BRIDGE_WAIT_MS).then(() => false)])) === true;
    if (ready) this.sdk = sdk;
    return ready;
  }

  isReady(): boolean {
    return this.sdk !== null;
  }

  /** The platform Bridge runs on ('playgama', 'playgama_sandbox', 'mock', …); null without it. */
  platformId(): string | null {
    const id = this.sdk?.platform?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /** True on a real portal page, false on a local preview, the QA tool or without Bridge. */
  onPortal(): boolean {
    const id = this.platformId();
    return id !== null && !TEST_PLATFORMS.has(id);
  }

  /** `platform/version`, for the one diagnostics line. */
  describe(): string {
    const v = this.sdk?.version;
    return `${this.platformId() ?? 'none'}/${typeof v === 'string' ? v : '?'}`;
  }

  /** The player's language as the platform reports it (ISO 639-1); null without it. */
  language(): string | null {
    const v = this.sdk?.platform?.language;
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** 'mobile', 'tablet', 'desktop' or 'tv'; null without it. */
  deviceType(): string | null {
    const v = this.sdk?.device?.type;
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** `game_ready`, `gameplay_started`, `gameplay_stopped`, … */
  send(message: string): void {
    void settle(() => this.sdk?.platform?.sendMessage?.(message));
  }

  /** One custom analytics event (Bridge 2.3.0 and newer; a no-op before). */
  track(event: string, data?: Record<string, string | number | boolean>): void {
    void settle(() => this.sdk?.analytics?.send?.(event, data));
  }

  /** The platform's pause: true when it asks the game to stop (its own overlay, a hidden tab). */
  onPause(cb: (paused: boolean) => void): void {
    void settle(() => this.sdk?.platform?.on?.('pause_state_changed', (p) => guard(() => cb(p === true))));
  }

  /** The platform's sound switch: called now with whether to mute, then on every change. */
  onMute(cb: (muted: boolean) => void): void {
    if (!this.sdk) return;
    guard(() => cb(this.sdk?.platform?.isAudioEnabled === false));
    void settle(() => this.sdk?.platform?.on?.('audio_state_changed', (on) => guard(() => cb(on === false))));
  }

  /** Reads `keys` in one call; values come back as strings (objects are stringified again). */
  async load(keys: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const got = await settle(() => this.sdk?.storage?.get?.([...keys], false));
    if (!Array.isArray(got)) return out;
    keys.forEach((key, i) => {
      const v: unknown = got[i];
      if (typeof v === 'string') out.set(key, v);
      else if (v !== null && v !== undefined) out.set(key, JSON.stringify(v));
    });
    return out;
  }

  /** Whether Bridge storage answered at all — false without the SDK or its storage module. */
  hasStorage(): boolean {
    const s = this.sdk?.storage;
    return typeof s?.get === 'function' && typeof s.set === 'function';
  }

  save(entries: ReadonlyMap<string, string>): void {
    void settle(() => this.sdk?.storage?.set?.([...entries.keys()], [...entries.values()]));
  }

  interstitialSupported(): boolean {
    return this.sdk?.advertisement?.isInterstitialSupported === true;
  }

  rewardedSupported(): boolean {
    return this.sdk?.advertisement?.isRewardedSupported === true;
  }

  /** One rewarded ad: true only once Bridge says 'rewarded' and the ad then closed. */
  rewarded(opened?: () => void): Promise<boolean> {
    if (!this.rewardedSupported()) return Promise.resolve(false);
    return this.show('rewarded_state_changed', (ad) => ad.showRewarded?.(), opened);
  }

  /**
   * One interstitial, for the named placement; resolves when it closed or failed.
   *
   * The placement is Bridge's own routing key: `playgama-bridge-config.json` declares the list
   * and maps each id to a platform's native placement, and a call that passes none falls back
   * to the config's `placementFallback`. Naming the pause costs nothing here and is what lets
   * the platform tell one pause from another.
   */
  async interstitial(placement?: string, opened?: () => void): Promise<void> {
    if (!this.interstitialSupported()) return;
    await this.show('interstitial_state_changed', (ad) => ad.showInterstitial?.(placement), opened);
  }

  /** Whether an ad is on screen or being requested right now. */
  adInFlight(): boolean {
    return this.inFlight !== null;
  }

  private show(event: string, call: (ad: NonNullable<BridgeShape['advertisement']>) => unknown, opened?: () => void): Promise<boolean> {
    const ad = this.sdk?.advertisement;
    if (!ad || typeof ad.on !== 'function' || this.inFlight) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let paid = false;
      let open = false;
      let over = false;
      const listen = (state: unknown): void => {
        if (over) return;
        if (state === 'opened') {
          open = true;
          guard(() => opened?.());
        } else if (state === 'rewarded') paid = true;
        else if (state === 'closed' || state === 'failed') {
          over = true;
          if (this.inFlight?.listen === listen) this.inFlight = null;
          resolve(paid && state === 'closed');
        }
      };
      this.inFlight = { event, listen };
      if (!this.subscribed.has(event)) {
        this.subscribed.add(event);
        void settle(() => ad.on?.(event, (s) => this.inFlight?.event === event && this.inFlight.listen(s)));
      }
      // The watchdog: an ad that never opens is a no-fill that never said so, and one that
      // never closes would hold the game paused forever. Either way the game takes itself back.
      void this.wait(AD_OPEN_MS).then(() => {
        if (!open) listen('failed');
        else return this.wait(AD_RUN_MS - AD_OPEN_MS).then(() => listen('failed'));
      });
      try {
        call(ad);
      } catch {
        listen('failed');
      }
    });
  }
}
