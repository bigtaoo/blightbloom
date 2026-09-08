# Work log — 2026-09-05: the gameserver's address becomes a lookup

Volume 34. ROADMAP 8.6, the last item in Phase 8, and by some distance the smallest — the work is
one indirection, and the value is entirely in which indirection it is.

Landed the same day as [volume 31](31-2026-09-05-exactly-once-settlement.md),
[volume 32](32-2026-09-05-delivery-outbox.md) and [volume 33](33-2026-09-05-ladder-mode-gate.md),
all in Phase 8 and none of them touching this one: those three are the money and ladder planes, this
is topology.

Indexed from [`../ROADMAP.md`](../ROADMAP.md). Design account in
[`../19-server-platform.md`](../19-server-platform.md) §6.

## The gameserver's address becomes a lookup (2026-09-05, server only, no engine bump)

### What was there

`matchsvc.ts` held a module constant:

```ts
const GAMESERVER_URL = process.env.BB_GAMESERVER_URL ?? 'ws://localhost:8787/ws';
const withUrl = (t: MatchTicket) => ({ ...t, wsUrl: GAMESERVER_URL });
```

and stamped it onto every issued ticket. The client half was already in place and needed no change:
`MatchInfo.wsUrl` exists, and `client/src/net/matchmaking.ts` / `reconnect.ts` have been opening
`${wsUrl}?ticket=${token}` since ROADMAP 3.3. So the *shape* of "the control plane tells you where
the data plane is" was already right; what was missing is that the answer could not vary.

That is defensible today — the gameserver's rooms are in-process `Map`s driven by in-process
intervals (`RoomManager.ts`), so there can be exactly one instance. The problem design/19 §6 names
is that this was an **accident rather than a decision**, and the cheap moment to make it a decision
is before anything depends on `/find`'s response format.

### What shipped

`server/src/GameRegistry.ts` (new, 218 lines) and the two lines of `matchsvc.ts` that consult it.
`register`/`heartbeat` exist as methods and have **no HTTP route**, exactly as §6 specifies: a
single-instance deployment does not register at all, and a configured static address supplies the
one entry. The static branch is the only one a real deployment can reach today.

`ticket.ts` is untouched, which is the point. The chosen URL travels in `/find`'s **response**; the
signed payload stays `{roomId, owner, seed, playerCount, teamId, mode, exp}` and never learns the
topology. §6 records this as superseding an earlier "put a gameserver id inside the ticket" sketch,
and the reason it matters is visible in one of the tests: a seat granted while instance `a` was
serving resumes against instance `b` after a failover, because the grant never mentioned `a`.

### The three decisions worth recording

**The static address is a fallback, not an entry in the map.** §6's wording is "a configured static
address seeds one entry", and seeding it literally is wrong: nothing heartbeats a configured
address and nothing reports its load, so as a map entry it sits at load 0 and never goes stale, and
would therefore win every `pick()` against real instances reporting real numbers. A fallback that
outcompetes the thing it is a fallback for is not a fallback. It is held in its own field and
reached only when no registered instance qualifies — which also makes "empty registry" and "healthy
instance registered" two genuinely different code paths rather than one ranking.

**The registration rules are written into the class, not left for the next person.** §6's second
bullet — retry indefinitely with capped backoff, give up immediately on a 4xx, and never
re-register from a heartbeat — is the *shape* of this class rather than a detail of a component
that does not exist yet. It is in the header comment, `REGISTER_BACKOFF_CAP_MS` is exported beside
`STALE_MS` (equal today, and deliberately two constants: one is how long the registry waits before
disbelieving an instance, the other how long an instance waits before retrying), and `heartbeat()`
returns `false` for an unknown id and **writes nothing**, so the "a heartbeat must not
re-register" half is enforced rather than described. Whoever builds the routes inherits the
reasoning instead of re-deriving it.

**`pick()` returning `null` is a real answer, and the route had to grow a refusal.** With
`fallbackUrl: null` and no registered instance it is the *only* answer. The pre-existing code typed
`withUrl` as returning `MatchTicket & { wsUrl: string }` and could not express it, so the whole of
the interesting work landed in `routes/match.ts`: `MatchRouteDeps.withUrl` became
`pickGameserver: () => { wsUrl: string } | null`, and all three routes answer **503
`{ error: 'no gameserver available' }`**. 503 rather than 500 because the request was well formed
and the service is fine; the client already rejects on `!res.ok || body.error`, so no client change
was needed.

### The one thing the build decided that the plan did not

