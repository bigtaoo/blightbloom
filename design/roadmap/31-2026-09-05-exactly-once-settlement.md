# Work log — 2026-09-05: the settlement report becomes exactly-once

Volume 31. The one thing volume 29 left open, closed the next day. ROADMAP 8.1 shipped the
internal trust seam and wrote its own outstanding defect at the call site it created:
`POST /rating/report` became an **at-least-once** delivery the moment `reportSettledMatch`
got a retry budget, and `RatingStore.applyMatch` had no dedupe key, so a report that was
delivered and lost only its response added a whole match's rating deltas a second time.
[`../19-server-platform.md`](../19-server-platform.md) §3 ended with that paragraph marked
**"Open, and the first thing to do to this seam next"**. This is that.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §3, which now carries an
"Exactly-once settlement" subsection and no longer ends on an open item.

## The settlement report becomes exactly-once (2026-09-05, server, no engine bump)

### The defect was not a race

Worth stating plainly, because "idempotency" reads like insurance against something
improbable. `internalFetch` retries a 5xx, a timeout and a network error. A matchsvc that
writes the ratings and *then* fails to get the response back out — a socket reset, a proxy
timeout, a 500 thrown after the write — is not exotic; it is the ordinary shape of a
partially-completed HTTP request. Under the shipped budget of 3, one such settlement moved
every participant's rating twice or three times, in the direction they placed. Nothing logged
it, because from the gameserver's side a retry that eventually gets a 200 is a success.

That is why the budget was 3 and not 10, and the note at the call site said so.

### The shape is the one §4 already specifies for billing

Four pieces, all of them the billing pattern pointed at this seam:

| Piece | Where |
| --- | --- |
| The dedupe key, in the report body | `server/src/ladderReport.ts` — `ratingReportKey`, plus a `reportKey` field on `RatingReportBody` |
| The `UNIQUE` column that *is* the mechanism | `server/src/db.ts` — `rating_reports(report_key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)` |
| Claim-then-`changes()`, in the same transaction as the ratings | `server/src/rating.ts` — `RatingStore.applyMatchOnce` |
| What a lost claim answers | `server/src/routes/rating.ts` — 200 with `duplicate: true` |

There is no SELECT-then-INSERT anywhere on the path. The claim is
`INSERT ... ON CONFLICT DO NOTHING` followed by reading `changes()`, inside the one
`BEGIN IMMEDIATE` that also writes `ratings` — a look-before-write would be answering the
question before holding the lock that makes the answer true, which is the mistake design/19
§4's AMENDMENT 2 records for billing.

### Four things the build settled

**The rollback direction matters more than the dedupe direction.** Losing the claim and
applying anyway is the original defect: a redelivery double-credits, which is visible in the
ladder and reversible by hand. Winning the claim and *then* failing is worse — the key is
burned for a match whose deltas were never written, so that match's rating is gone
permanently and every retry is answered "already applied". Nothing logs that, and no player
can report it as anything more specific than "my rating didn't change". So the claim and the
ratings roll back together, and both directions get their own tests. The failing-write case
is forced with a real SQLite trigger (`RAISE(ABORT, ...)` before an `INSERT ON ratings`)
rather than a mocked driver, because the property under test is that the *database* aborting
the write also releases the claim tied to it; a second case then asserts the connection is
still usable, since a `ROLLBACK` that did not run leaves every later settlement broken.

**A lost claim answers 200 with `duplicate: true`, deliberately not 409.** The sender is a
retry ladder, and `internalFetch` counts every non-2xx a failure: a 409 would log
`ladder report for room X failed` naming a match whose rating actually landed, and — for the
retryable statuses — keep asking until the budget ran out. 200 is what *ends* at-least-once
delivery meeting an idempotent receiver, so the marker goes in the body, where an operator
can still tell a first landing from a redelivery. A thrown apply is the mirror decision:
**500**, because 500 is the one status that is retried and `applyMatchOnce` has already
rolled its claim back, so the retry can actually land. Without the `try/catch` the throw
escapes a `req.on('end')` handler, node answers nothing at all, and the caller waits out its
own timeout — the worst of both, since the retry it then makes is indistinguishable from a
redelivery.

**`roomId` alone would have been a correct key, and is not the one that shipped.** The prompt
asked for this to be confirmed rather than assumed, and confirming it moved the answer. A
room settles at most once — `MatchRoom.reportResult` latches `this.settled` and destroys the
room immediately after firing `onSettled` — and `matchsvc.ts` mints room ids with
`randomUUID()`. The mode does not change that: a PvE/co-op settlement travels the **same**
`onSettled` → `reportSettledMatch` path and is filtered only by that function's
`hashOk`/`placements`/`winner` guard, but the filter is per-REPORT, so whatever gets through
still gets through once per room. What breaks it is that the room id is not always ours:
`index.ts`'s legacy dev handshake (no `BB_TICKET_SECRET` configured) reads `roomId` straight
off the query string, and the room is gone once it settles — so a local `?roomId=dev` really
can host a second, genuinely different match, and a roomId-only key would swallow every
settlement after the first. The key is therefore `{roomId}:{16 hex of sha256 over the
report}`: the prefix is what an operator greps (`WHERE report_key LIKE 'the-room:%'`, since
design/19 §7 rules out an admin service), the digest is what keeps two matches apart, and it
is stable across the retry ladder because it is a pure function of the body.

