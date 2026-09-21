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
import {
  guestMergeOffer, hasGuestProgress, mergeGuestIntoAccount, pullAccountSnapshot,
  type AccountSnapshot, type GuestMergeOffer, type MetaState,
} from '../../meta';
import { claimGuestMerge } from '../../net/auth';
import { getInstallId } from '../../net/identity';
import { getSession, setSession } from '../../net/session';
import { notifySessionChanged } from '../../platform/sessionEvents';
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

/**
 * The modal this controller asks its two account questions through — `game/ui/AccountPrompt
 * .ts` implements it. Declared here as a structural interface rather than imported, because
 * this file is on `pureLayerBoundary.test.ts`'s list and the real prompt imports Pixi: a
 * pure module may reach no package but `@dd/engine`. The seam is also what lets both
 * questions be tested with two `vi.fn()`s and no renderer.
 */
export interface AccountPromptView {
  askGuestMerge(counts: GuestMergeOffer, username: string): Promise<'account' | 'merge'>;
  showNotice(title: string, body: string): void;
}

export interface OnlineMatchDeps {
  run: RunState;
  nav: ScreenNav;
  hud: HudView;
  matchmaking: Matchmaking;
  accountPrompt: AccountPromptView;
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

  /**
   * Left the queue flow without a match. TWO callers, and that is the point: the
   * Matchmaking screen's CANCEL, and — since 2026-09-20 — the PvP preview's BACK.
   *
   * `beginSoloQueue`/`beginSquadMatch` declare the run online BEFORE any screen is shown,
   * so every exit from the flow has to undo that declaration. The preview's BACK did not
   * (`gameWiring` wired it straight to `nav.showMenu`), and `run.online` is not a screen's
   * own state: `GameLoop.update` routes the WHOLE frame on it. An offline run started under
   * a stale `true` — the lobby's TUTORIAL row, PLAY, CONTINUE — enters `advanceOnline` with
   * no session, which holds the scene and returns. The room `RunLifecycle.enterPrimedRun`
   * just built stays on screen with no actors in it, the sim never ticks, the HUD keeps the
   * PREVIOUS run's numbers, and (both `keydownAction` and `HudView.onPause` are gated on the
   * same flag) Escape and the pause button are dead too — a freeze with no way out but a
   * reload. Live report 2026-09-20: *"新手教程，点进去就卡住了。有时候是好的，有时候不行"* —
   * intermittent because it takes a visit to the preview first.
   *
   * Routing by `matchmakingReturnPhase` is what makes one method serve both: the preview is
   * only ever reached from the lobby (`beginSoloQueue` sets `'menu'`), so BACK from it lands
   * where the button says it does.
   */
  onCancelled(): void {
    const d = this.deps;
    d.matchmaking.hide(); // already hidden when the caller is the preview's BACK
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
   * nothing.
   *
   * **Only ever applied between runs** (`isHubPhase`, 2026-09-10). A session does not arrive
   * when the player asks for it: a portal signs them in silently at boot and can sign them
   * in again mid-session (`portalAuth.ts`'s `addAuthListener`), and this method's `setMeta`
   * replaces the whole `MetaState`. Landing that during a run gives back a loadout
   * `RunLifecycle.beginRun` has already spent — see `isHubPhase`'s own comment for the full
   * shape. Outside the hub the sync is remembered on `RunState.pendingMetaSync` and
   * `flushPendingMetaSync` runs it on the way back in, so nothing is lost, only delayed.
   *
   * ## The two failures this method WAS, closed 2026-09-17 (design/16's holes 1 and 2)
   *
   * It was `setMeta(remote ?? d.run.meta)` inside a bare `try`/`catch`, and both halves of
   * that line were wrong in the same direction — each threw away something the player had:
   *
   * 1. **The `??` only ever reached the brand-new-account branch.** Logging into an account
   *    that already had server state overwrote this browser's guest progress with no prompt
   *    and no message. What replaces it is `resolveAccountMeta` below: a one-time merge,
   *    keyed on the guest install id so it happens exactly once per device, with the account
   *    as the truth afterwards.
   * 2. **Every failure arrived through one `catch`, including a 401.** So an expired or
   *    revoked session kept painting `Hi, {name}` while cloud save silently never worked.
   *    `pullAccountSnapshot` returns that status as a value now, and the two answers are
   *    handled oppositely: a 401 drops the session, a network failure changes nothing at
   *    all. **Offline is not logged out**, and neither one may touch the local `MetaState`.
   */
  async syncMetaWithSession(): Promise<void> {
    const d = this.deps;
    const session = getSession();
    if (!session) return; // logged out — local state keeps being used as-is
    if (!isHubPhase(d.run.phase)) {
      d.run.pendingMetaSync = true;
      return;
    }
    let snapshot: AccountSnapshot;
    try {
      snapshot = await pullAccountSnapshot(d.run.matchBaseUrl, session.token, {
        local: d.run.meta,
        // `getInstallId`, never `getPlayerId`: the latter PREFERS the account id once a
        // session exists, which is the account we are merging into — it would key every
        // device this player logs in on to one shared answer.
        guestId: getInstallId(),
      });
    } catch {
      // Offline, DNS, a 502 — the request failed, which says nothing about the session.
      // Local state keeps being used, exactly as it did before any of this existed.
      return;
    }
    if (snapshot.status === 'unauthorized') {
      this.dropRejectedSession();
      return;
    }
    const remote = snapshot.meta;
    // `remote === null` is the brand-new account: `setMeta` mirrors local state into
    // localStorage AND pushes it up, which is how a guest's Forge progress reaches the
    // account they just registered. No merge question — there is nothing on the other side.
    const next = remote === null
      ? d.run.meta
      : await this.resolveAccountMeta(remote, snapshot.guestMerged, session.token, session.username);
    d.run.setMeta(next);
    d.nav.refreshHubIfOpen();
  }

  /**
   * The one-time device merge (design/16 hole 1) — returns the `MetaState` to adopt.
   *
   * The decision, in the order it is made:
   *
   *  - **Already merged, or nothing local to merge** → the account's state, unchanged. That
   *    is every login after the first on a given browser, and it is the point of the whole
   *    mechanism rather than a shortcut through it: the account is the truth afterwards.
   *  - **Nothing on the account's side either** → merge silently. There is no choice to
   *    offer between a player's guest progress and an empty account, and a modal whose two
   *    buttons do the same thing is worse than none. Taking the account's empty state here
   *    would be hole 1 again, on the account shape where it is most obviously wrong.
   *  - **Both sides hold something** → ask. The primary button is *use the account's*; see
   *    `AccountPrompt` for why that ordering is the decision and not the styling.
   *
   * The claim is made AFTER the answer and for BOTH answers, because what it records is the
   * question having been ASKED on this device — a player who declined must not be asked
   * again on their next login. A claim that comes back `false` (another tab answered first)
   * or that fails outright means the merge is NOT applied: merging twice adds a material
   * bank the account already holds, and nothing afterwards can tell that it happened.
   */
  private async resolveAccountMeta(
    remote: MetaState,
    guestMerged: boolean,
    token: string,
    username: string,
  ): Promise<MetaState> {
    const d = this.deps;
    const local = d.run.meta;
    if (guestMerged || !hasGuestProgress(local)) return remote;
    const choice = hasGuestProgress(remote)
      ? await d.accountPrompt.askGuestMerge(guestMergeOffer(local, remote), username)
      : 'merge';
    let claimed = false;
    try {
      claimed = await claimGuestMerge(d.run.matchBaseUrl, token, getInstallId());
    } catch {
      /* unclaimed — fall through to the account's state, the answer that cannot double-count */
    }
    return choice === 'merge' && claimed ? mergeGuestIntoAccount(local, remote) : remote;
  }

  /**
   * The stored session was rejected (design/16 hole 2) — drop it, say so, and touch the
   * local `MetaState` not at all.
   *
   * That last part is the rule rather than an implementation detail. The player's blueprints
   * and bank are on this device and are still theirs; a sign-out that also cleared them
   * would turn an expired token into data loss. What changes is only who the game thinks is
   * playing.
   *
   * `notifySessionChanged` is the same announcement `portalAuth.ts` makes when the platform
   * signs somebody out, and it is what walks the lobby's account chip back from `Hi, {name}`
   * to LOGIN. It re-enters this class — `gameWiring`'s listener calls `syncMetaWithSession`
   * — which now returns at its first line, because there is no longer a session.
   */
  private dropRejectedSession(): void {
    setSession(null);
    this.deps.accountPrompt.showNotice(t('auth.sessionExpiredTitle'), t('auth.sessionExpiredBody'));
    notifySessionChanged();
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
