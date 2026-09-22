# Work log — 2026-09-22

Volume 88. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Every route that was unbounded, in one pass (2026-09-22, net + ui + test + i18n + docs, no engine change)

> *"把 /party/create 也加上限流  你把类似的问题一次性解决"*
> (add rate limiting to `/party/create` too — and solve the similar problems all at once)

[Volume 87](87-2026-09-22-party-join-rate-limit.md), earlier the same day, gave `/party/join` a
per-IP budget and left `/party/create` deliberately unbounded, with a test asserting the absence
and this reason beside it: *minting a code is not guessing one, and a collision is already a
non-event*. Both halves of that are still true. Both are about **discovery** — whether a caller
can reach a party that is not theirs. Nothing in that pass asked what a caller can do to the
**supply**, and the answer was: everything.

Asking the supply question of every other route is what made this a sweep rather than a second
one-route fix.

### What actually had a ceiling, before this

Three budgets, on two surfaces: `/client-log` + `/client-events` (shared, 20/min, 2026-09-09) and
`/auth/register` (30 per ten minutes, 2026-09-17), plus `/party/join` from volume 87. Everything
else this process serves was unbounded — including six routes that each mint state or spend real
CPU for a caller who has proved nothing:

| route | what one unbounded caller gets |
| --- | --- |
| `POST /party/create` | a party per call, holding one of 10^6 codes and a `Map` entry for ten idle minutes |
| `POST /auth/login` | a full scrypt hash per call against any account that exists, and a timing oracle for the ones that do not |
| `POST /auth/portal` | an RS256 verification per call, and an account minted on first sight — the one registration path `REGISTER_RATE_LIMIT` never watched |
| `POST /auth/change-password` | two scrypt hashes, the most expensive single request in the process |
| `POST /find` | a queue entry that, with enough of the same shape, **forms a room on a real gameserver** |
| `POST /store/order` | an order row and payment parameters in another service's database |

### The supply argument, for the route that was asked about

`CREATE_RATE_LIMIT` is **60 per ten minutes per address**, and the number is derived twice over.

The resource is not "codes drawn" but *codes held at once*, so the steady state of an unbounded
caller is its request rate times the party TTL: at 50 requests a second, thirty thousand live
parties ten minutes in; at a few hundred a second the keyspace itself starts to fill, which is
`PartyService`'s `CODE_DRAW_ATTEMPTS` throwing `CodeSpaceExhausted` — a 503 on the create button,
for everybody, from one address.

Because the budget window is exactly the ten-minute party TTL, **the budget is that steady
state**: sixty per ten minutes means at most sixty live parties per address. That is the bound
worth stating, and it is the reason not to widen the window instead of the count.

It is also a claim about two constants AGREEING, which prose cannot hold — the window and the TTL
were two independent `10 * 60_000` literals in two files. So `PartyService`'s `DEFAULT_TTL_MS` is
exported now for exactly one reader, and the budget's test asserts
`CREATE_RATE_LIMIT.windowMs === DEFAULT_TTL_MS` rather than restating the literal a third time. A
test that restates a literal agrees with itself while the doc comment quietly stops being true;
that is the defect [volume 82](82-2026-09-21-numeric-room-code.md) paid for with the room-code
shape living in two places.

Half of `/party/join`'s 120 rather than equal to it: a squad has one creator and up to three
joiners, so legitimate creates run at roughly a third of legitimate joins, and half leaves the two
the same headroom over what real traffic does. The false positive is the same shape as the join
one — a player who cannot get a squad together, having done nothing wrong, possibly behind a
carrier-grade NAT with a city on it — which is why neither number is tight.

### The other five numbers, each an argument about its own traffic

| route | budget | what it is an argument about |
| --- | --- | --- |
| `/auth/login` | 60 / 10 min | the three things a per-username lockout cannot see (below) — twice register's thirty because logging in is the more frequent legitimate act |
| `/auth/portal` | 120 / 10 min | the loosest here, because **no human decides to spend it**: the client calls it at boot, once per page load, and a refusal is silent (`portalAuth.ts` treats every throw as "stay a guest"). An invisible false positive is an argument for headroom |
| `/auth/change-password` | 20 / 10 min | the tightest, because it is the only one whose false positive hits a player who is already logged in and already playing — and the only route that pays two scrypt hashes |
| `/find` | 120 / 10 min | an arrival RATE, since a waiter TTLs out after thirty seconds; twelve a minute against a legitimate one-per-attempt-then-go-and-play |
| `/store/order` | 30 / 10 min | `REGISTER_RATE_LIMIT`'s number, deliberately: both bound a write into a database that is not this process's |

