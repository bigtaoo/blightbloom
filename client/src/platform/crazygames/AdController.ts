// WHEN an ad may be shown, and what has to be true of the game while one is showing.
//
// `sdk.ts` is the transport; this is the policy, and the policy is the part with rules
// attached to it (`docs.crazygames.com/requirements/ads`). The three that shape this file:
//
//  1. **An ad may never interrupt gameplay.** Not "should not" — it is the rule the
//     requirements page repeats most. So there is no "show an ad now" method here that a
//     call site can reach during a run: every entry point below refuses unless the game is
//     out of gameplay, and the refusal is a normal return value rather than a throw.
//  2. **The game is muted and frozen for the length of the ad.** An ad has audio of its own,
//     and the player must not be able to progress the game underneath it. That is what
//     `AdSuspension` is, and it is released in a `finally` — an ad that errors must not
//     leave the game silent, which is the single worst bug this file can have.
//  3. **An adblocked player plays normally.** No penalty, no popup, and specifically no
//     rewarded-ad button that is visible but cannot work. `rewardAvailable()` answers that
//     question once at boot so the UI can simply not draw the offer.
//
// Frequency is deliberately NOT tracked here. The SDK enforces the "one midgame ad every
// three minutes" cap itself and the docs say so explicitly; a second timer in this file
// could only ever disagree with the authoritative one, and would be untestable against it.
//
// The ONE timer that does live here answers a different question, and the SDK cannot answer
// it: a rewarded ad does not count against the midgame cap, so a player who watches one on
// the results screen and then presses CONFIRM would be handed a second ad within a couple of
// seconds — the platform's own "comes as a surprise" case, arrived at by two individually
// legal calls. `REWARDED_MIDGAME_COOLDOWN_MS` suppresses the midgame after a rewarded ad the
// player actually watched. It is our policy, not the platform's cap, which is why it does not
// contradict the paragraph above.
import type { CgAdType, CrazyGamesSdk } from './sdk';

/** How long a played rewarded ad suppresses the next automatic midgame ad. One minute:
 *  long enough to cover the results screen → menu → next-run click-through that produced
 *  the stacked pair, short enough that a player who then plays a real run still sees the
 *  ordinary break ad afterwards. */
export const REWARDED_MIDGAME_COOLDOWN_MS = 60_000;

/**
 * Everything the game has to do for the duration of an ad, as one pair of calls.
 *
 * Two things live behind it — muting the audio bus and freezing the update loop — and they
 * are one interface because they must never be applied separately. `main.crazygames.ts`
 * supplies the implementation; a test supplies a counter.
 */
export interface AdSuspension {
  /** Mute and freeze. Must be safe to call when already suspended. */
  suspend(): void;
  /** Restore whatever the settings say. Must be safe to call when not suspended — it runs
   *  from a `finally`, and the paths that reach it include "the ad threw before it started". */
  resume(): void;
}

/** What the controller needs to know about the game to decide whether an ad is legal.
 *  Functions rather than values: it is consulted at the moment of the request, and the
 *  answer at wiring time would be meaningless. */
export interface AdContext {
  /** True while the player is in a run. An ad is refused outright. */
  inGameplay: () => boolean;
  /** True while a networked match is live. Refused for a second, independent reason:
   *  a lockstep session cannot stop for one player (design/06), so "freeze the game for
   *  30 seconds" is not something this client is able to honour there. */
  online: () => boolean;
}

/** Why an ad request did not result in a played ad. Every value is a branch with a test. */
export type AdRefusal =
  /** No SDK, or it reported an environment where ads do nothing. */
  | 'unavailable'
  /** The player is in a run. */
  | 'in-gameplay'
  /** A networked match is live. */
  | 'online'
  /** Another ad is already in flight. */
  | 'busy'
  /** Requested, and the network had nothing to show (the docs' "unfilled" case) — or the
   *  player dismissed it. Normal, not an error. */
  | 'not-filled'
  /** A rewarded ad the player watched is still inside `REWARDED_MIDGAME_COOLDOWN_MS`, so
   *  this automatic midgame would have stacked onto it. Only ever refuses a `midgame()`. */
  | 'too-soon';

