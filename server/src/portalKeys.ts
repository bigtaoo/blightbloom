/**
 * The RSA public key `portalToken.ts` verifies against, fetched from CrazyGames and cached.
 * Split from `portalToken.ts` so that module stays pure of I/O and env — the same split
 * `config.ts` is to `ticket.ts`.
 *
 * The platform publishes one document, `https://sdk.crazygames.com/publicKey.json`, shaped
 * `{"publicKey": "-----BEGIN RSA PUBLIC KEY-----\n..."}` (PKCS#1 PEM, which
 * `crypto.createPublicKey` detects from that header without being told a format). Their
 * documentation offers two options — refetch per verification, or cache — and this caches,
 * because a login is on the player's critical path and an outbound HTTPS round trip per
 * login is a hard dependency on someone else's uptime for something that changes about
 * never.
 *
 * Two failure postures worth stating, because they are opposites and both are deliberate:
 *
 * - **A failed fetch keeps serving the stale key.** If CrazyGames' CDN is down, the key we
 *   already have is still the right key, and refusing to use it would lock every portal
 *   player out for the length of someone else's outage. The cache therefore has an expiry
 *   for freshness, not for correctness.
 * - **A failed VERIFICATION never triggers a refetch.** That would let anyone force an
 *   outbound request per bad token, so key rotation costs up to one TTL of failed logins
 *   instead. A rotation is an announced, rare event; a flood of invalid tokens is free.
 */
export interface PortalKeyStore {
  /** The cached PEM, fetching it if absent or stale. `null` only when it has never been
   *  fetched successfully — which the caller must map to a refusal, not to a bypass. */
  key(): Promise<string | null>;
}

export interface PortalKeyStoreDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  /** How long a fetched key is served without refetching. One hour. */
  ttlMs?: number;
  url?: string;
  /** Bound so a hung CDN cannot hold a login request open indefinitely. */
  timeoutMs?: number;
}

export const CRAZYGAMES_PUBLIC_KEY_URL = 'https://sdk.crazygames.com/publicKey.json';

const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export function createPortalKeyStore(deps: PortalKeyStoreDeps = {}): PortalKeyStore {
  const doFetch = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const url = deps.url ?? CRAZYGAMES_PUBLIC_KEY_URL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cached: string | null = null;
  let fetchedAt = 0;
  // One in-flight fetch at a time: a burst of logins on a cold cache would otherwise each
  // start their own request. Same "collapse concurrent identical work" shape as the rest of
  // this server's single-process caches.
  let inFlight: Promise<string | null> | null = null;

  async function fetchKey(): Promise<string | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(url, { signal });
      if (!res.ok) return null;
      const json = (await res.json()) as { publicKey?: unknown };
      const pem = json?.publicKey;
      return typeof pem === 'string' && pem.includes('PUBLIC KEY') ? pem : null;
    } catch {
      return null;
    }
  }

  return {
    async key(): Promise<string | null> {
      if (cached !== null && nowMs() - fetchedAt < ttlMs) return cached;
      if (!inFlight) {
        inFlight = fetchKey().finally(() => {
          inFlight = null;
        });
      }
      const fresh = await inFlight;
      if (fresh !== null) {
        cached = fresh;
        fetchedAt = nowMs();
        return fresh;
      }
      // Stale-but-present beats nothing — see the header.
      return cached;
    },
  };
}
