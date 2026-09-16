# Work log — 2026-09-15

Volume 67. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The other three stores follow, and SQLite leaves the repository (2026-09-15, server + deploy + docs, no engine change)

[Volume 66](66-2026-09-15-mongodb-control-plane.md) moved the control plane and listed six stages
it had not. This is all six: billing and analytics merged from the branches they were built on,
the ops console and the backup worker ported, compose and the deploy script rewritten, the
one-time data migration written, and `node:sqlite` removed from every bundle. The owner's
instruction was *"四个库全部替换掉 SQLite"* and *"取代：SQLite 那部分直接删掉"*; after this pass
there is exactly one file in the repository that imports the builtin, and it has a deletion date
on it.

What is still open is not code. **The migration has not been RUN.** Until it is, a deployed
matchsvc reads an empty cluster, which is why the day's PR stays a draft.

> **It ran the next day** — [volume 68](68-2026-09-16-mongodb-cutover.md), 2026-09-16, 175 rows.
> The packaging problem this volume's last section names was real and was the last blocker: the
> migration became a sixth bundle, ran, and was deleted with `src/migrate/`.

### Three merges, and the one conflict shape they all had

Stages 2 and 3 were built concurrently on branches cut from volume 66's foundation, so each of
them had the control plane on a file while the daily branch had it on the cluster. Every one of
the eight conflicts was that same shape — HEAD with accounts on MongoDB and X on a file, the
branch with the inverse — and every resolution was *both*, never a side taken whole.

Three were semantic rather than textual and are worth naming, because each one had a claim in it
that had quietly stopped being true:

- **`scripts/grantAudit.ts` opened the accounts file READ-ONLY** and its header said, in so many
  words, that SQLite enforced what a comment would not. One client reaching one cluster cannot
  hold half a handle. The posture is a convention plus an Atlas role now, and the header says so
  rather than keeping a sentence that had become decoration.
- **`test/billingDb.legacy.test.ts` compared the billing default path against `defaultDbPath()`**,
  so that one operator setting one variable could not point both planes at one file. There is no
  accounts path to collide with. What survived is the half still checkable — that `BB_DB_PATH`
  cannot move the billing default — and then the whole file went, with the opener.
- **`matchsvc.ts` never wired `analyticsDb`.** Neither branch could: stage 3 needed a
  `connectMongo()` that stage 1 was adding. Merging them made it possible and made a decision
  necessary — see below.

### The switch that was a file path's absence, three times over

design/21 §2.4's rule is *"collection is opt-in by env var, with no default path"*, and the
no-default half was carried **entirely by the path**: an unset `BB_ANALYTICS_DB_PATH` had nothing
to fall back to, so the deployment collected nothing. The same shape held the flag store
(`BB_OPS_DB_PATH`) and the backup worker's source list (`BB_DB_PATH` and friends).

`store(name)` always resolves. So a port that simply dropped those readers would have turned all
three ON for every deployment that upgraded — collection in the one subsystem with a privacy
policy attached, a writable database in the one process whose whole argument is what it cannot
write, and a backup worker reading whatever it found. Silently, by omission, with nothing red.

Each is now said out loud:

- `BB_ANALYTICS_ENABLED`, in `analytics/db.ts` — the leaf module both matchsvc and adminsvc
  import, so the collector and the console cannot disagree about a deployment's state. It was
  briefly duplicated (matchsvc had one copy, adminsvc would have needed another, because importing
  `matchsvc.ts` into the console drags `ws` and every route group into its bundle), which is
  exactly the arrangement the old path reader had — two two-line functions with a test pinning
  their answers to each other because nothing else could. One home needs no such test.
- `BB_OPS_FLAGS_ENABLED`, in `adminsvc/server.ts`.
- `BACKUP_STORES`, compiled into `backup/config.ts` and constrained by
  `satisfies readonly StoreName[]` — so the drift the three shared env-var names guarded against
  is a compile error at the declaration rather than a check at boot.

All three are OFF for both unset and empty, which keeps design/19 §9's `""`-beats-`??` trap closed
from the side that matters.

### Decision B1 lost both of its enforcement layers

*"The console cannot write player data"* was never a policy in this project. It was a capability
the process did not hold: `readOnly: true` handles, which SQLite enforced, behind `:ro` bind
mounts, which Docker enforced. `adminsvc.dbs.test.ts` asserted it by attempting an INSERT, an
UPDATE, a DELETE and a DROP through each handle and requiring a throw — the sentence was checkable.

Both layers are gone with the files, and what stands in their place is an Atlas ROLE, which lives
in the cluster's configuration where no diff and no test in this repository can see it.

