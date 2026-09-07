/**
 * `sdk.ts` — the wrapper whose entire job is that a remote script cannot break the game.
 *
 * So the cases that matter are the ABSENCE cases, and they are the majority of this file: no
 * global, a global with no methods, a method that throws synchronously, a method that
 * returns a rejected promise. Each one has to be indistinguishable from success at the call
 * site, because every call site is fire-and-forget.
 *
 * The fake below mimics the documented v2 shape (`docs.crazygames.com/sdk/html5-v2`). It is
 * a fake and it is the only thing these tests can prove things against — what remains
 * unproven is whether the documented names are the shipped names, which is why
 * `environment()` is surfaced through `PortalSession.diagnostics()` and readable on a live
 * page. See the module header.
 */
import { describe, expect, it, vi } from 'vitest';
import { CrazyGamesSdk, SDK_WAIT_MS, type CgAdCallbacks, type CgGlobal, type CgSdkShape } from './sdk';

/** Zero waiting: `init`'s poll loop is driven by injected `now`/`sleep`, so a test that
 *  exercises the timeout does not spend 3 real seconds doing it. */
function fastSdk(global: CgGlobal, opts: { advanceMs?: number } = {}) {
  let clock = 0;
  const advance = opts.advanceMs ?? 1000;
  return new CrazyGamesSdk(
    global,
    () => clock,
    async () => {
      clock += advance;
    },
  );
}

function fakeSdk(over: Partial<CgSdkShape> = {}): CgSdkShape {
  return {
    environment: 'crazygames',
    init: () => Promise.resolve(),
    game: {
      sdkGameLoadingStart: vi.fn(),
      sdkGameLoadingStop: vi.fn(),
      gameplayStart: vi.fn(),
      gameplayStop: vi.fn(),
      happytime: vi.fn(),
    },
    ad: { requestAd: vi.fn(), hasAdblock: () => Promise.resolve(false) },
    banner: { requestBanner: vi.fn(), clearBanner: vi.fn(), clearAllBanners: vi.fn() },
    ...over,
  };
}

