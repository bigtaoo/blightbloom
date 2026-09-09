# Work log — 2026-09-09

Volume 52. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The deploy that reported success three times while nothing changed (2026-09-09, deploy + server + docs, no engine change)

Volumes 47–50 built the observability stack, analytics, the ops console and client flag
delivery, and left all of it unpushed. This is the deploy: `main` was seven commits ahead of
`origin/main`, and a push deploys client and server. Nine containers now run on the borrowed
VPS, and every row of [`server/deploy/README.md`](../../server/deploy/README.md) §4 has been
walked against the live host.

What is worth writing down is not that it landed. It is that **three separate things reported
success while having done nothing**, and each one had a different mechanism. The runbook
predicted one of the three, named the right symptom, and pointed at the wrong cause.

### The two hand steps were right, and there was a third nobody had written down

§2's two hand steps — `BB_ADMIN_PASSWORD` into `~/wnet-test/.env` (compose's `:?` refuses
*every* service without it), then a `handle /admin*` block ahead of the catch-all — were
correct and sufficient as written. Reading `~/wnet/docker/Caddyfile` first was also right:
a `bb.gamestao.com` block was already there from volume 47, so the snippet's append would
have produced a duplicate.

The third step is the one that matters, because skipping it is silent in the direction that
costs data. `ci-deploy.sh`'s live copy at `~/wnet-test-ci-deploy.sh` is **hand-installed by
design** — the CI key must not be able to rewrite its own forced command — so editing the repo
copy does nothing, and CI going green is not evidence the new check ran. The live copy predated
adminsvc entirely: no `dist/adminsvc.mjs` in the payload check, no `data/adminsvc` in the
ownership loop, no `adminsvc:8790:/admin/health` in the health loop. Deploying with it would
have let compose create that bind-mount source `root:root` and reproduced 2026-09-08's
eighteen hours of silent backup failure, with CI reporting success both times.

This is the same shape 2026-09-08 already recorded — a guard that existed only in the repo —
and it recurred nine days later on the same file. The standing `diff` check is the whole
defence:

```bash
ssh wnet-server 'cat ~/wnet-test-ci-deploy.sh' | diff - server/deploy/ci-deploy.sh && echo IN-SYNC
```

Install with `tr -d '\r'`. `core.autocrlf=true` and no `.gitattributes` means every shell
script in this repo is CRLF in a Windows worktree and LF in CI, and a CRLF script dies on the
box with `$'\r': command not found`.

### Failure 1 — the ownership loop could fix a state dir but not create one

The first deploy died at `mkdir: cannot create directory '/home/tao/wnet-test/data/adminsvc':
Permission denied`. `~/wnet-test/data` is uid-1000-owned — container `node` (1000) equals host
`elkadmin` (1000) on this box — while the account CI logs in as is 1001. So the deploy user
cannot create anything under `data/` at all.

It had never shown up because **`mkdir -p` is a silent no-op for a directory that already
exists**, and every directory did, for as long as the set never grew. The first new one broke
it. Fixed by moving creation into the root container that was already there for the chown, and
only on that path — `backups` sits at the top level, which the deploy user owns, so its plain
`mkdir` succeeds and no wide mount is ever taken for it.

Loud, at least. This is the good half: the check that had been added to the script for
adminsvc is what turned a silent `root:root` mount into a failed deploy.

### Failure 2 — a failed backup cycle was a 24-hour decision

The second deploy died at `wnet-test-backup: no healthy backup cycle within 15s`. The worker's
first cycle runs immediately at boot, which is what gives a fresh deploy a verified snapshot in
seconds. It also **races the services that create the databases it reads**: it ran 0.6s before
matchsvc created `analytics.db` — a *new* third backup source, from volume 48's retention
instrumentation — recorded the source as failed, and then slept the full 24-hour interval.

