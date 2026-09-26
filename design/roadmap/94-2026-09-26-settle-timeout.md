# Work log — 2026-09-26

Volume 94. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A silent seat times out after 30 seconds (2026-09-26, net + test + docs, no engine change)

A follow-up to [volume 93](93-2026-09-26-pvp-settlement-vote.md). That pass listed two gaps it
did not close, and the owner answered both the same day:

1. *"Give settlement a 30-second timeout. A player who never reports is handled as an offline
   player."* Built here.
2. *"The coordinated-majority case can be left alone: players cannot collude in practice, and even
   if they did, the logic would produce different verification results."* Recorded in design/15
   as out of scope, not as an open gap. Each client computes its hash by running the
   deterministic sim, so agreeing on a forged tuple would take identically modified clients, not
   just players agreeing on a story. That residual case is what the deferred server replay would
   catch.

The third instruction, *"set the needed environment variable on the server yourself"*, needed no
write. `BB_TICKET_SECRET` was already in the box's `.env`. `push-env.py` reported `no change --
host already matches the encrypted store`, and both `bb-gameserver` and `bb-matchsvc` hold a
64-character value. The live `ci-deploy.sh` is installed by hand (the CI key must not be able to
rewrite its own forced command), so its guard list still predated volume 93. It was re-installed
the documented way (`….sh.new` then `mv`), and the standing diff check reports `IN-SYNC`.

### What the timeout does

- **The first `result` arms it.** `MatchRoom.reportResult` arms one `SETTLE_TIMEOUT_MS` (30 s)
  timer, and later reports do not re-arm it. When every seat has reported, the room settles as
  before and clears the timer.
- **When it fires, the room settles on what it has.** `judgeSettlement` (new, in
  `settlement.ts`) runs the vote over the seats that DID report. A silent seat casts no vote, so
  it can neither block the result nor dilute it. Every seat still silent is listed in
  `MatchIntegrity.absent`.
- **The quorum rule applies to the reporters.** Three reporters out of eight must agree
  unanimously, and 2-to-1 settles nothing, exactly as a three-seat room would. A lone reporter in
  a 1v1 settles. That is the case the timeout exists for: the loser closes the tab to keep the
  result off the ladder.
- **A new verdict, `partial`,** below `dissent`: every reporter agreed, nobody was kicked, but
  some seat never reported. It rates like `dissent` does. It is recorded (the gameserver POSTs
  every non-clean PvP match) with the input log, and an absent seat is **never a suspect**. A
  dropped connection is not a cheat, so a player whose wifi dies at the end of every match does
  not climb the ops console's most-named list for it. The console shows the seat as "no report
  (offline)".
- **When everyone leaves, the room settles.** Before this, the last seat's disconnect destroyed
  the room outright, and results that had already been reported were thrown away. It now settles
  on those reports first (`MatchRoom.abandon`). The same applies when a checkpoint kick takes the
  last connection. A room nobody reported in still just goes.

### Why `Scheduler` grew two methods rather than reusing `setInterval`

A one-shot built from `setInterval` would work in production, but every test's fake scheduler
fires all its intervals on `pulse()`. Every existing test that pulses after a partial report would
then silently settle the room at the wrong moment. So `setTimeout`/`clearTimeout` are
required on the interface: the production wiring cannot quietly leave them out, and the fakes
fire them only on an explicit `expire()`. The production implementation moved out of
`index.ts` into `nodeScheduler.ts` so it could be tested against vitest's fake timers. The
test checks that the delay is honoured to the millisecond, a clear really cancels, and a timeout
fires once. Inline in `createGameserver`, the two new arrows were only reachable through a live
30-second wait.

### Tests

+35 server cases (2062 → 2097):

- `MatchRoom.timeout.test.ts` (new, 16): arming once, pulses never settling, clearing on the last
  report, the lone 1v1 reporter, disagreement among reporters, the 2-to-1-at-quorum refusal, a
  dissenter among five of eight, seat 0 silent and the end screen falling back, late reports and
  resumes refused, and the three ways a room empties.
- `settlement.test.ts` (+9): `judgeSettlement`'s verdict ranking (`bounds` > `dissent` > `partial`
  > `clean`), and the vote over reporters. The same three seats of eight settle under
  `judgeSettlement` but not under an eight-seat `voteSettlement`, so the test would fail if the
  denominator went back to the player count.
- `nodeScheduler.test.ts` (new, 3). `integrityReport`, `integrity`, and `adminsvc.integrity`:
  `absent` carried end to end, validated by the route, never counted, and rendered on the page.

`MatchRoom.ts` stays under the 500-line cap (499). The judgement moved into `settlement.ts`, and
a stale doc block that had drifted above the wrong interface went with it.
