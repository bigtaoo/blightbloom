# Work log — 2026-09-17

Volume 72. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The dead door opens, and the empty queue stops being a waiting room (2026-09-17, server + docs, no engine change)

[Volume 70](70-2026-09-17-home-and-login-design.md)'s audit of the lobby ended on three findings
and called all three design questions. Two of them were not: they were a `mode` check and a
number. This pass closes both, and the third — *should a route you cannot walk carry the same
visual weight as one you can* — is answered by them rather than by anything on the screen.

**No client code changed.** Nothing in the lobby's styling changed either, and that is the
result, not an omission.

### CO-OP was one boolean away from working, past content that already existed

`Matchmaker.poll`'s practice-bot backfill was gated on `waiter.mode === 'pvp'`. A co-op queue's
only exit was therefore `queueTtlMs`: a solo player tapped CO-OP, watched a matchmaking screen
for the timeout, and was told the request expired. Not a refusal anybody wrote — the arm simply
was not built for the other mode, and PvP was the only one that had ever needed it.

What makes that worth fixing rather than designing around is that **the ally already exists**.
`AllyController` has driven the second seat behind the local `?coop=1` toggle since ROADMAP 3.1
— engage the nearest enemy, regroup on the leader when the floor is quiet, all from the engine's
fp state. The bot the co-op queue needed was not a new opponent AI; it was the one the game
ships, given a socket.

So the arm is gated on the wait alone now, and the mode selects only the **delay**:

```
if (waited >= this.botFillMs[waiter.mode]()) this.formWithBots(playerCount, mode, queueId);
```

`botFillMs` is a `Record<MatchMode, () => number>`, which is also what makes a third mode a
compile error here rather than a queue that silently never fills.

**The seat count was not a decision.** Co-op is a 2-seat match everywhere the lobby can produce
one (`onlineConnect.ts` sends `playerCount: 2` for every non-PvP route), so PvP's existing rule
— fill every seat the real waiters did not take — is exactly one ally, and a co-op-specific cap
would have been a rule with no input to act on. It generalises anyway: a 4-seat co-op shape
bot-fills three, and a test says so, because `enqueue` accepts the shape whether or not a button
produces it.

### The bot had to learn which game it was in

Two things a bot decides from its room, and before this pass it decided neither — it assumed PvP
for both, correctly, for exactly as long as PvP was the only mode it could land in.

**The EngineConfig is the one that fails silently.** `runBotClient` built
`buildPvpEngineConfig(seed, playerCount)` unconditionally. Dropped into a co-op room that is a
bot simulating the ARENA while every human in the room simulates the dungeon — same confirmed
frames, divergent state from frame one, and nothing anywhere saying so until the end-of-match
hashes disagree. It now passes `buildOnlineConfig` straight through as `CoopSession`'s
`buildConfig`, which is the same function `onlineConnect.ts` hands a browser tab, reading the
same `match_start` the same gameserver sent. Byte-identical by construction rather than by two
call sites agreeing (design/06 anti-drift) — and shorter than what it replaced.

**The brain is the one that fails loudly.** `PvpBotController` fires at the nearest living player
on a *different* team, and a co-op seat has no such thing: the co-op branch of `buildOnlineConfig`
sets no `teamId`, so `GameState.buildSeat` gives every seat the shared default 0. Its candidate
list is empty on every tick of every co-op match, so the old brain's only possible output there
is `idleCommand` — a partner who stands at the door for the whole run. `brainFor(mode)` picks
`AllyController` instead, reading the mode from `match_start`, never from the caller. The
fallback for an absent mode is `'coop'`, matching the protocol's own default.

`matchsvc`'s `onBotFill` block needed no branch at all, which is the shape worth keeping: the
ticket a co-op ally gets is the same grant a PvP practice bot's is, and everything mode-specific
is read off the `match_start` the gameserver sends. Nothing minted in matchsvc can disagree with
the real clients in the room, because nothing minted there says anything about the game.

### Thirty seconds was a matchmaking window over a queue that does not exist

`match.pvpBotBackfillDelayMs` shipped at 30 s. That is a sensible window when there are people to
window over; with nobody else waiting it is thirty seconds of spelling out "nobody is here" at
greater length. It is 5 s now, and `match.coopBotBackfillDelayMs` is new beside it at the same
value.

**Two names, not one shared "bot backfill delay".** A PvP bot is a lesser opponent and a co-op
ally is not — it is the partner the mode is about. A deployment that grows a population will want
to wait for a human in one mode and not in the other, and a single value would make raising the
PvP window raise CO-OP's too. Both are flags (design/21 §4) precisely because the right number is
a fact about the player population, which changes without a deploy; five seconds is the answer
for today's, and raising it is one console edit the day that stops being true.

