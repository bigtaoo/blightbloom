// Silent login on a game portal (design/20 "account integration").
//
// This is the whole of the login a CrazyGames player gets: no screen, no form, no button.
// The platform requires it in those words — "new logged in CrazyGames users are automatically
// registered & logged in within your game", "returning logged in CrazyGames users are
// automatically logged in" — and forbids the alternative we already ship on our own domain:
// `docs.crazygames.com/requirements/account-integration` disallows external login options
// (it lists email), disallows a logout that leads back to one, and disallows a login button
// as a primary call to action. `gameWiring.ts` therefore hides `LoginScreen` on a portal host
// and this runs instead.
//
// ## The shape, and why the policy is here rather than in `sdk.ts`
//
// `sdkUser.ts` is transport: four reads that never throw. Everything below is policy, and
// all of it is policy the platform wrote:
//
//   ask availability first        a domain without accounts enabled answers false, and every
//                                 call after that would be noise in a reviewer's console
//   a guest is a normal outcome   `getUser()` → null is most players, not an error
//   re-read on every start        "request current user data every time the game starts"
//   never prompt automatically    `showAuthPrompt` exists and is deliberately never called
//   react to a login mid-session  `addAuthListener`, so a player who logs in on the portal
//                                 while the game is open does not have to reload
//
// ## Why a failed exchange is silent
//
// Every failure path — no SDK, accounts unavailable, a guest, a rejected token, our own
// server down, a 503 because the verification key could not be fetched — ends in the same
// place: the player keeps playing as a guest. That is not a swallowed error, it is the
// pre-existing and fully supported state of this game (`design/16`: "logging in is NEVER
// required to play"), and the portal's own rules require guest play to keep working. What it
// costs is cloud-saved progress, which is exactly what an adblocked player loses on the ad
// path too, and `AdController` answers that the same way.
import { getSession, setSession } from '../../net/session';
import { portalLogin } from '../../net/auth';
import { notifySessionChanged } from '../sessionEvents';
import type { CrazyGamesSdk } from './sdk';
import { readUser, readUserToken, subscribeAuth, userAvailable, type CgUser } from './sdkUser';

export interface PortalAuthDeps {
  sdk: CrazyGamesSdk;
  /** matchsvc's origin — `resolveMatchBaseUrl` in `game/runState.ts`, resolved by the entry
   *  point because this runs before any `RunState` exists. */
  baseUrl: string;
  /** Injected in tests; defaults to the real `net/auth.ts` call. */
  exchange?: typeof portalLogin;
}

/** What a live portal page can be asked about its own login state — the account half of
 *  `PortalSession`'s `diagnostics()`, which is the only instrument this repository has for
 *  the half of the integration it cannot test. */
export interface PortalAuthDiagnostics {
  available: boolean;
  portalUser: string | null;
  session: string | null;
  lastError: string | null;
}

export class PortalAuth {
  private available = false;
  private portalUser: CgUser | null = null;
  private lastError: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly exchange: typeof portalLogin;
  /** One exchange at a time. `addAuthListener` can fire while the boot exchange is still in
   *  flight, and two concurrent exchanges would race to write `net/session.ts` — the same
   *  re-entrancy guard `LoginScreen`'s own `doLogin` carries, for the same reason. */
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: PortalAuthDeps) {
    this.exchange = deps.exchange ?? portalLogin;
  }

  /**
   * Read who is playing and log them in, then subscribe to changes.
   *
   * Called from the entry point after `sdk.init()`, and it resolves rather than rejects on
   * every path — boot must not gain a new way to fail (`CrazyGamesSdk.init`'s own rule).
   */
  async start(): Promise<void> {
    const api = this.deps.sdk.userApi();
    this.available = await userAvailable(api);
    if (!this.available) {
      // Not an error and not worth a console line: this is what every non-portal page and
      // every accounts-disabled dev domain answers. `diagnostics()` reports it.
      this.clearPortalSession();
      return;
    }
    this.unsubscribe = subscribeAuth(api, (user) => void this.onAuthChanged(user));
    await this.onAuthChanged(await readUser(api));
  }

  /** Stop listening. Nothing calls this in the shipped entry point — a page teardown takes
   *  the whole frame with it — but a test that subscribed must be able to unsubscribe, and a
   *  listener with no way off is a leak waiting for the first caller who needs one. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  diagnostics(): PortalAuthDiagnostics {
    return {
      available: this.available,
      portalUser: this.portalUser?.username ?? null,
      session: getSession()?.username ?? null,
      lastError: this.lastError,
    };
  }

  /** Both entry points into the exchange — boot and the auth listener — serialised through
   *  the one in-flight slot. */
  private onAuthChanged(user: CgUser | null): Promise<void> {
    const run = (this.inFlight ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyUser(user))
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async applyUser(user: CgUser | null): Promise<void> {
    this.portalUser = user;
    if (!user) {
      // Logged out on the portal, or never logged in. A session left over from a DIFFERENT
      // portal player on this browser is the thing being cleared here, and it is not a
      // hypothetical: a shared machine is the normal case on a web-game portal.
      this.clearPortalSession();
      return;
    }
    const existing = getSession();
    if (existing?.origin === 'portal' && existing.providerId === user.userId) {
      // Already this player's session, from a previous visit — nothing to exchange, and no
      // reason to spend a token round trip on it. The display name may have changed on the
      // portal side since, so it is refreshed locally; the server adopts the new name on
      // this account's next real exchange.
      if (existing.username !== user.username) {
        setSession({ ...existing, username: user.username });
        notifySessionChanged();
      }
      return;
    }

    const token = await readUserToken(this.deps.sdk.userApi());
    if (!token) {
      this.lastError = 'no user token';
      return;
    }
    try {
      const result = await this.exchange(this.deps.baseUrl, token);
      setSession({ ...result, origin: 'portal', providerId: user.userId });
      this.lastError = null;
      notifySessionChanged();
    } catch (e) {
      // See the header: a failed exchange leaves a fully playable guest. Recorded for
      // `diagnostics()` because a live portal page is the only place this can be observed.
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * Drop a stored session that this build could only have obtained through portal login.
   *
   * Guarded on `origin === 'portal'` rather than clearing unconditionally, so the same code
   * running on a build that DOES have a login screen can never log a player out of an
   * account they typed a password for. Nothing ships that combination today; the guard is
   * what keeps this from being the reason it cannot.
   */
  private clearPortalSession(): void {
    if (getSession()?.origin !== 'portal') return;
    setSession(null);
    notifySessionChanged();
  }
}