describe('CrazyGamesSdk.init', () => {
  it('reads the environment the script reports', async () => {
    const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk({ environment: 'local' }) } });
    expect(await sdk.init()).toBe('local');
    expect(sdk.environment()).toBe('local');
    // `local` counts as ENABLED, deliberately: testing ads is the whole purpose of that
    // environment, and a gate that excluded it would mean the ad and banner paths could only
    // ever run for the first time in production.
    expect(sdk.isEnabled()).toBe(true);
  });

  it('is enabled on a real portal page', async () => {
    const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk() } });
    await sdk.init();
    expect(sdk.isEnabled()).toBe(true);
  });

  it('is NOT enabled where the SDK declines to act', async () => {
    // The case that produced a real console error on the first live run: a page the SDK
    // reports as `disabled` still has a `window.CrazyGames`, so "the script is present" is
    // not the question — "will a request do anything" is.
    const disabled = fastSdk({ CrazyGames: { SDK: fakeSdk({ environment: 'disabled' }) } });
    await disabled.init();
    expect(disabled.isEnabled()).toBe(false);

    const absent = new CrazyGamesSdk({});
    expect(absent.isEnabled()).toBe(false);
  });

  it('gives up after the wait budget when the script never arrives', async () => {
    // The real failure this covers: an adblocker blocks sdk.crazygames.com, so the global
    // never appears and `init` would otherwise poll forever with boot behind it.
    const sleep = vi.fn(async () => {
      clock += 500;
    });
    let clock = 0;
    const sdk = new CrazyGamesSdk({}, () => clock, sleep);
    expect(await sdk.init()).toBe('disabled');
    // Bounded, and bounded by the budget rather than by a retry count.
    expect(clock).toBeGreaterThanOrEqual(SDK_WAIT_MS);
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(SDK_WAIT_MS / 500 + 1);
  });

  it('waits for a script that arrives late rather than only probing once', async () => {
    const global: CgGlobal = {};
    let clock = 0;
    const sdk = new CrazyGamesSdk(
      global,
      () => clock,
      async () => {
        clock += 100;
        if (clock >= 300) global.CrazyGames = { SDK: fakeSdk() };
      },
    );
    expect(await sdk.init()).toBe('crazygames');
  });

  it('still reads the environment when init() itself throws', async () => {
    // `init()` talks to the parent frame and is allowed to fail; `environment` is set by the
    // script independently, so a failed init must not cost us the environment.
    const sdk = fastSdk({
      CrazyGames: {
        SDK: fakeSdk({
          init: () => {
            throw new Error('no parent frame');
          },
        }),
      },
    });
    expect(await sdk.init()).toBe('crazygames');
  });

  it('resolves even when the SDK’s own init() never settles', async () => {
    // Observed on a real page, and the worst failure this file can have: an unbounded await
    // here means `PortalSession.start()` never resolves, so `loadingStop()` is never called
    // and the portal shows a loading spinner over a game that has been playable for minutes.
    let clock = 0;
    const sdk = new CrazyGamesSdk(
      { CrazyGames: { SDK: fakeSdk({ init: () => new Promise(() => {}) }) } },
      () => clock,
      async () => {
        clock += 500;
      },
    );
    // Still answers, and answers with the environment the script had already set.
    expect(await sdk.init()).toBe('crazygames');
    expect(clock).toBeGreaterThanOrEqual(SDK_WAIT_MS);
  });

  it('waits for an environment that appears after init, rather than reading it once', async () => {
    // The second real-page finding: the SDK object initially carries only `sdkInitializer`
    // and a few throttled wrappers, and `environment` appears once its own async init has
    // run. A single read reported `disabled` for a page that was about to answer `local`,
    // and the whole integration then silently did nothing — no brackets, no banner, no ads.
    const shape = fakeSdk();
    delete shape.environment;
    let clock = 0;
    const sdk = new CrazyGamesSdk(
      { CrazyGames: { SDK: shape } },
      () => clock,
      async () => {
        clock += 200;
        if (clock >= 600) shape.environment = 'local';
      },
    );
    expect(await sdk.init()).toBe('local');
    expect(sdk.isEnabled()).toBe(true);
  });

  it('gives up on an environment that never appears', async () => {
    const shape = fakeSdk();
    delete shape.environment;
    let clock = 0;
    const sdk = new CrazyGamesSdk({ CrazyGames: { SDK: shape } }, () => clock, async () => {
      clock += 500;
    });
    expect(await sdk.init()).toBe('disabled');
    expect(clock).toBeGreaterThanOrEqual(SDK_WAIT_MS);
  });

  it('reads the environment from v2’s getEnvironment(), not just v3’s property', async () => {
    // Found on a live page, not in the docs: the shipped `crazygames-sdk-v2.js` (2.9.0) has
    // NO `environment` property — `'environment' in SDK` is false — only
    // `getEnvironment()` on its prototype. Reading the documented property alone reported
    // `disabled` for a page whose own console was logging `environment: local`, and the
    // whole integration then did nothing at all, silently.
    const shape = fakeSdk();
    delete shape.environment;
    shape.getEnvironment = () => 'local';
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    expect(await sdk.init()).toBe('local');
  });

  it('awaits getEnvironment(), which returns a PROMISE on the live SDK', async () => {
    // The second half of the same finding, and the half that is nowhere in the docs: 2.9.0's
    // `getEnvironment()` hands back a `Promise<'local' | ...>`. A synchronous read gets an
    // object, fails the string check, and reports `disabled` — which is what it did.
    const shape = fakeSdk();
    delete shape.environment;
    shape.getEnvironment = () => Promise.resolve('local');
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    expect(await sdk.init()).toBe('local');
    expect(sdk.isEnabled()).toBe(true);
  });

  it('gives up on a getEnvironment() promise that never settles', async () => {
    const shape = fakeSdk();
    delete shape.environment;
    shape.getEnvironment = () => new Promise(() => {});
    let clock = 0;
    const sdk = new CrazyGamesSdk({ CrazyGames: { SDK: shape } }, () => clock, async () => {
      clock += 500;
    });
    expect(await sdk.init()).toBe('disabled');
    expect(clock).toBeGreaterThanOrEqual(SDK_WAIT_MS);
  });

  it('prefers the property when both shapes are present', async () => {
    const shape = fakeSdk({ environment: 'crazygames', getEnvironment: () => 'local' });
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    expect(await sdk.init()).toBe('crazygames');
  });

  it('treats a getEnvironment that throws as an absent one', async () => {
    const shape = fakeSdk();
    delete shape.environment;
    shape.getEnvironment = () => {
      throw new Error('not ready');
    };
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    expect(await sdk.init()).toBe('disabled');
  });

  it('reports disabled for an environment string it does not recognise', async () => {
    const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk({ environment: 'something-new' }) } });
    expect(await sdk.init()).toBe('disabled');
  });
});

