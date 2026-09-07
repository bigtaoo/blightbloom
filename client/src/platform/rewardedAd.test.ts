/**
 * The rewarded-ad seam. Three lines of registry, and the reason it is tested at all is
 * that its DEFAULT is the load-bearing half: every target but the portal installs nothing,
 * and "nothing installed" has to mean "no offer is ever drawn" rather than a crash or a
 * truthy stub. `rewardedAdAvailable()` is what call sites read, so it is asserted directly
 * for each of the three states it can be in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { rewardedAd, rewardedAdAvailable, setRewardedAd, type RewardedAd } from './rewardedAd';

function stub(available: boolean, plays = true): RewardedAd {
  return { available: () => available, show: async () => plays };
}

afterEach(() => setRewardedAd(null));

describe('rewardedAd seam', () => {
  it('is uninstalled by default: no implementation, and not available', () => {
    expect(rewardedAd()).toBeNull();
    expect(rewardedAdAvailable()).toBe(false);
  });

  it('an installed implementation is handed back as-is', async () => {
    const ad = stub(true);
    setRewardedAd(ad);

    expect(rewardedAd()).toBe(ad);
    expect(await rewardedAd()!.show()).toBe(true);
  });

  it('availability is asked of the implementation on every read, not cached at install', () => {
    let ok = false;
    setRewardedAd({ available: () => ok, show: async () => true });

    expect(rewardedAdAvailable()).toBe(false);
    ok = true; // e.g. the adblock probe has since answered
    expect(rewardedAdAvailable()).toBe(true);
  });

  it('an INSTALLED implementation that says no is as unavailable as none at all', () => {
    setRewardedAd(stub(false));

    expect(rewardedAd()).not.toBeNull();
    expect(rewardedAdAvailable()).toBe(false);
  });

  it('uninstalling restores the default — the reset a test suite and a locale switch share', () => {
    setRewardedAd(stub(true));
    setRewardedAd(null);

    expect(rewardedAd()).toBeNull();
    expect(rewardedAdAvailable()).toBe(false);
  });
});
