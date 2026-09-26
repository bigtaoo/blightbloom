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
import { defaultMetaState, type MetaState, type MetaStore } from '../../meta';
import { STARTER_BLUEPRINTS } from '@dd/engine';
import { RunState } from '../runState';
import { OnlineMatch, SQUAD_MATCH_SEATS, type OnlineMatchDeps } from './OnlineMatch';
import * as onlineConnect from '../match/onlineConnect';
import * as session from '../../net/session';
import * as identity from '../../net/identity';
import * as authApi from '../../net/auth';
import * as sessionEvents from '../../platform/sessionEvents';
import * as meta from '../../meta';

const store: MetaStore = { load: () => defaultMetaState(), save: () => {} };

/** This browser's guest install id, as `getInstallId()` would answer it. Spied rather than
 *  real: the node test environment has no usable `localStorage`, and the VALUE is the point
 *  — it is the idempotency key of the one-time merge. */
const INSTALL_ID = 'install-7';

function make(over: Partial<OnlineMatchDeps> = {}) {
  const run = new RunState(store);
  const nav = {
    showSquad: vi.fn(), showMenu: vi.fn(), showMatchmaking: vi.fn(),
    showPvpPreview: vi.fn(), refreshHubIfOpen: vi.fn(),
  };
  const accountPrompt = {
    askGuestMerge: vi.fn((): Promise<'account' | 'merge'> => Promise.resolve('account')),
    showNotice: vi.fn(),
  };
  const deps: OnlineMatchDeps = {
    run,
    nav: nav as never,
    hud: { toast: vi.fn() } as never,
    matchmaking: { hide: vi.fn() } as never,
    accountPrompt,
    endRunAsDefeat: vi.fn(),
    ...over,
  };
  return { net: new OnlineMatch(deps), run, nav, accountPrompt, deps };
}

/** A successful `GET /account/meta`, as `pullAccountSnapshot` hands it back. `guestMerged`
 *  defaults to `true` — "this device has already been through the question" — so only the
 *  cases that are ABOUT the merge have to say so. */
const ok = (meta_: MetaState | null, guestMerged = true) =>
  ({ status: 'ok', meta: meta_, guestMerged }) as const;

/** A `MetaState` that `hasGuestProgress` reports as real progress — a banked material is the
 *  durable half and the one a merge is actually for. */
const withProgress = (over: Partial<MetaState> = {}): MetaState => ({
  ...defaultMetaState(),
  materialBank: { mat_fire: 5 },
  ...over,
});

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

describe('beginPartyMatch (2026-09-26, co-op room codes)', () => {
  it('queues a CO-OP party for a co-op room, with its party id, skipping the preview', () => {
    const t = make();
    t.run.pvp = true; // left over from an earlier PvP visit — must not leak into co-op
    t.net.beginPartyMatch('party-3', 'coop');
    expect(t.run.online).toBe(true);
    expect(t.run.pvp).toBe(false);
    expect(t.run.partyId).toBe('party-3');
    expect(t.run.matchmakingReturnPhase).toBe('squad'); // CANCEL returns to the lobby it came from
    expect(t.nav.showMatchmaking).toHaveBeenCalled();
    expect(t.nav.showPvpPreview).not.toHaveBeenCalled();
  });

  it('sends a squad party down the squad path', () => {
    const t = make();
    t.net.beginPartyMatch('party-7', 'pvp');
    expect(t.run.pvp).toBe(true);
    expect(t.run.pvpSeats).toBe(SQUAD_MATCH_SEATS);
    expect(t.run.partyId).toBe('party-7');
  });
});

