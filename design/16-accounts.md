# 16 — Accounts

Real username/password login, replacing every "no account system exists" scaffold noted in `05`/`15`/`server/src/rating.ts`/`server/src/PartyService.ts`/`client/src/net/identity.ts`. Shipped 2026-07-29.

## Storage: MongoDB Atlas since 2026-09-15 — and what it replaced

**Current:** the control plane lives on a MongoDB Atlas cluster, reached through `server/src/mongo.ts` (`BB_MONGO_URI`, plus an optional `BB_MONGO_DB_PREFIX` so one cluster can host more than one environment). Six collections on the `accounts` logical database; shapes, constraints and the reasoning for each are in `server/src/db.ts`'s header, which is the authority. Work log: [volume 66](roadmap/66-2026-09-15-mongodb-control-plane.md).

**This section used to be headed "Storage: SQLite (`node:sqlite`), not MongoDB", and the reversal is recorded rather than quietly overwritten** — a design doc that flips a decision without saying so teaches the next reader that its reasons were never load-bearing. The original argument, verbatim in substance: the server side is zero-ops (two bare `node:http` processes, in-memory `Map`s, no Express, no DB); accounts need one real relational fact (a unique username → a login) plus two 1:1 side tables, which is exactly what SQLite's schema and constraints are for, and MongoDB's schema-flexibility advantage buys nothing here since `MetaState`'s shape is already fixed and versioned via `meta/store.ts`'s `migrate()`. `node:sqlite`'s `DatabaseSync` was chosen over `better-sqlite3` because this dev box has no C++ build toolchain and the native `node-gyp rebuild` failed outright.

That argument was true and, on its own terms, still is. It was not refuted; its premise was replaced — the project owner chose a managed cluster over a file. What the move actually costs is therefore worth stating as plainly as the original claim:

- **Foreign keys are gone**, with no equivalent. `entitlements.account_id REFERENCES accounts(id)` made a hand-issued row for a typo'd account fail loudly at the prompt; an orphan is now accepted by the cluster and refused only by `routes/internalEntitlements.ts`'s explicit lookup. The CHECK constraints *did* survive, as `$jsonSchema` + `$expr` collection validators, so they still bind a `mongosh` prompt.
- **Uniqueness semantics differ where it matters.** MongoDB's unique index treats a MISSING field as one `null` and admits exactly one such document, where SQLite treats every NULL as distinct. Every index over a formerly-nullable column is therefore PARTIAL. `server/test/mongo.semantics.test.ts` pins this and three other server behaviours the port depends on.
- **Reads are asynchronous**, which removed an accident registration was relying on — see `db.ts` and volume 66 on the case-insensitive unique index, and on the request error boundary `matchsvc.ts` grew at the same time.

**MIGRATION: DONE, both halves.** The code moved 2026-09-15 — all four stores (`accounts`,
`billing`, `analytics`, `ops`) are logical databases on the cluster and adminsvc and the backup
worker read them through the driver. The DATA moved **2026-09-16**: 175 rows off the deployed
box's four `.db` files, verified through the ops console. `node:sqlite` is imported nowhere in
this repository; the one-time migration was deleted with the data it carried, which was its
stated expiry from the day it was written.

`server/deploy/README.md` §5 is the record of that cutover rather than a procedure — what ran, in
what order, what moved, and how to bring the migration back out of git if a later discovery needs
it (a completed run leaves a marker in the `ops` store, so a second run is REFUSED without
`--force`). Volumes 66, 67 and 68 have the full account; 68 is also where the packaging hole that
nearly stopped the cutover at its first command is written up.

## Server (`matchsvc.ts`, port 8788 — same control-plane process as matchmaking/party/rating)

