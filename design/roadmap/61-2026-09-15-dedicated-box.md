# Work log — 2026-09-15

Volume 61. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The backend gets hardware of its own (2026-09-15, deploy + infra + docs, no engine change)

*"I am going to buy this game a dedicated server"* — and the interesting part of this pass is not the move. It
is how much of `server/docker-compose.yml`, `prometheus.yml`, `config.alloy` and
`deploy/ci-deploy.sh` turned out to be describing **the landlord rather than the services**.
Since 2026-09-07 the three planes had run as a guest on a box belonging to somebody else,
borrowed for its idle spare capacity. Four things in the deployment existed only because of
that, and every one of them had a comment explaining itself, which is the only reason they
could be told apart from decisions with live reasons:

- **The reverse proxy was somebody else's.** This project's entire footprint on that machine
  was ONE site block appended by hand to the host's own Caddyfile, a file fronting three
  other site blocks as well as us. It is now `server/caddy/Caddyfile`, a tracked file shipped
  with every deploy — same four-way `handle` split, upstreams named by compose SERVICE
  (`matchsvc:8788`) rather than by container, because our Caddy is inside the project now.
- **The network was theirs.** An `external: true` network existed so that THEIR
  Caddy could resolve OUR container names. Both halves of that arrangement left with the box.
- **Prometheus scraped their exporters.** The host's own cAdvisor and node-exporter —
  the right trade on hardware we did not own (a second privileged cAdvisor mounting `/`,
  `/sys` and `/dev/kmsg` to recompute numbers that already existed one DNS name away), and a
  trade whose stated cost was that another team renaming a container emptied every infra panel
  here. `obs-cadvisor` and `obs-node-exporter` are ours now.
- **Nothing was named after the game** so that nothing about it appeared on a machine
  belonging to someone else. Containers are `bb-*` and the image is `blightbloom:latest`; the
  disguise cost nothing while it was true and reads as somebody else's container on a box
  that is ours.

**What did NOT change is the more useful half.** The `obs-` prefix stays, the Alloy discovery
filter stays, and both now guard something smaller than they were written for — so both say so
in their own comments and in the test that enforces them. A rule whose reason has quietly
expired is one nobody can evaluate later, and `deploy.observability.test.ts` now names which of
the two states it is asserting: the prefix has stopped preventing a DNS collision on a shared
network and started being what makes `docker compose ps` legible and what five other files
spell out. design/19 §10's *"two facts about the host that shaped the deployment"* are both
marked **EXPIRED** in place rather than deleted, for the same reason.

**The cutover was shaped by one fact about Caddy**: it attempts the ACME challenge the instant
its config loads, which on 2026-09-07 cost a ~10 minute backoff when the site block was
reloaded before the DNS record existed. So the order was — ship and start **everything except
`caddy`**, verify from the inside where no hostname is involved (each `/health` over
`docker exec`, `up == 1` on all eight scrape targets, and Loki's own `label/svc/values` to
prove collection works under the new container names), stop the old stack, re-copy the
databases with nothing writing either side, move the A record, and only then start the proxy.
The certificate signed on the first attempt. **It also corrected a claim this pass had written
into three files**: the comments said port 80 must stay open because it is the HTTP-01
challenge path — but the watched issuance solved `tls-alpn-01` on 443 and never touched 80.
Port 80 carries the HTTP→HTTPS redirect and the `http-01` **fallback**, which is worse to get
wrong than it sounds: closing it breaks nothing on the day it is closed and removes the spare
tyre from a renewal two months later.

**A uid, chosen rather than inherited.** The deploy account is `deploy` with **uid 1000** — the
same uid the container's `node` user has — where the borrowed box's `tao` was 1001. That one
number is why `ci-deploy.sh`'s ownership normalisation is a no-op in the steady state instead
of the rite it became on 2026-09-09, when `mkdir data/adminsvc` failed with `Permission denied`
and aborted a deploy. The normalisation stays, because a directory **Docker** creates because
nobody created it first is still `root:root`, and that is the actual 2026-09-08 bug (18 hours of
silently failing backups, CI green throughout).