describe('connect', () => {
  it('forwards the queue countdown callback to onlineConnect', () => {
    const spy = vi.spyOn(onlineConnect, 'connectOnlineSession').mockResolvedValue({} as never);
    const t = make();
    const onQueued = vi.fn();
    void t.net.connect({} as never, onQueued);
    expect(spy.mock.calls[0]![0].onQueued).toBe(onQueued);
  });

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
    vi.spyOn(identity, 'getInstallId').mockReturnValue(INSTALL_ID);
  });

  it('does nothing at all when logged out', async () => {
    vi.spyOn(session, 'getSession').mockReturnValue(null);
    const pull = vi.spyOn(meta, 'pullAccountSnapshot');
    const t = make();
    await t.net.syncMetaWithSession();
    expect(pull).not.toHaveBeenCalled();
  });

  it('adopts the server state when there is some', async () => {
    const remote = { ...defaultMetaState(), hasSeenTutorial: true };
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(remote));
    const t = make();
    await t.net.syncMetaWithSession();
    expect(t.run.meta).toEqual(remote);
    expect(t.nav.refreshHubIfOpen).toHaveBeenCalled();
  });

  it('PUSHES local state up for a brand-new account instead of wiping it', async () => {
    // A player who accumulated blueprints as a guest and then registers must not lose them.
    // `setMeta` on the local copy is what mirrors it back to `/account/meta`.
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(null));
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
    vi.spyOn(meta, 'pullAccountSnapshot').mockRejectedValue(new Error('offline'));
    const t = make();
    const before = t.run.meta;
    await expect(t.net.syncMetaWithSession()).resolves.toBeUndefined();
    expect(t.run.meta).toBe(before);
  });

  it('sends the INSTALL id, not the account id, as the merge key', async () => {
    // `getPlayerId()` prefers the accountId once a session exists, which is the account being
    // merged INTO: keyed on that, every device the player ever logs in on would share one
    // answer, so the first device's merge would silently suppress the second's prompt.
    const pull = vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(defaultMetaState()));
    const t = make();
    t.run.matchBaseUrl = 'http://mm';
    await t.net.syncMetaWithSession();
    expect(pull).toHaveBeenCalledWith('http://mm', 'tok', { local: t.run.meta, guestId: INSTALL_ID });
    expect(INSTALL_ID).not.toBe('a'); // the accountId the session above carries
  });
});

