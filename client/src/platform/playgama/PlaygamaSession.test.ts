/**
 * `PlaygamaSession` — what Bridge is told and what Bridge may stop, derived from the phase
 * stream alone. Written as phase SEQUENCES a player walks, like `PortalSession.test.ts`.
 *
 * What would fail silently: an interstitial on entering a run instead of on leaving one (or
 * on opening Settings from a paused run), a platform pause that never stops the clock, an ad
 * ending that unmutes a game the platform had muted, and a `gameplay_started` while an ad is up.
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
    h.walk('menu', 'playing', 'paused', 'settings', 'paused', 'playing');
    expect(h.count('ad:interstitial')).toBe(0);
    h.walk('victory', 'settings', 'menu');
    expect(h.count('ad:interstitial')).toBe(1);
  });

  it('does not ask on the very first phase', () => {
    const h = harness();
    h.walk('playing');
    expect(h.count('ad:interstitial')).toBe(0);
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
    expect(h.log.at(-1)).toBe('clock:stop');
    expect(h.mutes.at(-1)).toBe(true);
    h.walk('playing');
    expect(h.log.at(-1)).toBe('gameplay_stopped');
    h.pause(false);
    expect(h.log.at(-1)).toBe('clock:start');
    expect(h.mutes.at(-1)).toBe(false);
    h.walk('playing');
    expect(h.log.at(-1)).toBe('gameplay_started');
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
    expect(h.session.diagnostics()).toBe('holds none · muted false · interstitials 0');
  });
});
