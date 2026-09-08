// "This player is in a squad, and here is how to join it" — declared by the game, read by
// whatever the host wants told about it.
//
// The third registry in this directory, and it points the same way `sessionEvents.ts` does:
// the game announces, the platform reacts. (`rewardedAd.ts` is the one that points the other
// way — a capability the entry point installs and the game reads.) The reason is the same in
// both cases: `src/game/` may not import `platform/crazygames/`, so anything the two need to
// say to each other goes through a module in `platform/` that neither owns.
//
// What reads it today: `crazygames/PortalRooms.ts`, which turns it into the portal's own
// `updateRoom`/`leftRoom` and its invite button. A game portal requires that room
// information be passed through its SDK so a friend can join a player in progress
// (`docs.crazygames.com/requirements/multiplayer`), and our joinable unit is a PARTY — a
// pre-match lobby with a share code (`screens/PartyScreen.ts`) — never a live match room,
// whose seats are fixed and whose lockstep session cannot absorb a joiner (design/06).

/** A squad somebody could be invited into. `code` is the human-shareable join code; the
 *  `partyId` is the server-side identity, and the two are deliberately both here because
 *  the portal wants an opaque room id AND a parameter to hand a joiner. */
export interface PartyPresence {
  partyId: string;
  code: string;
  /** Whether one more player could actually join right now — false once the party is
   *  matching (its seats are being allocated) or already full. Reported honestly rather
   *  than optimistically: the platform shows a join affordance based on this, and a join
   *  that then fails is worse than no affordance at all. */
  joinable: boolean;
}

type Listener = (presence: PartyPresence | null) => void;

const listeners = new Set<Listener>();
let current: PartyPresence | null = null;

/** Announce the player's squad, or `null` for "not in one". Idempotent: an unchanged
 *  presence notifies nobody, so this is safe to call from a poll (`PartyScreen.refresh`
 *  runs once a second) without turning into a per-second SDK call. */
export function setPartyPresence(presence: PartyPresence | null): void {
  if (same(current, presence)) return;
  current = presence;
  for (const listener of [...listeners]) {
    try {
      listener(presence);
    } catch {
      /* a host's reaction failing is the host's problem — nothing here can retry */
    }
  }
}

/** The current presence, for a reader that starts up after the party already exists. */
export function getPartyPresence(): PartyPresence | null {
  return current;
}

/** Subscribe. Returns an unsubscribe; does NOT deliver the current value — a caller that
 *  wants it reads `getPartyPresence()`, which is one line and makes the order explicit
 *  rather than hiding a first call inside the subscription. */
export function onPartyPresence(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop every listener and the current presence. For tests, which must not leak either
 *  into the next file's module registry (`resetHostKind`'s convention). */
export function resetPartyPresence(): void {
  listeners.clear();
  current = null;
}

function same(a: PartyPresence | null, b: PartyPresence | null): boolean {
  if (a === null || b === null) return a === b;
  return a.partyId === b.partyId && a.code === b.code && a.joinable === b.joinable;
}