**`/auth/login` deserves its own paragraph, because this file previously argued the opposite.**
`matchsvc.registerLimit.http.test.ts`'s header said login "was never in the same position: it
already refuses after five failures per username, and a login against a name that does not exist
never reaches the hash at all". Both halves are true and the conclusion was wrong, so the sentence
is quoted in that header rather than deleted. The per-username lockout is per **name** and the
attack is per **list** — one guess each against ten thousand usernames never reaches any name's
fifth failure. And "never reaches the hash" is not a saving, it is an **oracle**: it is precisely
what makes the response time answer *does this name exist*, which is how the list for the first
attack gets built. `AuthService`'s lockout is untouched and still does the job it was written for;
this covers the two attacks it was never shaped to see, plus the CPU.

### Why the list had stopped growing on its own

The structural half, and the reason five routes that wanted a budget never got one. Each of the
three existing limiters had been wired by hand, and each arrival cost four places: an option on
`MatchsvcServerOptions`, a field on the shared `deps` bundle, a field on the route group's own
`*RouteDeps`, and a paragraph explaining that it is not one of the others. The assembly had grown
a running commentary to match — *a `limiter`*, then *"a SECOND limiter, with its own budget"*,
then *"a THIRD, for `/party/join`"*. A per-route tax on the cheapest thing this server has.

So the set is declared once (`server/src/routes/limits.ts`) and a route that wants a budget names
a key. What that must not cost is the two properties the hand-wiring had:

- **Separate counters.** Every key is its own `RateLimiter`. One shared counter would make each
  route's ceiling depend on how busy the others are — a chatty client's log batches spending the
  budget a player's join needs — and would make every number above unarguable.
- **Narrow reach.** `BudgetDeps<K>` hands a handler a `Pick` of the single key it spends, so
  `/party/leave` still cannot see a limiter and `postJoin` cannot spend `/find`'s. The
  intersection `matchsvcDispatch.ts` derives from the handlers reassembles the whole set at the
  one place that builds it — which is also the one place a missing wire fails to compile.

`spendBudget(limiter, req, res, now, message)` is the other half: one helper, spent before the
body is read on all nine routes, sending the 429 itself so a handler's budget line cannot
accidentally fall through. `createLimiters` moved to its own file (`limitsTable.ts`) rather than
push `matchsvc.ts` past CLAUDE.md's 500 lines — it imports the route modules for their constants,
which is why it cannot live in `routes/limits.ts` that those modules import back.

### What is left unbudgeted, and asserted rather than assumed

`GET /find/:queueId` is the clearest case in this server for leaving a route alone: the real
client polls it every 500 ms for up to ninety seconds — around 180 requests per attempt, per
player — so any ceiling low enough to inconvenience an attacker refuses the four players in one
living room first. It writes nothing and needs a `queueId` no caller can guess. `GET /store/skus`,
`GET /store/order/:id`, `GET /party/:id`, `/party/leave`, `/party/start`, `/auth/logout`,
`/auth/me`, `/rating/*` and the public flag readout are unbudgeted too, each for a version of the
same reason: a read, or a write that needs an id the caller already holds.

Two of those absences are pinned by tests, because an absence is what no suite asserts by
accident — twenty polls served on an address whose `POST /find` budget is spent, and a
`GET /store/skus` that still answers **401** rather than 429 on an address whose order budget is
gone. Adding a limiter to either would break nothing else in this tree.

### Two things found on the way

**`clientKey` threw on a request with no socket.** Its own doc comment promised a fallback "to a
constant when even that is absent"; `req.socket.remoteAddress` on a socket-less request raises a
`TypeError` instead, which is the opposite of a refusal — it hands the request to the error
boundary as a 500. So the one request shape nobody had considered would have been the shape no
budget could bound. Node nulls `socket` once a connection is destroyed, which is an aborted
request still in flight. Now `req.socket?.remoteAddress`, with the case that names why.

