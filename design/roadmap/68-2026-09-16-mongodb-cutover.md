# Work log — 2026-09-16

Volume 68. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The cutover runs, and the migration deletes itself (2026-09-16, server + deploy + docs, no engine change)

[Volume 67](67-2026-09-15-mongodb-stores-and-console.md) ended with the port complete and the
data still on the box. This pass packages the migration so it can reach a production machine at
all, runs it against the live box, merges the port, and deletes the migration. Four `node:sqlite`
files are now four logical databases on an Atlas cluster holding real player data, and the last
import of the builtin is gone from the repository.

### The command in the runbook could not run, and nothing could have told us

`server/deploy/README.md` §5 — the cutover's own procedure, written the day before — said to run
the migration's TypeScript source under `tsx`, out of a `scripts/` directory, inside
`blightbloom:latest`. That image is built by `COPY dist/*.mjs ./` and nothing else. There is no
`scripts/` in it, no TypeScript, and no `tsx`. The first command of the cutover would have failed
on a stopped production box, at the one moment when the services are down and the only copy of
the data is a tarball somebody took four minutes earlier.

The suite was green the whole time, and the shape of that is the part worth keeping:

- `test/migrate.test.ts` drove `src/migrate/` against a real cluster through an injected reader.
  Every mapping, both refusals, 100% lines. It says nothing about whether the thing an operator
  types exists.
- `test/deploy.bundle.test.ts` boots every bundle as a bare node process — the layer built
  precisely because "the build passed" and "the service runs" are different questions. It could
  not catch this, because there was no sixth bundle for it to boot.

So the coverage was real and the hole was real at the same time. The migration's LOGIC had tests;
the way it reaches a box had none. That is a general shape, not a typo: a step that only ever runs
once, by hand, on the day everything is stopped, is exactly the step nothing routinely exercises.

### The fix, and what it left behind after the tool was deleted

`dist/migrate.mjs` became a sixth bundle entry, so the command is `node migrate.mjs --dir=/data` —
the same shape as every other process here. `node:sqlite` needed no `external` entry (esbuild
leaves `node:`-prefixed builtins external on `platform: 'node'`); `mongodb` was already both
external and in `deploy/package.json`.

Two tests came with it, and both are the missing layer rather than more of the layer that was
already there:

- **`deploy.bundle.test.ts` ran the shipped bundle** against real `.db` files written by the same
  builtin that wrote the ones on the box, and a real cluster, **in the runbook's own order** — dry
  run, real run, and the refusal that stops a second one. The fixture was three pairs wide, one
  per trap the port would otherwise have shipped: two accounts where only one carries a
  `provider_id` (a stored `null` under a partial unique index admits one and refuses the other),
  two entitlements granted inside one second (`ObjectId.createFromTime` zeroes the tail and
  collides them), and two unsettled orders (the same index trap on the payment path).
- **`deploy.manifests.test.ts` checked the command written in the README** against the filename
  the build emits. A runbook command is deployment configuration too — it is one more copy of a
  filename that no compiler compares, which is what that whole file exists for.

Both were mutation-checked before being believed: renaming the entry to `migrateXX` turned five
cases red across the two files, which is the control that separates a test from a paragraph.

`service: true|false` on a build entry is what survives the tool's deletion. `deploy.manifests`
cross-checks bundle filenames against compose's `command:` lines, so a bundle nothing runs on a
schedule fails it, and the fix a tired operator reaches for is an exemption list. The flag says
"this one has no service" in a way the test can read. Every entry is `true` again today, and the
case that holds a tool bundle to the rules that *do* apply to it — no compose service may run it,
the deploy payload must still carry it — reads as a no-op until somebody adds the next one.

### What actually moved

Stop the five writing services, leaving Caddy and the observability stack up. Snapshot `data/` by
hand, because the backup worker had already stopped reading those files. Ship the payload and
`docker compose build` with **nothing started** — the image on the box predated the port, so the
new one had to exist before the migration ran and no service could start before it, which is the
step the runbook was missing. Then the migration in a throwaway container with `data/` mounted
read-only: `--dry-run`, then for real. Then `up -d --force-recreate`.

175 rows: 2 accounts, 2 sessions, 1 meta_state, 74 events, 7 daily_active, 88 daily_rollup, 1
flag. Zero in the billing plane, which is correct — nothing has been sold. Every collection ended
up holding at least what its table did, which is the count the migration checks rather than
trusting its own write tally.

**Decision B1 was proven against the live cluster at boot**: adminsvc logged three refused write
probes — `accounts`, `billing`, `analytics` — and came up `readOnly=true`. Volume 67 recorded that
the refusal arm could not be an authorization refusal in any test here, because a local mongod has
no roles to refuse with and a collection validator had to stand in. This is the first time the real
refusal ran, in the place it has to hold.

The acceptance pass afterwards: twelve containers healthy, `/health` answering, `/client/flags`
returning exactly its two public keys with `cache-control: no-store`, 404 on `/metrics` and
`/admin/health`. Then the row that catches what a successful-looking migration can still be — the
console's Players tab lists both real accounts and Retention reads all 88 rollup rows. An empty
Players tab after a migration that reported success means the services are pointed at a different
`BB_MONGO_DB_PREFIX` from the one the migration wrote, and nothing else in the checklist would
have said so.

### Deleting it, and what a deletion has to leave

`src/migrate/`, `scripts/migrateFromSqlite.ts`, `test/migrate.test.ts` and the build entry are
gone, which was their stated expiry from the day they were written. The repository imports
`node:sqlite` nowhere.

Three things were kept rather than deleted with them, each because deleting it would have removed
the reason rather than the code:

- **`data/` stays on the box.** Nothing reads it; it is the only copy of the pre-migration state
  until the cluster has served for long enough to trust. The backup worker's pruner deliberately
  cannot see the retired `.db.gz` names, so retention cannot age them out during exactly the
  window they matter.
- **§5 of the deploy README is now a record, not a procedure** — what ran, in what order, what
  moved, and what was checked. It ends with how to bring the migration back if a discovery days
  later needs it: the code is in git as of the commit that deleted it, restore three paths,
  rebuild, run with `--force`. A completed run leaves a marker in the `ops` store and a second run
  without that flag is REFUSED, because every upsert would put a live document back to what the
  `.db` file still says.
- **The `service` flag and its test case**, above.

The runbook also lost two commands that could not work: its `rsync` lines named
`blightbloom:~/blightbloom/`, and `ssh blightbloom` lands as **root**, so `~` is `/root` — a copy
would have created a directory nobody deploys from and reported success. There is no `rsync` in
Git Bash on the workstation either. Both are `tar | ssh` with full paths now.

1,853 tests green, coverage unchanged (nothing under `src/` was added; the migration's own
coverage left with it).
