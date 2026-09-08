// The portal's room and invite affordances, driven by the party the game declares.
//
// A portal requires that room information be passed through its SDK so that a friend can
// join a player, and offers its own invite button for sharing the link
// (`docs.crazygames.com/requirements/multiplayer`). Both are a function of ONE fact — is
// this player in a joinable squad — which `platform/partyPresence.ts` carries out of
// `screens/PartyScreen.ts`.
//
// ## Why this is a subscription and not a phase derivation
//
// `PortalSession` derives everything it tells the portal from the phase stream, once per
// frame, and its header argues at length for why that beats event hooks. This does not, and
// the difference is real rather than an inconsistency: a phase says WHICH SCREEN is open,
// and a room is not a screen. A player sits in a party across the squad screen, the
// matchmaking screen and (as a member waiting on their leader) the menu; and the interesting
// transitions — a fourth member arriving, the leader pressing START — change nothing about
// the phase at all. There is no per-frame reading of the phase that answers this.
//
// What it does borrow is the shape that made that argument work: the state is declared in
// one place, this reacts to changes in it, and there is no second path by which a room can
// be announced. `setPartyPresence` de-duplicates, so `PartyScreen`'s one-second poll does
// not become a one-second SDK call.
import { getPartyPresence, onPartyPresence, type PartyPresence } from '../partyPresence';
import type { CrazyGamesSdk } from './sdk';

/** The invite parameter a joiner reads back with `getInviteParam` — one constant, because
 *  the writer (here) and the reader (`portalBoot.ts`) are the two halves of one contract
 *  and a typo in either is a link that silently does nothing. */
export const INVITE_PARAM_PARTY = 'party';

export class PortalRooms {
  private unsubscribe: (() => void) | null = null;
  /** What was last pushed to the SDK, so `stop()` knows whether a `leftRoom` is owed and a
   *  diagnostics reader can see what the portal believes. */
  private announced: PartyPresence | null = null;

  constructor(private readonly sdk: CrazyGamesSdk) {}

  /** Subscribe, and apply whatever the party state already is — a party can exist before
   *  this is installed (the entry point starts it after `game.start()`), and reading the
   *  current value is how that ordering stops mattering. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onPartyPresence((presence) => this.apply(presence));
    this.apply(getPartyPresence());
  }

  /** Unsubscribe, and tell the portal the player is out of the room if it currently thinks
   *  they are in one. Nothing calls this in the shipped entry point — a page teardown takes
   *  the frame with it — but leaving a room announced after this object stops watching it
   *  would be a stale join button on somebody else's page. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.announced) this.apply(null);
  }

  /** What the portal currently believes, for `__portal.diagnostics()`. */
  state(): string {
    if (!this.announced) return 'no room';
    return `room ${this.announced.code}${this.announced.joinable ? ' (joinable)' : ' (closed)'}`;
  }

  private apply(presence: PartyPresence | null): void {
    this.announced = presence;
    if (!presence) {
      this.sdk.leftRoom();
      this.sdk.hideInviteButton();
      return;
    }
    // The invite params travel with the room AND with the button, because the two are
    // separate surfaces on the portal's side: a friend can arrive from the shared link or
    // from the site's own "join" affordance, and both have to carry the join code.
    const inviteParams = { [INVITE_PARAM_PARTY]: presence.code };
    this.sdk.updateRoom(presence.partyId, presence.joinable, inviteParams);
    // A full or already-matching party is still a room worth being IN, but there is nothing
    // useful to invite anyone to — so the button goes away rather than handing out a link
    // that will be refused.
    if (presence.joinable) this.sdk.showInviteButton(inviteParams);
    else this.sdk.hideInviteButton();
  }
}