**The client would have shown the server's English prose.** `LoginScreen` renders
`(e as Error).message` for every failure, which is right and stays: only the server knows whether
the username was taken or the password too short, and a client that localised those would have to
branch on prose. A 429 is the exception in both directions — its message names no action the
player can take, and it would arrive in English on a screen the player has in one of eight
languages. `net/auth.ts` now throws an `AuthRequestError` carrying the **status** (the same shape
`PartyRequestError` took in volume 87, for the same reason: prose is the server's and a reword
must not be a client release), and `LoginScreen.failureText` swaps in one localised string for a
429 and nothing else. `PartyScreen.doCreate` gets the same carve-out `doJoin` already had.

**And the screen that would have argued with itself hardest was the matchmaking one.** A 429 from
`/find` fell through `Matchmaking.classifyError` to `matchmaking.errorGeneric` — *"Could not
connect — try again"* — on a screen whose error state ends in a **RETRY button**. That is the
volume 87 defect exactly: a rate limit whose message points at the one action that spends more of
an exhausted budget. `net/matchmaking.ts` throws a `MatchRequestError` with the status (only the
POST does; the poll is deliberately unbudgeted, so a status on its failures would be a field
nothing could read), and the 429 arm is checked FIRST and on the status. The other three arms
still read a message, which is tolerable only because those strings are the CLIENT's own —
`connectOnlineSession` writes "timed out", the cancel path writes "cancelled" — and that
distinction is now written above the function. `/store/order`'s 429 is left on the generic
"order failed" wording: 30 in ten minutes is a rate no human reaches, and a purchase retry is not
the attack the budget is for.

### The two mutants that survived, and the file written for them

The HTTP suite could not see the WIRING. Both of these passed every rate-limit test in the tree:

- `partyJoin: limiterFor(CREATE_RATE_LIMIT)` — a key handed the wrong constant, so `/party/join`
  quietly means 60 instead of the 120 its doc comment argues.
- `partyCreate` and `partyJoin` handed the **same instance** — the one-character version of the
  mistake `routes/limits.ts` spends a paragraph forbidding.

Neither is visible over HTTP for a reason worth keeping: the file that would notice has *overridden
that very key* to something it can exhaust, so the mutant's damage lands on the key the test is not
looking at. `server/test/limits.test.ts` reads each limiter's **capacity** back out instead — `take`
with a frozen clock never elapses the window, so counting the `true`s is the limit — and compares
it against a key-to-constant map written out a second time. Both mutants now die there.

### The battery

Eighteen mutants across fifteen rows (four rows are a branch forced BOTH ways), each killed by
the case written for it. The last five are from a second pass, asked for directly — *“有测试可以加吗”* — and the first four of those were **run before
the tests existed and survived**, which is what made them worth writing:

| mutant | killed by |
| --- | --- |
| `/party/create` budget removed | 4 of the create cases |
| 429 sent, but the work happens anyway (no early `return`) | 2 — "does no work when it refuses", and the window case |
| a FROZEN clock, so the window never elapses | 1 — the window case, alone |
| `spendBudget` touches the response on the ALLOWED path | 8 |
| `Matchmaking.classifyError`: no throttle arm / throttle for every `MatchRequestError` | 1 / 1 |
| spent inside `readJson`, before validation | 1 — the stalled-body case, alone |
| spent after validation | 2 — the stalled-body case and "the 400 is spent too" |
| `partyJoin` built from `CREATE_RATE_LIMIT` | 1 — the capacity map |
| create and join share one instance | 2 — the capacity map and the nine-instances case |
| only SUCCESSFUL logins charged | 4 — both "is charged" cases, the counter-separation case, the ordering case |
| `/store/order` charged after the session check | 3 |
| `spendBudget` never refuses | 37 |
| `clientKey` loses its socket guard | 13 |
| `PartyScreen.doCreate`: never throttled / always throttled | 1 / 3 |
| `LoginScreen.failureText`: no branch / throttle for every `AuthRequestError` | 2 / 1 |

