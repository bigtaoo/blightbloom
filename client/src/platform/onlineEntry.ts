// The two multiplayer doors the game can be pushed through from OUTSIDE it.
//
// A capability registry pointing the same way `rewardedAd.ts` does — declared here in
// `platform/`, INSTALLED by the game (`gameWiring.ts`, which already owns both verbs), and
// called by a host that has a reason to. Nothing installs it on our own domain, and nothing
// there calls it either.
//
// Two hosts' worth of reason exists today, both from the same requirements page
// (`docs.crazygames.com/requirements/multiplayer`):
//
// - **`isInstantMultiplayer`.** The portal can open the game already meaning "put me in a
//   multiplayer match", and asks that the game then land the player there rather than on a
//   menu. `queueCoop` is that landing.
// - **An accepted invite.** A player who clicks a friend's invite link arrives with the
//   friend's party code in an invite parameter. Without `joinPartyByCode` that link drops
//   them on the main menu, which makes the whole invite affordance a lie.
//
// Why a registry rather than a query param, which is how every other boot-time entry into
// this game works (`?online=1`, `?pvp=1`): those are read inside `Game`'s constructor, from
// `location.search`, which an entry point cannot influence. The portal's intent arrives
// asynchronously from the SDK, after `new Game(...)` has already run.

/** The two verbs, as the caller thinks of them. Neither returns anything: both are
 *  navigations, and their outcome is a screen the player then sees. */
export interface OnlineEntry {
  /** Queue for a co-op match — the "land me in multiplayer" answer. Co-op rather than PvP
   *  deliberately: an instant-multiplayer visitor has consented to playing with people, not
   *  to being dropped into a battle royale against them. */
  queueCoop(): void;
  /** Open the squad screen and join this code, as if the player had typed it. */
  joinPartyByCode(code: string): void;
}

let installed: OnlineEntry | null = null;

/** Install (or, with `null`, uninstall) the implementation. Called during screen assembly;
 *  `null` is also how a test resets between cases. */
export function setOnlineEntry(entry: OnlineEntry | null): void {
  installed = entry;
}

/** The installed implementation, or `null` before assembly has run. A caller must handle
 *  `null` rather than assume: the SDK's answer can arrive before the game exists. */
export function onlineEntry(): OnlineEntry | null {
  return installed;
}