- `server/src/db.ts` — schema: `accounts(id, username UNIQUE, password_hash, provider, provider_id, created_at)`, `sessions(token, account_id, expires_at)`, `ratings(account_id, rating)` (no FK to `accounts` — a rating key is any opaque id `ladderReport.ts` hands over, including a guest/bot's `seat:{roomId}:{seatIdx}` scaffold that never has an `accounts` row), `meta_state(account_id, data)`, and — since 2026-09-04, ROADMAP 8.2 — `entitlements(id, account_id, sku, source, order_id, granted_at)` with `UNIQUE(account_id, sku)`, which **does** take the FK `ratings` refuses, because an entitlement is only ever minted for a real logged-in account (`design/19-server-platform.md` §2 has the full contrast).
- `server/src/AuthService.ts` — pure class over an injected `DatabaseSync`, same DI shape as `Matchmaker`/`PartyService`. Passwords: `crypto.scrypt` + a random 16-byte salt (`salt:hash` hex), `timingSafeEqual` to verify — no bcrypt/argon2 dependency. **The ASYNC scrypt since 2026-09-17**: it was `scryptSync` until then, which spent every millisecond of a deliberate ~50-100ms hash inside the one event loop that also serves matchmaking, party and ladder settlement, so a burst of registrations froze the whole control plane rather than merely queueing. Same cost, paid on the threadpool. Sessions: opaque `crypto.randomBytes(32)` bearer tokens stored server-side (revocable via `DELETE`, not JWT — no new dependency, mirrors `ticket.ts`'s own HMAC-over-JWT choice), 30-day TTL. `login` also enforces an in-memory per-username lockout (5 consecutive failures → locked 15 minutes, reset on any success) — the username is case-folded before use as the lockout key so it lines up with the `COLLATE NOCASE` account lookup; keyed by username rather than request IP since this server has no IP plumbing today, but a per-username lock already stops the actual attack it defends against (repeated password guessing against one account). `changePassword` **revokes the account's other sessions** (2026-09-17): it takes the caller's own token as `keepToken` and deletes every other session row, because "somebody else is in my account" is the case a password change exists for and leaving the intruder's 30-day bearer token live answers it with "no". The caller's own device stays signed in; a REFUSED change revokes nothing, or a wrong guess becomes a way to sign somebody out.
- Routes (all in `matchsvc.ts`, same linear-`if` dispatch as every other route there): `POST /auth/register` (rate-limited per IP since 2026-09-17 — `REGISTER_RATE_LIMIT`, thirty in ten minutes, its own limiter rather than telemetry's, and the budget is spent BEFORE the body is read; it was the only route here that was both unbounded and expensive), `POST /auth/login`, `POST /auth/portal` (a verified CrazyGames user token → one of our sessions, 2026-09-08 — `server/src/portalToken.ts` + `portalKeys.ts`, `design/20`), `POST /auth/logout`, `GET /auth/me` (Bearer), `POST /auth/change-password`, `GET/POST /account/meta` (Bearer) — the Forge `MetaState` JSON blob. **No longer the whole of `MetaState`**: since ROADMAP 8.2 blueprint/character ownership is owned by the `entitlements` table, `GET` overwrites those two fields in the returned blob from it and returns the entitlement list alongside, and `POST` strips them before storing (ignored, not rejected). See `design/19-server-platform.md` §2.
- `accounts.provider`/`provider_id` (default `'local'`/`NULL`) were reserved for third-party login (WeChat openid, etc.) per the user's request. **Used since 2026-09-08** (`design/20` "Account integration"): CrazyGames is the first provider, `AuthService.loginWithProvider` is the federated half, and `POST /auth/portal` is its route. The reservation's prediction held — a new provider is a `provider != 'local'` row plus a route — with one thing it did not predict, and `accounts.display_name` is that thing: a federated identity arrives with a name chosen under someone else's rules, and it cannot be forced through ours (`validateUsername`'s length, charset and profanity list are the rules for a name a player chooses HERE; applied to a platform username they leave real players unable to log in at all). So `username` became strictly the LOGIN HANDLE — `{provider}:{providerId}` for a federated row, which contains a `:` and is therefore unreachable by `validateUsername`, so the two namespaces cannot collide — and `display_name` is what a human sees, read everywhere through `COALESCE(display_name, username)` so every pre-existing local row is unaffected. `password_hash` is `NOT NULL`, so a federated row stores the sentinel `'!'`, checked explicitly in `verifyPassword`; `login` additionally refuses any row whose provider is not `local`. Two independent guards, on purpose. **This is also this project's first real schema MIGRATION** — `db.ts`'s `ADDED_COLUMNS`, applied behind a `PRAGMA table_info` guard, because `CREATE TABLE IF NOT EXISTS` never re-reads the body of a table that already exists on a deployed box.

## Client

- `client/src/net/session.ts` — `{accountId, username, token}` in `localStorage['daydayup.session.v1']`, same storage-port/cache convention as `net/identity.ts`'s `IdentityStore`.
- `client/src/net/auth.ts` — thin `fetch` wrapper over the routes above, same injected-fetch DI convention as `net/party.ts`/`net/matchmaking.ts`.
- `client/src/net/identity.ts`'s `getPlayerId()` now prefers the logged-in `accountId` over the local guest UUID — the single seam every downstream caller (party, matchmaking, ladder rating) already read through, so nothing else needed to change to pick up a real identity once logged in.
- `client/src/game/screens/LoginScreen.ts` — login/register/logout/change-password UI, same `Panel`/`Button`/`TextInputOverlay` pattern as `PartyScreen.ts` (`TextInputOverlay` gained a `password?: boolean` masking option). Reached from a new MainMenu "LOGIN"/"Hi, {username}" button. **Never required to play** — BACK without an account is the unchanged guest path.
  - **Unreachable on a game-portal build since 2026-09-08.** That platform disallows a game's own credential login (external login options, a logout leading back to one, a login button as a primary CTA), so `MainMenu.setAccountEntry(false)` renders no entry and `gameWiring.ts` leaves `onAccount` unwired — the screen is still constructed and mounted, exactly as `StoreScreen` is on a build that may not sell. `platform/crazygames/portalAuth.ts` signs the player in from the entry point instead, and `platform/sessionEvents.ts` is how that session reaches the main-menu label and the account-bound meta re-sync without a screen having been touched. See `design/20`.

## What's bound to an account (vs. what isn't, yet)

- **Login/session itself** — done, the core of this doc.
- **PvP ladder rating** — a logged-in client's real `accountId` rides in the signed match ticket (`TicketPayload.accountId`) from `POST /find` through `Matchmaker` → the gameserver's `Seat`/`RoomConnection` → `MatchRoom.reportResult`'s new `SettledMatch.seatAccounts` (seat → accountId) → `ladderReport.buildRatingReportBody`'s new optional 4th param. A seat missing from `seatAccounts` (guest, bot) still gets the pre-existing `seat:{roomId}:{seatIdx}` scaffold — fully backward compatible, every pre-account test/caller unaffected. **2026-08-03: `RatingStore` now persists to the `ratings` SQLite table** — `matchsvc.ts` passes its own `openDb()` result into `new RatingStore(db)`, so a rating survives a server restart; the constructor's `db` param stays optional (`new RatingStore()` falls back to the original in-memory `Map`) so every pre-existing test/caller is unaffected.
- **Forge blueprints/materials/loadout** (`MetaState`) — `client/src/meta/accountSync.ts`'s `createAccountSyncMetaStore` wraps the existing localStorage `MetaStore`: every `save()` best-effort mirrors to `/account/meta` once logged in (fire-and-forget, same shape as the server's own `reportSettledMatch`); `pullAccountMeta()` runs once right after login/register to pull the account's server-side state (or push the current local state up, for a brand-new account). A guest's behavior is byte-identical to before this doc. Since ROADMAP 8.2 the pulled blob's ownership fields are the SERVER's answer rather than whatever this device last pushed up — which changes nothing visible, because `store.ts`'s `migrate()` unions the free baseline (`STARTER_BLUEPRINTS` + `FREE_CHARACTERS`) back in on every load, so an account owning nothing paid reads identically before and after a login.

## A real bug only live verification caught

`vitest`/curl both passed throughout, but the first live click-through (claude-in-chrome, real Chrome) hit `Failed to fetch` on every bearer-token call. Cause: `matchsvc.ts`'s CORS constant only declared `access-control-allow-headers: content-type` — fine for every pre-existing route (none sent custom headers), but `/auth/me` and `/account/meta` send `Authorization`, which a real browser's CORS preflight rejects unless the server explicitly allows it. Node's own `fetch`/`undici` and `curl` don't enforce browser CORS preflight rules, so neither the test suite nor a server-side curl check could ever have caught this — only an actual browser exercising the actual request could. Fixed by adding `authorization` to `access-control-allow-headers`; re-verified live (register → unlock a blueprint → log out → clear local state → log back in with a changed password → blueprint state pulled back from the server) end to end, including a direct SQLite row check.

## Test coverage (added after the initial ship, on request)

- **Local username blacklist** (`server/src/usernameFilter.ts`) — reserved system names (`admin`/`root`/`system`/`moderator`/…) + a small first-pass profanity list, case-insensitive substring match. No external content-moderation API is wired in (this project has no WeChat appid/secret anywhere) — swapping in a real one later is a one-function change to `isBlockedUsername`.
- **`matchsvc.ts` was refactored for testability**: `createMatchsvcServer(opts)` builds the HTTP server WITHOUT starting it; `main()` (the real CLI entrypoint) is now guarded behind an ESM `import.meta.url === process.argv[1]` check, so importing the module for tests no longer has the side effect of binding the real port. `server/test/matchsvc.http.test.ts` is the first direct HTTP-layer test this file has ever had: a real server on an ephemeral port, real `fetch` calls through the full `/auth/*`/`/account/*` surface, AND a real CORS preflight (`OPTIONS` with `Access-Control-Request-Headers`) asserting `authorization` is allowed — a regression test for the exact bug above, which no prior test category in this repo (pure-logic unit tests, curl) could catch.
- **`AuthService` edge cases**: boundary-length inputs, unicode/emoji rejection, SQL-injection-style username/password strings (proven inert — parameterized queries + charset validation), concurrent same-username registration (only one wins). Also fixed a real correctness gap found while writing these: username uniqueness and login lookup were case-SENSITIVE (`'Alice'`/`'alice'` were two different accounts) — now `COLLATE NOCASE` on both queries.
- **`LoginScreen` re-entrancy**: `doLogin`/`doRegister`/`doChangePassword`/`doLogout` now guard against a second call landing while the first is still in flight (matches `PartyScreen`'s `doCreate`/`doJoin` convention, which `LoginScreen` had missed) — tested with a controllable deferred promise per action.
- Totals after this pass: **134 server tests** (was 100) + **568 client tests** (was 564), both `tsc --noEmit` clean.

**2026-08-03: ladder-rating persistence + login rate-limiting shipped.** Two of the three items this doc's "Explicitly not built" section used to list. `ratings` (see above) is no longer unused schema — its `account_id` column deliberately has no FK to `accounts`, since a guest/bot's scaffold id needs to persist there too, and `node:sqlite` enforces FK constraints by default (caught by a real `FOREIGN KEY constraint failed` test failure before shipping, not assumed). Login lockout (see `AuthService.login` above) is a simple in-memory counter, not a DB table — a failed-login streak isn't account state worth persisting across a restart. **142 server tests** (was 134) + 582 client tests, `tsc --noEmit` clean both packages.

**Same day, later: the third item — expired `sessions` rows are now swept.** `verifySession` already deleted the one expired row it happened to look up, but nothing ever cleared a session nobody logged out of and never came back to check — the table only grew. `issueSession` (the one place a new row gets written, i.e. the one place growth actually happens) now runs `DELETE FROM sessions WHERE expires_at < now` first — an opportunistic sweep, not a background timer, matching this project's "no process the team doesn't need yet" convention; the hot per-request read path (`verifySession`) deliberately still only touches the one row it's already looking at, so an authenticated request stays a single indexed lookup. **144 server tests** (was 142).

## The identity model, and the platform matrix (2026-09-17)

Three layers, and **one seam**. Everything above was built one platform at a time; this is the
shape they turned out to have, written down before a fourth platform arrives and adds a fourth set
of branches. Work log: [volume 70](roadmap/70-2026-09-17-home-and-login-design.md).

| Layer | What it is | Who mints it | Lives as long as | Where |
| --- | --- | --- | --- | --- |
| **L0 device guest** | a UUID plus a local `MetaState` | the client itself | this browser's storage | `net/identity.ts` |
| **L1 host-vouched identity** | a signed assertion from the platform the game is embedded in | CrazyGames (WeChat would be the second) | the platform account | `platform/crazygames/portalAuth.ts` → `POST /auth/portal` |
| **L2 our own account** | a username/password row | the player, deliberately | forever, revocable | `LoginScreen` → `/auth/register`\|`/auth/login` |

**L1 and L2 are two shapes of the same `accounts` document** (`provider: 'local'` vs a federated
provider; the handle is `{provider}:{providerId}`, which contains a `:` and is therefore
unreachable by `validateUsername`). Downstream there is exactly one reader: `getPlayerId()`, which
prefers a session's `accountId` and falls back to the guest UUID. **A new platform is one
`/auth/<provider>` route plus one silent call site** — that is what CrazyGames actually cost, and
the prediction the reserved `provider`/`provider_id` columns made.

| Host | Identity from | Login action | Our credential form | What the player sees | Cloud save |
| --- | --- | --- | --- | --- | --- |
| **web** | L2 | the player opts in | allowed | `LOGIN` button / `Hi, {name}` | after login |
| **CrazyGames** | L1 | silent, every start | **forbidden** (three separate rules, see `design/20`) | platform display name, as a LABEL | automatic |
| **WeChat** | none today — every player is a guest | — | pointless | guest | none |

Two consequences of that table are worth stating because they are easy to assume the other way:

- **Clickability is the HOST's decision; the copy is the SESSION's.** They are one boolean today
  (`MainMenu.setAccountEntry`), and they come apart at the first host that has an identity and
  forbids a logout — which is every federated host, WeChat included if it ever gets one.
- **WeChat having no login is a real gap, not a simplification.** A cleared storage there is a new
  player with nothing. Closing it is a token exchange shaped exactly like `POST /auth/portal` and
  `wx.login` needs no consent dialog — but unlike the portal's, it is OUR choice and it mints a
  server-side identity for a player who never asked for one. Weigh it; do not tick it.

## Three holes, found 2026-09-17 by reading the boot path against the account path

**All three were closed the same day** — holes 1 and 2 in
[volume 73](roadmap/73-2026-09-17-guest-merge-and-session-check.md), hole 3 in
[volume 74](roadmap/74-2026-09-17-ladder-identity.md). The original text of all three is kept
verbatim below, each with what actually shipped underneath it, because the diagnosis is the part
worth being able to read back: none of the three was reachable by a test as the code stood, and
what made them invisible is more reusable than what fixed them. Hole 3 is the one whose diagnosis
turned out to be **wrong**, and its entry is worth reading for that alone.

They were P0 for the account system in the sense that they are wrong *whatever* the account turns
out to be worth — see [volume 70](roadmap/70-2026-09-17-home-and-login-design.md) for why most of
the rest of that design was deferred.

1. **Logging into an account that already has server state discards local guest progress.**
   `OnlineMatch.syncMetaWithSession` is `setMeta(remote ?? d.run.meta)`, and the `??` only covers
   the brand-new-account branch (`pullAccountMeta` returns `null`). The merge that the "Guest
   progress carried up" row of `design/20`'s table claims therefore exists only where there was
   nothing to merge. **The fix is not a field-by-field union** — that is the wrong default on a
   shared computer. It is: this device merges **once**, on its first association with any account,
   keyed by the guest install id and made idempotent server-side (`mergedGuestIds`), after which
   the account is the truth; blueprint/character ownership unions, the material bank adds, and the
   confirmation screen's primary button says *use the account's*.

   ✅ **Closed 2026-09-17, as designed.** `accounts.mergedGuestIds` holds the guest install ids
   this account has been offered a merge on; `POST /account/guest-merge` claims one atomically
   (one conditional update, `modifiedCount` as the answer — never a find-then-write, because two
   tabs answering at once would otherwise both merge and the bank would be added twice), and
   `GET /account/meta` reports the answer back for the id in the `x-guest-id` header as a single
   boolean. `OnlineMatch.resolveAccountMeta` is the decision; `meta/guestMerge.ts` is the pure
   arithmetic. Three things worth knowing that the design above does not say:
   - **The claim is spent on the ANSWER, not on the merge.** A player who chose *use the
     account's* is recorded exactly like one who combined, because what the key records is the
     question having been asked. Recording the answer instead would re-offer a declined merge on
     every login forever.
   - **An empty account side merges without asking.** A modal whose two buttons do the same thing
     is worse than none, and taking the account's empty state there would be this hole again on
     the shape where it is most obviously wrong.
   - **The ownership half of the union is not durable, and that is ROADMAP 8.2, not a bug.**
     `POST /account/meta` strips `unlockedBlueprints`/`ownedCharacters` out of the blob and `GET`
     writes the server's `entitlements` answer back over them, so ownership a client granted
     itself survives the session and not the round trip. The bank — the half a guest actually
     accumulates — is stored verbatim and does survive. Granting a real entitlement from the
     client is precisely the free-money hole 8.2 closed, so the merge does not try.
2. **A stored token is trusted forever and never verified.** `fetchMe` exists and has **zero
   production callers**; boot reads the session out of `localStorage` and believes it.
   `SESSION_TTL_MS` is 30 days, written once by `issueSession` and never extended, so an expired or
   revoked session paints as `Hi, {name}` while every bearer call 401s into a `.catch()`. The fix
   is not a second request at boot: `/account/meta` is already called on the way in, so its 401 is
   the check — `fetchAccountMeta` needs to return that status as a value rather than throwing it.
   Then **401 clears the session and never touches local `MetaState`**, and a network failure
   changes nothing at all (offline is not logged out).

   ✅ **Closed 2026-09-17, as designed, and with no second request.** `fetchAccountState` returns
   a 401 as the value `ACCOUNT_UNAUTHORIZED` and still throws on everything else; the 401 is read
   off the STATUS before the body is touched, so a proxy's HTML error page behind one is still a
   clean sign-out rather than a parse failure wearing its clothes. `syncMetaWithSession` then
   clears the session, announces it through `platform/sessionEvents.ts` (which is what walks the
   lobby chip back from `Hi, {name}` to LOGIN) and shows a notice — while a network failure
   returns having changed nothing at all. `fetchMe` and `fetchAccountMeta` were **deleted**, not
   left in place: two tested readers with no production callers are what made this hole look like
   a check that existed.

   One deviation from the design's wording, and it matters: the notice is **a dismissible panel,
   not a toast**. `HudView`'s toast queue lives inside `hudView`, which every hub screen sets
   `visible = false` — and a 401 fires at the lobby by definition, since it is the answer to the
   meta pull a login or a boot just made. A toast would have been pushed into a hidden container,
   which is this same hole moved down one layer.
3. **A guest's ladder rating is discarded every match.** A seat with no `accountId` is keyed
   `seat:{roomId}:{seatIdx}` — a new identity per match. The guest already has a persistent id
   that `POST /find` receives, so this is a key choice, not a missing capability. Carrying it into
   the ticket is the fix; *telling* the player their rating is thrown away is not.

   ✅ **Closed 2026-09-17, by the OPPOSITE decision** — a guest is not scored at all, and the
   PvP results screen says so. The full argument is in `design/15-pvp-arena.md`'s "Who a rating
   belongs to (locked 2026-09-17)"; what belongs here is why the paragraph above is wrong, since
   it is the only one of the three whose diagnosis did not survive contact with the wire.

   - **The carry it asks for already happened.** `findMatch` sent `accountId: getPlayerId()` in
     the `/find` body and `postFind` honoured it, so a guest's rating did accumulate under a
     stable key. `seat:{roomId}:{seatIdx}` only ever keyed bots and the dev raw-param handshake.
     "This is a key choice, not a missing capability" was right; which key had been chosen was
     not.
   - **What was actually missing was the check that makes any key mean anything.** The client
     sent **no `Authorization` header on `/find`**, so `deps.auth.verifySession` had zero
     production callers — hole 2's exact shape, on a different route. Every scored identity was
     the caller's unverified claim, so anyone could post a stranger's real accountId and move
     their rating. Carrying the guest id further is what OPENS that; it is not what closes it.
   - **So the fix inverts.** `/find` proves identity with the session's bearer token and reads
     the body's `accountId` never. A guest carries no identity, the per-match scaffold keys the
     seat, and that per-match-ness is now the design rather than an accident. A guest's rating
     could not have been merged into their account later anyway (importing a forgeable key's
     value into an unforgeable one re-imports the forgery), so what hole 3 proposed building was
     a number with nowhere to go.
   - **"Telling the player is not the fix" was answered on its own terms.** The line does not
     stand in for a fix — the fix is the trust boundary above. It stands in for the SILENCE that
     came with it, and it is gated twice (`canSignIn()`, `getSession()`) so it never appears
     where signing in is impossible or already done. It names no number, because this client has
     never displayed a rating.
   - **One thing came free.** `session?.username` was `undefined` in production for the same
     missing header, so design/20's verified seat names had never been shown to anyone. Sending
     the token turned them on.

## What the account's own tests were not testing (2026-09-17)

Asked of this doc's whole surface once the three holes above were closed, and answered by reading
a full `coverage` run against it rather than against the total. Work log:
[volume 75](roadmap/75-2026-09-17-account-test-gaps.md).

**The server had no gap worth the name** — `routes/auth.ts` and `routes/account.ts` are at 100% on
every column. Both real gaps were on the client and were the same shape, which is the part worth
keeping, because a 90/90 gate cannot see it: **the tests inject a fake and the shipped
implementation is what is left over.**

- `net/session.ts` read **69.23% lines / 53.84% branches**. Every case passes a `fakeStore` and this
  runner has no `localStorage`, so `createWebSessionStore` — the store every web and portal build
  actually uses — had never executed, including the `catch` that decides whether a corrupt stored
  session reads as *logged out* or throws out of boot. `identity.ts`'s twin had web-store cases
  from the start; this was the one of the pair that was missed.
- `LoginScreen.ts` read **42.3% on functions**. Every case calls `doLogin`/`doRegister` directly, so
  the path a player actually takes — button → `promptCredentials` → the overlay → `do*` — was dead
  code as far as the suite was concerned. What that hid: **`password: true` is passed in exactly one
  place and was asserted in none.** Deleting the word left 4000+ green tests and the player's
  password rendered in plain text as they typed it, with `autocapitalize` upper-casing it on a
  phone, since this overlay's default is the party join-code field.

Two further findings were **decisions rather than missing tests**, and both shipped: the session
revocation on `changePassword` and the `/auth/register` budget, each described in the Server
section above. And one was a live defect found while moving scrypt off the event loop:
`verifyPassword` guards `!saltHex || !hashHex`, but a stored `'aa:zz'` walks past that with both
halves non-empty while `Buffer.from('zz', 'hex')` is EMPTY — so it asked scrypt for a zero-length
key and `timingSafeEqual(<empty>, <empty>)` answered **true**, and any password logged in. It needs
a damaged or planted row to reach, and the pre-existing corrupted-hash case could never have found
it (`'garbage'` has no colon and stops at the earlier guard). There is an explicit length check
ahead of the comparison now.

One thing came out of this that is not about accounts at all. **The seven `daydayup.*` storage keys
were pinned by nothing** — each is a lone literal in one module, read back only by that module, so
renaming one is a one-word edit that no type, no test and no gate would notice, and the day it
happens every existing player silently becomes a new one. Since the rename to Blightbloom was
deliberately left unfinished (see the name note in `README.md`), that edit is a plausible act of
tidying rather than a mistake. `client/src/storageKeys.test.ts` is the gate: the exact set, one
module each, and the converse — no `blightbloom.*` twin.

## Login is never a gate (locked; restated 2026-09-10 against a proposal to make it one)

The proposal, from the same report that produced design/10's lobby: boot into an **auto-login
loading** state on the hosts that sign a player in silently, and into a **login screen** on the
hosts that do not, and only then into the lobby. Half of it shipped — the loading state is real
(`identityGate.ts`, design/10) — and the other half is refused, for three reasons that are worth
writing down because the instinct behind it is sound and will recur.

1. **This doc's own locked decision.** Logging in is never required to play (see `LoginScreen` in
   the Client section above). A guest is a first-class player, not a degraded one: the whole
   `MetaState` path is local-first and an account only ever *mirrors* it.
2. **A portal forbids it outright.** `docs.crazygames.com/requirements/account-integration`
   disallows an external login option, disallows a logout that leads back to one, and disallows a
   login button as a primary call to action — quoted in full in `client/src/platform/crazygames/
   portalAuth.ts`. A login screen between boot and the lobby is all three at once.
3. **The set of hosts that auto-login has exactly one member, and it is not the one people
   assume.** See the correction below.

What replaces it is the **account chip** in the lobby (design/10): identity is *visible* at the
front door without being a *gate*, and it opens `LoginScreen` only where `setAccountEntry` says a
host permits one at all. The instinct the proposal got right was that login state used to be
invisible AND late — the chip fixes the first half, the identity gate the second.

### Audited against the code, and pinned (2026-09-21)

Asked directly — *“请确认组队和匹配功能，是
否需要玩家登录”* — so the rule above was checked against what the
routes actually do rather than restated. It holds. `requireAuth` (`routes/auth.ts`) is called from
`routes/account.ts` and `routes/store.ts` and **nowhere else**: all five `/party/*` routes, plus
`/find`, `/find/:queueId` and `/resume`, resolve no session and refuse nobody **on identity
grounds**. One of them refuses on other grounds since 2026-09-22: `POST /party/join` answers 429
once a caller's per-IP budget is spent (`JOIN_RATE_LIMIT`, see `design/15`). That is a rate, not an
account check — a guest and a session holder get the same budget, and nothing about being logged
in buys more of it — but "refuses nobody" would otherwise read as a promise this route no longer
keeps.

- A **`playerId`** is whatever opaque string the client sends — the real `accountId` once a
  session exists, a locally generated guest id otherwise (`net/identity.ts`) — and nothing
  verifies which. That is the right trust level here: the worst a forged one can do is confuse a
  party the forger has already joined.
- **`/find` does verify an `Authorization: Bearer` when one is sent**, but a missing or invalid one
  means *guest*, not 401 (a 30-day session expiring mid-play must not end the match). The only
  thing withheld is the durable **ladder rating**, which falls back to `ladderReport.ts`'s
  one-match `seat:{roomId}:{seatIdx}` scaffold — not the party, not the match, not the win. See
  the three-holes section above for why a self-declared identity can never own a rating.

**Why this needed tests and not just this paragraph.** The guarantee is an *absence* of auth checks
spread over eight route registrations, and an absence is what no suite asserts by accident —
adding a `requireAuth` to `/party/create` would have broken nothing and changed the answer. Both
directions are now pinned in `server/test/matchsvc.queue.http.test.ts`, and the second is not
redundant with the first:

1. the whole squad flow (create → join → poll → start → `/find` → leave) runs with
   **no `Authorization` header at all**;
2. a **valid bearer token is ignored** — `playerId` still names the member, and the session holder
   is still refused as a non-leader. Without this case, a route that quietly preferred the session
   over `playerId` would pass (1) happily, and a player who logged in mid-lobby would change
   identity underneath their own party.

`matchsvc.findIdentity.http.test.ts` already held the matchmaking half (*“still gets a playable
seat — nothing but the ladder key is withheld”*); (1) and (2) are the party half.

One stale claim fell out of the same audit: `server/src/PartyService.ts`'s header said *“no
account system backs this (none exists anywhere in this project)”*, written before this doc
shipped on 2026-07-29 and left standing for two months. It now says that one exists and that this
route group deliberately does not consult it, which is a stronger statement than the one it
replaced — and the tests above are what keep it honest.

### Correction: WeChat does not log in at all (2026-09-10)

Worth stating plainly, because "CrazyGames and WeChat both auto-login" is a natural reading of
what this project ships and it is false. There is no `wx.login` call anywhere in the client and no
`POST /auth/wechat` route on the server — the route table is `register` / `login` / `logout` /
`portal` / `me` / `change-password`. **Every WeChat player is a guest**, and `identityGate.ts`
therefore settles instantly on that target rather than waiting for anything.

What it would take, if it is ever wanted: `wx.login`'s code exchanged server-side for an openid
(a new `POST /auth/wechat`, shaped like `POST /auth/portal` — a host-vouched token exchange, not
an OAuth redirect), plus a `SessionStore` over `wx.getStorageSync`/`setStorageSync`, which is the
same seam volume 51 already built for `IdentityStore` and can be installed the same way. Until
then, the honest description of that target is "guest-only", and design/04's checklist is where a
positive check for it would belong.

## Explicitly not built

- Real third-party OAuth (WeChat/Google) — the `provider`/`provider_id` columns and routing seam are reserved, not implemented. **Partially superseded 2026-09-08**: CrazyGames' user token IS implemented (`POST /auth/portal`), and it is a token exchange rather than an OAuth code flow — there is no redirect, no client secret and no consent screen of ours, because the host page has already authenticated the player and hands the game a signed assertion. WeChat/Google remain unbuilt, and a real OAuth flow would need the redirect handling this one does not.
- **Account LINKING** — one human on two platforms is deliberately two accounts (the project owner's decision, 2026-09-08, recorded in `design/20`). The platform's own `showAccountLinkPrompt` is not called and no `provider`-to-`provider` merge exists. That is a decision, not a gap: linking would put another platform's account rules in charge of ours.
- Email/password-reset flows — none of this exists; `register`/`login`/`changePassword` are the whole surface.
- Squad-aware or account-aware anything beyond what's listed above (e.g. friends lists, cross-device sync verification) — out of scope.
