/**
 * Pure placement → rank conversion for the ladder-rating report (design/15, ROADMAP
 * 4.6) — split out of index.ts so it's unit-testable without touching node:http/fetch.
 * index.ts intentionally stays thin and untested-directly (its own doc comment: "the
 * ONLY file that touches ws... hands everything to the pure RoomManager/MatchRoom
 * lifecycle, which the tests drive with fakes") — this module is that same principle
 * applied to the 4.6 wiring.
 *
 * Also owns the report's exactly-once dedupe key (`ratingReportKey`, design/19 §3), for the
 * same reason: whether `roomId` is a sufficient key is an argument about match identity, and
 * arguments belong where a test can reach them.
 */
import { createHash } from 'node:crypto';
import { teamIdForOwner } from './config';

export interface RatingReportBody {
  accountIds: string[];
  places: number[];
  /** Squad membership per entry (index-aligned with `accountIds`/`places`), fed to
   * `rating.ts`'s `computeRatingDeltas` so squadmates share one team rank/rating
   * instead of being scored off their individually-adjacent `places` — see that
   * file's doc comment. Derived the same way every seat's squad already is
   * (`teamIdForOwner`), so a solo/FFA match (squad size 1) degenerates to one
   * singleton team per seat, byte-identical to the pre-squad behavior. */
  teamIds: number[];
  /**
   * The exactly-once dedupe key for this report (design/19 §3, closing ROADMAP 8.1's one
   * open item) — see `ratingReportKey` below for what is in it and why. matchsvc claims
   * this string in `rating_reports` inside the same transaction that moves the ratings, so
   * a retried-but-already-delivered report adds nothing the second time.
   *
   * Carried in the BODY rather than derived by the receiver, because the sender is the only
   * side that knows which match this is: the receiver sees a set of accounts and places,
   * and two genuinely different matches can produce an identical one. The key is exactly as
   * trusted as the placements it travels with, which is what design/19 §3's internal key
   * already establishes.
   */
  reportKey: string;
}

/**
 * The dedupe key for one settled match: `{roomId}:{16 hex of sha256 over the report}`.
 *
 * WHY roomId, and why it is not enough ON ITS OWN. A room settles at most once —
 * `MatchRoom.reportResult` latches `this.settled` and destroys the room immediately after
 * firing `onSettled` — and `matchsvc.ts` mints room ids with `randomUUID()`, so in
 * production one roomId names exactly one settlement and `roomId` alone would be a correct
 * key. The mode does not change that: a PvE/co-op settlement travels the SAME
 * `onSettled` → `reportSettledMatch` path and is filtered only by that function's
 * `hashOk`/`placements`/`winner` guard, but the filter is per-REPORT, so whatever gets
 * through still gets through once per room.
 *
 * What breaks it is the room id not always being ours. `index.ts`'s legacy dev handshake
 * (no `BB_TICKET_SECRET` configured) takes `roomId` straight off the query string, and the
 * room is destroyed when it settles — so a local `?roomId=dev` can host a second, genuinely
 * different match, and a roomId-only key would silently swallow every settlement after the
 * first. That failure is the one the tests below care about most: double-crediting a match
 * is visible and reversible, while a match whose rating never lands is neither.
 *
 * The room id appears TWICE — as the prefix and inside the digest — and the second is
 * redundant while the first is intact (a mutation battery on 2026-09-05 confirmed it:
 * dropping `roomId` from the digest kills nothing, dropping the prefix kills four cases).
 * It is kept as the cheaper half of the pair to lose: the prefix exists for humans reading
 * SQL and could reasonably be shortened or normalised one day, and if it is, the digest is
 * what keeps two rooms apart.
 *
 * So the content digest rides along. It costs nothing to compute, it is a pure function of
 * the report (the SAME body a retry re-sends, so the key is stable across the retry ladder
 * — which is the one property the whole mechanism rests on), and it separates two matches
 * that share a room id unless their accounts, places AND teams are all identical, at which
 * point the two reports are indistinguishable anyway.
 */
export function ratingReportKey(
  roomId: string,
  accountIds: readonly string[],
  places: readonly number[],
  teamIds: readonly number[],
): string {
  // JSON of a fixed-order tuple rather than a hand-rolled join: it cannot be made ambiguous
  // by an id that happens to contain the separator, and `buildRatingReportBody` fills the
  // three arrays in a deterministic seat order, so the same match always digests the same.
  const digest = createHash('sha256').update(JSON.stringify([roomId, accountIds, places, teamIds])).digest('hex');
  return `${roomId}:${digest.slice(0, 16)}`;
}

/**
 * Convert `GameState.placements` (seat indices in ELIMINATION order — worst place
 * first, see `GameState.ts`'s doc comment) into a 1-based place per seat index, then
 * into the `{accountIds, places, teamIds}` triple matchsvc's `/rating/report` expects
 * (index-aligned across all three). `placements[j]` (0-indexed) is place `N - j`,
 * where `N` = `playerCount` — the FIRST-eliminated seat is the WORST place.
 *
 * `playerCount` (the true total seat count) is a REQUIRED param, not derived from
 * `placements.length + 1` — that inference is only correct for a solo/FFA match.
 * `WinConditionSystem.tickPlacement` (engine) only ever pushes LOSING squads' seats
 * into `placements`; the winning squad's OTHER members (everyone but the single
 * `winner` seat `state.winner` names) never appear in `placements` OR `winner`, so a
 * squad win with a real playerCount would silently drop them from the ladder report
 * entirely without this param. With it, every seat sharing the winner's `teamId`
 * (`teamIdForOwner`, same formula the engine used to assign teams) is filled in as
 * tied for 1st — the "full squad-tied ranking" design/15 flagged as a follow-up.
 * A solo/FFA match (squad size 1) has the winner's team be just the winner seat
 * itself, reproducing the exact pre-squad single-winner behavior.
 *
 * `accountId` falls back to a SCAFFOLD (`seat:{roomId}:{seatIdx}`) for any seat with no
 * real account behind it — a guest, a bot, or (pre design/16-accounts.md) every seat,
 * since this project had no account/auth layer anywhere before that. `seatAccounts`
 * (optional last param) is `MatchRoom`'s per-seat real accountId map, threaded from the
 * signed ticket a logged-in player redeemed; omitting it (every pre-account caller)
 * reproduces the exact old scaffold-only behavior.
 */
export function buildRatingReportBody(
  roomId: string,
  winner: number,
  placements: readonly number[],
  playerCount: number,
  seatAccounts?: Readonly<Record<number, string>>,
): RatingReportBody {
  const n = playerCount;
  const winnerTeam = teamIdForOwner(winner, n);

  const bySeat = new Map<number, number>();
  for (let seatIdx = 0; seatIdx < n; seatIdx++) {
    if (teamIdForOwner(seatIdx, n) === winnerTeam) bySeat.set(seatIdx, 1); // whole winning squad, tied for 1st
  }
  placements.forEach((seatIdx, j) => bySeat.set(seatIdx, n - j));

  const accountIds: string[] = [];
  const places: number[] = [];
  const teamIds: number[] = [];
  for (const [seatIdx, place] of bySeat) {
    accountIds.push(seatAccounts?.[seatIdx] ?? `seat:${roomId}:${seatIdx}`);
    places.push(place);
    teamIds.push(teamIdForOwner(seatIdx, n));
  }
  return { accountIds, places, teamIds, reportKey: ratingReportKey(roomId, accountIds, places, teamIds) };
}
