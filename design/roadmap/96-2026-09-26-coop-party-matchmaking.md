# Work log — 2026-09-26

Volume 96. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Co-op room codes, whole-party matching and a load driver (2026-09-26, net + ui + i18n + tools + test + docs, no engine change)

Step 2 of the plan agreed after [volume 92](92-2026-09-26-backlog-resync.md), which recorded the
owner's decision on the open question in `design/05`: *"automatic matchmaking is required at
launch."* The plan read that as **both** — the public queue as it already was (two seats, an AI
ally after 5 s, [volume 72](72-2026-09-17-coop-backfill.md)) plus friends by room code — and listed
four pieces: a co-op path for the room code, a wait time and an "AI joining soon" hint on the
queue screen, a load-test script, and the design question closed.

### Co-op parties

A party was a PvP squad and nothing else: `PartyService` capped membership at `SQUAD_SIZE`, and
`PartyScreen`'s START went to the squad path. A party now carries a **mode**, fixed by whoever
created it:

- **`client/src/game/match/partyShape.ts`** (new, pure, imported by the server through
  `server/src/config.ts` like `roomCode.ts`): `COOP_SEATS = 2`, `partyCapacity(mode)` (two for a
  co-op party, `SQUAD_SIZE` for a squad) and `parsePartyMode`, which reads only `'coop'` as co-op
  so a client older than this field still gets the squad it always got.
- **`PartyService.create(playerId, mode = 'pvp')`**; `PartyInfo` gains `mode` and `capacity`, and a
  join past `partyCapacity(mode)` is refused. `/party/create` reads `mode` leniently.
- **`PartyScreen`** has a CREATE CO-OP PARTY button above CREATE PVP SQUAD (the old CREATE PARTY
  label, renamed now that it is one of two). Once in a party, the title is the mode and head-count
  — `CO-OP · 1/2`, `PVP SQUAD · 2/4` — in the title's slot rather than a line above the members,
  because a full squad's four rows already reach the START button. The portal presence's
  `joinable` reads `capacity`, so a full co-op party is no longer advertised as open.
- **`OnlineMatch.beginPartyMatch(partyId, mode)`** is the lobby's one exit: a squad goes to the
  existing `beginSquadMatch`, a co-op party queues for a two-seat co-op room with its `partyId`.
  Neither shows the PvP preview (followers auto-advance on their poll). `onlineConnect` asks for
  `COOP_SEATS` instead of a literal 2.
- **`POST /find`** looks the party up. It refuses a party queueing for the other mode (400 — a
  client bug that would seat friends in a room shaped for the other game), and passes the member
  count to the matchmaker. An unknown or expired `partyId` still degrades to a plain grouping tag.

### A party is matched whole — the bug the co-op path exposed

Members call `POST /find` one at a time, each off its own one-second party poll, so for about a
second a party is **partly queued**. `Matchmaker.pullChunk` groups a party into one squad chunk, but
a co-op room's squad size is 1, so the first member to arrive was paired with any stranger already
waiting, and the second member went to another room. PvP squads had the smaller version of the
same race: two of four members queued plus six strangers formed a room without the other two.

The fix is a `groupSize` on each waiter (the party's member count, from the route's lookup) and one
rule, `Matchmaker.partyPresent`: **a party member is seated only once every member is live in the
queue.** `formIfReady` filters on it. `formWithBots` filters on it too, with one exception: a
partly-queued party's member whose OWN wait has passed the backfill delay is eligible, because that
friend is not coming. That makes three outcomes, each pinned in `Matchmaker.test.ts`:

- a stranger's backfill does not sweep up a party whose second member is one poll away;
- a friendless member pairs with a waiting stranger once it ages in, with no bot minted;
- with nobody else there, it plays with an ally.

The first version of `formWithBots` bailed out on the UNFILTERED count ("the live queue already
holds a room's worth") and left exactly that stranger with no room at all — one of the new tests
caught it before anything shipped.

### The queue screen: a countdown, and a clock that never ran

`Matchmaker` now reports `botFillInMs` — time to its backfill point — on a queued `POST /find` and
on every queued poll. `findMatch` hands it to a new `onQueued` callback, threaded through
`connectOnlineSession`, `OnlineMatch.connect`, `ScreenNav` and the `MatchmakingConnect` type. The
Matchmaking screen shows a second line: *"AI players fill empty seats in 4s"*, then *"Filling
empty seats with AI players…"*. It re-syncs on each poll and ticks down locally between them, so
an operator who changes the backfill flag moves it too. A server without the field shows no line.

Checking it in the browser found an older bug: **nothing ever called `Matchmaking.update`.**
`GameLoop` drove `partyScreen.update` and nothing else, so *"0s elapsed"* sat at 0 s for as long
as any queue lasted, since the screen shipped on 2026-08-03. The single `partyScreen` dependency
became `lobbyScreens: [partyScreen, matchmaking]` (which also kept `GameLoop.ts` at 500 lines), and
`GameLoop.test.ts` pins that the matchmaking screen is driven.

Five new strings (`party.createCoop`, `party.headerCoop`, `party.headerSquad`,
`matchmaking.botSoon`, `matchmaking.botNow`) and the renamed `party.create` are in all eight
locales. `labelFit.test.ts` counts the new button and fits every label.

### The load driver

`server/scripts/matchLoad.ts` plays dozens of clients — solo co-op, solo PvP, co-op parties, PvP
squads — through the real HTTP calls, each party arriving in pieces as real members do. It checks
answers rather than timings: every seat matched, no chair double-seated, no room over-filled, no
party split across rooms or squad across teams. Each client sends its own `X-Forwarded-For`
(the hop `rateLimit.clientKey` reads) unless `sharedIp` puts them behind one NAT.
`npm run loadtest:match -w server -- --url …` is the CLI for a local or staging matchsvc — never
production, since every room it forms and every bot it fills is real.

`server/test/matchLoad.test.ts` runs it on every CI run against an in-process matchsvc with the
**production** per-IP limiters (only the backfill wait is shortened to 150 ms):

- **49 mixed clients from their own addresses**: all 49 matched, six co-op parties in six rooms,
  nothing refused. Stable over repeated runs, about 4 s.
- **130 co-op clients behind one address**: exactly 120 matched and 10 refused with a 429 —
  `FIND_RATE_LIMIT` is 120 queue entries per address per ten minutes.
- **64 co-op parties behind one address**: `CREATE_RATE_LIMIT` (60 per ten minutes) bites first —
  four parties refused at the lobby, sixty seated.

So the budgets do not touch players on their own addresses. They only matter behind a shared
address that queues more than 120 times, or creates more than 60 parties, in ten minutes. That is
far beyond a launch-sized population, and the numbers are now asserted, so a change to either
budget changes a test.

### Numbers

- Server: +22 cases (2097 → 2119, green). They cover `Matchmaker` (whole parties, the
  countdown), `PartyService` (mode and cap), `/find` and `/party/*` over HTTP (the
  stranger-between-friends case, the mode refusal) and the load driver with its invariant checker.
- Client: +19 cases (7442 → 7461, green): `PartyScreen`, the Matchmaking countdown, `findMatch`,
  `onlineConnect`, `OnlineMatch` and `partyShape`, plus a new assertion in `GameLoop`.
- `tsc --noEmit` is clean in both.

### Still open

- The countdown is exact only for the waiter's own backfill; a party member's room can form
  earlier (its partner arrived) or, with a stranger aging in, without the bot the line promised.
  Either way the room forms no later than the line says.
- A real multi-host load run against staging has not been done; the in-process test measures the
  control plane, which is where a queue can strand someone, not gameserver capacity.