One lost race by half a second cost a day of snapshots and failed every deploy, because
`ci-deploy.sh` demands a healthy cycle. A failed cycle now retries from a 60-second floor,
doubling to the interval: the immediate cycle keeps its purpose without that one attempt being
decisive, and a permanently broken source degrades to one attempt per interval — the old
behaviour, reached rather than assumed.

**Making `retryDelayMs` pure and testing it was not enough**, and that is the transferable
part. Reverting the loop body to `sleep(cfg.intervalMs)` leaves every one of those cases green
while restoring the exact bug. So `runForever` took a `LoopDeps { now, io, sleep }` seam and the
test *is* the thing the loop waits on — it drives a source that fails once and then succeeds,
and asserts the delays in order. Verified by control run: the two loop tests go red against the
reverted loop, the pure ones do not.

### Failure 3 — the Caddyfile edit that `validate` and `reload` both confirmed

`/admin/` came back as `{"error":"not found"}` — byte-identical to matchsvc's catch-all 404,
which is precisely the trap §3.4 of [design/21](../21-ops-analytics.md) names and §2 repeats:
*getting the ordering wrong is not an error, it is the console's page answered by matchsvc's
404 handler, a blank page with a 200.* The ordering was right. The block was in the file,
ahead of the catch-all, and the file was validated and reloaded.

`docker inspect docker-caddy-1` says why: the mount is
`/home/tao/wnet/docker/Caddyfile -> /etc/caddy/Caddyfile`, a single **file**, so it is bound to
that file's **inode** and not to its path. The edit had gone in with `awk … > new && mv new
Caddyfile`, and `sed -i` for a follow-up fix — both of which write a new file and rename it over
the old name. The host path then pointed at a new inode while the container kept the old one.
And so:

- `caddy validate --config /etc/caddy/Caddyfile` read the stale inode and printed
  **Valid configuration**,
- `caddy reload --config /etc/caddy/Caddyfile` reloaded it and logged `adapted config to JSON`,
- and the route never existed.

Every command reported success and the config never changed. The only check that actually
proves a Caddyfile edit reached Caddy is comparing the two inodes:

```bash
ssh wnet-server 'stat -c "host %i" ~/wnet/docker/Caddyfile
  docker exec docker-caddy-1 stat -c "container %i" /etc/caddy/Caddyfile'
