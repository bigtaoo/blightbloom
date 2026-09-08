// Split of `sdk.ts` (2026-09-08) — the portal's user module, as four independent functions
// over the raw SDK object `CrazyGamesSdk.userApi()` hands over.
//
// Free functions rather than methods (CLAUDE.md's preferred split form): there is no state
// here at all. `sdk.ts` owns the one real piece of state in this directory — whether the
// script ever showed up — and every function below is a pure read through `settle`.
//
// This file is TRANSPORT, like `sdk.ts` itself. The policy built on it lives in
// `portalAuth.ts`: when to ask, what to do with the answer, and the fact that "this player
// is a guest" is a normal outcome rather than a failure.
//
// ## Two SDK versions, and the trap in each
//
// design/20 records findings of the form "the shipped SDK is not the documented SDK". For this
// module the shapes actually differ BETWEEN VERSIONS, which is worse than a documentation error
// because both descriptions are true of something:
//
// - **v2**: every one of these is a METHOD, including `isUserAccountAvailable`, which reads like
//   a property and is not. Called with no argument they return a promise; called with a callback
//   they do not.
// - **v3**: `isUserAccountAvailable` is a plain boolean VARIABLE (its migration notes list this
//   change explicitly, for this field and for `environment`).
//
// `userAvailable` therefore reads both shapes, the way `sdk.ts`'s `init` reads the environment
// both ways. Every call here also goes through `settle`, because these promises REJECT for the
// ordinary cases — a guest asking for a token, the module disabled on this domain — rather than
// resolving falsy.
import { settle, guard } from './settle';
import type { CgSdkShape } from './sdk';

/** The portal's own idea of who is playing. `username` is what the platform requires the
 *  game to display (`docs.crazygames.com/requirements/multiplayer`); `userId` is what an
 *  account is keyed on (`accounts.provider_id`, server-side). */
export interface CgUser {
  userId: string;
  username: string;
  profilePictureUrl?: string;
}

type CgUserApi = CgSdkShape['user'];

/**
 * Narrow the SDK's raw user object into a `CgUser`, or `null`.
 *
 * One function, used by both the read and the subscription, so the two cannot disagree about
 * what a valid user is — the failure mode where one path validates the shape and the other
 * trusts it. `username` falls back to the id rather than to a placeholder: an id is at least
 * a true statement about who this is, and a placeholder would be shown to other players.
 */
function narrowUser(raw: unknown): CgUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { userId?: unknown; username?: unknown; profilePictureUrl?: unknown };
  if (typeof u.userId !== 'string' || !u.userId) return null;
  return {
    userId: u.userId,
    username: typeof u.username === 'string' && u.username ? u.username : u.userId,
    profilePictureUrl: typeof u.profilePictureUrl === 'string' ? u.profilePictureUrl : undefined,
  };
}

/**
 * Whether the user module answers at all on this domain. The documentation is explicit that
 * this is asked FIRST, and it is not a formality: a developer domain with accounts not
 * enabled answers false, and so does every non-portal page.
 *
 * Strict `=== true`, so a method that resolves a truthy non-boolean (or that is missing, and
 * therefore resolves `undefined` through `settle`) reads as unavailable.
 */
export async function userAvailable(api: CgUserApi): Promise<boolean> {
  // v2 makes this a METHOD (which reads like a property and is not); v3 makes it a plain
  // BOOLEAN VARIABLE (its migration notes list exactly this change, for this field and for
  // `environment`). Both are read, in that order, so this file works against either script —
  // and a truthy non-boolean still answers false, because the cost of guessing true is a
  // console full of account calls on a page that has no account module.
  const raw = api?.isUserAccountAvailable;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'function') return (await settle(() => raw.call(api))) === true;
  return false;
}

/**
 * The logged-in portal user, or `null` for a guest.
 *
 * `null` is the documented answer for "not logged in on CrazyGames", and it is also what
 * every failure collapses to here — a rejected promise, a missing method, an unavailable
 * module, an object without an id. That collapse is deliberate: the caller's response to all
 * of them is the same (play as a guest), and distinguishing them would only add branches
 * that cannot be exercised outside a real portal domain.
 */
export async function readUser(api: CgUserApi): Promise<CgUser | null> {
  return narrowUser(await settle(() => api?.getUser?.()));
}

/**
 * A short-lived signed token proving who the player is, for OUR server to verify.
 *
 * Never decoded here. The platform's documentation says so explicitly and it is right: the
 * claims are only worth anything after the signature has been checked against a key this
 * page has no business holding. `server/src/portalToken.ts` is the only place in this
 * repository that reads inside one.
 */
export async function readUserToken(api: CgUserApi): Promise<string | null> {
  const token = await settle(() => api?.getUserToken?.());
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Subscribe to "the player logged in (or out) on the portal while the game was running".
 *
 * Returns an unsubscribe, and returns a no-op one where the SDK has no such method — so a
 * caller never has to check whether it managed to subscribe. The listener is wrapped in
 * `guard` because it runs inside the SDK's own dispatch: a throw there is not ours to let
 * escape.
 */
export function subscribeAuth(api: CgUserApi, listener: (user: CgUser | null) => void): () => void {
  const add = api?.addAuthListener;
  if (typeof add !== 'function') return () => {};
  const adapter = (raw: unknown): void => {
    guard(() => listener(narrowUser(raw)));
  };
  try {
    add.call(api, adapter);
  } catch {
    return () => {};
  }
  return () => {
    void settle(() => api?.removeAuthListener?.(adapter));
  };
}