So the process proves it at boot. `probeWriteAccess` upserts one document into
`_adminWriteProbe` on each player-data database and requires the server to refuse;
`assertReadOnlyAccess` refuses to start unless every one of them did, and `AdminWritableError`
is an `AdminStartupError` so `runMain` already turns it into exit 1 and a readable line.

Four things about it are deliberate:

1. **A real write, not `connectionStatus`.** The roles a credential CLAIMS is a different question
   from what this connection may do, and only the second one is B1.
2. **An idempotent upsert under a fixed id**, not an insert followed by a delete. The first
   version had the delete, and the delete needed a `catch` that swallowed its own failure —
   because a delete that threw would have escaped into the outer catch and reported a credential
   just proven WRITABLE as read-only, which is the one wrong answer this function must never give.
   That catch was also unreachable: a server that accepts the insert accepts the delete. The
   upsert removes the step and the branch together, and leaves something more useful than nothing
   behind — a correctly-scoped cluster never has the document at all, and one that does carries
   the time of the last boot at which B1 was observed to be false.
3. **The escape hatch is loud.** A local mongod has no roles, so the suite and every developer
   machine need `BB_ADMIN_ALLOW_WRITABLE`. The alternative to a hatch is skipping the probe when
   it is inconvenient, which is the version that silently never runs in production either. So the
   probe always runs, always logs, and a console running without B1 prints `readOnly: false` on
   every startup line — `main.ts`'s field stopped being the literal `true` it honestly was when
   the handles carried a mode flag, and became a measurement.
4. **`compose` is asserted never to contain the variable.**

`adminsvc.dbs.test.ts` proves both arms of the probe. The refusal arm is bought with a collection
VALIDATOR that makes the server reject every document — a genuine server-side refusal of a genuine
write, and **not an authorization refusal, which no test here can be**. What became untestable in
this repository is exactly the thing that moved out of it, and the file says so at the top rather
than letting a green suite imply the old guarantee survived.

### Every handler is async, so the console grew matchsvc's boundary

Same reason volume 66 gave for `matchsvc.ts`: a failover, a pool timeout or a dropped connection
arrives as a REJECTED PROMISE on an ordinary request, and Node answers an unhandled rejection by
killing the process. For a console it matters more — the process that dies is the one an operator
opened BECAUSE something was already wrong.

`readForm`'s callback form was deleted rather than kept beside the promise one. Every form handler
in this process now also reads the cluster, so the body callback is exactly where a network
failure surfaces and exactly where a callback has nowhere to deliver it; keeping both shapes would
have left the unusable one reachable and indistinguishable at the call site.

The boundary's two arms are genuinely different answers and only one is reachable through a route
here — every handler builds its whole body before it sends — so `reportRequestFailure` is exported
and driven directly, rather than left inline as a branch a coverage gate cannot tell apart from an
untested one.

### The views, and the injection shape that replaced SQL's

`searchPlayers`'s LIKE became a `$regex`, and the hole it can open is bigger than the one bound
parameters closed. SQL injection needed a quote to escape out of. A document store has no quotes
and two different holes in their place: a term that is an OPERATOR (`{ $ne: null }` matches every
account and needs no escaping at all), and a term that is a REGEX (`.*` is "list everything",
`(a+)+$` is a denial of service the SERVER executes). The `typeof` guard refuses the first —
re-established here rather than inherited from `URL.searchParams`, because that is a property of
the caller — and `escapeRegex` escapes the whole metacharacter class rather than enumerating the
dangerous ones, which is the only version that stays correct when somebody adds a character to the
pattern. `$options: 'i'` rather than a query collation, because `$regex` does not honour one and
asking for it would produce a search that is case-sensitive in a way nothing on the page explains.

`commerce.ts` cuts `raw` with `slice` rather than a `$substrBytes` projection: `raw` is arbitrary
UTF-8 a stranger chose, and a byte-wise cut can split a multi-byte character into an invalid
sequence. The cost is the whole document crossing the wire, on a page that reads fifty of them.

`retention.ts` keeps the `SELECT DISTINCT day … LIMIT 60` subquery's exact semantics — distinct
days over the WHOLE collection, not only over the three metrics it renders — so the grid's window
does not silently lengthen the day a metric is added.

### The backup worker, and what the format change cost

`VACUUM INTO` is a cursor per collection writing gzipped NDJSON in Extended JSON. The format is
readable by `zcat` and `mongoimport`, which is the property that decides whether a backup is usable
by whoever is holding it at 3am — and Extended JSON rather than plain JSON because
`entitlements._id` is an ObjectId whose embedded time IS the "oldest grant first" ordering, and
`JSON.stringify` would flatten it into a string that restores as a different document.