Both client branches were mutated **both ways**, which matters more than it looks: forcing
`throttled` false kills only the new case, and forcing it true kills three — including a
pre-existing i18n case — so each branch is pinned from both sides rather than merely proven
reachable.

### The three questions the first pass had not asked

Three mutants survived the whole suite as it stood after the sweep, and each names a property
that every "serves then refuses" case in this tree is blind to:

- **A 429 on the wire says nothing about whether the work behind it ran.** Dropping the `return`
  after a spent budget still answers 429 — the first `writeHead` wins on a real response — while
  minting the party, queueing the player or booking the order anyway.
- **A budget that never recovers** refuses a player forever after one bad minute. A handler frozen
  at `nowMs: () => 0` is indistinguishable from a correct one unless a test owns the clock, and
  the injected `nowMs` these six routes take had nothing exercising it at all.
- **`spendBudget` writing to the response on the ALLOWED path** leaves every test green, because
  each route then writes its own answer over the top; only a real `ServerResponse` in production
  notices that the headers had already been sent.

So the stalled-body table became one table of six routes × three questions — each row naming the
route, a well-formed body, and the single unit of WORK behind its budget as a spy, which is what
makes "did not happen" assertable — plus three unit cases on the helper itself. That is +15 server
cases, and all three mutants now die.

### The red coverage run, and the two things under it

The second pass's new cases passed every plain suite run and then turned `npm run coverage` red
once, two failures, with no names captured. Both mechanisms found under it are worth recording,
because neither is about rate limiting and both are about a test that fails for a reason it is
not about:

- **`/find` leaves real waiters in the matchmaker, and bot backfill is FIVE seconds** —
  `Matchmaker`'s `DEFAULT_BOT_FILL_MS`, evaluated on each POLL rather than on a timer. The
  twenty-poll case that pins `GET /find/:queueId` as unbudgeted takes milliseconds on an idle
  box; under a coverage pass, where three workspaces instrument back to back, it can take longer
  than five seconds, and then the poll forms a room with bots. The assertion that every poll
  answers `queued` becomes false, and — worse — the real `spawnBotClient` opens a WebSocket per
  bot seat to a gameserver that is not running. The fixture now passes `spawnBot: () => {}`, so
  no timing can reach the network from this file.
- **A waiter TTLs out after thirty seconds**, so a late poll can legitimately answer `expired`.
  The case is about the RATE, so it asserts `not 429` on all twenty polls and pins `queued` on
  the first one only. Asserting `queued` twenty times was measuring the machine.

What they buy is that this file stays green on a loaded box rather than by luck. Neither
failure's NAME was captured (the run was piped through `tail`), so this is the mechanism found
by reading the code rather than a confirmed diagnosis — recorded that way on purpose.

A later coverage pass went red again, once, somewhere else entirely: `client/src/game/scene/
groundGeometryBudget.test.ts` timing out at vitest's 5 s per-test default inside a file that
takes 28 s under instrumentation, and passing in 6.6 s on its own. Nothing in this pass touches
`client/src/game/scene/`. It is a pre-existing load-sensitive perf case and it is somebody's own
task, not this one's — but it is worth naming here, because `coverage` is one of the four
required PR checks and a perf test whose verdict depends on how busy the box is has already
stopped being evidence.

### Numbers

Server **1,909 → 1,954**, client **7,208 → 7,221**. `tsc --noEmit` clean in every workspace,
`check:filelength` green (`matchsvc.ts` came back to 480 lines rather than entering the baseline
at 525), `check:docpaths` and `check:roadmapindex` green. No engine change and no `ENGINE_VERSION`
bump — nothing here is inside the sim.

Docs corrected rather than appended to: `design/16-accounts.md`'s account of the login lockout no
longer says this server "has no request-IP plumbing today" (it has had some since 2026-09-09, and
now uses it on `/auth/login` itself), and its 2026-09-21 audit line — the eight routes that
"resolve no session and refuse nobody on identity grounds" — now names all three of them that
refuse on a rate. `design/15-pvp-arena.md` names the create budget beside the keyspace it defends,
and `design/19-server-platform.md` records that the store proxy's session gate bounds *who* while
`ORDER_RATE_LIMIT` bounds *how often*.

`net` `ui` `test` `i18n` `docs`
