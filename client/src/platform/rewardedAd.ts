// The rewarded-ad seam: a capability the ENTRY POINT installs and the game layer reads.
//
// Why a registry rather than a direct import. `src/game/` may not import
// `platform/crazygames/` — that directory's own header states the shape it is keeping
// ("the game does not know it exists. Nothing in `src/game/` imports it. Removing the
// portal target is deleting one entry point and this directory"), and a rewarded ad is
// the one place that shape does not reach on its own: an offer has to be DRAWN on a
// screen the game owns, and its reward has to land in the meta layer. Everything else
// the portal wants is derivable from the phase stream; this is not.
//
// So the capability is declared here, in `platform/` beside `hostKind.ts` and
// `storePlatform.ts`, as a module-level registry set once at boot — the same shape
// `setUiAudio`/`setMusicAudio`/`setHostKind` already use. `main.crazygames.ts` installs
// the one implementation there is (`crazygames/portalRewardedAd.ts`, an adapter over
// `AdController`); every other entry point installs nothing, and nothing installed means
// no offer is drawn anywhere. Deleting the portal target still costs exactly one entry
// point and one directory.
//
// What this deliberately does NOT model: the reward. A reward is game/design knowledge
// (design/05's locked wipe rule, design/14's "sell breadth, not power") and lives with
// the screen that grants it — `controllers/RunOutcome.ts`. This is only "may I offer an
// ad, and did one play".

/** One rewarded ad, as the two questions a call site has. */
export interface RewardedAd {
  /**
   * May an offer be DRAWN at all? False for an adblocked player and false with no live
   * SDK, which is what keeps a button that cannot work off the screen — the requirements
   * page (`docs.crazygames.com/requirements/ads`) asks for that specifically.
   *
   * Synchronous on purpose: it is read while laying out a screen, and a promise there
   * would mean drawing the button first and retracting it.
   */
  available(): boolean;
  /**
   * Show one. Resolves `true` only when the ad actually finished; every refusal and every
   * unfilled request resolves `false`. Never throws, and never leaves the game muted or
   * frozen — see `AdController.request`'s `finally`.
   *
   * A `false` must always leave the player with the non-ad alternative rather than
   * nothing. That is the caller's job, and the caller does it by having already granted
   * the baseline before the offer is ever shown.
   */
  show(): Promise<boolean>;
}

let installed: RewardedAd | null = null;

/** Install (or, with `null`, uninstall) the implementation. Called from an entry point
 *  before the first screen exists; `null` is also how a test resets between cases. */
export function setRewardedAd(ad: RewardedAd | null): void {
  installed = ad;
}

/** The installed implementation, or `null` on every build that has none. */
export function rewardedAd(): RewardedAd | null {
  return installed;
}

/** Whether an offer may be drawn right now. Collapses "nothing is installed" and "the
 *  installed implementation says no" into the one question every call site actually has,
 *  so no caller has to remember both halves. */
export function rewardedAdAvailable(): boolean {
  return installed?.available() ?? false;
}
