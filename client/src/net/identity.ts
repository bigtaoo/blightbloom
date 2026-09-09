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
 *
 * The store itself is a port ({@link IdentityStore}): `localStorage` on the web, and
 * `wx.getStorageSync` on the mini-game shell, which has no `localStorage` at all —
 * `platform/wechat/weChatStorage.ts`, installed by that entry point through
 * {@link setIdentityStore}. Until that adapter existed the WeChat build minted a fresh id
 * every boot, which is why analytics was switched off there rather than reporting visits as
 * distinct installs (design/21 §9).
 */
import { getSession } from './session';

/** The one stored key both readers below share, and the one the WeChat store reuses so a
 *  player's id has a single name across hosts. Exported for
 *  `platform/wechat/weChatStorage.ts`. */
export const IDENTITY_STORAGE_KEY = 'daydayup.playerId.v1';

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

export function createWebIdentityStore(key: string = IDENTITY_STORAGE_KEY): IdentityStore {
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

let installedStore: IdentityStore | null = null;

/**
 * Install the store both readers below use when a caller passes none — the module-sink shape
 * `setAssetHost`/`setHostKind`/`setUiAudio` already use, set once by an entry point.
 *
 * It exists because the two production readers take no arguments: `installAnalytics` calls
 * `getInstallId()` and the ladder report calls `getPlayerId()`, and neither has any business
 * knowing which platform it is on. So a host whose persistence is not `localStorage` needs
 * one line at boot rather than a store threaded through everything in between —
 * `main.wechat.ts` calls this with `createWeChatIdentityStore()` before it installs
 * analytics, and that ORDER is load-bearing: the install id is read during the install.
 *
 * `null` restores the web default, which is how a test leaves the module as it found it.
 * Both caches are dropped on the way through, because an id already handed out came from the
 * store that was installed then, and continuing to answer with it would make the swap a lie.
 */
export function setIdentityStore(store: IdentityStore | null): void {
  installedStore = store;
  cached = null;
  installCached = null;
}

/** The installed store, or the web one. Called per read rather than memoised, so the web
 *  fallback still re-checks `localStorage` availability the way it always did. */
function identityStore(): IdentityStore {
  return installedStore ?? createWebIdentityStore();
}

let cached: string | null = null;

/** The local player's persistent id: the real accountId once logged in, otherwise a
 * generated-and-saved guest id. */
export function getPlayerId(store: IdentityStore = identityStore()): string {
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
export function getInstallId(store: IdentityStore = identityStore()): string {
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

/** Test-only: clear the in-process cache so a fresh store is actually read again, and drop
 *  any store {@link setIdentityStore} installed — a test that installed the WeChat one has to
 *  leave the module as it found it, or the next file in the run reads through it. */
export function resetIdentityCacheForTests(): void {
  cached = null;
  installCached = null;
  installedStore = null;
}