describe('a session that arrives while a run is in flight (2026-09-10)', () => {
  // The bug this closes, in full: on a game portal the silent login lands whenever it lands,
  // and the menu there is in one-click mode — so the first click starts a RUN and the login
  // can resolve after it. `syncMetaWithSession` then wrote the account's server blob straight
  // over `run.meta`, with no phase guard anywhere in the path.
  beforeEach(() => {
    vi.spyOn(session, 'getSession').mockReturnValue({ token: 'tok', accountId: 'a', username: 'u' } as never);
    vi.spyOn(identity, 'getInstallId').mockReturnValue(INSTALL_ID);
  });

  const IN_FLIGHT = ['playing', 'paused', 'matchmaking', 'pvpPreview', 'victory', 'defeat'] as const;

  it.each(IN_FLIGHT)('defers rather than pulling while the phase is %s', async (phase) => {
    const pull = vi.spyOn(meta, 'pullAccountSnapshot');
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
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(staged));
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
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(remote));
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
    const pull = vi.spyOn(meta, 'pullAccountSnapshot');
    const t = make();
    t.net.flushPendingMetaSync();
    await new Promise((r) => setTimeout(r, 0));
    expect(pull).not.toHaveBeenCalled();
  });

  it('a second flush while the first pull is still in flight does not pull twice', async () => {
    // Why the flag is cleared BEFORE the await. The forge is entered twice in a row on the
    // way out of the settings overlay, and both entries fire the hook.
    let release: (m: unknown) => void = () => {};
    const pull = vi.spyOn(meta, 'pullAccountSnapshot').mockReturnValue(
      new Promise((res) => { release = res as (m: unknown) => void; }) as never,
    );
    const t = make();
    t.run.phase = 'playing';
    await t.net.syncMetaWithSession();
    t.run.phase = 'forge';

    t.net.flushPendingMetaSync();
    t.net.flushPendingMetaSync();
    release(ok(null));
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

/**
 * Hole 1 (design/16-accounts.md, closed 2026-09-17): **logging into an account that already
 * had server state discarded this browser's guest progress, silently.**
 *
 * The line was `setMeta(remote ?? d.run.meta)`, and the `??` only ever reached the
 * brand-new-account branch — so the "guest progress carried up" row of design/20's
 * requirements table was satisfied for exactly the case where there was nothing to carry.
 *
 * What replaces it is narrow on purpose, and the narrowness is the part worth testing: NOT a
 * field-by-field union on every login (wrong on a shared computer, where the guest progress
 * belongs to whoever used the browser last), but one merge per device, keyed on the guest
 * install id and claimed server-side so a second tab cannot repeat it.
 */
describe('the one-time device merge (design/16 hole 1)', () => {
  const REMOTE = {
    ...defaultMetaState(),
    materialBank: { mat_fire: 10, mat_poison: 1 },
    unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cannon'],
  };

  beforeEach(() => {
    vi.spyOn(session, 'getSession').mockReturnValue({ token: 'tok', accountId: 'a', username: 'alice' } as never);
    vi.spyOn(identity, 'getInstallId').mockReturnValue(INSTALL_ID);
    vi.spyOn(authApi, 'claimGuestMerge').mockResolvedValue(true);
  });

  /** A first login on this device into an account that already holds something. */
  function firstLogin(local: MetaState = withProgress()) {
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(REMOTE, false));
    const t = make();
    t.run.matchBaseUrl = 'http://mm';
    t.run.meta = local;
    return t;
  }

  it('COMBINE keeps both sides: the banks add, and the blueprints union', async () => {
    // The failure this closes, stated as a number: before it, `mat_fire` came back as the
    // account's 10 and the guest's 5 was gone with no prompt and no message.
    const t = firstLogin();
    t.accountPrompt.askGuestMerge.mockResolvedValue('merge');
    await t.net.syncMetaWithSession();
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 15, mat_poison: 1 });
    expect(t.run.meta.unlockedBlueprints).toContain('cannon');
  });

  it('USE THE ACCOUNT is the other answer, and it really does drop the local bank', async () => {
    // Asserted rather than assumed: a merge that ran regardless of the answer would pass
    // every other case in this file, and would be the field-by-field union the design
    // explicitly refuses.
    const t = firstLogin();
    t.accountPrompt.askGuestMerge.mockResolvedValue('account');
    await t.net.syncMetaWithSession();
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 10, mat_poison: 1 });
  });

  it('claims the device for EITHER answer — declining once must not be asked again', async () => {
    // The key records the question having been ASKED, not the answer. Without this, a player
    // who chose the account's state would be shown the same modal on every login forever.
    const t = firstLogin();
    t.accountPrompt.askGuestMerge.mockResolvedValue('account');
    await t.net.syncMetaWithSession();
    expect(authApi.claimGuestMerge).toHaveBeenCalledWith('http://mm', 'tok', INSTALL_ID);
  });

  it('shows the prompt with the DELTA and the account name, not with totals', async () => {
    const t = firstLogin(withProgress({ unlockedBlueprints: [...STARTER_BLUEPRINTS, 'cryobolt'] }));
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).toHaveBeenCalledWith(
      { materials: 5, blueprints: 1, characters: 0 },
      'alice',
    );
  });

  it('does not ask a device that has already been through the question', async () => {
    // Every login after the first, on this browser. The account is the truth afterwards.
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(REMOTE, true));
    const t = make();
    t.run.meta = withProgress();
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).not.toHaveBeenCalled();
    expect(authApi.claimGuestMerge).not.toHaveBeenCalled();
    expect(t.run.meta).toEqual(REMOTE);
  });

  it('does not ask when this device has nothing a fresh account does not already hand out', async () => {
    // `defaultMetaState` is not "progress": the starter blueprints and the free roster are
    // given to everyone and re-unioned by `migrate()` on every load. Prompting here would put
    // a two-button modal in front of every player, offering to merge nothing into nothing.
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(REMOTE, false));
    const t = make();
    t.run.meta = defaultMetaState();
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).not.toHaveBeenCalled();
    expect(t.run.meta).toEqual(REMOTE);
  });

  it('merges WITHOUT asking when the account side is empty — there is nothing to choose', async () => {
    // The account has a saved blob, so this is not the brand-new-account branch; the blob is
    // just a fresh one. Taking it unchanged would be hole 1 all over again, on the account
    // shape where it is most obviously wrong, and a modal whose two buttons do the same thing
    // would be worse than none.
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(defaultMetaState(), false));
    const t = make();
    t.run.meta = withProgress();
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).not.toHaveBeenCalled();
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 5 });
    expect(authApi.claimGuestMerge).toHaveBeenCalledTimes(1);
  });

  it('does NOT merge when another tab won the claim', async () => {
    // Two tabs answering at once is the case the atomic server-side claim exists for. The
    // loser must take the account's state: the winner has already folded this bank in, and a
    // second merge would add it twice with nothing afterwards able to tell.
    vi.mocked(authApi.claimGuestMerge).mockResolvedValue(false);
    const t = firstLogin();
    t.accountPrompt.askGuestMerge.mockResolvedValue('merge');
    await t.net.syncMetaWithSession();
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 10, mat_poison: 1 });
  });

  it('does NOT merge when the claim itself fails', async () => {
    // Same reasoning in the other failure mode: an unclaimed merge is one that can be applied
    // again on the next login. Declining once is visible and recoverable; double-counting a
    // bank is neither.
    vi.mocked(authApi.claimGuestMerge).mockRejectedValue(new Error('offline'));
    const t = firstLogin();
    t.accountPrompt.askGuestMerge.mockResolvedValue('merge');
    await expect(t.net.syncMetaWithSession()).resolves.toBeUndefined();
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 10, mat_poison: 1 });
  });

  it('PERSISTS the merged state, rather than only holding it in memory', async () => {
    // The failure this pins is the worst one available here, because it is silent AND
    // permanent: `setMeta` is what mirrors into localStorage and pushes to `/account/meta`,
    // and the device has just spent its one claim. A merge that updated `run.meta` without
    // going through the store would look perfect for the rest of the session and be gone on
    // the next login, with `guestMerged` now true so it could never be offered again.
    //
    // Every other case in this suite reads `t.run.meta`, which a plain field assignment
    // would satisfy — so none of them can see this.
    const saves: MetaState[] = [];
    const t = firstLogin();
    (t.run.store as { save: (m: MetaState) => void }).save = (m) => saves.push(m);
    t.accountPrompt.askGuestMerge.mockResolvedValue('merge');

    await t.net.syncMetaWithSession();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.materialBank).toEqual({ mat_fire: 15, mat_poison: 1 });
    expect(saves[0]).toBe(t.run.meta);
  });

  it('asks nothing on the brand-new-account branch — local state is pushed up whole', async () => {
    // `data: null` on the server. There is no other side to merge with, so the question never
    // arises and the guest's whole state becomes the account's first save.
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue(ok(null, false));
    const t = make();
    t.run.meta = withProgress();
    const local = t.run.meta;
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).not.toHaveBeenCalled();
    expect(t.run.meta).toBe(local);
  });
});

