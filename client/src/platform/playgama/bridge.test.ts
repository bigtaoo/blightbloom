/**
 * `PlaygamaBridge` — the wrapper over a REMOTE script, so the property under test is mostly
 * what happens when that script is missing, old, slow or throws: the game must carry on as a
 * plain browser build. The ad half is the other property: one ad at a time, a 'rewarded'
 * only counts once the ad then closes, and a watchdog takes the game back from an ad that
 * never opens or never closes.
 */
import { describe, expect, it, vi } from 'vitest';
import { AD_OPEN_MS, AD_RUN_MS, BRIDGE_WAIT_MS, PlaygamaBridge, type BridgeShape } from './bridge';

type Listener = (...a: unknown[]) => void;

/** A fake SDK that records every call and lets a test fire the events it subscribed to. */
function fakeSdk(over: Partial<BridgeShape> = {}) {
  const listeners = new Map<string, Listener>();
  const sent: string[] = [];
  const tracked: [string, unknown][] = [];
  const stored = new Map<string, unknown>();
  const shown: string[] = [];
  const sdk: BridgeShape = {
    initialize: () => Promise.resolve(),
    version: '2.4.1',
    platform: {
      id: 'playgama',
      language: 'de',
      isAudioEnabled: true,
      sendMessage: (m) => void sent.push(m),
      on: (e, cb) => void listeners.set(`platform:${e}`, cb),
    },
    storage: {
      get: (keys) => Promise.resolve(keys.map((k) => stored.get(k) ?? null)),
      set: (keys, values) => {
        keys.forEach((k, i) => stored.set(k, values[i]));
        return Promise.resolve();
      },
    },
    advertisement: {
      isInterstitialSupported: true,
      isRewardedSupported: true,
      showInterstitial: () => void shown.push('interstitial'),
      showRewarded: () => void shown.push('rewarded'),
      on: (e, cb) => void listeners.set(`ad:${e}`, cb),
    },
    device: { type: 'mobile' },
    analytics: { send: (e, d) => void tracked.push([e, d]) },
    ...over,
  };
  const fire = (key: string, ...a: unknown[]) => listeners.get(key)?.(...a);
  return { sdk, listeners, sent, tracked, stored, shown, fire };
}

