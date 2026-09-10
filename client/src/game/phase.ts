// Which screen the game is currently showing. 'settings' is a full screen rather than
// an overlay (Game tracks which phase to return to via settingsReturnPhase). 'squad' is
// the PvP pre-formed-party lobby (design/05/15's squad follow-up) — the first runtime
// (not boot-flag) entry point into PvP.
//
// 'menu' is the LOBBY, and since 2026-09-10 that is one screen rather than two: the branch
// point PLAY used to open ('modeSelect', solo PvE / co-op / PvP solo queue / tutorial) is
// gone and its four routes are rows in the menu itself (design/10). Nothing replaced the
// phase — a route leads straight to the phase it always led to.
// 'matchmaking' wraps the connectOnlineSession call for BOTH the solo-queue paths and the
// pre-formed squad path (PartyScreen's onStartMatch now routes through it too) so there is
// one real "connecting…"/error screen instead of a blank 'playing' phase with no feedback.
// 'pvpPreview' sits between ModeSelect's PVP SOLO QUEUE button and 'matchmaking' (design/10
// open question "PvP preset-pick has no UI yet") — the squad path does NOT route through it
// (every party member's poll auto-advances to beginSquadMatch, so a manual confirm gate
// there would desync followers who never see it; PartyScreen's own lobby/roster already
// serves as squad's pre-match review step).
// 'store' is the real-money purchase screen (design/19 §4), opened from the forge's STORE
// button or its [B] key. A full phase rather than an overlay for one concrete reason: every
// forge key is guarded on `phase === 'forge'` (ForgeInput), so a separate phase silences the
// whole craft/clear/cycle table for free while a purchase is in flight — an overlay would
// leave [X] CLEAR LOADOUT live under a modal asking someone for money.
//
// Lives at the game root rather than under screens/ because it is the shared vocabulary
// Game.ts and the screen layer both speak, not a screen implementation detail.
export type Phase =
  | 'menu' | 'forge' | 'pvpPreview' | 'matchmaking' | 'playing' | 'paused'
  | 'victory' | 'defeat' | 'settings' | 'squad' | 'account' | 'store';

/**
 * Is the player BETWEEN runs — i.e. is it safe to replace `MetaState` wholesale right now?
 *
 * The one question about a phase that is not "which screen is up", and it exists because of
 * a real ordering bug (design/10, 2026-09-10): an account session can arrive at any moment
 * (a portal's silent login, or a player signing in on the host page mid-session), and
 * `OnlineMatch.syncMetaWithSession` answers it by writing the account's server-side meta
 * over whatever is local. Done during a run, that undoes `RunLifecycle.beginRun`'s
 * `setMeta(clearLoadout(...))` — the run has already SPENT the staged loadout, so the
 * server's older blob hands it back.
 *
 * The list is deliberately the pre-run hub rather than "everything except playing". A run
 * that has ENDED is excluded too: the result screen's banked materials have just been
 * written and are being mirrored up fire-and-forget (`meta/accountSync.ts`), so a pull that
 * lands between the write and the mirror is the same clobber one screen later. Deferring
 * costs nothing — the next thing every one of those screens does is return here.
 */
export function isHubPhase(phase: Phase): boolean {
  return phase === 'menu' || phase === 'forge' || phase === 'store'
    || phase === 'squad' || phase === 'account' || phase === 'settings';
}