describe('CrazyGamesSdk game-module calls', () => {
  it('forwards each bracket to its documented method', async () => {
    const shape = fakeSdk();
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    await sdk.init();
    sdk.loadingStart();
    sdk.loadingStop();
    sdk.gameplayStart();
    sdk.gameplayStop();
    sdk.happytime();
    expect(shape.game?.sdkGameLoadingStart).toHaveBeenCalledOnce();
    expect(shape.game?.sdkGameLoadingStop).toHaveBeenCalledOnce();
    expect(shape.game?.gameplayStart).toHaveBeenCalledOnce();
    expect(shape.game?.gameplayStop).toHaveBeenCalledOnce();
    expect(shape.game?.happytime).toHaveBeenCalledOnce();
  });

  it('is silent with no SDK at all', () => {
    // Every unit test in this repository and every local `vite dev` session is this case.
    const sdk = new CrazyGamesSdk({});
    expect(() => {
      sdk.loadingStart();
      sdk.gameplayStart();
      sdk.gameplayStop();
      sdk.happytime();
      sdk.clearBanner('x');
      sdk.clearAllBanners();
    }).not.toThrow();
  });

  it('is silent when the SDK is present but a method is missing', async () => {
    // The version-skew case: a v2 script that drops or renames a method. It must degrade to
    // "that call does nothing", never to a TypeError inside a ticker callback.
    const sdk = fastSdk({ CrazyGames: { SDK: { environment: 'crazygames', game: {} } } });
    await sdk.init();
    expect(() => sdk.gameplayStart()).not.toThrow();
  });

  it('is silent when a method throws', async () => {
    const sdk = fastSdk({
      CrazyGames: {
        SDK: {
          environment: 'crazygames',
          game: {
            gameplayStart: () => {
              throw new Error('boom');
            },
          },
        },
      },
    });
    await sdk.init();
    expect(() => sdk.gameplayStart()).not.toThrow();
  });
});

