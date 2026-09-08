/**
 * The logged-in account session (design/16-accounts.md) — this project's first real
 * login system. Same storage-port shape as `net/identity.ts`'s `IdentityStore` (a web
 * localStorage impl here, a WeChat impl elsewhere later), and the same
 * cache-plus-injectable-store test seam.
 */
export interface Session {
  accountId: string;
  username: string;
  token: string;
  /**
   * How this session was obtained. Absent means "a credential the player typed"
   * (`LoginScreen`), which is every session that existed before 2026-09-08 — so absence is
   * the safe default and no stored session needs migrating.
   *
   * `'portal'` means the host platform vouched for the player and `platform/crazygames/
   * portalAuth.ts` exchanged that for this session. The distinction is load-bearing exactly
   * once, and only in one direction: a portal session may be dropped automatically when the
   * platform says a different player (or no player) is now at the keyboard, and a typed-in
   * session may never be.
   */
  origin?: 'portal';
  /** The provider's own id for this player, when `origin` says there is one. Compared on
   *  boot to tell "the same player returning" from "somebody else on this browser" — the
   *  accountId cannot answer that, because it is what we are trying to decide. */
  providerId?: string;
}

const STORAGE_KEY = 'daydayup.session.v1';

export interface SessionStore {
  load(): Session | null;
  save(session: Session | null): void;
}

export function createWebSessionStore(key: string = STORAGE_KEY): SessionStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load(): Session | null {
      if (!available) return null;
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as Session) : null;
      } catch {
        return null; // corrupt/unreadable — treat as logged out rather than throw
      }
    },
    save(session: Session | null): void {
      if (!available) return;
      try {
        if (session) localStorage.setItem(key, JSON.stringify(session));
        else localStorage.removeItem(key);
      } catch {
        /* quota / private-mode — an unpersisted session for this tab is acceptable */
      }
    },
  };
}

let cached: Session | null = null;
let loaded = false;

/** The current logged-in session, or `null` if the player is a guest. */
export function getSession(store: SessionStore = createWebSessionStore()): Session | null {
  if (!loaded) {
    cached = store.load();
    loaded = true;
  }
  return cached;
}

/** Call after a successful login/register (a `Session`), or on logout (`null`). */
export function setSession(session: Session | null, store: SessionStore = createWebSessionStore()): void {
  cached = session;
  loaded = true;
  store.save(session);
}

/** Test-only: clear the in-process cache so a fresh store is actually read again. */
export function resetSessionCacheForTests(): void {
  cached = null;
  loaded = false;
}
