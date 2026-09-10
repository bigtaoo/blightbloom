// Split out of Game.ts, 2026-09-03 — the network glue: which mode to queue for, the connect
// function the Matchmaking screen drives, what a cancel or a lost connection does, and the
// account re-sync a login triggers.
//
// It is the thinnest of the three controllers on purpose. `onlineConnect.ts` already owns
// the actual matchmaking protocol (poll `/find`, redeem the ticket, open the socket) and
// `RunLifecycle.finalizeOnlineRun` owns what happens once a session exists. What lives here
// is the part that was stranded in the shell between them: the four fields a queue entry
// sets (`online` / `pvp` / `pvpSeats` / `partyId`), and the three failure paths.
//
// The failure paths are the reason this is worth its own file rather than a few more methods
// on the shell. `onMatchmakingCancelled` and `onOnlineConnectionLost` both have to leave the
// run state consistent for whatever the player does NEXT — a cancel that forgets to clear
// `online` leaves the next offline run reading a closed session, which is the exact bug
// `RunState.endRun` records for the quit path. They are now assertable without a renderer.
import { t } from '../../i18n';
import { THEME } from '../theme';
import { pullAccountMeta } from '../../meta';
import { getSession } from '../../net/session';
import type { CoopSession } from '../../net/CoopSession';
import { connectOnlineSession } from '../match/onlineConnect';
import type { MatchmakingSignal, Matchmaking } from '../screens/Matchmaking';
import type { HudView } from '../ui/HudView';
import type { ScreenNav } from './ScreenNav';
import type { RunState } from '../runState';
import { isHubPhase } from '../phase';

/** The seat count a pre-formed squad match is forced to — 2 squads of `SQUAD_SIZE`, the
 *  shape `teamIdForOwner` actually chunks (design/05/15). */
export const SQUAD_MATCH_SEATS = 8;

export interface OnlineMatchDeps {
  run: RunState;
  nav: ScreenNav;
  hud: HudView;
  matchmaking: Matchmaking;
  /** End the run as a defeat with a result screen — the shell's RunOutcome host methods. */
  endRunAsDefeat: (title: string, body: string) => void;
}

export class OnlineMatch {
  constructor(private readonly deps: OnlineMatchDeps) {}

  /** The Matchmaking screen's injected connect function. */
  connect(signal: MatchmakingSignal): Promise<CoopSession> {
    const d = this.deps;
    return connectOnlineSession({
      matchBaseUrl: d.run.matchBaseUrl,
      pvp: d.run.pvp,
      pvpSeats: d.run.pvpSeats,
      lagMs: d.run.lagMs,
      partyId: d.run.partyId,
      signal,
      onMatchStart: (localOwner) => {
        d.run.localOwner = localOwner;
      },
      // Mid-match reconnect feedback (ROADMAP reconnect, design/06) — a drop this far in is
      // no longer this promise's business (it already resolved), so it is surfaced straight
      // through the HUD/outcome screen instead of Matchmaking's own connecting/error state.
      onReconnecting: () => d.hud.toast(t('toast.reconnecting'), THEME.colors.enemy),
      onReconnected: () => d.hud.toast(t('toast.reconnected'), THEME.colors.pickupHeal),
      onConnectionLost: () => this.onConnectionLost(),
    });
  }

  /**
   * The bounded mid-match reconnect loop gave up (ROADMAP reconnect, design/06) — previously
   * this class of failure just left the run frozen forever with no feedback at all
   * (`CoopSession.drive()` silently stalls on a dead transport). Ends the run the same way a
   * real defeat does: the player gets a clear result screen instead of a stuck one.
   */
  onConnectionLost(): void {
    // Already resolved some other way (e.g. gameover raced it).
    if (this.deps.run.phase !== 'playing') return;
    this.deps.endRunAsDefeat(t('results.connectionLostTitle'), t('results.connectionLostBody'));
  }

