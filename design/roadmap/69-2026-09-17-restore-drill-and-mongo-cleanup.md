# Work log — 2026-09-17

Volume 69. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The backup gets restored, and the runbook it was restored from was wrong in three places (2026-09-17, deploy + docs, no engine change)

[Volume 68](68-2026-09-16-mongodb-cutover.md) ended with the cutover done and four things open
that it had *enabled* rather than closed. This pass closes three of them and turns the fourth
into a written trigger. **No code changed** — every deliverable is either a fact about the live
system or a correction to a document that read as verified: a restore that has actually been
performed, a live deploy script that matches its repo copy again, an empty pre-migration
footprint on the box, and four paragraphs that were wrong.

### A backup nobody has restored is a hypothesis

The `backup` worker has been writing verified gzipped-NDJSON snapshots since the cutover, and
`zcat … | mongoimport` has been written down since the day before it. Neither fact is a restore.
So: 174 documents out of the box's own `2026-09-16T08-58-59Z` snapshots and back into a database,
**twice** — first into a throwaway `mongo:7.0` server on the box, then into scratch collections
on the live cluster.

**Counts are not the check.** A JSON round trip that squashes an ObjectId into a string restores
exactly the right *number* of documents. So the comparison was between representations:
`mongoexport --jsonFormat=canonical` out of the restored collection against `jq -c .d` out of
the snapshot file, both `sort`ed, then `diff`. All six collections came back **byte-identical**,
both times. The 169 ObjectIds stayed ObjectIds — including the migration's `0xbb` marker byte at
offset 4, which is still legible in `6aa169e7bb00000000000100` and is the only reason a document
id carries the meaning of the integer id it replaced. `--jsonFormat=canonical` is load-bearing
in that diff: the worker writes `EJSON.stringify(…, { relaxed: false })` and relaxed output
differs on every `$numberLong`.

Two smaller claims got checked while the apparatus was up. `--mode=upsert` really is repeatable
— a second identical run reports `0 document(s) imported`, which is success and reads like
failure. And **a drill needs no downtime**: the `docker compose stop` in the procedure belongs
to a real restore over live collections, not to a restore into a scratch target, which is the
whole argument for preferring one.

Production was untouched, and that was verified rather than asserted: all four databases'
collection counts were captured before and after and diffed clean, and the six scratch
collections were dropped.

**What a drill cannot reach yet.** `billing`'s snapshot is 20 bytes — six empty collections —
and `accounts.entitlements`, the only other collection whose `_id` is an ObjectId, is empty too.
So the money half of the backup is verified as a FILE and has never been verified as a restore.
That does not close until something sells, and saying so is the point: "the restore is drilled"
would otherwise imply more than happened.

### Three things the written procedure said that were not true

None of these is a bug in the worker, and none was findable by a test. They are facts about this
box and this cluster, which is the class of thing only running the procedure produces.

1. **The box has no `mongoimport`, no `mongosh` and no `jq`** — and `mongodb-database-tools` is
   not in Ubuntu's own repositories, so "install it" is not a one-liner either. The restore now
   runs inside `mongo:7.0`, which carries all of them, with `backups/` bind-mounted read-only.
   The image is left on the box on purpose: an incident is the wrong time to need 1.18 GB off
   the internet first. This is the version of *"a restore needs no tooling from this repo"* that
   is actually true — one pinned public image and nothing else.
2. **A scratch DATABASE is refused, which is what the procedure told you to use.** `bb-app`'s
   Atlas roles are `readWrite` on the four database *names*, so `--db restore_check` answers
   `AtlasError: user is not allowed to do action [insert] on [restore_check_accounts.probe]` —
   and `BB_MONGO_DB_PREFIX`, the mechanism that would create one, is therefore useless here.
   Nor can the grant be issued from this side: the Atlas API key this repo holds
   (`secrets/infra/atlas.yaml`) belongs to funny's project, not this cluster's. What works is a
   **collection prefix inside `ops`** — the one logical database with no player data in it, and
   the one the worker deliberately does not snapshot. `ops.zz_drill_*`, dropped afterwards.
3. **`set -a; . .env` yields an EMPTY variable, and nothing says so.** The connection string
   ends `?retryWrites=true&w=majority`; a shell sourcing that line reads the `&` as "background
   this assignment", so the value lands in a subshell and never reaches the caller. `mongosh ""`
   then tries `127.0.0.1:27017` and reports `ECONNREFUSED`, naming neither the variable nor the
   cause — the same shape as the placeholder-URI failure volume 68 records, one layer further
   out. `sed -n 's/^BB_MONGO_URI=//p'` instead. `docker compose` is unaffected: it parses `.env`
   itself and no shell is involved, which is exactly why this could sit here unnoticed.

### The live deploy script was two days stale, and installing it found a rewritten coreutils