**A report with NO `reportKey` is applied the old, non-deduped way — and logged.** The route
has exactly one legitimate caller, so a keyless report means version skew during a rolling
deploy. The two options are asymmetric: accept it and risk the bounded double-apply that
stood until today, or 400 it and lose those matches' ratings for good, because a 4xx is never
retried. The recoverable failure wins, and the warning names the cause an operator can act
on. This is not a hole worth closing separately — the route is internal-key gated, and anyone
who can reach it can already post whatever placements they like.

With that in place the settlement budget went **3 → 5**. What the ceiling now trades against
is in-flight requests to a struggling peer, not a rating multiplier, and `SETTLEMENT_RETRY`
is exported so the give-up test asserts against the real budget rather than a copy of the
number.

### Tests

**+45 cases** across four files — three grown, one new. The server suite reads **720** at
this commit (675 + 45); the shared working tree read 793, because two co-resident sessions
were landing billing and sim work in it throughout this pass — which is also why every number
here was re-measured in an isolated worktree checked out at the commit itself rather than
taken from that tree. Four of the five changed source files read **100% lines and 100%
branches** — `db.ts`, `rating.ts`, `ladderReport.ts` and `routes/rating.ts`. `index.ts` is
unchanged at 97.72/90.14, its one uncovered line the pre-existing
`import.meta.url === process.argv[1]` auto-start guard. Server-wide, 99.48% lines / 97.00%
branches.

- `test/rating.test.ts` — the claim on all three backends (in-memory, `:memory:`, and a
  real file, because `:memory:` gives each connection a *private* database and a
  cross-connection dedupe test over it would pass for the wrong reason), the two rollback
  directions on both backends, and a peer holding the write lock (`BEGIN IMMEDIATE` throwing
  with no transaction open, which is why it sits outside the `try`).
- `test/ratingReportOnce.test.ts` (18, new) — the route, in two layers: real HTTP through
  `createMatchsvcServer` for the same settlement posted twice, two posts in flight at once,
  and a second match in the same room; the handler directly for the 500, the audit lines and
  the keyless fallback.
- `test/ladderReport.test.ts` — the key's two properties, which pull in opposite
  directions: STABLE (or the retry claims a fresh row and the mechanism does nothing) and
  DISTINCT (or a settlement's rating is silently dropped).
- `test/index.lifecycle.test.ts` (+3, 1 rewritten) — that the gameserver sends the **same**
  key on every attempt of one settlement, that a duplicate answer is not logged as a failure,
  and the give-up point against `SETTLEMENT_RETRY.attempts`.

**Mutation battery: 26 real mutants, 24 killed, both controls survived.** Three survivors,
all judged and recorded in the code rather than papered over:

- `ROLLBACK` → `COMMIT` on the lost-claim branch is genuinely indistinguishable — nothing was
  written in that transaction — so no test pretends to tell them apart.
- `BEGIN IMMEDIATE` → a deferred `BEGIN` changes nothing *today*, because the claim is the
  transaction's first statement and it is a write, so the write lock is taken at the same
  instant either way. `IMMEDIATE` stays because the equivalence ends the moment a read is
  added ahead of the claim — which is exactly design/19 §4 AMENDMENT 2's mistake.
- Dropping `roomId` from the digest kills nothing, because the `${roomId}:` prefix already
  separates two rooms (dropping the *prefix* kills four cases). The redundancy is kept as the
  cheaper half of the pair to lose: the prefix exists for humans reading SQL and could
  reasonably be shortened one day.

The battery also found one real gap coverage could not: the `reportKey` length bound had no
boundary case, so `>` → `>=` survived — a key one character short of the limit would have
been refused with a 4xx that is never retried. A test for a key of exactly the maximum length
closes it.

### Left alone, and worth naming

`MatchRoom.reportResult` takes `placements` from the **client's** `result` message, and
`reportSettledMatch`'s PvP filter is `hashOk && placements && typeof winner === 'number'`.
So the gate that keeps PvE/co-op settlements off the ladder is fed by client-supplied data:
seats in a co-op room that all report the same hash and a fabricated `placements` array would
produce a ladder report for a match nobody competed in. That is a separate trust question
from this pass's (and does not affect key uniqueness — one room still settles once), so it
is recorded here rather than changed.