Two properties were lost, and both are written down where they went rather than glossed:

- **Point-in-time consistency ACROSS collections.** `VACUUM INTO` ran inside a read transaction
  over one file. A cursor per collection is consistent per document and not across them, so a
  settlement landing between the `orders` read and the `ledger` read appears in one and not the
  other. The alternative is a transaction with `snapshot` read concern held open across every
  collection — a long-running transaction against the live cluster, which is a worse trade for a
  worker whose job is to be invisible.
- **The capability, again.** It held no writable handle on anything, enforced by SQLite and by
  Docker. It holds a credential now. Unlike the console it does NOT probe that at boot, because a
  backup worker that refused to start over a too-generous role is a worker that stops taking
  backups over a permission it never uses.

`SNAPSHOT_RE` deliberately does not match the retired `.db.gz` names. A box upgraded in place still
holds them, and until the one-time migration has run and been verified they are the only copy of
the pre-migration data — which is exactly the window in which a retention policy that recognised
them would delete them, on schedule.

### The migration, and the three things that would have gone wrong quietly

`src/migrate/` maps sixteen legacy tables onto their collections and is pure over an injected
reader; `scripts/migrateFromSqlite.ts` is the SQLite reader, the arguments and the printing, and is
the last place in this repository that imports `node:sqlite`. Both carry their own deletion date.

**The absent-vs-null rule, in the direction that costs data.** `accounts.providerId` and
`orders.platformTxnId` are ABSENT, not null, because both sit under a PARTIAL unique index filtered
on `{$type: 'string'}`: one stored null is a value, so the index admits exactly one such document
and refuses the SECOND local account and the SECOND unsettled order. A migration that got this
backwards does not fail loudly — it stops half-way through, once, on the box.
`webhookEvents.orderId` and `reviewQueue.dayKey` go the other way and hold explicit nulls, because
a reader treats them as SQL's `IS NULL` did. Both directions are pinned against the real indexes.

**Two integer keys had to become ObjectIds without colliding.** `ObjectId.createFromTime` zeroes
the eight bytes after the timestamp, so a settled multi-SKU order — which mints several
entitlements in one millisecond — would have become ONE document with the rest silently
overwritten, under a report that said success. `legacyObjectId` builds the tail by hand from the
row's own integer: deterministic, so a re-run is an upsert, and ordered, so the integer's meaning
survives. A marker byte makes a migrated `_id` identifiable.

**Running it a second time after the cutover** would put every live document back to what the
`.db` file still says. Two guards, because neither sees what the other does: a completion MARKER
written only by a run that finished — the only signal that works for a string-keyed collection like
`metaState`, where a blob a player changed since the cutover looks exactly like the one the file
holds — and a driver-minted `_id` in a collection the migration keys by ObjectId, the backstop for
a box whose marker was lost and blind to the string-keyed ones, which is precisely why it is not
the only check.

`--dry-run` runs every mapping without writing, so a row that cannot be mapped is found before
anything moves.

### Deploy: three services stop writing to disk, and one variable becomes two

compose loses every `./data` bind mount for matchsvc, billsvc and adminsvc, and the backup worker
loses its two `:ro` source mounts — one writable bind mount is left in the whole project, and it is
`./backups`. `ci-deploy.sh`'s ownership-normalising loop shrinks to that one directory, and its
`:?` check list grows from two to four.

`BB_ADMIN_MONGO_URI` is a SECOND connection string, for the console alone. The fact that it is a
different variable is the whole of B1 as a compose file can express it, and
`deploy.manifests.test.ts` asserts that no other service shares it.

`data/` stays on the box, deliberately and with a comment saying so: nothing reads it, and it is
the only copy of the pre-migration state until the cluster has been serving long enough to trust.

### Tests, and four branches that were removed rather than covered

1,844 pass; 98.61% lines / 97.75% branches on the server. Three test files were deleted and each
says where its subject went — `billingDb.legacy.test.ts` and `legacyAccountsDb.ts` with the opener
they covered, and `flags.page.test.ts`'s three SQLite-era describes, whose one surviving question
(a `flags` document an operator broke by hand) moved to `flags.store.test.ts` rather than being
kept in two places.

Four uncovered branches in the new code were removed rather than left under a comfortable
whole-tree average, which is [design/18](../18-test-strategy.md) "Layer 4" applied to the module it
was written about: the probe's cleanup `catch` (gone with the cleanup), `BACKUP_STORES`'s runtime
check (the type constraint is stronger), an `opsDb !== null` guard only a test could reach, and a
re-wrapping `catch` in `snapshot.ts` whose message `runner.ts` already carried.

