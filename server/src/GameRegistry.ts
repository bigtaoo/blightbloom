/**
 * `GameRegistry` (ROADMAP 8.6, design/19 §6) — which gameserver a freshly issued seat
 * ticket should be redeemed against.
 *
 * The gameserver's rooms are in-process `Map`s driven by in-process intervals
 * (`RoomManager.ts`), so today there can be exactly one instance. That is fine — a
 * frame-broadcast room is inherently a stateful shard — but it was an *accident* rather
 * than a decision, and the cheap moment to shape it is before anything depends on
 * `/find`'s response format. So this class exists now with the whole shape (register,
 * heartbeat, pick-least-loaded, staleness) and only ONE branch actually reachable: the
 * statically configured single instance. `register`/`heartbeat` have no HTTP route yet.
 *
 * Two rules from design/19 §6 are the *shape* of this class rather than implementation
 * detail, which is why they are written down here and not left for the next person to
 * re-derive when they add the routes:
 *
 *  1. **A single-instance deployment does not register at all.** A configured static
 *     address (`BB_GAMESERVER_URL`) supplies one entry. That is why `pick()` has a
 *     fallback arm at all, and why the fallback is held SEPARATELY from `entries`
 *     rather than seeded into the map as a competing entry: nothing reports load or
 *     liveness for a configured address, so as a map entry it would sit at load 0 and
 *     never go stale, and would therefore win every `pick()` against real instances
 *     reporting real numbers. A fallback that outcompetes the thing it is a fallback
 *     for is not a fallback.
 *
 *  2. **When registration is built: retry indefinitely with capped backoff, give up
 *     immediately on a 4xx, and never re-register from a heartbeat.** Each half has a
 *     failure it exists to prevent. A 4xx is a configuration or authentication error,
 *     so retrying it just hides a deployment mistake behind an instance that never
 *     appears; anything else is a network blip, and giving up on one would leave a
 *     healthy instance permanently invisible. And a heartbeat that silently
 *     re-registered would mask a failed startup registration — which is why
 *     `heartbeat()` below returns `false` for an unknown id and writes nothing.
 *
 * The chosen URL travels in `/find`'s RESPONSE, never inside the ticket: `ticket.ts`
 * stays purely a seat authorization and never learns the topology. (design/19 §6
 * supersedes the earlier "put a gameserver id inside the ticket" sketch.)
 */

/** How long an instance may go without a heartbeat before it is considered dead. */
export const STALE_MS = 30_000;

/**
 * Cap for the registering instance's exponential backoff (rule 2 above). Equal to
 * `STALE_MS` by coincidence, not by derivation — one is how long a registry waits
 * before disbelieving an instance, the other is how long an instance waits before
 * retrying. Kept as separate constants so tuning one does not silently move the other.
 */
export const REGISTER_BACKOFF_CAP_MS = 30_000;

/** How an entry got into the registry — see rule 1 above for why it matters. */
export type GameServerSource = 'static' | 'registered';

/** One gameserver instance the control plane knows how to hand players to. */
export interface GameServerEntry {
  readonly id: string;
  /** The public WS URL a client opens as `${wsUrl}?ticket=${token}`. */
  readonly wsUrl: string;
  /** Concurrent seats this instance accepts. `Infinity` for a static entry, which
   * reports nothing about itself — an unknown capacity must not read as a full one. */
  readonly capacity: number;
  /** Seats currently occupied, in the same unit as `capacity`. */
  readonly load: number;
  /** Wall clock of the last `register`/`heartbeat`. `null` for a static entry:
   * configuration is not a signal of life, and pretending otherwise would make
   * "we have never heard from it" indistinguishable from "it just checked in". */
  readonly lastSeenMs: number | null;
  readonly source: GameServerSource;
}

/** What an instance sends when it registers itself (no route yet — see the header). */
export interface GameServerRegistration {
  id: string;
  wsUrl: string;
  capacity: number;
  /** Initial load, if the instance restarted into a non-empty state. Default 0. */
  load?: number;
}

export interface GameRegistryOptions {
  /**
   * The statically configured single-instance address (rule 1). Defaults to
   * `staticGameserverUrl()`; pass `null` for a deployment with no static instance,
   * where an empty registry genuinely means "nowhere to send this player".
   */
  fallbackUrl?: string | null;
  /** Injected clock, so staleness is testable without waiting 30 real seconds. */
  nowMs?: () => number;
  /** Staleness window override; defaults to `STALE_MS`. */
  staleMs?: number;
}

/**
 * The WS data-plane URL an issued ticket is redeemed against, read per call for the
 * same reason `config.ts`'s `ticketSecret`/`controlPlaneUrl` are: a module-scope capture
 * makes the answer depend on whether the environment was loaded before the first import.
 *
 * Lives here rather than in `config.ts` because this is now the only consumer — the
 * registry owns the topology question, and matchsvc asks the registry.
 */
