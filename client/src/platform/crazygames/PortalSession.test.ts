/**
 * `PortalSession` — everything the portal is told, derived from the phase stream alone.
 *
 * This is the file that proves the design claim in the module header: that a midgame ad, the
 * achievement ping, the gameplay bracket and the banner can all be driven from one
 * `update()` per frame, with no hook anywhere inside `src/game/`. So the tests are written
 * as phase SEQUENCES — the sequence a player actually walks — rather than as method calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { PortalSession, type PortalGameView, type PortalSessionOptions } from './PortalSession';
import type { CrazyGamesSdk } from './sdk';
import type { Phase } from '../../game/phase';

function harness(opts: { live?: boolean; auth?: PortalSessionOptions['auth'] } = {}) {
  const calls: string[] = [];
  let phase: Phase = 'menu';
  let online = false;

  // `isEnabled` is false until `init()` has resolved, exactly like the real wrapper. That
  // detail is not decoration: it is the whole content of the "race with the first frame"
  // case below, and a harness that reported `true` from the start hid the bug that shipped.
  let initialized = false;
  const sdk = {
    init: async () => {
      initialized = true;
      return 'crazygames' as const;
    },
    environment: () => (opts.live === false ? 'disabled' : 'crazygames'),
    isEnabled: () => (opts.live ?? true) && initialized,
    loadingStop: () => void calls.push('loadingStop'),
    gameplayStart: () => void calls.push('gameplayStart'),
    gameplayStop: () => void calls.push('gameplayStop'),
    happytime: () => void calls.push('happytime'),
    hasAdblock: async () => false,
    requestAd: async (type: string) => {
      calls.push(`ad:${type}`);
      return true;
    },
    requestBanner: async (id: string, w: number, h: number) => void calls.push(`banner:${id}:${w}x${h}`),
    clearBanner: (id: string) => void calls.push(`bannerClear:${id}`),
  } as unknown as CrazyGamesSdk;

  const game: PortalGameView = { getPhase: () => phase, isOnline: () => online };
  const session = new PortalSession(game, {
    sdk,
    suspension: { suspend: () => void calls.push('suspend'), resume: () => void calls.push('resume') },
    bannerDom: { createContainer: () => ({ setVisible: () => {} }) },
    now: () => 0,
    auth: opts.auth,
  });

  /** Walk a sequence of phases, one `update()` per phase (plus a repeat, so any per-frame
   *  duplicate emission shows up in the log). */
  const walk = async (...phases: Phase[]) => {
    for (const p of phases) {
      phase = p;
      session.update();
      session.update();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { session, calls, walk, setOnline: (v: boolean) => void (online = v) };
}

describe('PortalSession.start', () => {
  it('closes the loading bracket and probes for adblock', async () => {
    const { session, calls } = harness();
    await session.start();
    expect(calls).toContain('loadingStop');
    expect(session.ads.adblockState()).toBe('clear');
  });
});

describe('PortalSession.start — the race with the first frame', () => {
  it('shows the banner on a menu the game was ALREADY sitting on', async () => {
    // The bug this pins, found by running the built bundle rather than by reading it: the
    // session acts on phase CHANGES, the only `menu` transition of a session happens on the
    // first frame, and `init()` is still in flight then — so the SDK-enabled gate was closed
    // when it went past and the banner never appeared at all. Order here is deliberately the
    // real one: frames first, `start()` second.
    const h = harness();
    await h.walk('menu');
    expect(h.calls.filter((c) => c.startsWith('banner:'))).toEqual([]);

    await h.session.start();
    await h.walk('menu');
    expect(h.calls).toContain('banner:cg-banner:320x50');
  });

  it('does not invent a between-runs ad break when it re-runs', async () => {
    // Re-running the current phase must not look like leaving a run. Asserted from inside a
    // run, which is the case where getting it wrong would put an ad over live gameplay.
    const h = harness();
    await h.walk('menu', 'playing');
    await h.session.start();
    await h.walk('playing');
    expect(h.calls).not.toContain('ad:midgame');
  });
});

describe('PortalSession phase derivation', () => {
  it('brackets gameplay across a whole solo run', async () => {
    const { calls, walk } = harness();
    await walk('menu', 'playing', 'victory', 'forge');
    // One start, and a stop on each side. The duplicate `update()` per phase above means a
    // per-frame emission would show here as a wall of repeats.
    expect(calls.filter((c) => c === 'gameplayStart')).toHaveLength(1);
  });

  it('fires the achievement ping on a win, and never on a loss', async () => {
    const win = harness();
    await win.walk('playing', 'victory');
    expect(win.calls.filter((c) => c === 'happytime')).toHaveLength(1);

    const loss = harness();
    await loss.walk('playing', 'defeat');
    expect(loss.calls).not.toContain('happytime');
  });

  it('shows the banner on the main menu and clears it everywhere else', async () => {
    const { session, calls, walk } = harness();
    await session.start();
    await walk('menu');
    expect(calls).toContain('banner:cg-banner:320x50');
    await walk('forge');
    expect(calls).toContain('bannerClear:cg-banner');
  });

  it('never shows a banner during a run', async () => {
    const { session, calls, walk } = harness();
    await session.start();
    await walk('menu', 'playing');
    // Requested once for the menu, cleared on the way into the run, and not re-requested.
    expect(calls.filter((c) => c.startsWith('banner:'))).toHaveLength(1);
    expect(calls.indexOf('bannerClear:cg-banner')).toBeGreaterThan(-1);
  });
});

describe('PortalSession midgame placement', () => {
  it('requests an ad on the click OUT of a result screen, not on the result screen', async () => {
    // The placement decision, asserted as a sequence: a player who has just died is still
    // reading their own numbers, and an ad over that is the "comes as a surprise" case the
    // requirements page rules out. The break is the next click.
    const { session, calls, walk } = harness();
    await session.start();
    await walk('menu', 'playing');
    await walk('defeat');
    expect(calls).not.toContain('ad:midgame');
    await walk('forge');
    expect(calls.filter((c) => c === 'ad:midgame')).toHaveLength(1);
  });

  it('does not treat a pause as leaving the run', async () => {
    const { session, calls, walk } = harness();
    await session.start();
    await walk('playing', 'paused', 'settings', 'paused', 'playing');
    // `settings` is reachable from a pause and is not a break in the run — an ad there
    // would interrupt a run the player is coming back to.
    expect(calls).not.toContain('ad:midgame');
  });

  it('requests an ad when a run is abandoned to the menu', async () => {
    const { session, calls, walk } = harness();
    await session.start();
    await walk('playing', 'paused', 'menu');
    expect(calls.filter((c) => c === 'ad:midgame')).toHaveLength(1);
  });

  it('never requests one on the first frame, however the game boots', async () => {
    // `from === null` guard: booting straight into a run (`?replay=`) and then reaching a
    // menu is a real path, and the boot frame itself must not read as "left a run".
    const { session, calls, walk } = harness();
    await session.start();
    await walk('menu');
    expect(calls).not.toContain('ad:midgame');
  });

  it('refuses the break entirely while an online match is live', async () => {
    const h = harness();
    await h.session.start();
    h.setOnline(true);
    await h.walk('playing', 'menu');
    expect(h.calls).not.toContain('ad:midgame');
  });

  it('asks for nothing at all when the SDK will not act', async () => {
    // Our own domain (no SDK) and a page the SDK reports as `disabled`. Ads AND banners:
    // requesting a banner there logs an SDK console error, which the first live run of this
    // integration produced, and a reviewer reads the console.
    const { session, calls, walk } = harness({ live: false });
    await session.start();
    await walk('menu', 'playing', 'victory', 'forge');
    expect(calls.filter((c) => c.startsWith('ad:'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('banner:'))).toEqual([]);
    // The gameplay brackets still run — they are free, and the portal reads them to decide
    // when the initial download finished.
    expect(calls).toContain('gameplayStart');
  });
});

describe('PortalSession.diagnostics', () => {
  it('reports the environment, the adblock probe and the live brackets', async () => {
    // The one line readable from a console on a real portal page, which is the only place
    // any of this can be verified end to end. Worth a test because a wrong string here
    // makes a working integration look broken and vice versa.
    const { session, walk } = harness();
    await session.start();
    await walk('menu');
    expect(session.diagnostics()).toBe('portal crazygames · ads clear · banner · auth n/a');
    await walk('playing');
    expect(session.diagnostics()).toBe('portal crazygames · ads clear · gameplay · auth n/a');
  });

  it('says so when there is no portal', () => {
    const { session } = harness({ live: false });
    expect(session.diagnostics()).toBe('portal disabled · ads unprobed · auth n/a');
  });

  it('reports the five account states, because each one is a different bug', () => {
    // The account half of the one instrument this repository has for the parts of the
    // integration it cannot test. `auth n/a` above is the shipped-entry-point case only in
    // a test harness that passes none; every state below is one a live page can be in, and
    // the interesting ones are the two that report a BROKEN integration rather than an
    // absent player.
    const ok = { userReadFailed: false } as const;
    const states = [
      [{ available: false, portalUser: null, session: null, lastError: null, ...ok }, 'auth unavailable'],
      [{ available: true, portalUser: null, session: null, lastError: null, ...ok }, 'guest'],
      [{ available: true, portalUser: 'Ada', session: 'Ada', lastError: null, ...ok }, 'signed in Ada'],
      [{ available: true, portalUser: 'Ada', session: null, lastError: 'invalid portal token', ...ok },
        'NOT signed in (invalid portal token)'],
      [{ available: true, portalUser: 'Ada', session: null, lastError: null, ...ok },
        'NOT signed in (no reason recorded)'],
      // A failed read, which leaves `portalUser` null exactly like a guest does. Reported as
      // `guest` until 2026-09-08, which made the likeliest failure of the whole silent-login
      // path — `getUser` is in BETA on the platform's side — look like a quiet day.
      [{ available: true, portalUser: null, session: null, lastError: 'getUser is gated', userReadFailed: true },
        'getUser BROKEN (getUser is gated)'],
      [{ available: true, portalUser: null, session: null, lastError: null, userReadFailed: true },
        'getUser BROKEN (no reason recorded)'],
    ] as const;
    for (const [diag, expected] of states) {
      const { session } = harness({ live: false, auth: { diagnostics: () => diag } });
      expect(session.diagnostics()).toContain(expected);
    }
  });

  it('does not call a failed read a guest', () => {
    // The two states share a null `portalUser`, so the ONLY thing separating them is which
    // arm runs first. A guard placed after the guest arm would be unreachable — this pins
    // the order, not just the wording.
    const { session } = harness({
      live: false,
      auth: {
        diagnostics: () => ({
          available: true, portalUser: null, session: null,
          lastError: 'boom', userReadFailed: true,
        }),
      },
    });
    const line = session.diagnostics();
    expect(line).toContain('getUser BROKEN');
    expect(line).not.toContain('guest');
  });
});

describe('PortalSession is inert in the game it observes', () => {
  it('reads the game through two getters and nothing else', () => {
    // A structural guard on the design claim: if this ever needs more than the phase and
    // the online flag, the "no hooks in src/game/" argument in the module header has
    // stopped being true and should be re-argued rather than quietly widened.
    const view = { getPhase: vi.fn(() => 'menu' as Phase), isOnline: vi.fn(() => false) };
    const session = new PortalSession(view, {
      suspension: { suspend: () => {}, resume: () => {} },
      bannerDom: { createContainer: () => null },
    });
    session.update();
    expect(Object.keys(view)).toEqual(['getPhase', 'isOnline']);
    expect(view.getPhase).toHaveBeenCalled();
  });
});