`/home/deploy/blightbloom-ci-deploy.sh` still dated from before the MongoDB port, so its `.env`
guard did not check `BB_MONGO_URI` or `BB_ADMIN_MONGO_URI` — the two values `compose up` now
refuses every service without — and its ownership loop still created three `data/*` directories
nothing mounts. Nothing was broken by that; the guard whose whole job is to make a deploy log
NAME the missing variable was simply absent, which is the third time this file has paid for
being hand-installed by design.

The install command in the README could not run. Ubuntu 26.04 ships **uutils coreutils** (the
Rust rewrite) as `/usr/bin/install`, and there `install /dev/stdin <dest>` fails when the source
is a **pipe** and the destination **already exists**:

```
removed '/home/deploy/blightbloom-ci-deploy.sh'
install: No such file or directory
```

Both halves of that are worth keeping. The `ENOENT` is for the *source*: `/dev/stdin` →
`/proc/self/fd/0` → the magic link `pipe:[5179570]`, which uutils re-opens by name instead of by
descriptor. And **the `removed` line is a lie** — the inode is unchanged afterwards and the old
script survives intact, so the three failed attempts that found this destroyed nothing. A `-v`
transcript claiming a removal is not evidence that anything was removed. It had never fired
before because every install on this box was the first one (fresh machine, 2026-09-15) and every
install before that was on the borrowed box, which ran GNU coreutils. Writing to `…sh.new` and
`mv -f`-ing it over sidesteps it, and is an atomic replace besides — worth having anyway, since
uutils truncates the destination in place and the documented command was never atomic.

**The forced command was re-verified after installing, which is the point of installing.** All
three halves hold: asking the key to run `cat /etc/shadow; id` runs `ci-deploy.sh` regardless
(it rejects the non-tar.gz stdin and never reaches the command), `ssh -tt` gets `PTY allocation
request failed on channel 0`, and a `-L` tunnel is accepted by the local client and then reset
by the server on first use, so `restrict`'s `no-port-forwarding` is doing its half too.
`authorized_keys` is still one line.

### The pre-migration copies are gone, and what was checked before deleting them

`data/`, `/root/pre-mongo-20260916T063739Z.tar.gz` and 42 retired `*.db.gz` were the only copies
of the pre-migration state, kept for a day after the cutover. The clock was not what closed the
window — the drill above was, plus a row-for-row check of the files themselves. `python3`'s
`sqlite3` module read all four `.db` files (the box has no `sqlite3` binary) and every table's
count was present on the cluster: `accounts` 2, `sessions` 2, `meta_state` 1, `daily_active` 7,
`daily_rollup` 88 (99 by then — the rollup job kept running), `events` 74, `flags` 1, and ten
tables empty on both sides.

Two of those ten are `ratings` and `rating_reports`, and they are worth naming because their
**collections do not exist on the cluster at all** — which looks like a hole in the port and is
not one. `db.ts` declares both; MongoDB materialises a collection on first write; an unrated,
unsold game has had no first write. An absent collection is not an absent table, and the cheap
way to tell the difference is to read the code rather than the collection list.

The tarball's four members hashed identically to the live `data/`, so one of the two was always
redundant. `data/` does not come back on the next deploy either: compose has no `./data` bind
mount and `ci-deploy.sh`'s ownership loop is down to `backups` alone. All twelve containers
stayed healthy across the deletion and the worker took a verified cycle afterwards
(`accounts` 5, `billing` 0, `analytics` 180).

### What is left, and the one item that became a trigger instead

The cluster tier has no point-in-time recovery, so an operator error is recoverable only to the
last daily NDJSON cycle. That stays as it is, deliberately — today the irreplaceable data is two
accounts and a rollup table, both reconstructible from a day-old snapshot with nobody out of
pocket, and PITR means a tier change with a bill rather than a checkbox. What this pass added is
the **trigger**, written into `server/deploy/README.md` §7 and `design/19` §9 so it is a decision
and not a drift: re-evaluate when **the first real payment settles**, not when the Paddle
credential arrives. After that, "recoverable to the last daily cycle" means a player can have
paid inside a window the restore silently discards, and `ledger`/`receipts` stop being
reconstructible from anything this project holds.

Still open, unchanged: the off-box copy of the backups (§7 item 3), and the money half of the
backup, which cannot be drilled until there is money in it.

### Numbers

- **174 documents** restored and diffed byte-identical, twice; **169** of them ObjectIds.
- **3** corrections to the restore procedure, **1** to the install command, **2** documents
  closing the same open item from different directions.
- **47 files deleted** from the box (4 `.db`, 42 `.db.gz`, 1 tarball) after **16 tables** were
  checked row-for-row against the cluster.
- **12/12** containers healthy throughout; production collection counts before == after.
