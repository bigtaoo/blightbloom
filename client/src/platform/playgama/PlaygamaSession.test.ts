/**
 * `PlaygamaSession` — what Bridge is told and what Bridge may stop, derived from the phase
 * stream alone. Written as phase SEQUENCES a player walks, like `PortalSession.test.ts`.
 *
 * What would fail silently: an interstitial on entering a run instead of at one of the three
 * natural pauses `naturalPause()` names (or on opening Settings from a paused run), a platform
 * pause that never stops the clock, an ad ending that unmutes a game the platform had muted,
 * and a `gameplay_started` while an ad is up.
 */
import { describe, expect, it } from 'vitest';
import { PlaygamaSession } from './PlaygamaSession';
import type { Phase } from '../../game/phase';

interface Pending {
  opened: () => void;
  resolve: (v: boolean) => void;
}

function harness(opts: { rewarded?: boolean; throwOnOpen?: boolean } = {}) {
  const log: string[] = [];
  let phase: Phase = 'menu';
  let pause: ((p: boolean) => void) | null = null;
  let mute: ((m: boolean) => void) | null = null;
  let inFlight = false;
  const pending: Pending[] = [];
  const ad = (kind: string) => (opened: () => void): Promise<boolean> => {
    log.push(`ad:${kind}`);
    if (opts.throwOnOpen) {
      opened();
      return Promise.reject(new Error('sdk threw'));
    }
    inFlight = true;
    return new Promise<boolean>((resolve) => {
      pending.push({
        opened,
        resolve: (v) => {
          inFlight = false;
          resolve(v);
        },
      });
    });
  };
  const bridge = {
    send: (m: string) => void log.push(m),
    onPause: (cb: (p: boolean) => void) => void (pause = cb),
    onMute: (cb: (m: boolean) => void) => void (mute = cb),
    interstitial: async (opened: () => void) => void (await ad('interstitial')(opened)),
    rewarded: ad('rewarded'),
    rewardedSupported: () => opts.rewarded ?? true,
    adInFlight: () => inFlight,
  };
  const clock = { stop: () => void log.push('clock:stop'), start: () => void log.push('clock:start') };
  const mutes: boolean[] = [];
  const session = new PlaygamaSession({ getPhase: () => phase }, bridge, clock, (m) => void mutes.push(m));
  session.start();
  /** One `update()` per phase plus a repeat, so a per-frame duplicate shows up in the log. */
  const walk = (...phases: Phase[]) => {
    for (const p of phases) {
      phase = p;
      session.update();
      session.update();
    }
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  const count = (m: string) => log.filter((x) => x === m).length;
  return {
    session, log, mutes, walk, settle, pending, count,
    pause: (p: boolean) => pause!(p),
    mute: (m: boolean) => mute!(m),
  };
}

describe('PlaygamaSession — the gameplay bracket and game_ready', () => {
  it('sends game_ready on ready(), and brackets real play only', () => {
    const h = harness();
    h.session.ready();
    h.walk('menu', 'loadout', 'playing', 'paused', 'playing', 'defeat');
    expect(h.log.filter((m) => m.startsWith('game'))).toEqual([
      'game_ready', 'gameplay_stopped', 'gameplay_started', 'gameplay_stopped', 'gameplay_started', 'gameplay_stopped',
    ]);
  });

  it('reports the live bracket in diagnostics', () => {
    const h = harness();
    h.walk('menu');
    expect(h.session.diagnostics()).toBe('holds none · muted false · interstitials 0');
    h.walk('playing');
    expect(h.session.diagnostics()).toBe('holds none · muted false · interstitials 0 · gameplay');
  });
});

describe('PlaygamaSession — the interstitial', () => {
  it('asks once when a run ends, never on entering one', () => {
    const h = harness();
    h.walk('menu', 'loadout', 'playing');
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('defeat'); // the result screen is still the run
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('menu');
    expect(h.count('ad:interstitial')).toBe(1);
    h.walk('loadout', 'forge', 'menu');
    expect(h.count('ad:interstitial')).toBe(1);
    expect(h.session.diagnostics()).toContain('interstitials 1');
  });

  it('treats Settings as an overlay: paused → settings → paused asks nothing', () => {
    const h = harness();
    h.walk('menu', 'playing', 'paused', 'settings', 'paused');
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('victory', 'settings', 'menu');
    expect(h.count('ad:interstitial')).toBe(1);
  });

  // The two pauses added 2026-11-11, the ones the sandbox showed the player actually takes.
  // Each lands back on `playing` without ever leaving `inRun`, which is why the old single
  // `inRun(from) && !inRun(to)` condition could not see either of them.
  it('asks when the player RESUMES from the pause menu', () => {
    const h = harness();
    h.walk('menu', 'playing', 'paused');
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('playing');
    expect(h.count('ad:interstitial')).toBe(1);
  });

  it('asks when the player RESTARTS from a result screen, on either outcome', () => {
    const h = harness();
    h.walk('menu', 'playing', 'defeat');
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('playing'); // TRY AGAIN
    expect(h.count('ad:interstitial')).toBe(1);
    h.walk('victory', 'playing');
    expect(h.count('ad:interstitial')).toBe(2);
  });

  it('does not ask on the very first phase', () => {
    const h = harness();
    h.walk('playing');
    expect(h.count('ad:interstitial')).toBe(0);
  });

  // The guide's one hard rule about the FIRST ad: not in the opening seconds of play. A run
  // started from the hub is not a pause, however it was reached.
  it('never asks on the way INTO a run, from any hub screen', () => {
    const h = harness();
    h.walk('menu', 'playing', 'menu'); // bank one, so a later count cannot pass by being 0
    expect(h.count('ad:interstitial')).toBe(1);
    h.walk('loadout', 'playing');
    expect(h.count('ad:interstitial')).toBe(1);
    h.walk('menu', 'matchmaking', 'playing');
    expect(h.count('ad:interstitial')).toBe(2); // the one for playing → menu, and nothing since
  });

  it('holds the clock, the sound and the bracket only once the ad has OPENED', async () => {
    const h = harness();
    h.walk('menu', 'playing', 'defeat', 'menu');
    expect(h.log).not.toContain('clock:stop');
    h.pending[0]!.opened();
    expect(h.log.at(-1)).toBe('clock:stop');
    expect(h.mutes.at(-1)).toBe(true);
    expect(h.session.diagnostics()).toContain('holds ad');
    h.pending[0]!.resolve(false);
    await h.settle();
    expect(h.log.at(-1)).toBe('clock:start');
    expect(h.mutes.at(-1)).toBe(false);
    expect(h.session.diagnostics()).toContain('holds none');
  });

  it('releases the hold when the ad call rejects', async () => {
    const h = harness({ throwOnOpen: true });
    h.walk('menu', 'playing', 'defeat', 'menu');
    await h.settle();
    expect(h.log.filter((m) => m.startsWith('clock'))).toEqual(['clock:stop', 'clock:start']);
    expect(h.mutes.at(-1)).toBe(false);
  });
});

describe('PlaygamaSession — the platform switches', () => {
  it('a platform pause stops the clock, mutes and closes the bracket; resuming restores all three', () => {
    const h = harness();
    h.walk('menu', 'playing');
    h.pause(true);
    // The bracket closes with the clock, not a tick later: the stopped clock has no tick.
    expect(h.log.slice(-2)).toEqual(['clock:stop', 'gameplay_stopped']);
    expect(h.mutes.at(-1)).toBe(true);
    h.walk('playing');
    expect(h.count('gameplay_stopped')).toBe(2); // the menu's, then the pause's — no repeat
    h.pause(false);
    expect(h.log.slice(-2)).toEqual(['clock:start', 'gameplay_started']);
    expect(h.mutes.at(-1)).toBe(false);
    h.walk('playing');
    expect(h.count('gameplay_started')).toBe(2);
  });

  it('a repeated pause signal touches the clock once', () => {
    const h = harness();
    h.pause(true);
    h.pause(true);
    h.pause(false);
    h.pause(false);
    expect(h.log.filter((m) => m.startsWith('clock'))).toEqual(['clock:stop', 'clock:start']);
  });

  it('a pause during an ad keeps the clock stopped when the ad ends', async () => {
    const h = harness();
    h.walk('menu', 'playing', 'defeat', 'menu');
    h.pending[0]!.opened();
    h.pause(true);
    h.pending[0]!.resolve(false);
    await h.settle();
    expect(h.log.filter((m) => m.startsWith('clock'))).toEqual(['clock:stop']);
    expect(h.mutes.at(-1)).toBe(true);
    expect(h.session.diagnostics()).toContain('holds pause');
    h.pause(false);
    expect(h.log.at(-1)).toBe('clock:start');
  });

  it('a platform mute survives an ad ending', async () => {
    const h = harness();
    h.mute(true);
    expect(h.mutes.at(-1)).toBe(true);
    h.walk('menu', 'playing', 'defeat', 'menu');
    h.pending[0]!.opened();
    h.pending[0]!.resolve(false);
    await h.settle();
    expect(h.mutes.at(-1)).toBe(true);
    expect(h.session.diagnostics()).toContain('muted true');
    h.mute(false);
    expect(h.mutes.at(-1)).toBe(false);
  });
});

describe('PlaygamaSession.rewardedAd', () => {
  it('is available only where supported and while no ad is up', () => {
    expect(harness({ rewarded: false }).session.rewardedAd().available()).toBe(false);
    const h = harness();
    const ad = h.session.rewardedAd();
    expect(ad.available()).toBe(true);
    void ad.show();
    expect(h.log.at(-1)).toBe('ad:rewarded');
    expect(ad.available()).toBe(false);
  });

  it('resolves with the reward and holds the game while it plays', async () => {
    const h = harness();
    h.walk('menu', 'playing');
    const shown = h.session.rewardedAd().show();
    h.pending[0]!.opened();
    expect(h.session.diagnostics()).toContain('holds ad');
    h.walk('playing');
    expect(h.log.at(-1)).toBe('gameplay_stopped');
    h.pending[0]!.resolve(true);
    await expect(shown).resolves.toBe(true);
    expect(h.session.diagnostics()).toBe('holds none · muted false · interstitials 0 · gameplay');
  });
});

describe('PlaygamaSession — a frame with no area', () => {
  function sized(w0: number, h0: number) {
    const log: string[] = [];
    let phase: Phase = 'playing';
    let size = { w: w0, h: h0 };
    const listeners: Array<() => void> = [];
    const bridge = {
      send: (m: string) => void log.push(m),
      onPause: () => undefined,
      onMute: () => undefined,
      interstitial: async () => undefined,
      rewarded: async () => false,
      rewardedSupported: () => false,
      adInFlight: () => false,
    };
    const clock = { stop: () => void log.push('clock:stop'), start: () => void log.push('clock:start') };
    const mutes: boolean[] = [];
    const viewport = { size: () => size, onResize: (fn: () => void) => void listeners.push(fn) };
    const session = new PlaygamaSession({ getPhase: () => phase }, bridge, clock, (m) => void mutes.push(m), viewport);
    session.start();
    session.update();
    return {
      session, log, mutes, listeners,
      resize: (w: number, h: number) => {
        size = { w, h };
        for (const fn of listeners) fn();
      },
      setPhase: (p: Phase) => void (phase = p),
    };
  }

  it('holds a run that boots into a 0x0 iframe, and reports gameplay stopped though the clock is', () => {
    const h = sized(0, 0);
    expect(h.log).toEqual(['gameplay_started']);
    h.session.watchViewport();
    expect(h.log).toEqual(['gameplay_started', 'clock:stop', 'gameplay_stopped']);
    expect(h.mutes.at(-1)).toBe(true);
    expect(h.session.diagnostics()).toContain('holds unsized');
  });

  it('releases the hold when the host gives the frame an area, and only then', () => {
    const h = sized(0, 0);
    h.session.watchViewport();
    h.resize(960, 0); // one axis is not enough to see anything
    expect(h.log.filter((m) => m === 'clock:start')).toHaveLength(0);
    h.resize(960, 540);
    expect(h.log.slice(-2)).toEqual(['clock:start', 'gameplay_started']);
    expect(h.mutes.at(-1)).toBe(false);
    h.resize(0, 540);
    expect(h.log.slice(-2)).toEqual(['clock:stop', 'gameplay_stopped']);
  });

  it('does nothing to a frame that already has an area', () => {
    const h = sized(800, 600);
    h.session.watchViewport();
    expect(h.log).toEqual(['gameplay_started']);
    expect(h.listeners).toHaveLength(1);
    expect(h.session.diagnostics()).toContain('holds none');
  });

  it('does not announce gameplay when the hold lifts on a menu', () => {
    const h = sized(0, 0);
    h.session.watchViewport();
    h.setPhase('menu');
    h.resize(960, 540);
    expect(h.log.at(-1)).toBe('clock:start');
    expect(h.log.filter((m) => m === 'gameplay_started')).toHaveLength(1);
  });
});

describe('PlaygamaSession — the keys hold (2026-11-10)', () => {
  /** A `SessionKeys` the test drives: `held` is the lesson's wait, `focus()` the window event. */
  function keys() {
    const k = { held: false, listeners: [] as Array<() => void> };
    return {
      k,
      gate: { held: () => k.held, onFocus: (fn: () => void) => void k.listeners.push(fn) },
      focus: () => k.listeners.forEach((fn) => fn()),
    };
  }

  it('holds a run whose lesson waits on the keys: clock stopped, muted, no gameplay_started', () => {
    const h = harness();
    const { k, gate, focus } = keys();
    h.session.watchKeys(gate);
    k.held = true;
    h.walk('menu', 'playing');
    expect(h.count('clock:stop')).toBe(1);
    expect(h.mutes.at(-1)).toBe(true);
    expect(h.count('gameplay_started')).toBe(0);
    expect(h.session.diagnostics()).toContain('holds keys');

    // The clock is stopped, so `update()` does not run: the focus event alone lets it go.
    k.held = false;
    focus();
    expect(h.count('clock:start')).toBe(1);
    expect(h.mutes.at(-1)).toBe(false);
    expect(h.count('gameplay_started')).toBe(1);
    h.walk('playing');
    expect(h.count('clock:stop')).toBe(1);
  });

  it('holds nothing outside a running run, and nothing before watchKeys', () => {
    const h = harness();
    const { k, gate } = keys();
    k.held = true;
    h.walk('playing'); // not watching yet
    expect(h.count('clock:stop')).toBe(0);
    h.session.watchKeys(gate);
    h.walk('paused', 'menu');
    expect(h.count('clock:stop')).toBe(0);
  });

  it('a lesson that stops waiting releases the hold on the next frame too', () => {
    const h = harness();
    const { k, gate } = keys();
    h.session.watchKeys(gate);
    k.held = true;
    h.walk('playing');
    k.held = false;
    h.walk('playing');
    expect(h.log.filter((m) => m.startsWith('clock'))).toEqual(['clock:stop', 'clock:start']);
  });

  it('defaults to the keyFocus sink, which holds nothing on a host with no iframe', () => {
    const h = harness();
    h.session.watchKeys();
    h.walk('playing');
    expect(h.count('clock:stop')).toBe(0);
  });
});
