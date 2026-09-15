# Work log — 2026-09-15

Volume 66. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The control plane moves to MongoDB, and the accident that was holding registration together (2026-09-15, server + deploy + docs, no engine change)

*"现在将数据直接保存到db吧"*, over a screenshot of a freshly created Atlas cluster named
`blightbloom`, then *"四个库全部替换掉 SQLite"* and *"取代：SQLite 那部分直接删掉"*. This volume is
**stage 1 of that**, and only stage 1: the control plane is on the cluster, billing and analytics
and the ops flags are not, and adminsvc still opens all three as read-only files.

The decision reverses `design/16-accounts.md`'s own heading — *"Storage: SQLite (`node:sqlite`),
not MongoDB"* — and the reversal was argued before it was executed rather than after. What that
section said was true and is still true: accounts need relational constraints and MongoDB's
schema flexibility buys nothing here. What changed is not the argument but the premise, and the
owner's call is the premise. The section is rewritten to record both, because a design doc that
quietly flips a decision teaches the next reader that its reasons were never load-bearing.

### The blast radius, measured before anything was written

Thirty source files, 77 `.prepare()` call sites, four database files, 89 test files, 27 of them
opening `:memory:`. `node:sqlite` is SYNCHRONOUS and the driver is not, so the port is an
async conversion first and a schema translation second — and that ordering is where both of this
volume's real findings came from. Neither is a bug that existed on 2026-09-14. Both are bugs the
conversion would have SHIPPED.

### Finding 1: registration's uniqueness check was sound by accident

`AuthService.register` read `WHERE username = ? COLLATE NOCASE`, found nothing, and inserted. The
constraint behind it was `username TEXT NOT NULL UNIQUE` — SQLite's default BINARY collation, so
case-SENSITIVE. The index therefore never enforced the rule the check existed for, and the check's
own comment named that rule exactly: *"'Alice' and 'alice' being two distinct accounts is a real
impersonation/confusion footgun"*.

It held anyway, and only for one reason: `node:sqlite` is synchronous, nothing can interleave
between the SELECT and the INSERT, and compose points exactly one process (`matchsvc`) at that
file. A look-before-write that is atomic by accident.

