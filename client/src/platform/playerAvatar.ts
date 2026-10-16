// The signed-in player's PICTURE, as the host knows it — the portal's avatar URL.
//
// CrazyGames' account-integration requirements name the username AND the avatar as what a game
// shows for a signed-in portal player (design/20). The username rides in the session, because
// our server stores it; the avatar does not — it is the portal's image, on the portal's CDN,
// and nothing of ours has any reason to keep it. So it gets this seam instead, in `platform/`
// for the reason every seam here is: `src/game/` may not import `platform/crazygames/`.
//
// Its own listener set rather than `sessionEvents.ts`: that one also re-syncs the Forge with
// the account, which is a network round trip a picture changing is not worth.

type Listener = () => void;

const listeners = new Set<Listener>();
let current: string | null = null;

/** Only an absolute https URL is accepted: the texture is fetched cross-origin, and anything
 *  else from a remote object is either a mistake or not ours to fetch. */
function usable(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}

/** The picture to draw for the signed-in player, or `null` for the initial-letter fallback. */
export function playerAvatar(): string | null {
  return current;
}

/** Set by the host's sign-in (`portalAuth.ts`). Listeners fire only on an actual change. */
export function setPlayerAvatar(url: string | null | undefined): void {
  const next = usable(url);
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a screen failing to redraw must not stop another — and must not fail the sign-in */
    }
  }
}

/** React to the picture changing. Returns an unsubscribe. */
export function onPlayerAvatarChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
