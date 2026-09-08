// What the portal meant by opening this page, and what to do about it.
//
// Two of the multiplayer requirements are about the FIRST moment of a session rather than
// about anything the game does later (`docs.crazygames.com/requirements/multiplayer`):
//
//   an accepted invite       the joiner arrives carrying their friend's party code, and has
//                            to end up in that party — otherwise the invite button is a
//                            share affordance that leads to a main menu
//   isInstantMultiplayer     the portal opened the game meaning "put me in a multiplayer
//                            match", and asks the game to land there rather than on a menu
//
// Both are read from the SDK and both are acted on through `platform/onlineEntry.ts`, the
// capability the game installs for exactly this. Neither is derivable from the phase stream
// (`PortalSession`'s input), because both are about intent that arrived with the page.
//
// The ORDER is a decision, not an accident: an invite beats instant multiplayer. A player
// who clicked a specific friend's link wants THAT party, and a queue for strangers is not a
// worse version of that — it is a different thing, and it would silently discard the only
// piece of information the link carried.
import { onlineEntry } from '../onlineEntry';
import { INVITE_PARAM_PARTY } from './PortalRooms';
import type { CrazyGamesSdk } from './sdk';

/** What was found, and what was done about it — returned so `__portal.diagnostics()` can
 *  report it, since this runs once at boot and is otherwise unobservable on a live page. */
export type PortalBootAction = 'none' | 'joined-party' | 'queued-coop' | 'no-entry-installed';

export interface PortalBootIntent {
  partyCode: string | null;
  instantMultiplayer: boolean;
  action: PortalBootAction;
}

/**
 * Read the boot intent and act on it, once, after the SDK has initialised.
 *
 * Resolves rather than rejects on every path — boot may not gain a new way to fail
 * (`CrazyGamesSdk.init`'s own rule) — and does nothing at all on a page that carries no
 * intent, which is every page a player opens normally.
 */
export async function applyPortalBootIntent(sdk: CrazyGamesSdk): Promise<PortalBootIntent> {
  const partyCode = await sdk.getInviteParam(INVITE_PARAM_PARTY);
  const instantMultiplayer = await sdk.instantMultiplayer();

  if (!partyCode && !instantMultiplayer) {
    return { partyCode, instantMultiplayer, action: 'none' };
  }

  const entry = onlineEntry();
  if (!entry) {
    // The capability is installed during screen assembly, which has long finished by the
    // time this runs — so this is a real bug rather than a race, and it is reported as one
    // instead of being silently swallowed into 'none'.
    return { partyCode, instantMultiplayer, action: 'no-entry-installed' };
  }

  if (partyCode) {
    entry.joinPartyByCode(partyCode);
    return { partyCode, instantMultiplayer, action: 'joined-party' };
  }
  entry.queueCoop();
  return { partyCode, instantMultiplayer, action: 'queued-coop' };
}
