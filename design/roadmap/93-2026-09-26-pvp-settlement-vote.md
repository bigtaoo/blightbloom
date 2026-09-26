# Work log — 2026-09-26

Volume 93. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Settlement becomes a per-seat vote, and a match that does not settle cleanly is recorded (2026-09-26, net + test + docs, no engine change)

*"PvP: seed verification only for now, like funny's. No server replay yet."* That is step 1 of the
plan [volume 92](92-2026-09-26-backlog-resync.md) recorded, and the decision itself lives in
design/15's Open questions. This pass built it. What shipped is in design/15, "Settlement: a
per-seat vote, bounds, and a record"; this volume records what building it settled.

### What changed, against what the code did

| | Before | After |
| --- | --- | --- |
| Seed | `Date.now() & 0x7fffffff`, plus one per room | `crypto.randomInt(SEED_SPACE)` |
| No ticket secret in production | warn, fall back to the published dev secret, and accept the raw-param handshake | `ticketSecret()` throws, both servers refuse to build, compose names the variable |
| Who decides the result | every hash must match; `winner`/`placements` copied from the FIRST reporter | one vote per seat over `{hash, winner, placements}`; above the quorum a strict majority that also reaches it |
| One divergent seat of eight | voids the ladder for all eight | the other seven settle; the one is named |
| An impossible agreed result | rated | refused by `checkPvpBounds` |
| A checkpoint kick | a reconnect, forgotten at settlement | in the record, even if the seat came back and voted with the majority |
| Anything flagged | a `console` line at most | `POST /integrity/report` → `integrityReports` + a per-account `suspicion` count → the ops console's Integrity tab |

### Four things the build settled

- **The duration floor was measured, not picked.** "Match length is plausible" needed a number.
  A temporary `minTicks` column on `pvpBalanceSim` (180 bot matches, 2–8 seats) gave a fastest
  finish of frame 954; the floor is 450, half of it. The frame compared is the server's broadcast
  frame when the last report lands, which can only trail the clients' end tick, so lag never cuts
  a real short match. Bots may be slower than an aggressive human squad, which is why the margin
  is a factor of two and not a few percent.
- **The winner is checked as the squad's representative, not just as "a seat".**
  `WinConditionSystem.tickPlacement` always names the winning squad's lowest seat and removes the
  whole squad from `placements`. So in an 8-seat match "winner in range" alone would accept seat 1
  naming itself winner over a placement list that still reads like seat 0's squad won. The check is
  that `winner` is the lowest seat of its team and `placements` is exactly the other team's seats.
- **No consensus names nobody.** When no tuple carries the vote there is no settled answer to
  dissent from, and naming all eight seats would put an honest player's suspicion count up for
  sitting in a match with a cheater. A `no_consensus` record keeps the log and the seat map,
  counts against no one, and rates nothing.
- **Production now requires the secret in three places, on purpose.** `ticketSecret()` throws;
  compose declares `${BB_TICKET_SECRET:?}` on gameserver and matchsvc; `ci-deploy.sh` checks it by
  name. The first is the rule. The other two decide how a missing value fails: a named deploy
  error instead of two containers in a restart loop. `deploy.manifests.test.ts` already required
  the `:?` set and the deploy script's list to match, so adding the variable to one without the
  other would have been red. The production secrets file (`D:\secrets`, `blightbloom/prod.yaml`)
  was checked to carry the key before this changed.

### What it does not close

- **A seat that never reports still holds the room open.** Settlement waits for every seat, as it
  always has. A withheld report now blocks a vote instead of a hash comparison, and nothing times
  it out.
- **A coordinated majority wins the vote.** That is the limit of any consensus without a
  server-side simulation. The seed, `engineVersion` and gzipped input log archived with each
  record are for the replay judge that would close it, and which the owner has deferred.
- **Clean matches archive nothing.** Only a non-clean PvP match carries its log, so a replay
  cannot later be run against an ordinary match for comparison. Deliberate: a clean match has
  nothing to judge, and every match carrying its log is a payload nobody reads.

### Tests

Seven new test files, 107 new cases:

- `settlement.test.ts`: the quorum edge, the strict-majority edge, a tie, a plurality that is not
  a majority, and each bounds failure one field away from a passing case, squads included.
- `MatchRoom.integrity.test.ts`: the room feeds the vote its own frame, mode and kicks. A lying
  first reporter no longer decides the placements.
- `integrityReport.test.ts`, `integrity.test.ts`, `index.integrity.test.ts`,
  `adminsvc.integrity.test.ts`: the report body, the store on both backends (exactly-once
  included, with two deliveries in flight at once), the route, the sender, and the console tab.
- Existing files gained the production refusal, the seed-is-not-a-counter check, the fifth tab,
  and the compose secret rule.

Server suite: 1,955 → 2,062 cases, all passing. New files are at 100% lines, and the server
tree at 98.51% lines / 97.88% branches. `matchsvc.ts`'s 69.7% lines is its untested `main()`, as
before this pass. Root `npm run check` goes green except the known worktree-only failure: CRLF
`#!` lines in `tools/png-pipeline` and `build/*.mjs` fail to parse in a worktree checkout. It is
re-run on the daily branch after the merge.