describe('CrazyGamesSdk.requestAd', () => {
  /** Drive an ad the way the SDK does: hand the callbacks back to the test. */
  function adSdk(behaviour: (cb: CgAdCallbacks) => void) {
    const shape = fakeSdk({ ad: { requestAd: (_t, cb) => behaviour(cb) } });
    return fastSdk({ CrazyGames: { SDK: shape } });
  }

  it('resolves true only when the ad finished', async () => {
    const sdk = adSdk((cb) => {
      cb.adStarted?.();
      cb.adFinished?.();
    });
    await sdk.init();
    const started = vi.fn();
    const finished = vi.fn();
    await expect(sdk.requestAd('midgame', { adStarted: started, adFinished: finished })).resolves.toBe(true);
    expect(started).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
  });

  it('resolves false on an unfilled request, and reports the error to the caller', async () => {
    const sdk = adSdk((cb) => cb.adError?.('unfilled', { code: 1 }));
    await sdk.init();
    const onError = vi.fn();
    await expect(sdk.requestAd('rewarded', { adError: onError })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith('unfilled', { code: 1 });
  });

  it('resolves false — and synthesises an error — when requestAd throws synchronously', async () => {
    // The bug this exists to prevent: a throw means no callback will ever arrive, so a
    // promise that only settles from a callback would hang forever with the game muted and
    // its clock stopped. That is not a hypothetical; it is what `AdController` relies on.
    const sdk = adSdk(() => {
      throw new Error('sdk internal');
    });
    await sdk.init();
    const onError = vi.fn();
    await expect(sdk.requestAd('midgame', { adError: onError })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('resolves false when there is no ad module', async () => {
    const sdk = fastSdk({ CrazyGames: { SDK: { environment: 'crazygames' } } });
    await sdk.init();
    await expect(sdk.requestAd('midgame')).resolves.toBe(false);
  });

  it('settles once even if the SDK calls back twice', async () => {
    // Defensive, and cheap: a double `adFinished` would otherwise resolve an already-settled
    // promise (harmless) but a `adFinished` then `adError` would make the outcome depend on
    // ordering. First answer wins.
    const sdk = adSdk((cb) => {
      cb.adFinished?.();
      cb.adError?.('late');
    });
    await sdk.init();
    await expect(sdk.requestAd('midgame')).resolves.toBe(true);
  });

  it('survives a hook that throws, and still settles', async () => {
    // A game-side hook failure must not propagate back into the SDK's dispatch, which would
    // leave the remaining callbacks unrun — the concrete symptom being an ad that ends with
    // the game still muted.
    const sdk = adSdk((cb) => {
      cb.adStarted?.();
      cb.adFinished?.();
    });
    await sdk.init();
    await expect(
      sdk.requestAd('midgame', {
        adStarted: () => {
          throw new Error('mute failed');
        },
      }),
    ).resolves.toBe(true);
  });
});

describe('CrazyGamesSdk.hasAdblock', () => {
  it('reports what the SDK says, and asks only once', async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk({ ad: { hasAdblock: probe } }) } });
    await sdk.init();
    expect(await sdk.hasAdblock()).toBe(true);
    expect(await sdk.hasAdblock()).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('reports false when it cannot be asked', async () => {
    // The default has to be "offer the reward and let the request fail into its non-ad
    // alternative", not "delete the offer" — otherwise a local build silently loses it.
    const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk({ ad: {} }) } });
    await sdk.init();
    expect(await sdk.hasAdblock()).toBe(false);
  });

  it('reports false when the probe rejects', async () => {
    const sdk = fastSdk({
      CrazyGames: { SDK: fakeSdk({ ad: { hasAdblock: () => Promise.reject(new Error('x')) } }) },
    });
    await sdk.init();
    expect(await sdk.hasAdblock()).toBe(false);
  });
});

describe('CrazyGamesSdk banner and invite calls', () => {
  it('addresses the banner container by id', async () => {
    const shape = fakeSdk();
    const sdk = fastSdk({ CrazyGames: { SDK: shape } });
    await sdk.init();
    await sdk.requestBanner('cg-banner', 320, 50);
    sdk.clearBanner('cg-banner');
    expect(shape.banner?.requestBanner).toHaveBeenCalledWith({ id: 'cg-banner', width: 320, height: 50 });
    expect(shape.banner?.clearBanner).toHaveBeenCalledWith('cg-banner');
  });

  it('returns an invite link, or null on every failure path', async () => {
    const ok = fastSdk({
      CrazyGames: {
        SDK: fakeSdk({ game: { inviteLink: (p) => `https://crazygames.com/x?party=${p.party}` } }),
      },
    });
    await ok.init();
    expect(await ok.inviteLink({ party: 'ABCD' })).toBe('https://crazygames.com/x?party=ABCD');

    // An empty string is a failure dressed as a success — it would render as a share button
    // that copies nothing — so it is normalised to null alongside the real failures.
    for (const game of [{}, { inviteLink: () => '' }, { inviteLink: () => 42 }]) {
      const sdk = fastSdk({ CrazyGames: { SDK: fakeSdk({ game }) } });
      await sdk.init();
      expect(await sdk.inviteLink({ party: 'ABCD' })).toBeNull();
    }
  });

  it('reads an invite parameter, or null', async () => {
    const sdk = fastSdk({
      CrazyGames: { SDK: fakeSdk({ game: { getInviteParam: (n) => (n === 'party' ? 'WXYZ' : '') } }) },
    });
    await sdk.init();
    expect(await sdk.getInviteParam('party')).toBe('WXYZ');
    expect(await sdk.getInviteParam('other')).toBeNull();
  });
});
