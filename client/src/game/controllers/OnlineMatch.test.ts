/**
 * `OnlineMatch` — the four fields a queue entry sets, and the three ways one ends.
 *
 * Before the 2026-09-03 split this was five private methods on `Game`, so none of it could
 * be reached without a WebGL renderer: measured immediately after the split, the file was at
 * 5.4% line coverage. What it decides, though, is what happens to a player who taps CO-OP,
 * cancels, or loses their connection twelve minutes into a PvP match.
 *
 * The connect call itself is not re-tested here — `onlineConnect.ts` owns the matchmaking
 * protocol and has its own suite. What IS tested is the argument mapping into it, because a
 * dropped `partyId` or a stale `pvpSeats` produces a perfectly successful connection to the
 * wrong match, which no error path anywhere would report.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { defaultMetaState, type MetaStore } from '../../meta';
import { RunState } from '../runState';
import { OnlineMatch, SQUAD_MATCH_SEATS, type OnlineMatchDeps } from './OnlineMatch';
import * as onlineConnect from '../match/onlineConnect';
import * as session from '../../net/session';
import * as meta from '../../meta';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

function make(over: Partial<OnlineMatchDeps> = {}) {
  const run = new RunState(store);
  const nav = {
    showSquad: vi.fn(), showMenu: vi.fn(), showMatchmaking: vi.fn(),
    showPvpPreview: vi.fn(), refreshForgeIfOpen: vi.fn(),
  };
  const deps: OnlineMatchDeps = {
    run,
    nav: nav as never,
    hud: { toast: vi.fn() } as never,
    matchmaking: { hide: vi.fn() } as never,
    endRunAsDefeat: vi.fn(),
    ...over,
  };
  return { net: new OnlineMatch(deps), run, nav, deps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('beginSoloQueue', () => {
  it('routes CO-OP straight to matchmaking', () => {
    const t = make();
    t.net.beginSoloQueue(false);
    expect(t.run.online).toBe(true);
    expect(t.run.pvp).toBe(false);
    expect(t.nav.showMatchmaking).toHaveBeenCalled();
    expect(t.nav.showPvpPreview).not.toHaveBeenCalled();
  });

  it('routes PVP through the preview confirm step first', () => {
    // design/10's "PvP preset-pick has no UI yet": a player should see their character and
    // the real map before committing to a queue they then have to cancel out of.
    const t = make();
    t.net.beginSoloQueue(true);
    expect(t.run.pvp).toBe(true);
    expect(t.nav.showPvpPreview).toHaveBeenCalled();
    expect(t.nav.showMatchmaking).not.toHaveBeenCalled();
  });

  it('CLEARS a partyId left over from a previous squad match', () => {
    // Otherwise a solo queue after leaving a party keeps sending that party's id to
    // `POST /find`, and the player is grouped into a squad chunk with people who are not
    // playing. Nothing about that fails — the match just forms wrong.
    const t = make();
    t.run.partyId = 'stale-party';
    t.net.beginSoloQueue(false);
    expect(t.run.partyId).toBeUndefined();
  });

  it('sets the return phase to the lobby, where the player came from', () => {
    const t = make();
    t.run.matchmakingReturnPhase = 'squad';
    t.net.beginSoloQueue(false);
    expect(t.run.matchmakingReturnPhase).toBe('menu');
  });
});

describe('beginSquadMatch', () => {
  it('forces the squad-sized room and attaches the party id', () => {
    // The seat count is the shape `teamIdForOwner` chunks into two squads (design/05/15). A
    // party queued at the default 2 seats would be split across rooms.
    const t = make();
    t.net.beginSquadMatch('party-7');
    expect(t.run.online).toBe(true);
    expect(t.run.pvp).toBe(true);
    expect(t.run.pvpSeats).toBe(SQUAD_MATCH_SEATS);
    expect(t.run.partyId).toBe('party-7');
    expect(t.run.matchmakingReturnPhase).toBe('squad');
  });

  it('skips the PvP preview, unlike the solo path', () => {
    // Deliberate (phase.ts's own note): every member's poll auto-advances here, so a manual
    // confirm gate would desync followers who never see it.
    const t = make();
    t.net.beginSquadMatch('party-7');
    expect(t.nav.showMatchmaking).toHaveBeenCalled();
    expect(t.nav.showPvpPreview).not.toHaveBeenCalled();
  });
});

describe('connect', () => {
  it('passes the live run shape into onlineConnect', () => {
    const spy = vi.spyOn(onlineConnect, 'connectOnlineSession').mockResolvedValue({} as never);
    const t = make();
    t.run.matchBaseUrl = 'http://mm:1';
    t.run.pvp = true;
    t.run.pvpSeats = 8;
    t.run.lagMs = 120;
    t.run.partyId = 'p9';

    void t.net.connect({} as never);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      matchBaseUrl: 'http://mm:1', pvp: true, pvpSeats: 8, lagMs: 120, partyId: 'p9',
    });
  });

  it('adopts the seat the server assigned, rather than assuming 0', () => {
    // `localOwner` is what the camera follows and what every command is stamped with. Left
    // at 0, every non-host player watches someone else's character.
    const spy = vi.spyOn(onlineConnect, 'connectOnlineSession').mockResolvedValue({} as never);
    const t = make();
    void t.net.connect({} as never);
    spy.mock.calls[0]![0].onMatchStart!(3);
    expect(t.run.localOwner).toBe(3);
  });

  it('surfaces reconnect progress through the HUD, not the matchmaking screen', () => {
    // A drop this far in is past the connect promise, so Matchmaking's own error state is
    // gone; without the toast the run just freezes with no explanation.
    const spy = vi.spyOn(onlineConnect, 'connectOnlineSession').mockResolvedValue({} as never);
    const t = make();
    void t.net.connect({} as never);
    const opts = spy.mock.calls[0]![0];
    opts.onReconnecting!(1);
    opts.onReconnected!();
    expect(t.deps.hud.toast).toHaveBeenCalledTimes(2);
  });
});

describe('onConnectionLost', () => {
  it('ends the run as a defeat with a real result screen', () => {
    // The alternative, which is what shipped before this path existed: `CoopSession.drive()`
    // silently stalls on a dead transport and the run is frozen forever.
    const t = make();
    t.run.phase = 'playing';
    t.net.onConnectionLost();
    expect(t.deps.endRunAsDefeat).toHaveBeenCalledTimes(1);
  });

  it.each(['menu', 'victory', 'defeat', 'forge', 'matchmaking'] as const)(
    'does nothing from the %s phase — the run already resolved',
    (phase) => {
      // Gameover can race the reconnect loop giving up. Showing a second result screen over
      // a victory would tell a player who just won that they lost.
      const t = make();
      t.run.phase = phase;
      t.net.onConnectionLost();
      expect(t.deps.endRunAsDefeat).not.toHaveBeenCalled();
    },
  );
});

describe('onCancelled', () => {
  it('clears the online flag and the party id, and hides the screen', () => {
    // Same class of bug as `RunState.endRun`'s: a cancel that leaves `online` set makes the
    // NEXT offline run read a session that does not exist.
    const t = make();
    t.run.online = true;
    t.run.partyId = 'p1';
    t.net.onCancelled();
    expect(t.run.online).toBe(false);
    expect(t.run.partyId).toBeUndefined();
    expect(t.deps.matchmaking.hide).toHaveBeenCalled();
  });

  it('returns to whichever screen opened the queue', () => {
    const solo = make();
    solo.run.matchmakingReturnPhase = 'menu';
    solo.net.onCancelled();
    expect(solo.nav.showMenu).toHaveBeenCalled();
    expect(solo.nav.showSquad).not.toHaveBeenCalled();

    const squad = make();
    squad.run.matchmakingReturnPhase = 'squad';
    squad.net.onCancelled();
    expect(squad.nav.showSquad).toHaveBeenCalled();
    expect(squad.nav.showMenu).not.toHaveBeenCalled();
  });
});

describe('syncMetaWithSession', () => {
  beforeEach(() => {
    vi.spyOn(session, 'getSession').mockReturnValue({ token: 'tok', accountId: 'a', username: 'u' } as never);
  });

  it('does nothing at all when logged out', async () => {
    vi.spyOn(session, 'getSession').mockReturnValue(null);
    const pull = vi.spyOn(meta, 'pullAccountMeta');
    const t = make();
    await t.net.syncMetaWithSession();
    expect(pull).not.toHaveBeenCalled();
  });

  it('adopts the server state when there is some', async () => {
    const remote = { ...defaultMetaState(), hasSeenTutorial: true };
    vi.spyOn(meta, 'pullAccountMeta').mockResolvedValue(remote);
    const t = make();
    await t.net.syncMetaWithSession();
    expect(t.run.meta).toEqual(remote);
    expect(t.nav.refreshForgeIfOpen).toHaveBeenCalled();
  });

  it('PUSHES local state up for a brand-new account instead of wiping it', async () => {
    // A player who accumulated blueprints as a guest and then registers must not lose them.
    // `setMeta` on the local copy is what mirrors it back to `/account/meta`.
    vi.spyOn(meta, 'pullAccountMeta').mockResolvedValue(null);
    const saves: unknown[] = [];
    const t = make();
    t.run.meta = { ...t.run.meta, hasSeenTutorial: true };
    const local = t.run.meta;
    (t.run.store as { save: (m: unknown) => void }).save = (m) => saves.push(m);

    await t.net.syncMetaWithSession();
    expect(t.run.meta).toBe(local);
    expect(saves).toEqual([local]);
  });

  it('keeps local state on a network failure, without throwing', async () => {
    // Best-effort by design — an offline player must still be able to play.
    vi.spyOn(meta, 'pullAccountMeta').mockRejectedValue(new Error('offline'));
    const t = make();
    const before = t.run.meta;
    await expect(t.net.syncMetaWithSession()).resolves.toBeUndefined();
    expect(t.run.meta).toBe(before);
  });
});

describe('a session that arrives while a run is in flight (2026-09-10)', () => {
  // The bug this closes, in full: on a game portal the silent login lands whenever it lands,
  // and the menu there is in one-click mode — so the first click starts a RUN and the login
  // can resolve after it. `syncMetaWithSession` then wrote the account's server blob straight
  // over `run.meta`, with no phase guard anywhere in the path.
  beforeEach(() => {
    vi.spyOn(session, 'getSession').mockReturnValue({ token: 'tok', accountId: 'a', username: 'u' } as never);
  });

  const IN_FLIGHT = ['playing', 'paused', 'matchmaking', 'pvpPreview', 'victory', 'defeat'] as const;

  it.each(IN_FLIGHT)('defers rather than pulling while the phase is %s', async (phase) => {
    const pull = vi.spyOn(meta, 'pullAccountMeta');
    const t = make();
    t.run.phase = phase;
    await t.net.syncMetaWithSession();
    expect(pull).not.toHaveBeenCalled();
    expect(t.run.pendingMetaSync).toBe(true);
  });

  it('does not hand back a loadout the run has already spent', async () => {
    // The failure in the shape it would actually take. `beginRun` clears the staged loadout
    // because the run consumed it; the account's blob still has it staged. Applying that mid
    // -run is a duplication the player can see: the weapons are in the run AND back in the
    // forge.
    const staged = { ...defaultMetaState(), loadout: ['smg' as never] };
    vi.spyOn(meta, 'pullAccountMeta').mockResolvedValue(staged);
    const t = make();
    t.run.setMeta({ ...defaultMetaState(), loadout: [] });
    const spent = t.run.meta;
    t.run.phase = 'playing';

    await t.net.syncMetaWithSession();
    expect(t.run.meta).toBe(spent);
    expect(t.run.meta.loadout).toEqual([]);
  });

  it('applies it on the way back into the hub, so nothing is lost — only delayed', async () => {
    const remote = { ...defaultMetaState(), hasSeenTutorial: true };
    vi.spyOn(meta, 'pullAccountMeta').mockResolvedValue(remote);
    const t = make();
    t.run.phase = 'playing';
    await t.net.syncMetaWithSession();
    expect(t.run.meta).not.toEqual(remote);

    t.run.phase = 'menu'; // what `ScreenNav.showMenu` sets, right after calling the hook
    t.net.flushPendingMetaSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.run.meta).toEqual(remote);
    expect(t.run.pendingMetaSync).toBe(false);
  });

  it('flushing with nothing pending touches the network not at all', async () => {
    // `ScreenNav` calls the hook on EVERY menu/forge entry, which is many times a session
    // for a player who never logged in. A flush that pulled unconditionally would turn the
    // guard into a per-navigation request.
    const pull = vi.spyOn(meta, 'pullAccountMeta');
    const t = make();
    t.net.flushPendingMetaSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(pull).not.toHaveBeenCalled();
  });

  it('a second flush while the first pull is still in flight does not pull twice', async () => {
    // Why the flag is cleared BEFORE the await. The forge is entered twice in a row on the
    // way out of the settings overlay, and both entries fire the hook.
    let release: (m: unknown) => void = () => {};
    const pull = vi.spyOn(meta, 'pullAccountMeta').mockReturnValue(
      new Promise((res) => { release = res as (m: unknown) => void; }) as never,
    );
    const t = make();
    t.run.phase = 'playing';
    await t.net.syncMetaWithSession();
    t.run.phase = 'forge';

    t.net.flushPendingMetaSync();
    t.net.flushPendingMetaSync();
    release(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('sets no pending flag for a guest — there is nothing to sync', async () => {
    // The early return for a logged-out player is BEFORE the phase check, so a guest whose
    // run ends does not carry a flush around forever.
    vi.spyOn(session, 'getSession').mockReturnValue(null);
    const t = make();
    t.run.phase = 'playing';
    await t.net.syncMetaWithSession();
    expect(t.run.pendingMetaSync).toBe(false);
  });
});