export function staticGameserverUrl(): string {
  const env = process.env.BB_GAMESERVER_URL;
  return env && env.length > 0 ? env : 'ws://localhost:8787/ws';
}

const STATIC_ENTRY_ID = 'static';

/**
 * The map's value type. Its `lastSeenMs` is a number and never `null`, because the only
 * entry that has never been heard from is the static fallback — and rule 1 keeps that one
 * out of the map. Stating it as a TYPE rather than checking it at read time matters: a
 * `lastSeenMs === null` arm inside the staleness check would be unreachable code that no
 * test can distinguish from a live branch.
 */
type RegisteredEntry = GameServerEntry & { readonly lastSeenMs: number; readonly source: 'registered' };

export class GameRegistry {
  private readonly entries = new Map<string, RegisteredEntry>();
  private readonly fallback: GameServerEntry | null;
  private readonly nowMs: () => number;
  private readonly staleMs: number;

  constructor(opts: GameRegistryOptions = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.staleMs = opts.staleMs ?? STALE_MS;
    const url = opts.fallbackUrl === undefined ? staticGameserverUrl() : opts.fallbackUrl;
    this.fallback = url
      ? { id: STATIC_ENTRY_ID, wsUrl: url, capacity: Infinity, load: 0, lastSeenMs: null, source: 'static' }
      : null;
  }

  /**
   * Record an instance (or refresh one that restarted under the same id). No HTTP route
   * reaches this yet — see the header. Re-registering an existing id REPLACES its
   * entry, which is the correct answer for a restarted process: its capacity may have
   * changed and its load is whatever it now reports, not whatever it reported before.
   */
  register(reg: GameServerRegistration): GameServerEntry {
    const entry: RegisteredEntry = {
      id: reg.id,
      wsUrl: reg.wsUrl,
      capacity: reg.capacity,
      load: reg.load ?? 0,
      lastSeenMs: this.nowMs(),
      source: 'registered',
    };
    this.entries.set(reg.id, entry);
    return entry;
  }

  /**
   * Refresh a known instance's load and liveness. Returns `false` — and writes nothing —
   * for an id that never registered: rule 2 in the header. The caller's correct response
   * to `false` is to register again from its own registration loop, not to have the
   * heartbeat quietly do it.
   */
  heartbeat(id: string, load: number): boolean {
    const prev = this.entries.get(id);
    if (!prev) return false;
    this.entries.set(id, { ...prev, load, lastSeenMs: this.nowMs() });
    return true;
  }

  /** Forget an instance immediately (a clean shutdown says so rather than going stale). */
  drop(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Registered instances that have checked in within the staleness window. */
  healthy(): GameServerEntry[] {
    const now = this.nowMs();
    return [...this.entries.values()].filter((e) => this.isAlive(e, now));
  }

  /** Every registered instance, alive or not — for an operator-facing view. */
  all(): GameServerEntry[] {
    return [...this.entries.values()];
  }

  /**
   * The instance a new ticket should be redeemed against: the healthy, non-full
   * registered instance with the lowest load RATIO (not lowest absolute load — a
   * 4-seat box at 3/4 is fuller than a 64-seat box at 10/64), falling back to the
   * static entry when no registered instance qualifies, and `null` when there is no
   * static entry either.
   *
   * `null` is a real answer, not an edge case to paper over: with the register routes
   * unbuilt and `fallbackUrl: null`, it is the ONLY answer. Callers must refuse the
   * request rather than issue a ticket with no address to redeem it at — `routes/match.ts`
   * answers 503, which is why `MatchInfo.wsUrl` can stay non-optional on the client.
   */
  pick(): GameServerEntry | null {
    const now = this.nowMs();
    let best: GameServerEntry | null = null;
    let bestRatio = Infinity;
    for (const e of this.entries.values()) {
      if (!this.isAlive(e, now)) continue;
      if (e.load >= e.capacity) continue; // full — skipped, not merely deprioritised
      // Safe to divide: a zero-capacity instance never reaches here, because `load >= 0`
      // is always true and the line above already skipped it. Guarding it again would be
      // an unreachable branch that reads like a live one.
      const ratio = e.load / e.capacity;
      // Ties break on id so a two-instance deployment does not depend on Map order.
      if (ratio < bestRatio || (ratio === bestRatio && best !== null && e.id < best.id)) {
        best = e;
        bestRatio = ratio;
      }
    }
    return best ?? this.fallback;
  }

  // Registered entries only — see `RegisteredEntry`. The static fallback is never stale
  // because nothing heartbeats it, and the alternative would be a single-instance
  // deployment going dark 30 s after boot; `pick` reaches it without asking this.
  private isAlive(e: RegisteredEntry, now: number): boolean {
    return now - e.lastSeenMs <= this.staleMs;
  }
}