**The pass's own expensive lesson was line endings.** Three separate edits to
`monitoring/alloy/config.alloy` reported success and changed nothing: the file is CRLF under
Windows `core.autocrlf`, the patterns were LF, and a `str.replace` that matches nothing is not
an error. `server/.gitattributes` now pins every file shipped to the box to LF — not tidiness,
since a CRLF `ci-deploy.sh` dies on the far end as `$'\r': command not found` (the reason
README §2's install line has always piped through `tr -d '\r'`), and a stray `\r` inside a
scrape target resolves to nothing at all.

**New assertions rather than renamed ones.** `EDGE_SERVICES` is its own category in
`deploy.manifests.test.ts` because `caddy` is the first service here to publish a host port and
therefore the first whose misconfiguration is reachable from the internet: exactly three ports,
80 among them, and **no other service publishing anything**. That last clause is the one worth
having — `ufw` cannot catch it, because Docker publishes a port by writing its own iptables
rules ahead of ufw's chain, so a `"9090:9090"` added to `obs-prometheus` during a debug session
puts an unauthenticated metrics browser on the public internet while the firewall still reports
the port closed. cAdvisor also got explicit flags (`--housekeeping_interval=30s`,
`--docker_only`, `--store_container_labels=false`): its defaults housekeep every cgroup once a
second, which on 2 vCPUs makes the monitoring the largest single CPU consumer on the box.

Walked, not assumed: twelve containers (eleven healthy, `bb-alloy` with no health column by
design), every public acceptance row from §4 including `/metrics` and `/admin/health` answering
404 while `/admin/` serves the console, `/client/flags` returning exactly two keys with
`cache-control: no-store` read off the GET, `ss -tlnp` showing only 22/80/443 bound publicly,
a verified backup cycle of all three databases on the new box before the old one was touched,
and a real payload pushed over the forced-command key — which was first proven to restrict by
asking it to run `cat /etc/shadow; id` (it ran the deploy script instead) and by `ssh -tt`
being refused a PTY. A full `--force-recreate` afterwards produced **zero** ACME lines, which
is the check that `caddy-data` is a named volume rather than something a deploy can clear.

The borrowed box is clean: block removed from its Caddyfile with `cp` rather than `mv` (that
file is a single-FILE bind mount, so a rename changes the inode and leaves `validate` and
`reload` both reporting success against the stale one — 2026-09-09's full-day diagnosis), its
four neighbours confirmed still routed by reading Caddy's own loaded config rather than by
guessing at a 404, and the deploy directory with its volumes, image and script backups all
gone. **One thing could not be finished from here**: `~/.ssh/authorized_keys` on that machine
is root-owned, so the retired deploy key's line has to be removed by whoever has its `sudo`
password. It is already inert — its forced command names a script that no longer exists — but
inert is not revoked. *(Revoked the same day, by the owner running two prepared scripts — see
"Leaving a borrowed box is a second job" below.)*

> **"Clean" meant the stack.** A sweep of the box later the same day found what a
> `compose down` does not touch — see "Leaving a borrowed box is a second job" below.

Two things were left open at the end of the move and both were decided the same day, by the
person who has to act on them — recorded because one of the decisions **reshapes the item rather
than closing it**. The off-box copy of the backups was going to want a scheduled pull from
somewhere that is not this VM; the answer instead is that **player data moves off SQLite onto a
database**, which makes "a verified copy that survives the box" a property of that store rather
than something to build here. Good answer to that problem — and not to its twin, which this pass
had paired it with: alerting. A managed database survives the VM; nothing in it notices that the
game stopped answering, and "the whole box is gone" still produces no signal at all, because the
dashboards that would report it are on it. So they stop being one problem with one answer. The
retired deploy key on the old box (root-owned `authorized_keys`, inert but not revoked) is the
box owner's to remove — done later the same day. `platform` `test` `docs`
