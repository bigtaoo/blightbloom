/**
 * The client half of server-owned entitlements (design/19-server-platform.md §2, ROADMAP
 * 8.2). Same injected-`fetch` shape as `net/auth.ts`/`net/party.ts`, so it is unit-testable
 * without a network.
 *
 * The one thing worth understanding before reading `pullAccountMeta` (meta/accountSync.ts):
 * **the server now overwrites the ownership fields of the blob it returns**, from its own
 * `entitlements` table. This client does not fight that and does not need to — the free
 * baseline it would otherwise be afraid of losing is re-supplied locally, by `migrate()`,
 * which unions `STARTER_BLUEPRINTS` and `FREE_CHARACTERS` back in on every load
 * (meta/store.ts). So for a player who owns nothing paid — which is every player today —
 * the ownership arrays before and after login are identical, and the Forge does not
 * flicker or roll back. What CAN disappear is ownership the client granted ITSELF, which
 * is exactly the hole ROADMAP 8.2 closes.
 *
 * `fetchAccountState` superseded `net/auth.ts`'s `fetchAccountMeta` (deleted 2026-09-17): it
 * reads the same route, but keeps the `entitlements` array the response now carries alongside
 * `data` instead of discarding it. One round trip, no second route.
 *
 * ## The 401 is a RETURN VALUE here (design/16 hole 2, 2026-09-17)
 *
 * And it is the only status that is. Everything else still throws, because everything else
 * means "the request failed" — a state in which the right thing to do is keep playing on
 * local data. A 401 means something categorically different: the stored session is dead, and
 * the player is being shown a name they are no longer signed in as.
 *
 * Distinguishing the two is the whole of what closed hole 2 without adding a request. This
 * route is already called on the way in, so its 401 verifies the token that boot read out of
 * `localStorage` and believed; a `GET /auth/me` at boot would have asked the same question a
 * second time. What the caller must do with the two answers is opposite, which is why they
 * cannot keep arriving through the same `catch`: **offline is not logged out.**
 */

/** Mirrors the server's `ENTITLEMENT_SOURCES` (server/src/EntitlementService.ts). Only
 * `purchase` implies money moved; the rest are grants, campaigns, gifts and run drops. A
 * store UI needs this to say "owned" differently from "bought". */
export const ENTITLEMENT_SOURCES = ['purchase', 'grant', 'event', 'starter', 'drop'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export interface Entitlement {
  sku: string;
  source: EntitlementSource;
  grantedAt: number;
}

/** Namespaced exactly as the server writes them (`EntitlementService.ts`) — one table,
 * two namespaces, and a blueprint id that can never collide with a skin id. */
export const BLUEPRINT_SKU_PREFIX = 'blueprint:';
export const CHARACTER_SKU_PREFIX = 'character:';

export interface EntitlementOwnership {
  unlockedBlueprints: string[];
  ownedCharacters: string[];
}

/**
 * Project entitlements onto the two `MetaState` ownership arrays. Deliberately the same
 * rules as the server's `skusToOwnership`: an unknown namespace and an empty id are both
 * SKIPPED rather than rejected, so a SKU billsvc later sells that is neither a blueprint
 * nor a character cannot break the Forge.
 */
export function entitlementOwnership(list: readonly Entitlement[]): EntitlementOwnership {
  const own: EntitlementOwnership = { unlockedBlueprints: [], ownedCharacters: [] };
  for (const e of list) {
    if (e.sku.startsWith(BLUEPRINT_SKU_PREFIX)) {
      const id = e.sku.slice(BLUEPRINT_SKU_PREFIX.length);
      if (id) own.unlockedBlueprints.push(id);
    } else if (e.sku.startsWith(CHARACTER_SKU_PREFIX)) {
      const id = e.sku.slice(CHARACTER_SKU_PREFIX.length);
      if (id) own.ownedCharacters.push(id);
    }
  }
  return own;
}

/**
 * Defensive parse of the wire array. Everything about a response is untrusted here for the
 * same reason `migrate()` distrusts a localStorage save: an older/newer server, a proxy's
 * error page, or a half-written response must degrade to "owns nothing extra" rather than
 * throw somewhere deep inside the Forge. A malformed ENTRY is dropped on its own; it never
 * discards the entries around it.
 */
export function parseEntitlements(raw: unknown): Entitlement[] {
  if (!Array.isArray(raw)) return [];
  const out: Entitlement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { sku, source, grantedAt } = item as Partial<Entitlement>;
    if (typeof sku !== 'string' || sku.length === 0) continue;
    if (typeof source !== 'string' || !(ENTITLEMENT_SOURCES as readonly string[]).includes(source)) continue;
    out.push({ sku, source: source as EntitlementSource, grantedAt: typeof grantedAt === 'number' ? grantedAt : 0 });
  }
  return out;
}

export interface AccountStateCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * This browser's guest install id (`net/identity.ts`'s `getInstallId()`), sent as the
   * `x-guest-id` header so the server can answer `guestMerged` for it. Omitted by every
   * caller that is not deciding whether to offer the one-time device merge — and omitting it
   * makes the server answer `true`, i.e. "offer nothing", which is the answer that cannot
   * lose data.
   */
  guestId?: string;
}

export interface AccountState {
  /** The stored `MetaState` blob with its ownership fields already overwritten by the
   * server, or `null` when this account has never saved one. */
  data: unknown | null;
  entitlements: Entitlement[];
  /**
   * Whether this device has already been through the one-time guest-merge question on this
   * account (design/16 hole 1). `true` means don't ask — including when no `guestId` was
   * sent, and including on a server too old to know the field, since an absent/garbage value
   * reads as `true` here. Both defaults point the same way on purpose: the cost of not
   * asking is that a guest keeps their progress locally, and the cost of asking twice is a
   * material bank counted twice.
   */
  guestMerged: boolean;
}

/** A 401 from `GET /account/meta`, as a value. See the header: it is the one status that
 *  means the stored session is dead rather than that the request failed. */
export const ACCOUNT_UNAUTHORIZED = 'unauthorized';
export type AccountStateResult = AccountState | typeof ACCOUNT_UNAUTHORIZED;

/**
 * `GET /account/meta` — the account's stored meta blob AND what the server says it owns.
 *
 * Returns {@link ACCOUNT_UNAUTHORIZED} on a 401 instead of throwing (see the header); every
 * other failure still throws.
 *
 * Guarded `res.json()` for the same reason every call in `net/auth.ts` is: a non-2xx can
 * come back as a proxy's HTML error page, which would otherwise throw a raw SyntaxError
 * instead of the clean `Error` the caller's `.catch()` expects. The 401 is read off the
 * STATUS, before the body is touched, so a 401 whose body is such a page is still a clean
 * "logged out" rather than a parse failure wearing its clothes.
 */
export async function fetchAccountState(
  baseUrl: string,
  token: string,
  opts: AccountStateCallOptions = {},
): Promise<AccountStateResult> {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.guestId) headers['x-guest-id'] = opts.guestId;
  const res = await doFetch(`${baseUrl}/account/meta`, { headers });
  if (res.status === 401) return ACCOUNT_UNAUTHORIZED;
  const json = (await res.json().catch(() => null)) as
    | { data?: unknown; entitlements?: unknown; guestMerged?: unknown; error?: string }
    | null;
  if (!res.ok || json?.error) throw new Error(json?.error ?? `account request failed (${res.status})`);
  return {
    data: json?.data ?? null,
    entitlements: parseEntitlements(json?.entitlements),
    // Anything that is not an explicit `false` is "don't ask" — see `AccountState.guestMerged`.
    guestMerged: json?.guestMerged !== false,
  };
}
