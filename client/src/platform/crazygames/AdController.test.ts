/**
 * `AdController` — the ad POLICY, which is where the platform's rules live.
 *
 * Every test here corresponds to a rule rather than to a line: an ad may never interrupt
 * gameplay, the game is muted and frozen for the length of one, an adblocked player is
 * offered nothing they cannot have, and the mute is released on every path including the
 * ones where the ad never started. The last is the one worth writing tests for even if
 * nothing else here were tested — a leaked suspension leaves the game silent and its clock
 * stopped, which from the player's side is indistinguishable from a crash.
 */
import { describe, expect, it } from 'vitest';
import { AdController, REWARDED_MIDGAME_COOLDOWN_MS, type AdContext, type AdSuspension } from './AdController';
import type { CgAdCallbacks, CrazyGamesSdk } from './sdk';

/** A stand-in for the SDK wrapper, narrowed to what the controller touches. `live` is the
 *  `isEnabled()` answer, i.e. "a request here will actually do something". */
function stubSdk(opts: {
  live?: boolean;
  adblock?: boolean;
  ad?: (type: string, hooks: CgAdCallbacks) => boolean | Promise<boolean>;
} = {}) {
  const calls: string[] = [];
  const sdk = {
    isEnabled: () => opts.live ?? true,
    hasAdblock: async () => opts.adblock ?? false,
    gameplayStop: () => void calls.push('gameplayStop'),
    requestAd: async (type: string, hooks: CgAdCallbacks) => {
      calls.push(`requestAd:${type}`);
      return (await opts.ad?.(type, hooks)) ?? false;
    },
  };
  return { sdk: sdk as unknown as CrazyGamesSdk, calls };
}

function stubSuspension(): AdSuspension & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    suspend: () => void log.push('suspend'),
    resume: () => void log.push('resume'),
  };
}

function ctx(over: Partial<AdContext> = {}): AdContext {
  return { inGameplay: () => false, online: () => false, ...over };
}

describe('AdController refusals', () => {
  it('refuses where the SDK will not act — our own domain, or a blocked script', async () => {
    const { sdk, calls } = stubSdk({ live: false });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    expect(await ads.midgame()).toEqual({ played: false, reason: 'unavailable' });
    // Not merely "resolved false": nothing was requested and nothing was told to stop.
    expect(calls).toEqual([]);
  });

  it('refuses during gameplay', async () => {
    // THE rule. An ad over a live run is the single thing the requirements page repeats
    // most, so the refusal is structural: there is no method here that can do it.
    const { sdk, calls } = stubSdk();
    const ads = new AdController(sdk, stubSuspension(), ctx({ inGameplay: () => true }));
    expect(await ads.midgame()).toEqual({ played: false, reason: 'in-gameplay' });
    expect(await ads.rewarded()).toEqual({ played: false, reason: 'in-gameplay' });
    expect(calls).toEqual([]);
  });

  it('refuses while a networked match is live', async () => {
    // A second, independent reason: freezing the clock for 30 seconds is not something a
    // lockstep session can survive (design/06 — it cannot stop for one player). Asserted
    // separately from the gameplay refusal because it must hold even between runs of an
    // online session, when `inGameplay` is already false.
    const { sdk, calls } = stubSdk();
    const ads = new AdController(sdk, stubSuspension(), ctx({ online: () => true }));
    expect(await ads.midgame()).toEqual({ played: false, reason: 'online' });
    expect(calls).toEqual([]);
  });

  it('refuses a second ad while one is in flight', async () => {
    const releases: Array<(ok: boolean) => void> = [];
    const { sdk } = stubSdk({ ad: () => new Promise<boolean>((r) => void releases.push(r)) });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    const first = ads.midgame();
    expect(ads.isShowing()).toBe(true);
    expect(await ads.rewarded()).toEqual({ played: false, reason: 'busy' });
    releases[0]?.(true);
    expect(await first).toEqual({ played: true });
    expect(ads.isShowing()).toBe(false);
  });

  it('reports an unfilled ad as not-filled rather than as an error', async () => {
    const { sdk } = stubSdk({ ad: () => false });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    expect(await ads.rewarded()).toEqual({ played: false, reason: 'not-filled' });
  });
});

