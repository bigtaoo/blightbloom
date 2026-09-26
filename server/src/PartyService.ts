/**
 * Party service (design/05/15's PvP squad follow-up) — pure pre-match grouping so
 * friends can queue together as one squad instead of matchmaking pairing strangers.
 * Mirrors `Matchmaker`'s shape exactly: a pure class, all non-determinism injected
 * (`nowMs`/`newPartyId`/`newCode`), in-memory `Map` state (this repo's standing
 * convention — no DB anywhere yet, see `RatingStore`).
 *
 * **A party needs no account, and that is the decision rather than a gap** (re-audited
 * 2026-09-21; the note this replaces predated design/16 and still said no account system
 * existed anywhere, which stopped being true on 2026-07-29). One DOES exist now, and none of
 * the five `/party/*` routes consults it: a "player" here is whatever opaque id string the
 * client sends — the real `accountId` once that client has a session, a locally generated
 * guest id otherwise (`client/src/net/identity.ts`) — and nothing verifies which. That is
 * the same trust level `Matchmaker.enqueue` gives a bare `playerCount`/`mode`, and it is
 * enough here because the worst a forged id can do is confuse a party the forger has already
 * joined. `matchsvc.queue.http.test.ts` pins the whole squad flow running with no
 * `Authorization` header at all, so adding a gate to any of these routes turns a test red
 * rather than quietly changing the answer.
 *
 * The one thing a guest genuinely forgoes is the durable LADDER RATING, which `/find` keys
 * off a verified bearer token precisely because a self-declared identity cannot own one
 * (`routes/match.ts`, design/16 hole 3). Not the party, not the match, not the win.
 *
 * Two lookup keys per party: an internal `partyId` (what the client polls) and a
 * short, human-typeable room `code` (what a leader reads out / pastes to a friend) — the
 * same `roomId`-vs-`queueId` separation `Matchmaker`/`ticket.ts` already use. The code's
 * SHAPE belongs to whoever supplies `newCode` (six digits, `routes/party.ts`); what belongs
 * here is that it is UNIQUE across every live party — see {@link CODE_DRAW_ATTEMPTS}.
 */
import { SQUAD_SIZE, partyCapacity, type PartyMode } from './config';

export interface PartyServiceDeps {
  nowMs(): number;
  newPartyId(): string;
  /** A fresh short room code. Injected so tests are deterministic and collisions are
   * trivially forceable (real: `routes/party.ts`'s six-digit `randomCode`). Its uniqueness
   * is NOT assumed — {@link PartyService.create} redraws a code already in use. */
  newCode(): string;
}

export interface PartyInfo {
  partyId: string;
  code: string;
  leaderId: string;
  members: readonly string[];
  /** What the party queues for (2026-09-26): a PvP squad, or a co-op room. Fixed at
   *  creation — a joiner joins whatever the leader made — and it sets {@link capacity}. */
  mode: PartyMode;
  /** How many members this party may hold: `partyCapacity(mode)`. Sent rather than left for
   *  the client to derive so the lobby's `1/2` and the join refusal read one answer. */
  capacity: number;
  /** Set once the leader calls `startMatching` — other members' polls observe this
   * flip and each independently call their own `POST /find` with this `partyId`. */
  matching: boolean;
}

/** The largest party of ANY mode (design/05/15) — the same `SQUAD_SIZE` `Matchmaker`'s
 * per-squad chunking uses (via `@dd/game/match/pvpConfig`). A given party's own ceiling is
 * `partyCapacity(mode)`, which is this for a squad and `COOP_SEATS` for a co-op party
 * (2026-09-26): a party can never grow larger than the room or squad it is meant to fill. */
export const MAX_PARTY_SIZE = SQUAD_SIZE;

/**
 * How long an idle party lives. Ten minutes — generous; a lobby isn't a hot loop.
 *
 * EXPORTED since 2026-09-22, for one reader: `routes/party.ts`'s `CREATE_RATE_LIMIT` argues
 * its number from the fact that its window is exactly this TTL (the budget is then also the
 * ceiling on how many live parties one address can hold). That argument is a claim about two
 * constants agreeing, and two copies of a number cannot be held in agreement by prose — so
 * the budget's test asserts the equality against THIS symbol rather than against `10 * 60_000`
 * written a second time.
 */
export const DEFAULT_TTL_MS = 10 * 60_000;

/**
 * How many times {@link PartyService.create} redraws a code that is already taken before it
 * gives up and throws {@link CodeSpaceExhausted}.
 *
 * The loop it bounds used to be `while (taken) redraw()`, with a `// vanishingly rare`
 * comment that was true of the old 33.5M-wide alphabetic code and is the kind of claim that
 * quietly stops being true when the shape underneath it changes. It is still true at six
 * digits in normal operation — 1M codes against a live set that TTLs out after ten idle
 * minutes — but "unlikely" and "cannot happen" are different guarantees, and an unbounded
 * loop over a saturated keyspace is an infinite loop on the ONE event loop that also serves
 * matchmaking, party polling and ladder settlement. A hang there is worse than a refusal:
 * a refusal is a 503 the player can retry, a hang is every player in the process.
 *
 * 100 and not 10: at 100 draws the probability of exhausting them is (live/1M)^100, so the
 * throw is unreachable until the keyspace is genuinely close to full (~100k live parties
 * still clears it with room to spare), which makes reaching it real evidence rather than
 * bad luck. And 100 iterations over a `Map.has` is microseconds, so the bound costs nothing
 * in the case that always happens: the first draw is free.
 */