/** A wait the test resolves by hand, so the watchdog's timing is the test's to choose. */
function manualWait() {
  const pending: { ms: number; resolve: () => void }[] = [];
  const wait = (ms: number) => new Promise<void>((resolve) => pending.push({ ms, resolve }));
  const release = async (ms: number) => {
    for (const p of pending.filter((x) => x.ms === ms)) p.resolve();
    await flush();
  };
  return { wait, pending, release };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('init — the game version', () => {
  it('is set on the SDK before initialize() runs, and left alone when absent', async () => {
    const seen: Array<string | undefined> = [];
    const sdk: BridgeShape = { initialize: () => void seen.push(sdk.gameVersion) };
    expect(await new PlaygamaBridge({ bridge: sdk }, manualWait().wait).init('0.0.1+abc')).toBe(true);
    expect(seen).toEqual(['0.0.1+abc']);
    const bare: BridgeShape = { initialize: () => undefined };
    await new PlaygamaBridge({ bridge: bare }, manualWait().wait).init();
    expect('gameVersion' in bare).toBe(false);
  });
});

async function ready(over: Partial<BridgeShape> = {}) {
  const f = fakeSdk(over);
  const w = manualWait();
  const bridge = new PlaygamaBridge({ bridge: f.sdk }, w.wait);
  expect(await bridge.init()).toBe(true);
  return { ...f, ...w, bridge };
}

describe('PlaygamaBridge.init', () => {
  it('is false without the script, and every call is then a harmless no-op', async () => {
    const bridge = new PlaygamaBridge({}, () => Promise.resolve());
    expect(await bridge.init()).toBe(false);
    expect(bridge.isReady()).toBe(false);
    expect(bridge.platformId()).toBeNull();
    expect(bridge.onPortal()).toBe(false);
    expect(bridge.describe()).toBe('none/?');
    expect(bridge.language()).toBeNull();
    expect(bridge.deviceType()).toBeNull();
    expect(bridge.hasStorage()).toBe(false);
    expect(await bridge.load(['a'])).toEqual(new Map());
    expect(bridge.interstitialSupported()).toBe(false);
    expect(bridge.rewardedSupported()).toBe(false);
    expect(await bridge.rewarded()).toBe(false);
    await bridge.interstitial();
    const cb = vi.fn();
    bridge.onMute(cb);
    bridge.onPause(cb);
    bridge.send('game_ready');
    bridge.track('x');
    bridge.save(new Map([['k', 'v']]));
    expect(cb).not.toHaveBeenCalled();
  });

  it('is false when the script has no initialize', async () => {
    const bridge = new PlaygamaBridge({ bridge: {} }, () => Promise.resolve());
    expect(await bridge.init()).toBe(false);
  });

  it('is false when initialize rejects', async () => {
    const f = fakeSdk({ initialize: () => Promise.reject(new Error('no')) });
    const bridge = new PlaygamaBridge({ bridge: f.sdk }, () => new Promise(() => undefined));
    expect(await bridge.init()).toBe(false);
    expect(bridge.isReady()).toBe(false);
  });

  it('gives up after BRIDGE_WAIT_MS on an initialize that never answers', async () => {
    const f = fakeSdk({ initialize: () => new Promise(() => undefined) });
    const waited: number[] = [];
    const bridge = new PlaygamaBridge({ bridge: f.sdk }, (ms) => {
      waited.push(ms);
      return Promise.resolve();
    });
    expect(await bridge.init()).toBe(false);
    expect(waited).toEqual([BRIDGE_WAIT_MS]);
  });

  it('reads the platform once ready', async () => {
    const { bridge } = await ready();
    expect(bridge.isReady()).toBe(true);
    expect(bridge.platformId()).toBe('playgama');
    expect(bridge.onPortal()).toBe(true);
    expect(bridge.describe()).toBe('playgama/2.4.1');
    expect(bridge.language()).toBe('de');
    expect(bridge.deviceType()).toBe('mobile');
  });

  it('treats the local mock and the QA tool as not a portal', async () => {
    for (const id of ['mock', 'qa_tool']) {
      const { bridge } = await ready({ platform: { id } });
      expect(bridge.onPortal()).toBe(false);
    }
  });

  it('answers null for empty or non-string platform fields', async () => {
    const { bridge } = await ready({ platform: { id: '', language: '' }, device: { type: '' }, version: undefined });
    expect(bridge.platformId()).toBeNull();
    expect(bridge.language()).toBeNull();
    expect(bridge.deviceType()).toBeNull();
    expect(bridge.describe()).toBe('none/?');
  });
});

describe('PlaygamaBridge — messages and analytics', () => {
  it('forwards messages and events', async () => {
    const { bridge, sent, tracked } = await ready();
    bridge.send('game_ready');
    bridge.track('run_end', { floor: 3 });
    await flush();
    expect(sent).toEqual(['game_ready']);
    expect(tracked).toEqual([['run_end', { floor: 3 }]]);
  });

  it('swallows a throwing sendMessage and an SDK without analytics', async () => {
    const { bridge } = await ready({
      platform: { sendMessage: () => { throw new Error('x'); } },
      analytics: undefined,
    });
    expect(() => bridge.send('game_ready')).not.toThrow();
    expect(() => bridge.track('e')).not.toThrow();
    await flush();
  });
});

describe('PlaygamaBridge — pause and sound', () => {
  it('reports the platform pause as a boolean and survives a throwing callback', async () => {
    const { bridge, fire } = await ready();
    const seen: boolean[] = [];
    bridge.onPause((p) => {
      seen.push(p);
      if (p) throw new Error('game bug');
    });
    await flush();
    fire('platform:pause_state_changed', true);
    fire('platform:pause_state_changed', false);
    fire('platform:pause_state_changed', 'junk');
    expect(seen).toEqual([true, false, false]);
  });

  it('calls back at once with the current sound state, then on every change', async () => {
    const { bridge } = await ready({ platform: { isAudioEnabled: false, on: undefined } });
    const seen: boolean[] = [];
    bridge.onMute((m) => seen.push(m));
    expect(seen).toEqual([true]);

    const f = await ready();
    const seen2: boolean[] = [];
    f.bridge.onMute((m) => seen2.push(m));
    await flush();
    f.fire('platform:audio_state_changed', false);
    f.fire('platform:audio_state_changed', true);
    expect(seen2).toEqual([false, true, false]);
  });
});

describe('PlaygamaBridge — storage', () => {
  it('loads strings as they are and objects stringified, and skips missing keys', async () => {
    const { bridge, stored } = await ready();
    stored.set('a', 'text');
    stored.set('b', { n: 1 });
    expect(await bridge.load(['a', 'b', 'c'])).toEqual(new Map([['a', 'text'], ['b', '{"n":1}']]));
  });

  it('saves a batch as two parallel arrays', async () => {
    const { bridge, stored } = await ready();
    expect(bridge.hasStorage()).toBe(true);
    bridge.save(new Map([['a', '1'], ['b', '2']]));
    await flush();
    expect([...stored]).toEqual([['a', '1'], ['b', '2']]);
  });

  it('loads nothing from a get that does not answer with an array', async () => {
    const { bridge } = await ready({ storage: { get: () => 'nope', set: () => undefined } });
    expect(await bridge.load(['a'])).toEqual(new Map());
  });

  it('has no storage without both halves', async () => {
    const { bridge } = await ready({ storage: { get: () => [] } });
    expect(bridge.hasStorage()).toBe(false);
  });
});

describe('PlaygamaBridge — ads', () => {
  it('pays a rewarded ad only once it was rewarded AND closed, and calls opened', async () => {
    const { bridge, fire, shown } = await ready();
    const opened = vi.fn();
    const result = bridge.rewarded(opened);
    expect(bridge.adInFlight()).toBe(true);
    await flush();
    expect(shown).toEqual(['rewarded']);
    fire('ad:rewarded_state_changed', 'opened');
    expect(opened).toHaveBeenCalledTimes(1);
    fire('ad:rewarded_state_changed', 'rewarded');
    fire('ad:rewarded_state_changed', 'closed');
    expect(await result).toBe(true);
    expect(bridge.adInFlight()).toBe(false);
  });

  it('does not pay an ad closed before the reward, and ignores events after it ended', async () => {
    const { bridge, fire } = await ready();
    const result = bridge.rewarded();
    await flush();
    fire('ad:rewarded_state_changed', 'opened');
    fire('ad:rewarded_state_changed', 'closed');
    fire('ad:rewarded_state_changed', 'rewarded');
    expect(await result).toBe(false);
  });

  it('does not pay a failed ad', async () => {
    const { bridge, fire } = await ready();
    const result = bridge.rewarded();
    await flush();
    fire('ad:rewarded_state_changed', 'rewarded');
    fire('ad:rewarded_state_changed', 'failed');
    expect(await result).toBe(false);
  });

  it('refuses a second ad while one is in flight, and subscribes once per event', async () => {
    const f = await ready();
    let subscriptions = 0;
    const on = f.sdk.advertisement!.on!;
    f.sdk.advertisement!.on = (e, cb) => {
      subscriptions += 1;
      return on(e, cb);
    };
    const first = f.bridge.interstitial();
    expect(await f.bridge.rewarded()).toBe(false);
    await flush();
    f.fire('ad:interstitial_state_changed', 'closed');
    await first;
    const second = f.bridge.interstitial();
    await flush();
    f.fire('ad:interstitial_state_changed', 'failed');
    await second;
    expect(subscriptions).toBe(1);
    expect(f.shown).toEqual(['interstitial', 'interstitial']);
  });

  it('ignores an event for the other ad kind', async () => {
    const f = await ready();
    const first = f.bridge.interstitial();
    await f.bridge.rewarded(); // refused, but leaves no listener behind
    await flush();
    f.fire('ad:interstitial_state_changed', 'closed');
    await first;
    const r = f.bridge.rewarded();
    await flush();
    f.fire('ad:interstitial_state_changed', 'closed'); // the wrong channel
    expect(f.bridge.adInFlight()).toBe(true);
    f.fire('ad:rewarded_state_changed', 'closed');
    expect(await r).toBe(false);
  });

  it('fails an ad that never opens after AD_OPEN_MS', async () => {
    const { bridge, release } = await ready();
    const result = bridge.rewarded();
    await release(AD_OPEN_MS);
    expect(await result).toBe(false);
    expect(bridge.adInFlight()).toBe(false);
  });

  it('fails an opened ad that never closes after AD_RUN_MS in total', async () => {
    const { bridge, fire, release, pending } = await ready();
    const result = bridge.interstitial();
    await flush();
    fire('ad:interstitial_state_changed', 'opened');
    await release(AD_OPEN_MS);
    expect(bridge.adInFlight()).toBe(true);
    expect(pending.some((p) => p.ms === AD_RUN_MS - AD_OPEN_MS)).toBe(true);
    await release(AD_RUN_MS - AD_OPEN_MS);
    await result;
    expect(bridge.adInFlight()).toBe(false);
  });

  it('fails an ad whose show call throws', async () => {
    const { bridge } = await ready({
      advertisement: {
        isRewardedSupported: true,
        on: () => undefined,
        showRewarded: () => { throw new Error('x'); },
      },
    });
    expect(await bridge.rewarded()).toBe(false);
    expect(bridge.adInFlight()).toBe(false);
  });

  it('shows nothing where the kind is unsupported or there is no event API', async () => {
    const a = await ready({ advertisement: { isInterstitialSupported: false, isRewardedSupported: false } });
    await a.bridge.interstitial();
    expect(await a.bridge.rewarded()).toBe(false);
    const b = await ready({ advertisement: { isRewardedSupported: true } });
    expect(await b.bridge.rewarded()).toBe(false);
  });

  it('keeps a throwing opened callback from breaking the ad', async () => {
    const { bridge, fire } = await ready();
    const result = bridge.rewarded(() => { throw new Error('x'); });
    await flush();
    fire('ad:rewarded_state_changed', 'opened');
    fire('ad:rewarded_state_changed', 'rewarded');
    fire('ad:rewarded_state_changed', 'closed');
    expect(await result).toBe(true);
  });
});

describe('PlaygamaBridge — default globals', () => {
  it('reads the real global and waits with a real timer by default', async () => {
    const g = globalThis as { bridge?: BridgeShape };
    g.bridge = fakeSdk().sdk;
    try {
      const bridge = new PlaygamaBridge();
      expect(await bridge.init()).toBe(true);
    } finally {
      delete g.bridge;
    }
  });
});
