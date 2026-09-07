/**
 * The adapter between `AdController` and the game-facing seam. It exists as a function so
 * that these four cases are possible at all — the alternative was an object literal inside
 * `main.crazygames.ts`, which no test can reach (an entry point runs `boot()` at import).
 *
 * The one behaviour worth pinning is that it FORWARDS rather than decides: `available` is
 * asked at the moment it is read, not captured at wiring time, and `show` reports only what
 * the controller reported. A cached answer here would draw the offer for an adblocked player
 * whose probe had not finished when the entry point ran.
 */
import { describe, it, expect } from 'vitest';
import { portalRewardedAd, type RewardedAdSource } from './portalRewardedAd';
import { AdController } from './AdController';
import { CrazyGamesSdk } from './sdk';

function source(opts: { available?: boolean; plays?: boolean } = {}) {
  let available = opts.available ?? true;
  let calls = 0;
  const src: RewardedAdSource = {
    rewardAvailable: () => available,
    rewarded: async () => { calls += 1; return { played: opts.plays ?? true }; },
  };
  return { src, calls: () => calls, set: (v: boolean) => { available = v; } };
}

describe('portalRewardedAd', () => {
  it('forwards availability, re-asked on every read', () => {
    const s = source({ available: false });
    const ad = portalRewardedAd(s.src);

    expect(ad.available()).toBe(false);
    s.set(true); // the adblock probe has since answered
    expect(ad.available()).toBe(true);
  });

  it('reduces a played outcome to true and requests exactly one ad', async () => {
    const s = source({ plays: true });
    const ad = portalRewardedAd(s.src);

    expect(await ad.show()).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it('reduces every refusal and unfilled request to false', async () => {
    const s = source({ plays: false });
    expect(await portalRewardedAd(s.src).show()).toBe(false);
  });

  it('accepts the REAL AdController structurally — the wiring the entry point does', async () => {
    // No SDK script on the page, so the controller is disabled and refuses: proof that the
    // shape matches without asserting on a shape a fake could satisfy alone.
    const ads = new AdController(new CrazyGamesSdk(), { suspend: () => {}, resume: () => {} }, {
      inGameplay: () => false,
      online: () => false,
    });
    const ad = portalRewardedAd(ads);

    expect(ad.available()).toBe(false);
    expect(await ad.show()).toBe(false);
  });
});
