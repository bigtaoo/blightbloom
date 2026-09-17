# Work log — 2026-09-17

Volume 74. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The ladder gets a trust boundary, and the third hole closes by inverting (2026-09-17, client + server + docs, no engine change)

[Volume 73](73-2026-09-17-guest-merge-and-session-check.md) took two of `design/16`'s three holes
and left the third, on the grounds that it lives on the server's ladder path and shares nothing
with the other two but a date. That was right about the location and wrong about the hole.

Hole 3 as written: *a seat with no `accountId` is keyed `seat:{roomId}:{seatIdx}`, a new identity
per match; the guest already has a persistent id that `POST /find` receives, so this is a key
choice, not a missing capability; carrying it into the ticket is the fix.* The brief that reached
this pass asked a design question on top of it — **the guest's persistent id is client-declared,
so accepting it as a scoring key means anyone can report results under anybody's key** — and
offered two legitimate answers: give guests a rating anyway (mixed or on a separate board), or
keep guests unscored and say so on the results screen.

Both halves of the premise had to be checked before either answer could be chosen, and checking
them is what turned the pass around.

### The trace, which contradicted the diagnosis in three places

1. **The carry hole 3 asks for had already happened.** `findMatch` sent
   `accountId: opts.accountId ?? getPlayerId()` in the `/find` body; `getPlayerId()` is the
   persistent guest UUID when there is no session; `postFind` took it as
   `session?.accountId ?? bodyAccountId`; it rode the signed ticket through `resolveSeat` into
   `seat.accountId`, into `SettledMatch.seatAccounts`, into `buildRatingReportBody`. A real web
   guest's rating **did** accumulate under a stable key. `seat:{roomId}:{seatIdx}` was reached
   only by bots and by the dev raw-param handshake.

2. **And the thing making that work was the hole, in a worse form than the brief supposed.**
   `findMatch`'s fetch carried `content-type` and nothing else — **no `Authorization` header on
   `/find`, ever**, and no caller wrapped it. So `deps.auth.verifySession` had zero production
   callers, `session` was always `null`, and the scored identity was the caller's own claim on
   **every** request, for logged-in players too. `POST /find` with
   `{ playerCount: 1, accountId: "<a stranger's real id>" }`, then lose, and that stranger's
   rating moves. This is hole 2's exact shape — a verified reader with no production caller, so
   the check looked like it existed — on a different route.

3. **Nothing in this client has ever displayed a rating.** There is no caller of
   `GET /rating/:accountId` anywhere in `client/src`. So both of the brief's options, as written,
   assumed UI that does not exist: a "separate guest board" has no board, and "sign in to keep
   your ladder rating" names a number the player has never been shown.

### The answer, and why it is the one the brief's author had previously overturned

**A ladder rating is keyed only by an identity the server verified. A guest is not scored.** Three
reasons, and the first is the one that makes it not a matter of taste:

- **A guest key cannot be made unforgeable without becoming an account.** What authentication buys
  here is *non-impersonation*, not scarcity — `register` is an unverified username/password, so an
  account key is barely scarcer than a guest UUID. But non-impersonation is precisely what a rank
  needs and precisely what a declared key cannot have.
- **A guest rating could never be carried into an account afterwards.** Importing a forgeable key's
  value into an unforgeable one re-imports the forgery. It would be a number with nowhere to go —
  and volume 73's one-time guest merge, which moves `MetaState`, deliberately would not touch it.
- **Rating is the only state in this project that is not local-first.** design/16's "a guest is a
  first-class player" rests on `MetaState` being local and an account only ever mirroring it, and
  `rating.ts` is explicitly account-level bookkeeping that never enters engine state. So this does
  not make login a gate — a guest queues, plays, wins and sees the result — it makes the ladder
  the first thing an account is actually **for**.

The earlier reversal stands corrected rather than contradicted. "*Telling* the player their rating
is thrown away is not the fix" was right **given its premise**, which was that a persistent id was
sitting there needing only to be carried. (1) says it was already carried and (2) says carrying it
is what opens the hole. The fix is not "carry the id"; it is "stop accepting a declared id".

### What shipped

- `client/src/net/matchmaking.ts` — `FindMatchOptions.accountId` becomes `token`, defaulting to
  the stored session's. The header goes on only when there is one (`Bearer undefined` is a token
  matchsvc has to try and fail to verify — the same guest outcome by a noisier route), and the
  body no longer carries an identity at all. An **explicit `undefined` check**, not
  `opts.token ?? getSession()?.token`: an omitted field falls back to the session, an explicit
  empty string is a caller *saying* guest, and those are two different requests.
- `server/src/routes/match.ts` — the body's `accountId` is not read. Not "read and outranked":
  not parsed. `MatchRouteDeps.auth` stays optional and its meaning is now the safe direction —
  a deps bundle that forgot the account layer records **no** rating rather than recording it
  against whatever the caller claimed.
- `client/src/platform/hostKind.ts` — `canSignIn()`, over a `Record<HostKind, boolean>` so a
  fourth host is a compile error rather than an inherited `true`. `web` only: WeChat has no
  `SessionStore` over `wx.getStorageSync`, so `getSession()` answers `null` forever and a typed
  password would not stick; the portal signs the player in itself and forbids the ask.
- `client/src/game/controllers/RunOutcome.ts` — one translated row under the arena stat block,
  `results.guestNotRanked` in all eight locales, gated on `canSignIn()` **and** on there being no
  session. It names no number, for the reason (3) gives.

**One thing came free, and it is not small.** `session?.username` was `undefined` in production for
the same missing header, so `design/20`'s verified seat names — the platform requirement that a
roster show the player's real name — had never once been shown to anybody. Sending the token turned
them on.

### The tests, and the one that had been asserting the bug

`matchsvc.queue.http.test.ts`'s *"accepts an accountId and carries it into the signed ticket"* was
green the whole time, and it was green **about the defect**: it pinned the body fallback as
intended behaviour, with a comment explaining why a dropped `accountId` was harmless. It is
reversed now and says so in place, because a test that changes sides is worth more with its history
attached than rewritten clean.

The rest:

- `matchsvc.findIdentity.http.test.ts` — the guest block inverted. The literal is
  `'victims-real-account'`, which is the attack in one string; and a second case asserts what an
  absent `accountId` *means* by running `buildRatingReportBody` on it and reading back
  `seat:{roomId}:0`, so the scaffold is pinned as the intent rather than left as a gap. Plus one
  case asserting a guest still gets a full playable seat, which is the design's own promise.
- `matchmaking.test.ts` — the header assertions are the obvious half; the **body** assertion is the
  load-bearing one. A request that still carried `accountId` would still be honoured by an older
  matchsvc, so "the header is present" alone would not prove the claim was gone.
- `hostKind.test.ts` — three cases for `canSignIn`, one per *reason*, not one per enum value.
- `RunOutcome.test.ts` — the notice's own block, plus the existing exact-equality arena-win
  assertion updated **in place rather than loosened to `toContain`**: that assertion is what
  noticed the new line at all, and weakening it would have hidden the next one.

Client 6547 green, server 1863 green, the 12 logic-consistency gates green.

### Still open, and named here so it is not rediscovered

**The player cannot see their rating.** That is now the largest thing missing from the ladder: the
math is real, the store is real, `GET /rating/:accountId` is real and public, and nothing calls it.
The honest line this pass added is a placeholder for a number, and the next pass on this should be
showing the number — a before/after delta on the arena results screen, which needs a read on the
way into the match as well as on the way out, since the client is not the party that reports the
result.