Every read is a promise now. The accident is gone, two concurrent registrations of `Alice` and
`alice` both find nothing and both insert, and the footgun is live — in the one path in this
server that mints an identity. What makes it worth writing down is that `rating.ts` already
carried four paragraphs forbidding this exact shape (*"IDEMPOTENCY IS A CLAIM, NEVER A
LOOK-BEFORE-WRITE … SELECT-then-INSERT answers the question before holding the lock that would
make the answer true"*) and `design/19` §4's AMENDMENT 2 says it again for billing. Settlement and
delivery got it right; registration was the one identity path still doing it the other way, and
nothing noticed because the synchronous store made it not matter.

`accounts_username_ci` carries `collation: { locale: 'en', strength: 2 }`, so case-insensitive
uniqueness is the DATABASE's to enforce, and `register` claims a name by inserting and reading
E11000 as "taken". Five simultaneous registrations of one name in five spellings; one survives.

### Finding 2: dispatch had no error boundary, and now needs one

`matchsvc`'s `createServer` callback ran the whole route chain with no try/catch anywhere. Over a
local SQLite file that was survivable: a throw was a programming bug, not a Tuesday.

A network database makes a transient failure ordinary. A failover, a pool timeout, a dropped
connection to Atlas arrives as a REJECTED PROMISE on a normal request, and Node answers an
unhandled rejection by killing the process — one bad request becoming a disconnect for every
player on that service. The boundary turns it into one 500 with the reason logged, and destroys
the connection instead when headers are already on the wire. Deleting the `.catch` does not fail
the new tests; it hangs three of them forever, which is what the missing boundary actually looked
like from outside.

Two smaller things fell out of the same conversion. `readJson`'s callback form cannot survive an
async handler — a rejected callback escapes into an unhandled rejection the boundary never sees,
and a synchronously-throwing one used to be caught by the `try` that also wrapped `JSON.parse`,
which then called the callback a SECOND time and answered one request twice. Parsing is separated
from dispatch now and `readJsonBody` is the promise form every awaiting handler uses.
`postPortalLogin` had a `void (async () => { … })()` inside that callback — a detached promise
whose rejection reached nothing — and is a plain `await` now.

### What MongoDB does differently, pinned rather than remembered

`test/mongo.semantics.test.ts` asserts four behaviours of the SERVER, not of our code, because
four of this project's correctness properties were inherited from `node:sqlite`'s semantics and
had to be re-bought under different ones. The first is the one that would have shipped:

**MongoDB's unique index treats a MISSING field as one `null` and admits exactly one such
document.** SQLite treats every NULL as distinct, and `billingDb.ts`'s comment relied on it in
writing: *"SQLite treats NULLs as distinct under UNIQUE, so any number of unsettled orders
coexist"*. The naive translation rejects the second concurrent unsettled order with E11000 — on
the payment path, in production, only under concurrency. A partial index filtered to
`{$type: 'string'}` restores it without relaxing the constraint that two SETTLED orders cannot
claim one payment. The same shape applies to `accounts.providerId`, absent on every local account:
a plain `unique: true` there would have refused the second player ever to register.

The other three: the exactly-once claim (`upsert` + `upsertedCount`, verified under eight
simultaneous claimants rather than sequentially), transaction rollback, and that a transaction
spans two logical databases — so keeping the four stores separate costs no atomicity.

### What did not survive, said out loud

**Foreign keys.** `entitlements.account_id REFERENCES accounts(id)` is gone and has no MongoDB
equivalent. The old schema's comment argued the FK earned its place because *"a hand-issued row
for a typo'd account id fails loudly at the `sqlite3` prompt instead of becoming an orphan that
silently never delivers"* — that protection is lost, and `mongosh` has nothing checking a hand-
written document. `EntitlementService.grant` does not fake one with a lookup: a read there would
be a look-before-write on the hot delivery path and would still not bind the prompt the FK was
protecting against. The check that actually stands is `routes/internalEntitlements.ts`'s explicit
account lookup, which was already there for a better reason than the FK — telling "no such
account" (permanent) apart from "the write failed" (transient) without parsing a driver's error
string.

`EntitlementService.test.ts`'s *"REFUSES a grant to an account that does not exist"* is therefore
INVERTED rather than deleted. It asserts the orphan is accepted now, and says why. A capability
this project gave up should be visible in the suite, not only in a comment.

**The CHECK constraints did survive**, as `$jsonSchema` + `$expr` collection validators — the
`source` enum and "a purchase-sourced entitlement must carry an order id" still bind every writer,
`mongosh` included.

**adminsvc's read-only handle.** Decision B1 ("the console cannot write player data") was a
capability the process did not hold: `readOnly: true` enforced by SQLite, behind `:ro` bind mounts
enforced by Docker. Both are gone. It is an Atlas ROLE now, which lives in the cluster's
configuration rather than in this repository — still true, no longer true in a way a code review
can confirm. Stage 4 has to assert it at startup by attempting a write and requiring the refusal.

### The deploy bundle, caught by booting it

`mongodb` is EXTERNAL in `scripts/build.mjs`, like `ws` and for the reason already written there:
a runtime `require()` esbuild cannot see through. It is not a theoretical reason here. Bundled,
the driver's `require('timers/promises')` becomes a dynamic require in ESM output, **the build
succeeds, and every service dies at boot**. `deploy.bundle.test.ts` boots each bundle as a bare
node process, and that is the only layer where "the build passed" and "the service runs" are
different questions. It now points matchsvc at the suite's own mongod, so a bundle that cannot
load the driver never answers `/health`.

Its adminsvc pairing case is inverted and left in place saying why. It used to prove the console
could open a database matchsvc had written, deliberately using matchsvc's own bundle rather than a
fixture — *"a console that can read a database this repo's own writer did not create proves
nothing about the deployed pair"*. That argument is exactly why the case cannot be rescued with a
fixture now: matchsvc writes no accounts file at all, so there is no pair. It asserts the real
consequence instead — **the ops console's accounts tab is dark on a live deployment until stage
4** — because an operator will see that during the rollout and this is where it is explained.

### Tests: a real server, and two cases that got stronger

`mongodb-memory-server`, single-node replica set (transactions need one), ~0.5s, one per run via
vitest's `globalSetup`. No driver fake, keeping this repo's no-mocks convention — and a fake would
have blessed the E11000 trap, which is the whole argument. `freshAccounts()` needs no teardown: the
mongod is destroyed at the end of the run and every database name carries a counter, so only the
shared socket is closed (an open client makes vitest HANG rather than fail, which is the worse
failure to leave lying around in a gate).

Two cases stopped being simulations. The provider find-or-create race was STAGED by monkeypatching
`db.prepare` to land a winner between the caller's lookup and its insert, because nothing could
interleave in a synchronous store; it is simply *run* now, six ways, and the staged version
survives only where the `catch` arm needs to be reached deterministically. The ladder claim is
asserted under eight simultaneous retries of one at-least-once delivery.

Two SQLite-only cases were replaced rather than faked, and say so in place: the `BEGIN IMMEDIATE`
write-lock contention case (no such mechanism exists — a real conflict is retried by
`withTransaction`, so there is no "locked" to assert and pretending otherwise would test nothing),
and `test/db.migrate.test.ts` in full, which tested an `ALTER TABLE ADD COLUMN` runner that no
longer exists. The rollback tests keep their instrument: a collection validator makes the SERVER
refuse the write, as the old `RAISE(ABORT)` trigger did, rather than a stubbed driver.

One test is new because the port opened an injection shape the old one could not have: a query
OPERATOR posing as a username. SQL injection needed a string to escape out of; `{ $ne: null }`
needs no escaping at all and would match the first account in the collection. `login`'s
`typeof !== 'string'` guard is what refuses it, and it is pinned now.

### The percentage that was hiding a module

First measurement: 97.59% lines / 97.31% branches, comfortably over the 90/90 gate — with
`src/mongo.ts` at 10% lines and **0% branches**. The module every service calls before it binds a
port, untested, invisible behind a whole-tree average. That is the failure `design/18` "Layer 4"
describes, met in the wild rather than in the abstract, and its refusal paths (a missing
`BB_MONGO_URI`, a store reached before boot, a failed connection leaving the in-flight latch set)
are tested now. Final: 98.59% lines / 98.05% branches over 1,770 tests.

Chasing the last uncovered branch in `db.ts` found dead code rather than a missing test:
`ensureValidator`'s `createCollection` arm could never run, because `createIndex` above it creates
the collection implicitly. The validator is installed FIRST now — both arms live, and no write can
reach `entitlements` before the rule that constrains it.

### Parallel work, unmerged

Stage 3 (analytics + the ops flags) and stage 2 (billing) were built concurrently on
`feat/mongo-analytics` and `feat/mongo-billing`, both branched from this volume's stage-0
foundation. Neither is merged here. Stage 3 reports a pre-existing `clearFlag` look-before-write
fixed in passing; stage 2 had not reported when this volume was written.

### Not done, and load-bearing

Stages 2 (billing integration), 4 (adminsvc's ~570 lines of SQL to aggregation pipelines), 5
(compose, backup, CI's mongod binary cache), 6 (the rest of the docs) and 7 (the one-time
migration of real player data off the Hetzner box's four `.db` files) are open. **Until 7 runs, a
deployed matchsvc reads an empty cluster**: this branch must not reach `main` as a deploy.
