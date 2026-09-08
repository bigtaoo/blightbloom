// The "somebody logged in without using our login screen" seam.
//
// `LoginScreen` already had one of these — `onSessionChange`, which `gameWiring.ts` wires to
// refresh the main menu's label and re-sync the Forge's account-bound meta. A portal build
// has no login screen (the platform forbids the credential form it draws) and logs the
// player in from the ENTRY POINT instead, so that same refresh has to be reachable from
// outside `src/game/`.
//
// This is the `rewardedAd.ts` registry with the arrow reversed. There, the entry point
// installs a capability and the game reads it; here the game installs a reaction and the
// entry point fires it. Same reasons: `src/game/` may not import `platform/crazygames/`, and
// `Game.ts` sits at exactly its 500-line limit so the seam may not cost it a line.
//
// ## Why it is sticky
//
// `notifySessionChanged()` before anyone subscribed is REMEMBERED and delivered on the next
// subscribe. That is not defensive padding — it is the failure design/20 already recorded
// once, in different clothing: `PortalSession.start()`'s only `menu` transition happens on
// frame one, while `init()` is still in flight, so the gate it was checked against was
// closed when it went past and the banner never appeared at all. A boot-time login racing
// screen assembly is the same shape, and a silent one: the player is logged in on the
// server, and the main menu says "ACCOUNT".

type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;

/**
 * React to a session change that did not come from a screen. Returns an unsubscribe.
 *
 * A change that already happened is delivered immediately — see the header. That makes the
 * subscription order between the entry point and screen assembly a non-issue rather than a
 * thing to get right.
 */
export function onSessionChanged(listener: Listener): () => void {
  listeners.add(listener);
  if (pending) {
    pending = false;
    listener();
  }
  return () => listeners.delete(listener);
}

/** Announce that `net/session.ts` now holds a different session (or none). Safe to call
 *  before anything has subscribed. */
export function notifySessionChanged(): void {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  // A copy, so a listener that unsubscribes during dispatch cannot skip the next one.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* one screen's refresh failing must not stop another's — nothing here can retry */
    }
  }
}

/** Drop every listener and any remembered change. For tests, which must not leak a
 *  subscription into the next file's module registry (`resetHostKind`'s convention). */
export function resetSessionEvents(): void {
  listeners.clear();
  pending = false;
}