describe('AdController suspension', () => {
  it('mutes and freezes when the ad STARTS, not when it is requested', async () => {
    // The distinction has teeth: a request that is never filled would otherwise mute the
    // menu music for the length of the network timeout, for nothing.
    const suspension = stubSuspension();
    const { sdk } = stubSdk({
      ad: (_t, hooks) => {
        expect(suspension.log).toEqual([]); // requested, nothing suspended yet
        hooks.adStarted?.();
        expect(suspension.log).toEqual(['suspend']);
        return true;
      },
    });
    const ads = new AdController(sdk, suspension, ctx());
    await ads.midgame();
    expect(suspension.log).toEqual(['suspend', 'resume']);
  });

  it('releases the suspension when the ad errors', async () => {
    const suspension = stubSuspension();
    const { sdk } = stubSdk({
      ad: (_t, hooks) => {
        hooks.adStarted?.();
        return false; // adError arm, as `sdk.requestAd` reports it
      },
    });
    await new AdController(sdk, suspension, ctx()).midgame();
    expect(suspension.log).toEqual(['suspend', 'resume']);
  });

  it('releases the suspension even when requestAd rejects outright', async () => {
    // The worst case, and the reason `request` uses a `finally`: an exception on the way out
    // must not leave the game muted and frozen forever.
    const suspension = stubSuspension();
    const sdk = {
      isEnabled: () => true,
      gameplayStop: () => {},
      requestAd: () => Promise.reject(new Error('boom')),
    } as unknown as CrazyGamesSdk;
    const ads = new AdController(sdk, suspension, ctx());
    await expect(ads.midgame()).rejects.toThrow('boom');
    expect(suspension.log).toEqual(['resume']);
    // ...and the controller is usable again rather than wedged as permanently busy.
    expect(ads.isShowing()).toBe(false);
  });

  it('leaves gameplay stopped before the request goes out', async () => {
    const { sdk, calls } = stubSdk({ ad: () => true });
    await new AdController(sdk, stubSuspension(), ctx()).midgame();
    expect(calls).toEqual(['gameplayStop', 'requestAd:midgame']);
  });
});

describe('AdController rewarded-ad offers', () => {
  it('offers nothing to an adblocked player', async () => {
    // The requirement is that an adblocked player plays normally and is not shown a
    // rewarded offer that cannot work — hidden, specifically, rather than disabled.
    const { sdk } = stubSdk({ adblock: true });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    await ads.probe();
    expect(ads.rewardAvailable()).toBe(false);
    expect(ads.adblockState()).toBe('blocked');
  });

  it('offers to a player who allows ads', async () => {
    const { sdk } = stubSdk({ adblock: false });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    await ads.probe();
    expect(ads.rewardAvailable()).toBe(true);
    expect(ads.adblockState()).toBe('clear');
  });

  it('offers nothing where the SDK will not act, probed or not', async () => {
    const { sdk } = stubSdk({ live: false });
    const ads = new AdController(sdk, stubSuspension(), ctx());
    expect(ads.adblockState()).toBe('unprobed');
    expect(ads.rewardAvailable()).toBe(false);
    await ads.probe();
    expect(ads.rewardAvailable()).toBe(false);
  });

  it('requests the rewarded type, not the midgame one', async () => {
    const { sdk, calls } = stubSdk({ ad: () => true });
    await new AdController(sdk, stubSuspension(), ctx()).rewarded();
    expect(calls).toContain('requestAd:rewarded');
  });
});

// ---------------------------------------------------------------------------------------
// The rewarded → midgame cooldown (2026-09-07, with the rewarded-ad offer on the results
// screen). Two individually legal calls produced one illegal outcome: a rewarded ad does
// not count against the SDK's midgame cap, so watching one on the results screen and then
// pressing CONFIRM handed the player a second ad seconds later.
// ---------------------------------------------------------------------------------------
describe('AdController — a midgame ad never stacks onto a rewarded one', () => {
  /** A controller whose clock the test drives, and whose ads always fill. */
  function harness(fills = true) {
    const { sdk, calls } = stubSdk({ ad: (_t, hooks) => { hooks.adStarted?.(); return fills; } });
    let now = 10_000;
    const ads = new AdController(sdk, stubSuspension(), ctx(), () => now);
    return { ads, calls, advance: (ms: number) => { now += ms; } };
  }

  it('suppresses the midgame inside the cooldown, and requests nothing at all', async () => {
    const h = harness();
    expect(await h.ads.rewarded()).toEqual({ played: true });
    h.advance(REWARDED_MIDGAME_COOLDOWN_MS - 1);

    expect(await h.ads.midgame()).toEqual({ played: false, reason: 'too-soon' });
    // The refusal is ours, before the SDK: exactly one request happened, the rewarded one.
    expect(h.calls.filter((c) => c.startsWith('requestAd'))).toEqual(['requestAd:rewarded']);
  });

  it('allows the midgame once the cooldown has passed', async () => {
    const h = harness();
    await h.ads.rewarded();
    h.advance(REWARDED_MIDGAME_COOLDOWN_MS);

    expect(await h.ads.midgame()).toEqual({ played: true });
  });

  it('an UNFILLED rewarded request suppresses nothing — it cost the player no time', async () => {
    const h = harness(false);
    expect(await h.ads.rewarded()).toEqual({ played: false, reason: 'not-filled' });

    // No cooldown was started, so the ordinary break ad is still allowed immediately.
    expect(await h.ads.midgame()).toEqual({ played: false, reason: 'not-filled' });
    expect(h.calls.filter((c) => c.startsWith('requestAd'))).toEqual(['requestAd:rewarded', 'requestAd:midgame']);
  });

  it('does not gate the REWARDED ad itself — the player asked for that one', async () => {
    const h = harness();
    await h.ads.rewarded();
    h.advance(1_000);

    // A second rewarded ad inside the window is still allowed: the cooldown exists to stop
    // an ad the player did not ask for, not one they pressed a button for.
    expect(await h.ads.rewarded()).toEqual({ played: true });
  });

  it('with no rewarded ad this session, the midgame path is exactly as it was', async () => {
    const h = harness();
    expect(await h.ads.midgame()).toEqual({ played: true });
  });
});