**Where the availability check sits relative to the queue.** The obvious placement is where the old
`withUrl` was — decorate the ticket on the way out — and on the poll route that is a bug:
`Matchmaker.poll` **deletes the waiter** on its way to returning `matched`, so a 503 decided after
the poll destroys the seat the player has been queued for, and their next poll answers `expired`.
Both `/find` routes therefore ask the registry *first*: refusing before `poll()` leaves the waiter
queued, and the next poll — once an instance exists — matches. `POST /find` is the same argument
one step earlier, since the arrival that completes a group forms the whole room inside `enqueue`.

`onBotFill` picks once **for the room** rather than once per seat (a match's bots belong on the same
instance as its players) and mints nothing when the pick comes back empty. That guard is not dead
code behind the route's 503: the route picks, then `poll()` forms the room and calls back into
`onBotFill`, which picks *again* — and an instance can drop or go stale in between.

### Tests

40 new cases in two new files. Server suite **798 → 838** passing, measured in a worktree at this
commit rather than on the shared tree — a co-resident session was landing ROADMAP 8.5 the same day,
so the shared tree's counts and its red client typecheck belong to that work, not to this one.

- `test/GameRegistry.test.ts` (24) — the class. Aimed at the decisions above rather than at lines:
  the fallback losing to a 90%-occupied registered instance, ratio-not-absolute ranking (a 4-seat
  box at 3/4 is fuller than a 64-seat box at 10/64), full meaning skipped rather than last, the
  staleness boundary pinned to `STALE_MS` itself rather than to a repeated `30000`, an unknown id's
  heartbeat writing nothing, and an explicit `fallbackUrl: null` staying distinct from an omitted
  one (a `??` there would silently hand a fallback-free deployment `localhost`).
- `test/matchsvc.registry.test.ts` (16) — the wiring, over a real `node:http` server. The three
  things only the assembly can be wrong about: the URL coming from the registry and following it
  *between requests* (a `const url = pick()` at startup passes every other test), the signed
  payload's whole key set containing no topology, and each 503 path. Plus the two the plan's
  reasoning implies and a real registry cannot express from a test — an instance vanishing between
  the route's pick and `onBotFill`'s, and a per-seat pick scattering one room's bots — driven by a
  registry stub that answers per call and exposes its call count, so the mapping the scripting
  depends on is pinned rather than assumed.

`GameRegistry.ts` at **100% lines, branches, functions and statements**; `matchsvc.ts` 92.5/94.94 →
93.75/96.96 (its remaining gap is the pre-existing untested `main()` and auto-start guard).
`tsc --noEmit` clean for server; `check:filelength` clean.

A **26-mutant battery over three rounds killed all 26**, with three controls surviving. Two rounds
of it changed the code rather than confirming it:

- Two survivors in round one were **my own tests being fake**. "Empty registry, assert no bots" held
  whether or not `onBotFill`'s guard existed, because an empty registry means the poll is refused
  before `onBotFill` can run at all — a zero asserted with no evidence the case ever arose. And
  "all bots share one wsUrl" is unfalsifiable against a registry with one instance. Both are now
  driven by the scripted-registry stub described above.
- One survivor was **unreachable code that read like a live branch**: `isAlive`'s
  `if (e.lastSeenMs === null) return true` arm, which cannot fire because the only null-`lastSeenMs`
  entry is the static fallback and rule 1 keeps that out of the map. Fixed by making the invariant a
  TYPE — the map's value type is `RegisteredEntry`, whose `lastSeenMs` is a number — rather than a
  runtime check nothing can distinguish from a live one.

Coverage then flagged the same class of thing a third time from the other direction:
`e.capacity > 0 ? e.load / e.capacity : Infinity`'s false arm is unreachable, because
`load >= capacity` already skipped every zero-capacity instance one line above. Removed, with the
reason written where the guard was.

### Left alone

- **`register`/`heartbeat` have no routes, and no gameserver calls them.** That is 8.6 as specified,
  not an omission: the registering client is the other half, and building it now would mean building
  the retry/backoff loop for a deployment that has exactly one instance. The rules it must follow
  are in the class header so that work starts from the decision rather than from the constant.
- **`pick()` ignores `roomId`.** `/resume` picks the same way `/find` does, which is right while
  every room is on the one instance and becomes a lookup-by-room the day they are not. The comment
  at that call site says so.
- **`server/src/config.ts` was not touched.** `BB_GAMESERVER_URL`'s default moved *into*
  `GameRegistry.ts` as `staticGameserverUrl()`, read per call for the same reason `ticketSecret` is
  — a module-scope capture makes the answer depend on whether the environment was loaded before the
  first import. The registry owns the topology question now, so `config.ts` has no reason to.
- **No client change.** `MatchInfo.wsUrl` stays non-optional, which is what the 503 buys: an
  `undefined` slipping into the match object would surface not at the control plane but much later,
  as a socket opened on `undefined?ticket=…`.