export type AdOutcome = { played: true } | { played: false; reason: AdRefusal };

export class AdController {
  private inFlight = false;
  private adblocked = false;
  private probed = false;
  /** When the last rewarded ad the player actually WATCHED finished, or `null` for none
   *  this session. Only a played one counts: an unfilled request cost the player nothing
   *  and must not suppress the ordinary break ad. */
  private rewardedAt: number | null = null;

  constructor(
    private readonly sdk: CrazyGamesSdk,
    private readonly suspension: AdSuspension,
    private readonly context: AdContext,
    /** Injected in tests. Wall clock, not the ticker: an ad stops the ticker (see
     *  `suspension.ts`), so a tick count cannot measure the gap this guards. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Ask once whether this player blocks ads, so `rewardAvailable()` can answer
   *  synchronously from the UI thread later. Failure to answer counts as "not blocked" —
   *  see `sdk.hasAdblock`'s own note on why that default is the safe one. */
  async probe(): Promise<void> {
    this.adblocked = await this.sdk.hasAdblock();
    this.probed = true;
  }

  /** Whether a rewarded-ad OFFER may be drawn at all. False for an adblocked player and
   *  false with no live SDK, which is what keeps a dead button off the screen. */
  rewardAvailable(): boolean {
    return this.sdk.isEnabled() && !this.adblocked;
  }

  /** True while an ad is on screen. Read by `GameplayBracket` (an ad suppresses gameplay)
   *  and by the update loop's freeze. */
  isShowing(): boolean {
    return this.inFlight;
  }

  /** For the settings diagnostics row: whether `probe()` has run, and what it found. */
  adblockState(): 'unprobed' | 'blocked' | 'clear' {
    if (!this.probed) return 'unprobed';
    return this.adblocked ? 'blocked' : 'clear';
  }

  /**
   * A break between runs: the player has just left a run and is back on a menu.
   *
   * Called from exactly one place (`ScreenNav`'s return-to-menu path via
   * `PortalSession.onLeftRun`) so that "between runs" is a fact about the code and not an
   * intention. The SDK decides whether enough time has passed to actually fill it.
   */
  async midgame(): Promise<AdOutcome> {
    if (this.rewardedAt !== null && this.now() - this.rewardedAt < REWARDED_MIDGAME_COOLDOWN_MS) {
      return { played: false, reason: 'too-soon' };
    }
    return this.request('midgame');
  }

  /**
   * The rewarded ad. The reward is the caller's business; this resolves whether the ad
   * actually finished, and `played: false` must always leave the player with the non-ad
   * alternative rather than nothing (the requirements page asks for one explicitly — here
   * it is the ordinary banked-materials amount, which is never taken away).
   */
  async rewarded(): Promise<AdOutcome> {
    const outcome = await this.request('rewarded');
    // Stamped from the OUTCOME, not from the request: see `rewardedAt`'s note on why an
    // unfilled request must not suppress the next break ad.
    if (outcome.played) this.rewardedAt = this.now();
    return outcome;
  }

  private async request(type: CgAdType): Promise<AdOutcome> {
    if (!this.sdk.isEnabled()) return { played: false, reason: 'unavailable' };
    if (this.inFlight) return { played: false, reason: 'busy' };
    if (this.context.online()) return { played: false, reason: 'online' };
    if (this.context.inGameplay()) return { played: false, reason: 'in-gameplay' };

    this.inFlight = true;
    // Out of gameplay BEFORE the request, not after it starts: the docs treat the request
    // itself as part of the break, and a `gameplayStart` still standing when the ad opens is
    // the shape their QA looks for.
    this.sdk.gameplayStop();
    try {
      // `suspend` on `adStarted` rather than here, because a request that is never filled
      // must not mute the menu music for the length of the timeout. The `finally` below
      // still resumes unconditionally — `resume` is documented safe when not suspended,
      // which is what makes the never-started case free.
      return (await this.sdk.requestAd(type, {
        adStarted: () => this.suspension.suspend(),
      }))
        ? { played: true }
        : { played: false, reason: 'not-filled' };
    } finally {
      this.suspension.resume();
      this.inFlight = false;
    }
  }
}
