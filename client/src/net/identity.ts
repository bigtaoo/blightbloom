/**
 * Local player identity (design/05/15's PvP squad follow-up; design/16-accounts.md).
 * `getPlayerId()` prefers a logged-in account's real `accountId` (`net/session.ts`)
 * once one exists; the random id below is only the guest/anonymous fallback, kept for
 * players who never log in. This is the seam `server/src/ladderReport.ts`'s own note
 * anticipated: "swapping in real account ids later is a caller-side change only."
 *
 * Since design/21 there are TWO readers of the stored id and they want opposite things:
 * `getPlayerId()` prefers the account (a ladder key should follow the person) and
 * `getInstallId()` never does (a retention cohort has to follow the browser). Both read the
 * same `daydayup.playerId.v1`, so analytics stores nothing new.
 */
import { getSession } from './session';

const STORAGE_KEY = 'daydayup.playerId.v1';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for an environment without crypto.randomUUID (e.g. an older WeChat
  // WebView) — not cryptographically strong, but this id is never a security
  // boundary, only a "which browser tab is this" grouping key.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A storage port so web (localStorage) and WeChat (wx.getStorageSync/setStorageSync)
 * can each plug in their own primitive — same seam as settings/store.ts's SettingsStore. */
export interface IdentityStore {
  load(): string | null;
  save(id: string): void;
}

export function createWebIdentityStore(key: string = STORAGE_KEY): IdentityStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load: () => (available ? localStorage.getItem(key) : null),
    save: (id: string) => {
      if (!available) return;
      try {
        localStorage.setItem(key, id);
      } catch {
        /* quota / private-mode — an unpersisted id for this session is acceptable */
      }
    },
  };
}

let cached: string | null = null;

/** The local player's persistent id: the real accountId once logged in, otherwise a
 * generated-and-saved guest id. */
export function getPlayerId(store: IdentityStore = createWebIdentityStore()): string {
  const session = getSession();
  if (session) return session.accountId;
  if (cached) return cached;
  const existing = store.load();
  if (existing) {
    cached = existing;
    return existing;
  }
  const id = randomId();
  store.save(id);
  cached = id;
  return id;
}

/**
 * The persisted random id, ALWAYS — never the account id (design/21 A2, "install id").
 *
 * This is the same stored value {@link getPlayerId} falls back to, and reusing it rather
 * than minting a second identifier is the whole point: analytics adds no new stored
 * identifier, existing players keep the id they already have (so retention is continuous
 * from the day this ships rather than starting from zero), and there is one fewer thing for
 * somebody clearing their site data to have to find.
 *
 * The difference from `getPlayerId` is the one that matters for a cohort. `getPlayerId`
 * PREFERS the account id once a session exists, which is right for a ladder key and wrong
 * here: a player who logs in halfway through their second visit would change identity
 * mid-cohort and read as one install that vanished plus one that appeared. Retention has to
 * be a question about the browser, and this is the browser's answer.
 *
 * It generates and persists on demand, because a player who logged in before ever playing
 * as a guest has no stored id at all — `getPlayerId` returns early in that case and never
 * writes one.
 */
export function getInstallId(store: IdentityStore = createWebIdentityStore()): string {
  if (installCached) return installCached;
  const existing = store.load();
  if (existing) {
    installCached = existing;
    return existing;
  }
  const id = randomId();
  store.save(id);
  installCached = id;
  return id;
}

let installCached: string | null = null;

/** Test-only: clear the in-process cache so a fresh store is actually read again. */
export function resetIdentityCacheForTests(): void {
  cached = null;
  installCached = null;
}