The rejected alternative was "fill immediately when the queue is empty, wait when somebody is in
it". It reads better than it behaves: at a 500 ms client poll cadence it makes the *first* of two
players to arrive unmatched-with-the-second by construction, converting a slow human queue into
an always-bots one whenever two people do not arrive inside one poll. A 0 in the flag already
expresses it for anyone who wants it; the delay is one concept and stays one.

### The reap rule had to be rewritten, not deleted

`liveQueue` dropped still-waiting entries past `queueTtlMs`, skipping PvP — `mode !== 'pvp'` —
because sweeping by age races `formWithBots` into dropping the very waiter whose own `poll` just
triggered it (both defaulted to the identical 30 s). With both modes bot-filling, that shape
generalises to "never reap anything by age", and the thing it was protecting is not the mode:

```
if (id !== keepId && now - w.enqueuedAt > this.queueTtlMs()) { … }
```

`keepId` is the one waiter a call must not reap — the one forming a room right now. Everything
else past the TTL is an **abandoned** entry: a client that closed the tab and stopped polling,
which left in place gets seated into a stranger's room that then never starts, because nobody is
coming to sit in that seat. PvP was never age-reaped at all before this pass, so this is a fix it
gets for free.

**A consequence worth stating plainly: in the shipped configuration nothing expires any more.**
`poll` checks the backfill before the expiry and both delays are far below the timeout, so
`queueTtlMs` is now the rule that decides only where an operator has put a backfill delay above
it. That branch stays reachable, and a test holds it there, because "give up after N" is still
what the flag means.

### Verification

The feature is four behaviours across three layers, so it was mutation-tested rather than
asserted at: eleven mutants, **eleven killed**, baseline green before and after (the two runs
that catch a harness faking ALL-KILLED and ALL-SURVIVED).

Two of them are the reason this section exists at all, because both survived the first round of
tests that looked complete:

- **"The co-op bot fires at something" does not prove it built the right config.** The intended
  reasoning was that an arena has no PvE enemies, so an ally wrongly placed in one could never
  fire. Measured: the launch arena spawns three of its own, alive by tick 600. A wrongly
  configured bot is a perfectly busy bot. The assertion is now the determinism claim itself — the
  bot's `hashState` against a reference `CoopSession` built the way a browser tab builds one and
  driven off the same room — which required `runBotClient` to return its session.
- **Watching a live bot cannot tell the two brains apart at all.** `NetInputSource` relays a
  command only when it CHANGED (design/15 sparse input sync), so a brain holding its output puts
  nothing on the wire and there is no tick-aligned stream to diff. And in a 2-seat arena both
  seats spawn together, inside `KEEP_DIST_FP` of each other *and* of the arena's own spawns, so
  both brains hold and fire and emit byte-identical commands for hundreds of ticks — gap 438 fp
  at tick 400 under either wiring. The choice is pinned where it is made instead: `brainFor` is
  exported and tested directly, over a fixture built to make the two disagree, against both
  controllers by identity rather than merely against each other.

The three flag-value mutants (each default moved back to 30 s) all survived the first round too —
nothing asserted the numbers, which for a pass whose entire second half *is* a number is a gap
worth naming. `flags.defs.test.ts` pins both delays with the reason written beside them, and
pins them below the give-up timeout, since their order is what decides whether a lone player
meets a match or an expiry.

The HTTP-layer cases go through the **flag**, not through `MatchsvcServerOptions.matchmaker`:
an override passed straight to the matchmaker would pass just as happily if
`createMatchsvcServer` had never wired `match.coopBotBackfillDelayMs` to it, which is the one
line those tests exist for.

Server suite 1837 green, repo `check` green (minus a worktree-only artifact: a fresh checkout
gets `tools/png-pipeline/*.test.mjs` with CRLF line endings, which those two files do not parse
under — they pass in the shared checkout and nothing in this pass touches them). Coverage
97.71/93.24 client, 97.71/93.77 engine, **98.61/97.66 server**, all three packages over the
90/90 gate.

### Still open

- **A queue entry is never cancelled.** Leaving the matchmaking screen sends nothing, so an
  abandoned entry lives until the TTL and can still be seated into a room that never starts. The
  age reap bounds it; a `DELETE /find/:queueId` would remove it.
- **SQUAD is the one route still conditional on another person**, and it should be — it is a
  feature that needs a friend, not a route in poor health. What design/10 now says is that the
  screen should SAY so rather than imply it by visual weight.
- **Five seconds is a guess about a population of zero.** The number to revisit is not this one;
  it is the first day two strangers are ever in the same queue.