```

So **edit in place and keep the inode** — `cat >>` (which is what §2's own snippet does, and
why volume 47's Grafana block worked) or `cp new Caddyfile`. Never `mv` over it, never `sed -i`.

Recovery has a wrinkle worth keeping: the mount is `:ro` inside the container, so you cannot
write back through it, and the replaced inode has no name left on the host — there is nothing
to repair. Routing was restored with zero downtime by `docker cp`-ing the good file to a
writable path in the container and `caddy reload --config /tmp/… --adapter caddyfile`. That
leaves the in-container path stale, so the next person reloading from it silently reverts the
block; `docker restart docker-caddy-1` re-resolves the bind mount to the host path and collapses
the split. That restart is the box owner's shared proxy fronting `wnet-mock.elk.de`, the
IP/hostname device block and `sync.gamestao.com`, so it was asked for rather than assumed, then
done and verified — both inodes equal, all four site blocks answering.

**After any reload, curl the neighbours, not just your own site.** A reload replaces the whole
config, and three of the four blocks in it are not ours.

### What the checklist found that the checklist was wrong about

All fifteen §4 rows pass. Two of them could not have.

- The **`cache-control: no-store`** sub-row asked for `curl -sI`. matchsvc routes on
  `req.method === 'GET'`, so a HEAD request falls through to the catch-all and returns **404** —
  the very failure that same row calls out three lines earlier as *the one row in this list where
  a 404 is the failure*. Read it off the GET with `curl -sD - -o /dev/null`.
- The **`/admin/health` returns 404** row passes for the wrong reason if read before the row
  above it: a missing `/admin*` block produces an identical 404. The row above is the only thing
  that proves the prefix reaches adminsvc at all, so the ordering is now stated in the file.
- And the row reading *"all three tabs answer"* never learned about the fourth. **Flags** arrived
  with §4 of design/21 and the row that verifies the console did not change, so a missing Flags
  tab was a thing nobody was looking for.

The flag round trip is worth recording as verified end to end, because it crosses every layer
this volume and the four before it built: a value typed into the console's form → `ops.db` →
matchsvc's 60-second poll → `GET /client/flags` → a real browser, rendered above the main menu.
Then cleared, and confirmed gone. The public route exposes exactly two keys while the internal
feed carries all four, which is the partition that keeps `match.pvpBotBackfillDelayMs` — a value
that would tell a player which opponent was not a person — off a public surface.

Two smaller things the pass turned up: Loki's backend label is `source="backend"`, and a wrong
selector returns **no series**, which reads exactly like nothing shipping logs rather than like a
typo. And `ver=` now carries a real build sha on the client stream, so volume 47's follow-up fix
holds in production — the field that was `unknown` for every client, which is worse than absent,
because a constant looks like an answer.

### Tests, and the one that would not have caught anything

Four suites gained assertions. The backup loop's pacing is above; the other three pin
`ci-deploy.sh`, and all three passed every existing assertion in `deploy.manifests.test.ts`
before being written:

- **Creating a state dir.** The existing test pinned *which* dirs get normalised, not that the
  script can make one — a different property, and it was false. Asserted as a shape (no unguarded
  `mkdir`, plus a container-side fallback), because a revert to the bare form is what has to go
  red, and matching the exact command would pin a spelling instead.
- **The health loop.** Port and path are literals there, so a copy-pasted entry polls the
  neighbour's port and reports a dead container healthy — the same failure the compose
  healthchecks in that file already guard, one file over and unguarded. Ports now come from
  compose's own `expose`, paths from the route module.
- **The required-variable set.** Both `:?` credentials were pinned individually; the set was not.
  A third would fail every service with compose's own opaque *"required variable is not set"*
  instead of the script's named explanation — and on an existing box, since `.env` is the one
  file CI cannot ship. Derived from compose, so it holds for a variable nobody has written yet.
  `BB_ADMIN_PASSWORD` was added to both places together; nothing had made that a requirement
  rather than a habit.

Each was control-run: the bare `mkdir`, adminsvc polled on `/health`, matchsvc polled on
billsvc's port, and an unchecked third `:?` variable each turn exactly the intended test red.

**The test that does not exist is the one for failure 3**, and it is worth saying why rather than
leaving a gap that looks like an oversight. The inode trap is a host filesystem operation against
a file this repo does not own and does not ship. The nearest testable thing would be linting the
runbook's prose for `mv`/`sed -i`, which pins wording rather than behaviour. It is recorded in §2
and in memory instead — which is the honest place for a fact no gate can hold.

### One process note

`check` went red once, at `4908cd1`, and not for a reason on the box: a scripted `snapshot` in a
new test omitted `Snapshot.source`. **vitest transpiles without typechecking**, so the file was
green in the runner and red under `tsc --noEmit`. Both local commands had been run — `tsc` before
the tests were added and vitest after — so neither covered the final state. The full
`npm run check` is the only thing that does, and it belongs after the last edit rather than
somewhere in the middle.

### Left deliberately

- **`acc_check_0909` is still the only row in `accounts.db`.** Rows 2 and 5 of §4 need a real
  session, so registering an account was unavoidable. Removing it is a CLI script on the box,
  because neither the console nor the deploy key can write player data — which is decision B1
  working rather than an inconvenience. Recorded in §4 rather than left as a leftover test
  account nobody wrote down, since that is indistinguishable from a real one.
- **`BB_CG_GAME_ID` is still unset**, and matchsvc says so at every startup. Unchanged by this
  deploy; it needs a game id CrazyGames has not assigned.
- **The off-box backup copy** remains §7's open item. The worker verified its snapshots through
  this deploy, on the same disk as the databases.