`src/migrate/` reached 100% lines / 98.33% branches by running all sixteen mappings and asserting
each whole document with `toEqual` rather than the interesting fields with `toMatchObject`. A
column dropped or renamed in a mapping produces a migration that reports success and a service that
finds `undefined` weeks later, on the only copy of the data — and a seventeenth table added without
a fixture fails a case written for exactly that.

`check.yml` caches the mongod binary, keyed on the pinned version rather than on a lockfile hash:
the `check` and `coverage` jobs each downloaded ~64MB per push without it.

### Every gate on the connection string was a PRESENCE check, and a placeholder passed all four

Found on the first attempt at the cutover, before it started. The runbook's one-liner was pasted
verbatim, ellipsis included, and `~/blightbloom/.env` on the live box came to hold
`BB_MONGO_URI=mongodb+srv://…` — twice, identically, for both users.

What makes it worth a section is how far that value travelled. `docker-compose.yml`'s
`${BB_MONGO_URI:?}` is satisfied by any non-empty string; `ci-deploy.sh`'s `grep -q "^$var=..*"`
by any single character; `mongo.ts`'s `if (!raw)` by the same; and `new MongoClient('mongodb+srv://…')`
**constructs without complaint**, because the driver's URI parser accepts `…` as a hostname. The
first component with an opinion is the SRV lookup inside `connectMongo()`, which — correctly, per
that module's "connect at boot, never lazily" argument — fails the service, but as a DNS error in
five containers during a cutover window, naming neither the variable nor the cause.

`mongoUriProblem()` (`src/mongo.ts`) now refuses two shapes at config time: a non-ASCII byte, which
is never legal in a connection string (a password that is not ASCII is percent-encoded first) and is
the signature of every way a placeholder arrives — a pasted `…`, a smart quote, a full-width IME
character; and a scheme the driver does not speak, plus the driver's own three-label rule for
`mongodb+srv` hosts, moved from a DNS error to a message naming the variable. `readBackupConfig`
calls the same helper rather than restating it, because the worker reads `BB_MONGO_URI` through its
own path and would otherwise have been the one service where a placeholder still booted — into a
failing cycle, which is a status file somebody has to go and read.

Two deliberate non-additions. A well-formed URI for the **wrong cluster** is not detectable here and
the §5 Players-tab check is what catches it. And there is no test that `BB_ADMIN_MONGO_URI` differs
from `BB_MONGO_URI`: `adminsvc/dbs.ts` already probes the role by attempting a real write and
refusing to boot unless the server refuses, which is the property B1 actually claims — a string
comparison would be a weaker restatement of a check that already exists. `ci-deploy.sh` was left
alone for the reason the 2026-09-08 backup incident records: a change to it does nothing until
somebody hand-reinstalls it on the box, so a guard there would read as protection that is not
deployed.

### Not done

**Stage 7 has not been RUN.** The runbook is in `server/deploy/README.md` §5 ("The MongoDB
cutover"), and it needs a window with the services stopped. Until it runs, merging this to `main`
deploys a server pointed at an empty cluster.

The `.env` half is **done and verified** — that part of this line is no longer true. Both
variables on the box hold real, tested credentials, mirrored into the `secrets` repo
(`secrets/blightbloom/prod.yaml`, SOPS+age, `push-env.py` reports no drift). The cluster, both
users' role matrices, the IP allowlist and decision B1's refusal were all probed against the live
cluster; §5's "verified 2026-09-15" list records what not to re-derive.

**What actually blocks the cutover now is the migration's PACKAGING.** §5 steps 3 and 4 invoke
`node --import tsx/esm scripts/migrateFromSqlite.ts` inside `blightbloom:latest`, and no image
this tree builds contains `scripts/`, TypeScript or `tsx` — the Dockerfile copies `dist/*.mjs` and
nothing else, and `build.mjs` declares five bundle entries with the migration not among them. The
suite is green because the migration is covered against a real cluster while the way it reaches a
production box is covered by nothing; `deploy.bundle.test.ts`, which boots each bundle as a bare
node process, is exactly the test that would have caught it had there been a sixth bundle to boot.

The fix is that sixth entry (`dist/migrate.mjs`, run as `node migrate.mjs --dir=/data`), plus a
`docker compose build` step between §5's 2 and 3 — the image on the box is still the pre-Mongo one
and the new one must exist before the migration runs without the services starting first.