  onCancelled(): void {
    const d = this.deps;
    d.matchmaking.hide();
    d.run.online = false;
    d.run.partyId = undefined;
    if (d.run.matchmakingReturnPhase === 'squad') d.nav.showSquad();
    else d.nav.showMenu();
  }

  /** The lobby's CO-OP / PVP SOLO QUEUE rows (design/10 screen-flow gap) — the
   *  menu-driven counterpart to the `?online=1`/`?pvp=1` boot-time URL flags, which were
   *  previously the ONLY way to reach either mode. */
  beginSoloQueue(pvp: boolean): void {
    const d = this.deps;
    d.run.online = true;
    d.run.pvp = pvp;
    d.run.partyId = undefined;
    d.run.matchmakingReturnPhase = 'menu';
    // PvP gets the match-preview confirm step first (design/10 open question); co-op is
    // plain PvE dungeon content and has nothing PvP-scaled to preview.
    if (pvp) d.nav.showPvpPreview();
    else d.nav.showMatchmaking();
  }

  /**
   * The party leader tapped START (or a member's poll saw the leader already had) — hand off
   * to the SAME online/PvP connect path `?pvp=1` uses, with this run's squad size forced to
   * `SQUAD_MATCH_SEATS` and `partyId` attached so every member's `POST /find` groups into one
   * squad instead of a stranger's.
   */
  beginSquadMatch(partyId: string): void {
    const d = this.deps;
    d.run.online = true;
    d.run.pvp = true;
    d.run.pvpSeats = SQUAD_MATCH_SEATS;
    d.run.partyId = partyId;
    d.run.matchmakingReturnPhase = 'squad';
    d.nav.showMatchmaking();
  }

  /**
   * Re-syncs `run.meta` with the server right after a login/register
   * (design/16-accounts.md). A brand-new account has no server state yet — that case pushes
   * the current (possibly guest-accumulated) local state up instead of overwriting it with
   * nothing. Best-effort: any network failure just keeps using local state, same as every
   * other account-sync call in this project.
   *
   * **Only ever applied between runs** (`isHubPhase`, 2026-09-10). A session does not arrive
   * when the player asks for it: a portal signs them in silently at boot and can sign them
   * in again mid-session (`portalAuth.ts`'s `addAuthListener`), and this method's `setMeta`
   * replaces the whole `MetaState`. Landing that during a run gives back a loadout
   * `RunLifecycle.beginRun` has already spent — see `isHubPhase`'s own comment for the full
   * shape. Outside the hub the sync is remembered on `RunState.pendingMetaSync` and
   * `flushPendingMetaSync` runs it on the way back in, so nothing is lost, only delayed.
   */
  async syncMetaWithSession(): Promise<void> {
    const d = this.deps;
    const session = getSession();
    if (!session) return; // logged out — local state keeps being used as-is
    if (!isHubPhase(d.run.phase)) {
      d.run.pendingMetaSync = true;
      return;
    }
    try {
      const remote = await pullAccountMeta(d.run.matchBaseUrl, session.token);
      // `setMeta` mirrors into localStorage and, when `remote` was null, pushes local state up.
      d.run.setMeta(remote ?? d.run.meta);
      d.nav.refreshForgeIfOpen();
    } catch {
      /* offline/best-effort — keep using local state */
    }
  }

  /**
   * Run a sync that was deferred while a run was in flight. Called by `ScreenNav` on the way
   * into the menu and the forge — the two screens that RENDER the meta, and the two the
   * player reaches from every run-shaped phase.
   *
   * Clearing the flag before the await, not after, is deliberate: `showForge()` can be
   * called twice in a row (the settings overlay returns through it), and a second call while
   * the first pull is still in flight would issue a duplicate request whose answer is the
   * same blob.
   */
  flushPendingMetaSync(): void {
    const d = this.deps;
    if (!d.run.pendingMetaSync) return;
    d.run.pendingMetaSync = false;
    void this.syncMetaWithSession();
  }
}
