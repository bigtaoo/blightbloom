// The adapter between this directory's ad policy (`AdController`) and the game-facing
// seam (`platform/rewardedAd.ts`) — the split named in that file's header.
//
// It exists as its own exported function rather than an object literal inside
// `main.crazygames.ts` for one reason: an entry point is the one thing in this client no
// test can call (it runs `boot()` at import), so anything written there is unverifiable by
// construction. Three lines moved out here are three lines under test.
import type { RewardedAd } from '../rewardedAd';

/** What this needs of `AdController` — the two methods, so a test asserts against a
 *  two-method fake instead of a whole SDK (CLAUDE.md form ②'s narrowed dependency). The
 *  real controller satisfies it structurally; nothing has to declare it. */
export interface RewardedAdSource {
  rewardAvailable(): boolean;
  rewarded(): Promise<{ played: boolean }>;
}

/**
 * Wrap the controller as the game's `RewardedAd`.
 *
 * Both methods are deliberately thin: every rule about when an ad is legal already lives
 * in `AdController` (and must, since the midgame path shares it), so re-checking anything
 * here would be a second opinion that can disagree with the authoritative one.
 */
export function portalRewardedAd(ads: RewardedAdSource): RewardedAd {
  return {
    available: () => ads.rewardAvailable(),
    show: async () => (await ads.rewarded()).played,
  };
}