/**
 * Hole 2 (design/16-accounts.md, closed 2026-09-17): **a stored token was trusted forever.**
 *
 * `fetchMe` existed with zero production callers, boot read the session out of `localStorage`
 * and believed it, and `SESSION_TTL_MS` is thirty days that nothing extends. So an expired or
 * revoked session painted as `Hi, {name}` while every bearer call 401'd into a `.catch()` —
 * the player believed they were signed in, and cloud save had never once worked.
 *
 * The fix adds no request: `/account/meta` is already called on the way in, and its 401 is
 * the check. What these cases pin is the three-way split that one `catch` used to flatten —
 * a 401 signs out, a network failure changes nothing, and NEITHER touches local `MetaState`.
 */
describe('a rejected session (design/16 hole 2)', () => {
  beforeEach(() => {
    vi.spyOn(session, 'getSession').mockReturnValue({ token: 'stale', accountId: 'a', username: 'alice' } as never);
    vi.spyOn(identity, 'getInstallId').mockReturnValue(INSTALL_ID);
    vi.spyOn(session, 'setSession').mockImplementation(() => {});
    vi.spyOn(sessionEvents, 'notifySessionChanged').mockImplementation(() => {});
  });

  function rejected() {
    vi.spyOn(meta, 'pullAccountSnapshot').mockResolvedValue({ status: 'unauthorized' });
    const t = make();
    t.run.meta = withProgress();
    return t;
  }

  it('clears the stored session', async () => {
    const t = rejected();
    await t.net.syncMetaWithSession();
    expect(session.setSession).toHaveBeenCalledWith(null);
  });

  it('announces the change, which is what walks the lobby chip back to LOGIN', async () => {
    // The chip is the only thing on screen that says who the player is. Without this the
    // session is gone and the lobby still reads `Hi, alice` — the same lie, one layer down.
    const t = rejected();
    await t.net.syncMetaWithSession();
    expect(sessionEvents.notifySessionChanged).toHaveBeenCalledTimes(1);
  });

  it('tells the player, in a notice the lobby can actually show', async () => {
    const t = rejected();
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.showNotice).toHaveBeenCalledTimes(1);
    const [title, body] = t.accountPrompt.showNotice.mock.calls[0]!;
    expect(title).not.toBe('');
    expect(body).not.toBe('');
  });

  it('NEVER touches local MetaState — an expired token is not data loss', async () => {
    // The rule, not an implementation detail. The blueprints and the bank are on this device
    // and are still the player's; what changed is only who the game thinks is playing.
    const t = rejected();
    const before = t.run.meta;
    await t.net.syncMetaWithSession();
    expect(t.run.meta).toBe(before);
    expect(t.run.meta.materialBank).toEqual({ mat_fire: 5 });
    expect(t.nav.refreshHubIfOpen).not.toHaveBeenCalled();
  });

  it('a NETWORK failure signs nobody out — offline is not logged out', async () => {
    // The other half, and the reason the 401 had to become a value rather than a throw: both
    // used to arrive through one `catch`, so making the catch sign the player out would log
    // out every player who opened the game on a train.
    vi.spyOn(meta, 'pullAccountSnapshot').mockRejectedValue(new TypeError('Failed to fetch'));
    const t = make();
    t.run.meta = withProgress();
    const before = t.run.meta;
    await t.net.syncMetaWithSession();
    expect(session.setSession).not.toHaveBeenCalled();
    expect(sessionEvents.notifySessionChanged).not.toHaveBeenCalled();
    expect(t.accountPrompt.showNotice).not.toHaveBeenCalled();
    expect(t.run.meta).toBe(before);
  });

  it('does not re-ask the merge question on the way out — there is no session to merge into', async () => {
    // `notifySessionChanged` re-enters `syncMetaWithSession` through `gameWiring`'s listener.
    // With the session already cleared that call returns at its first line; this pins that the
    // 401 path stops before anything that would prompt or claim.
    vi.spyOn(authApi, 'claimGuestMerge').mockResolvedValue(true);
    const t = rejected();
    await t.net.syncMetaWithSession();
    expect(t.accountPrompt.askGuestMerge).not.toHaveBeenCalled();
    expect(authApi.claimGuestMerge).not.toHaveBeenCalled();
  });
});