export const CODE_DRAW_ATTEMPTS = 100;

/**
 * Thrown by {@link PartyService.create} when {@link CODE_DRAW_ATTEMPTS} consecutive draws all
 * collided. A distinct class rather than a bare `Error` so the route layer can answer 503
 * ("retry, the service is briefly out of codes") instead of the 400 its `catch` gives a
 * malformed request — nothing the caller sent is wrong.
 */
export class CodeSpaceExhausted extends Error {
  constructor(attempts: number) {
    super(`no free room code after ${attempts} draws`);
    this.name = 'CodeSpaceExhausted';
  }
}

interface Party {
  code: string;
  mode: PartyMode;
  leaderId: string;
  members: string[];
  matching: boolean;
  updatedAt: number;
}

export class PartyService {
  private readonly parties = new Map<string, Party>();
  private readonly codeToPartyId = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(
    private readonly deps: PartyServiceDeps,
    ttlMs = DEFAULT_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
  }

  /** Create a new party with `playerId` as its sole member and leader. `mode` defaults to
   * `'pvp'`, the only kind of party there was before co-op room codes (2026-09-26).
   *
   * @throws {CodeSpaceExhausted} when {@link CODE_DRAW_ATTEMPTS} draws all collide. The
   * sweep above runs FIRST, so an expired party's code is already back in the pool before
   * any of those draws — the throw means the LIVE set is saturated, not that the map has
   * been filling up with corpses.
   */
  create(playerId: string, mode: PartyMode = 'pvp'): PartyInfo {
    this.sweepExpired();
    const partyId = this.deps.newPartyId();
    const code = this.drawFreeCode();
    const party: Party = { code, mode, leaderId: playerId, members: [playerId], matching: false, updatedAt: this.deps.nowMs() };
    this.parties.set(partyId, party);
    this.codeToPartyId.set(code, partyId);
    return this.toInfo(partyId, party);
  }

  /** Join the party behind `code`. Idempotent for an already-joined `playerId`.
   * `null` on an unknown/expired code or a full party. */
  join(code: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const partyId = this.codeToPartyId.get(code);
    const party = partyId ? this.parties.get(partyId) : undefined;
    if (!partyId || !party) return null;
    if (!party.members.includes(playerId)) {
      if (party.members.length >= partyCapacity(party.mode)) return null;
      party.members.push(playerId);
    }
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  /** Leave a party. The party dissolves once empty; the leader slot passes to the
   * next-oldest member if the leader leaves (never to nobody while members remain). */
  leave(partyId: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    if (!party) return null;
    party.members = party.members.filter((m) => m !== playerId);
    if (party.members.length === 0) {
      this.parties.delete(partyId);
      this.codeToPartyId.delete(party.code);
      return null;
    }
    if (party.leaderId === playerId) party.leaderId = party.members[0]!;
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  /** Current party state (for polling). `null` if unknown/expired. */
  get(partyId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    return party ? this.toInfo(partyId, party) : null;
  }

  /** Only the leader may start matching. Returns `null` on an unknown party or a
   * non-leader caller (the shell maps either to a 4xx, not a crash). */
  startMatching(partyId: string, playerId: string): PartyInfo | null {
    this.sweepExpired();
    const party = this.parties.get(partyId);
    if (!party || party.leaderId !== playerId) return null;
    party.matching = true;
    party.updatedAt = this.deps.nowMs();
    return this.toInfo(partyId, party);
  }

  /** A code no live party holds. See {@link CODE_DRAW_ATTEMPTS} for the bound and why the
   *  loop is not `while (taken)`. */
  private drawFreeCode(): string {
    for (let i = 0; i < CODE_DRAW_ATTEMPTS; i++) {
      const code = this.deps.newCode();
      if (!this.codeToPartyId.has(code)) return code;
    }
    throw new CodeSpaceExhausted(CODE_DRAW_ATTEMPTS);
  }

  private toInfo(partyId: string, party: Party): PartyInfo {
    return {
      partyId,
      code: party.code,
      leaderId: party.leaderId,
      members: [...party.members],
      mode: party.mode,
      capacity: partyCapacity(party.mode),
      matching: party.matching,
    };
  }

  private sweepExpired(): void {
    const now = this.deps.nowMs();
    for (const [id, party] of this.parties) {
      if (now - party.updatedAt > this.ttlMs) {
        this.parties.delete(id);
        this.codeToPartyId.delete(party.code);
      }
    }
  }
}
