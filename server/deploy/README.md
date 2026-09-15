# Deploying the backend

> **Status (2026-09-15): moved to dedicated hardware.** The backend now runs on a
> Hetzner CX23 of its own — `blightbloom`, `62.238.1.182`, Helsinki, 2 vCPU / 4 GB / 40 GB —
> at `~/blightbloom/` under a non-root `deploy` user, with its own Caddy, its own network and
> its own cAdvisor/node-exporter. Twelve containers. Everything below that read as a property
> of the box rather than of the services was rewritten in that pass; the history is kept
> wherever it explains a shape, because most of what this file knows was learned the expensive
> way and none of it stopped being true about how Docker, Caddy and SQLite behave.
>
> **What the move changed, in one list:** the reverse proxy is `caddy/Caddyfile` in this repo
> instead of one appended block in a Caddyfile belonging to somebody else; the compose network
> is ours instead of the host's shared external one; containers are `bb-*` instead of a
> neutral disguise; Prometheus runs its own two exporters instead of borrowing the host's;
> and the deploy account is `deploy` (uid 1000, matching the container's `node`) instead of
> `tao` (1001), which makes the ownership dance in §1 a no-op instead of a rite. The
> `authorized_keys` step that used to need a human with somebody else's `sudo` password is
> just a step now.
>
> **Status (2026-09-07): fully live, including CI.** Every container was up and
> healthy on the borrowed box, the Caddy site block appended and
> reloaded, DNS in place, and `curl https://bb.gamestao.com/health` returned
> `{"ok":true,"service":"daydayup-matchsvc"}` behind a real Let's Encrypt (production)
> certificate (§0–§2). The client now points at it by default on a deployed build (§3).
> CI-based deploy (§6) is fully wired end to end: the forced-command key is installed,
> confirmed to reject an arbitrary command and run only `ci-deploy.sh`, exercised once
> manually over SSH, then proven again through an actual `gh workflow run server-deploy`
> that went green (build → SSH deploy → public health check). Push-to-`main` deploys are
> now live. The only thing left is Paddle (§7), which is not an engineering task at all.
>
> **What has landed since.** The deployed set grew past the three containers this box
> started with: the backup worker (2026-09-07), the four `obs-*` observability images
> (2026-09-09), analytics collection on matchsvc (2026-09-09) and — as of **2026-09-09** —
> **`adminsvc`, the ops console at `/admin/`**, are all live. Nine containers. Every §4 row
> has been walked against the live deploy, including the console's own and the four
> `GET /client/flags` rows. This paragraph exists because the count above is the first thing
> anybody reads, and it was already wrong twice before it was wrong a third time — so it now
> says "every" and the current membership is listed here instead.
>
> **Three hand steps preceded that deploy, not two** (§2). `BB_ADMIN_PASSWORD` and the
> `/admin*` Caddy block were the two this file already named. The third is
> re-installing the live copy of `ci-deploy.sh`, and skipping it is not cosmetic: that copy
> had no `dist/adminsvc.mjs` in its payload check, no `data/adminsvc` in its ownership loop
> and no adminsvc health probe, so the deploy would have created that bind-mount source
> `root:root` and reproduced 2026-09-08's silent-backup failure exactly. See §6.
>
> One thing worth knowing for next time: Caddy attempted the ACME challenge the instant
> the Caddyfile was reloaded, *before* the DNS record actually existed — that attempt
> failed (NXDOMAIN) and Caddy backed off ~10 minutes before its next automatic retry,
> which is what actually succeeded once DNS had propagated. Add the DNS record FIRST,
> confirm it resolves, only then append/reload the Caddy block, and this wait disappears.

Client is on Cloudflare (`b.gamestao.com`, static). This backend runs on **its own VPS**
(`blightbloom` = `62.238.1.182`, Ubuntu 26.04 LTS, a Hetzner CX23 in Helsinki), domain
**`bb.gamestao.com`**. Nothing else runs on that machine.

**It did not start out that way, and the difference is worth stating once.** From 2026-09-07
to 2026-09-15 this backend was a guest on a Debian box belonging to somebody else, shared
with other tenants and borrowed for its idle spare capacity. Everything visible there was
named generically rather than after this project, the entire footprint was one appended line in a Caddyfile we did not own, and
several decisions recorded below exist because of that guest status rather than because of
anything the services need. Those are called out where they appear — a constraint whose
reason has expired is exactly the kind that gets copied forward forever.

**On naming, now:** the containers are `bb-*`, the directory is `~/blightbloom`, the image is
`blightbloom:latest`. The disguise cost nothing while it was true and would be actively
misleading here — a neutral container name on a machine that is ours reads like somebody
else's container, which is the opposite of what the name was for.

Four processes from one image (`server/Dockerfile`, `server/docker-compose.yml`):
`gameserver` (WS data plane, design/06), `matchsvc` (control plane — matchmaking,
accounts, store proxy), `billsvc` (billing plane) and `backup` (the daily SQLite
snapshotter, §5). Since 2026-09-09 the same compose project also runs **four off-the-shelf
observability containers** — Loki, Alloy, Prometheus and Grafana (§8) — which run no code
from this repo and which nothing above depends on. **billsvc runs in dev-stub mode**:
no real Paddle credential exists yet (design/19-server-platform.md §9), so `NODE_ENV` is
deliberately left off `production` for that one container — its
`startupGuard.ts` refuses to boot a dev-stub flag under `NODE_ENV=production`, full stop.
It is reachable only from `matchsvc` over the internal docker network, never through
Caddy, so no real money can move through it in this state.

Unlike a plain service that lets Node 26 run `.ts` directly, this server pulls live TypeScript from
sibling workspaces via path aliases (`@dd/engine`, `@dd/game/*`, `@dd/net/*` —
`../tsconfig.base.json`), so it can't just rsync `src/` and run it in place without
shipping (and `npm ci`-ing) the whole monorepo on the VPS. Instead: **build locally
first** (`npm run build -w server`, esbuild-bundles each entrypoint into one flat
`server/dist/*.mjs`, resolving those aliases at build time — see
`server/scripts/build.mjs`), then ship only the small built output. The VPS needs
nothing but Docker.

---

## 0. Prerequisites (one-time)

### DNS

Cloudflare, `gamestao.com` zone:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `bb` | `62.238.1.182` | **DNS only (grey cloud)** |

(It pointed at the borrowed box until 2026-09-15. That one record *is* the cutover: the new box
was brought up and verified service by service from the inside, with its own Caddy
deliberately not started, and only then was the record moved — see "Moving the box", §2.)

**Must be grey-clouded.** An orange-clouded (proxied) record means Caddy's ACME
challenge never reaches Let's Encrypt — the cert never signs, and the symptom is a
browser `ERR_SSL_...` with nothing useful in the server logs (a sibling project hit this first).

### Secrets

Generate once, keep in a local `server/.env` (never committed — see `.env.example`):

```bash
openssl rand -hex 32   # BB_TICKET_SECRET
openssl rand -hex 32   # BB_INTERNAL_KEY
```

#### Renaming an existing box's `.env` (`DDU_*` → `BB_*`, 2026-09-08) — DONE

> Kept as a record, not an instruction: the commands below name a box this project no longer
> uses, and the `.env` that moved to the dedicated server in 2026-09-15 carries `BB_*` only.
> The shape is what is worth keeping — an `.env` is the one file no deploy can fix, so a
> rename of anything in it is a hand step, done ADDITIVELY and before the code that needs it.

The env prefix moved with the game's name, and `.env` is the ONE file CI never ships (see
`ci-deploy.sh`) — so a box provisioned before this rename still holds `DDU_TICKET_SECRET` /
`DDU_INTERNAL_KEY`, and nothing in the repo can fix that for it. Left undone, the deploy that
carries the rename is not loud: `BB_TICKET_SECRET` unset falls back to the **well-known dev
secret** (a live-server security downgrade that only warns), and `BB_INTERNAL_KEY` unset under
`NODE_ENV=production` fails closed, so rating reports and the store proxy start being rejected.

Do it **before** merging the rename, and add rather than replace — a `.env` carrying both
prefixes is read correctly by both the old code and the new, which is what makes this a
zero-downtime step instead of a window:

```bash
ssh <deploy-host> "cd <deploy-dir> && sed -n 's/^DDU_/BB_/p' .env >> .env && grep -c '^BB_' .env"
```

Then merge, let the deploy land, confirm `/health`, and only then drop the old lines:

```bash
ssh <deploy-host> "cd <deploy-dir> && sed -i '/^DDU_/d' .env && docker compose up -d"
```

---

## 1. Build locally, ship the build

Run from the repo root (`npm run build -w server` needs the whole monorepo present to
resolve the workspace aliases — see the header above):

```bash
npm run build -w server        # → server/dist/{index,matchsvc,billsvc}.mjs
```

Then ship the small built output — NOT the monorepo — from `server/`. `deploy/package.json`
has to land at `~/blightbloom/deploy/package.json` (the Dockerfile's
`COPY deploy/package.json ./package.json` expects it there), which is why it's passed as
its own top-level arg rather than flattened:

```bash
cd server
rsync -av dist Dockerfile docker-compose.yml deploy/package.json monitoring caddy .env blightbloom:~/blightbloom/
```

**No `rsync` on Windows Git Bash** (this is how the first deploy actually happened,
2026-09-07) — `scp -r` works fine for something this small, just do the nested
`deploy/package.json` as its own copy so it lands at the right path:

```bash
ssh blightbloom 'mkdir -p ~/blightbloom/deploy'
scp -rq dist Dockerfile docker-compose.yml monitoring caddy .env blightbloom:~/blightbloom/
scp -q deploy/package.json blightbloom:~/blightbloom/deploy/package.json
```

Then on the server:

```bash
ssh blightbloom
cd ~/blightbloom
docker compose up -d --build
docker compose logs -f          # all three should log "on http://0.0.0.0:..." / "on ws://0.0.0.0:8787/ws"
```

**If matchsvc or billsvc fail on first boot with `unable to open database file`**: same
cause as its neighbour — `./data/matchsvc` / `./data/billsvc` are created root-owned by Docker's
first bind-mount, and the image runs as the non-root `node` user (uid 1000).

This is much less likely to bite since 2026-09-15, because the deploy account on this box is
`deploy` with **uid 1000 on purpose** — the same uid the container's `node` user has — so a
directory the deploy itself creates is already owned correctly. That reduces how often the
trap springs; it does not remove the trap. A directory Docker creates because nobody created
it first is still `root:root`, which is why `ci-deploy.sh` still normalises ownership and why
the fix below still works.

```bash
docker run --rm -v "$PWD/data:/data" busybox chown -R 1000:1000 /data
docker compose restart matchsvc billsvc
```

Self-check (bypassing Caddy, straight to each container):

```bash
docker exec bb-gameserver node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(console.log)"
docker exec bb-matchsvc   node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.json()).then(console.log)"
docker exec bb-billsvc    node -e "fetch('http://127.0.0.1:8789/health').then(r=>r.json()).then(console.log)"
docker exec bb-adminsvc   node -e "fetch('http://127.0.0.1:8790/admin/health').then(r=>r.json()).then(console.log)"
```

The console's probe is `/admin/health`, not `/health`: every path adminsvc answers lives
under `/admin` so that ONE Caddy `handle` block covers the whole thing. It also refuses any
request carrying `x-forwarded-for` — i.e. anything that came through Caddy — the same way
matchsvc's `/metrics` does, so `curl https://bb.gamestao.com/admin/health` is a 404 by
design and this `docker exec` is the only way to read it.

## 2. Caddy

**Since 2026-09-15 there is nothing to "wire up".** The reverse proxy is `server/caddy/Caddyfile`
in this repo, shipped with every deploy and bind-mounted read-only into the `caddy` service.
Editing it is editing a tracked file and redeploying; there is no box-side step at all.

That is the whole difference the dedicated hardware made here, and it deleted a page of this
section. What used to live in this spot: the site block was **appended by hand** to
the host's own Caddyfile — somebody else's Caddy, fronting three other site blocks as well
as us — then validated and reloaded, with a
neighbour check afterwards because a reload replaces the WHOLE config and a mistake took
their sites down with ours.

The routing itself did not change, and the three things that make it correct are worth
having here as well as in the file:

- **`handle` blocks, not bare `reverse_proxy` lines with matchers.** With more than two
  paths, "which directive wins" stops being obvious from reading the file, and the failure is
  not an error — it is Grafana's assets answered by matchsvc's 404 handler, i.e. a blank page
  with a 200. `handle` is mutually exclusive and first-match, so the order written is the
  order that runs.
- **Neither `/grafana*` nor `/admin*` is stripped**, for two different reasons. Grafana runs
  with `GF_SERVER_SERVE_FROM_SUB_PATH=true` and expects to receive its prefix; strip it and
  every asset 404s. adminsvc's own route table *is* `/admin/...` — the prefix is part of every
  path it knows, not a mount point — which is also what lets its session cookie be scoped
  `Path=/admin` so it never rides along on a player's `POST /client/events`.
- **The catch-all `handle { }` must stay last.** Anything after it is unreachable, and the
  symptom is the console's login page answered by matchsvc's 404 (design/21 §3.4).

```bash
# See what the running Caddy is actually serving — not what the file says
ssh blightbloom "docker exec bb-caddy wget -qO- http://127.0.0.1:2019/config/ | head -c 400"
```

#### The Grafana password must already be in `.env`

`docker-compose.yml` declares `GF_SECURITY_ADMIN_PASSWORD: ${BB_GRAFANA_ADMIN_PASSWORD:?…}`,
and `.env` is the one file CI never ships (`ci-deploy.sh`). The `:?` is deliberate —
Grafana's own default is `admin`/`admin` and this login page is on the public internet —
but it means a box whose `.env` predates the Grafana service fails `docker compose up` for
**every** service, not just Grafana. Do it first, on the box, by hand.

```bash
ssh blightbloom "cd /home/deploy/blightbloom && printf 'BB_GRAFANA_ADMIN_PASSWORD=%s\n' \"\$(openssl rand -hex 16)\" >> .env"
ssh blightbloom "grep '^BB_GRAFANA_ADMIN_PASSWORD=' /home/deploy/blightbloom/.env"   # the only copy — note it down
```

#### ...and so must the ops console's, for exactly the same reason

`BB_ADMIN_PASSWORD` (design/21 §3.3) is the second credential with a `:?` in
`docker-compose.yml`, and the second login page on the public internet. It is refused
TWICE: compose will not interpolate a missing value, and
`server/src/adminsvc/credentials.ts` throws `AdminStartupError` before the process opens a
database or binds a port — because adminsvc is also run from `npm` and from a test, and one
guard per entry point is one guard that can be bypassed. There is no default and no reset
flow: rotation is a new value here plus a redeploy (decision B3 — one operator, no roles).

The floor is 16 characters, which a generated value clears by 2x. Generate it rather than
choosing it, the same way as above, with `BB_ADMIN_PASSWORD` in place of the Grafana name.
The operator name defaults to `admin`; set `BB_ADMIN_USER` in `.env` to change it — it is
not a secret, and the password is the whole credential.

`ci-deploy.sh` checks for BOTH by name and fails the deploy with that explanation rather
than letting compose's own "required variable is not set" be the only clue.

#### ...and the other hand step: re-install `~/blightbloom-ci-deploy.sh`

The live script is hand-installed by design (§6 — the CI key must not be able to rewrite
its own forced command), so **editing the repo copy does nothing and CI going green is not
evidence the new check ran**. That is not a general caution: on 2026-09-09 the live copy
predated adminsvc entirely — no `dist/adminsvc.mjs` in the payload check, no `data/adminsvc`
in the ownership loop, no `adminsvc:8790:/admin/health` in the health loop — so the deploy
would have let compose create that bind-mount source `root:root` and reproduced 2026-09-08's
18 hours of silent EACCES, with CI reporting success. Same failure class as the backup guard
that shipped only to the repo.

```bash
# install (LF only — the worktree holds CRLF under core.autocrlf on Windows, and a CRLF
# shell script dies on the box with `$'\r': command not found`. `server/.gitattributes`
# pins this file to LF for exactly that reason, so the `tr` is now belt to that braces.)
tr -d '\r' < server/deploy/ci-deploy.sh |
  ssh blightbloom "install -m 700 -o deploy -g deploy /dev/stdin /home/deploy/blightbloom-ci-deploy.sh"
# then prove it, which is the standing check before believing anything about a deploy step
ssh blightbloom 'cat /home/deploy/blightbloom-ci-deploy.sh' | diff - <(tr -d '\r' < server/deploy/ci-deploy.sh) && echo IN-SYNC
```

#### A bind-mounted CONFIG FILE binds to an inode, not to a path

This cost a full diagnosis on 2026-09-09 and it looks like success the whole way through. It
is recorded here rather than deleted with the borrowed box, because the mechanism is Docker's
and the next config file this project bind-mounts will have it too.

`docker inspect` showed the mount as `<host-caddyfile> -> /etc/caddy/Caddyfile`:
a single **file**, so the mount is bound to that file's **inode**. Any editor that writes a
new file and renames it over the old one — `mv new Caddyfile`, and `sed -i`, which does
exactly that internally — leaves the host path pointing at a NEW inode while the container
keeps the OLD one. The host file is then correct, and:

- `caddy validate --config /etc/caddy/Caddyfile` reads the OLD inode and says **Valid configuration**,
- `caddy reload --config /etc/caddy/Caddyfile` reloads the OLD config and logs `adapted config to JSON`,
- and `/admin/` is answered by matchsvc's 404 handler — byte-identical to the catch-all's own
  404, which is the `handle`-ordering trap above wearing a different hat.

Every command reports success and the config never changed. Comparing the two inodes is the
only check that actually proves a bind-mounted config edit reached the container:

```bash
ssh blightbloom 'stat -c "host %i" /home/deploy/blightbloom/caddy/Caddyfile; docker exec bb-caddy stat -c "container %i" /etc/caddy/Caddyfile'
```

**What this deployment does about it now**: `caddy/` is mounted as a DIRECTORY, and
`ci-deploy.sh` replaces it with `rm -rf` + `cp -R` — which changes the inode every time, on
purpose rather than by accident. That is safe only because the deploy also carries
`--force-recreate`, which rebuilds the container and re-resolves every mount against the
current path. So nothing in the deploy ever reloads Caddy by hand, and the stale-inode state
is not reachable. If you ever edit the Caddyfile ON the box, either `cp` over it (same inode)
or `docker compose up -d --force-recreate caddy` — never `mv`, never `sed -i`, never a plain
`caddy reload`.

### Moving the box

Recorded because it is the procedure, not an anecdote: the same shape works for the next
move. The trap it routes around is the one 2026-09-07 hit — Caddy attempts the ACME challenge
the INSTANT its config loads, so a proxy started before DNS resolves fails with NXDOMAIN and
backs off ~10 minutes before retrying.

1. Ship the build and the configs to the new box, and copy `.env` and `data/` across. The
   databases are the only irreplaceable part and they are small; take them with a root
   container (`docker run --rm -v …:ro alpine tar czf -`) rather than `sudo`, since the deploy
   account cannot read a uid-1000 tree it does not own.
2. Bring up **everything except `caddy`** — `docker compose up -d --build gameserver matchsvc
   billsvc adminsvc backup obs-*`. No proxy means no ACME attempt, so there is no failed
   challenge and no backoff to wait out.
3. Verify from the inside: each `/health` over `docker exec`, `up == 1` for every Prometheus
   target, and Loki's own `label/svc/values` to prove collection works with the new container
   names. Nothing in this step needs the hostname, which is the point.
4. Re-copy `data/` with the old stack stopped, so the final state is not a snapshot taken
   mid-write.
5. **Then** move the DNS A record, confirm it resolves to the new address, and only then
   `docker compose up -d caddy`. The certificate signs within seconds because the challenge
   succeeds on the first attempt.
6. Decommission the old box: `docker compose down`, remove the directory, remove its site
   block from the host's Caddyfile, and revoke its deploy key from `authorized_keys`.

Once DNS has propagated and Caddy has its certificate:

```bash
curl https://bb.gamestao.com/health
# {"ok":true,"service":"daydayup-matchsvc"}
```

## 3. Client — DONE (2026-09-07)

`client/src/game/runState.ts`'s `matchBaseUrl` now reads a build-time
`VITE_MATCHSVC_URL` (falling back to `DEFAULT_MATCH_BASE_URL`,
`http://localhost:8788`, when unset — `?mm=` still overrides either at runtime).
`.github/workflows/client-deploy.yml`'s build step injects it from the repo Variable
`MATCHSVC_URL`, set to `https://bb.gamestao.com`. Local equivalent: `client/.env.example`.
A deployed client build now actually points its online co-op/PvP queue at this backend
instead of silently trying `localhost:8788` and failing with no visible error.

## 4. Acceptance checklist

**Walked end to end against the live deploy on 2026-09-09**, every row, after adminsvc
landed. Two rows failed on the first pass and both are recorded where they belong rather
than only here: `/admin/` was answered by matchsvc's 404 handler (§2 — the Caddyfile is a
file bind mount and `mv` over it changes the inode, so `validate` and `reload` both read
the stale file and reported success), and the `cache-control` sub-row below asked for a
`curl -sI` that cannot pass.

- [x] `curl https://bb.gamestao.com/health` → `{"ok":true,"service":"daydayup-matchsvc"}`,
      cert issued by Let's Encrypt
- [x] A WS client can open `wss://bb.gamestao.com/ws?ticket=...` and receive frames
- [x] `docker compose logs billsvc` shows `devStub=true` — confirms billsvc is NOT
      accidentally in production mode. (It was a bracketed `[DEV RECEIPT STUB ENABLED]`
      banner until the structured logger landed 2026-09-09; it is a logfmt FIELD now, which
      is the point — a marker buried in prose cannot be queried, and "was the store real on
      the day of that order?" is asked months after the log line has rotated away.)
- [x] `docker inspect bb-billsvc --format '{{.Config.Env}}'` does **not** show
      `NODE_ENV=production` (that combination is refused at the process level, but the
      compose file should never even attempt it)
- [x] A `/store/skus` request through matchsvc returns the SKU table (proves the
      matchsvc → billsvc internal hop works even with billsvc in dev-stub mode)
- [x] `https://bb.gamestao.com/grafana/` shows the login page, and `admin` +
      `BB_GRAFANA_ADMIN_PASSWORD` gets in
- [x] `https://bb.gamestao.com/admin/` shows the ops console's login page — NOT matchsvc's
      404 JSON, which would mean the `/admin*` `handle` block is missing or lost to the
      catch-all — and `admin` + `BB_ADMIN_PASSWORD` gets in
- [x] Signed in, all **four** tabs answer: **Players** lists accounts, **Commerce** shows the
      review queue and the webhook log, **Retention** shows the cohort grid, and **Flags** shows
      the switches. (This row said "three" until 2026-09-09 — the Flags tab arrived with
      design/21 §4 and the row that verifies the console did not learn about it, so a missing
      fourth tab was a thing nobody was looking for.) Retention says
      "No rollup rows for any day" until a complete day has been rolled up; that is the
      correct empty state and it prints the row count so it can be told from a broken reader
- [x] `curl -s https://bb.gamestao.com/admin/health` returns a **404** — like `/metrics`,
      the console's health route must not be public. **Check this row AFTER the one above it**,
      not before: a missing `/admin*` Caddy block also returns 404 here, with the identical
      `{"error":"not found"}` body, so on its own this row passes for the wrong reason. The
      row above is what proves the prefix reaches adminsvc at all
- [x] `docker compose logs adminsvc | grep 'ops console listening'` shows
      `accounts=true billing=true analytics=true readOnly=true`. Any `false` is a path that
      does not exist, and that tab reads "Unavailable" with the reason on it
- [x] In Grafana, **Backend — logs** shows a heartbeat line for all five services within
      five minutes, and **Server status** shows every scrape target `up` — **eight of them**
      since 2026-09-15, the two exporters having moved from the host owner's stack into this
      one. `up == 1` for `containers` (obs-cadvisor) and `host` (obs-node-exporter) is the row
      that proves the move actually happened rather than leaving two panels quietly empty:
      ```bash
      ssh blightbloom 'docker exec bb-prometheus wget -qO- "http://127.0.0.1:9090/api/v1/query?query=up"'
      ```
- [x] `docker compose ps` shows **twelve** containers, eleven of them `(healthy)` and
      `bb-alloy` with no health column at all — that last one is correct and is explained in
      `docker-compose.yml` beside the service. A twelfth healthy container would mean somebody
      gave Alloy a healthcheck it cannot pass
- [x] `ss -tlnp` on the box shows only **:22, :80 and :443** bound on a public address.
      Everything else is `expose`, reachable on the compose network and nowhere else. Worth
      checking by hand rather than trusting `ufw status`, because Docker publishes a port by
      writing its own iptables rules AHEAD of ufw's chain: a stray `ports:` entry is reachable
      from the internet while the firewall still reports the port closed
- [x] Open the game, force an error in its console, and it appears in **Client — browser
      logs** within ~30 seconds (§8 has the one-liner)
- [x] `curl -s https://bb.gamestao.com/metrics` returns a **404** — the metrics endpoint
      must not be public (it is reachable only over the compose network)
- [x] `curl -s https://bb.gamestao.com/client/flags` returns
      `{"flags":{"ads.rewardedOfferEnabled":true,"ui.maintenanceBanner":""}}` — the public
      flag route (design/21 §4). Three things to actually check in that output, because it is
      the one route on this host that is *supposed* to be readable by anybody:
    - **Exactly two keys.** `match.queueTimeoutMs` or `match.pvpBotBackfillDelayMs`
      appearing here is a private flag on a public surface — the backfill delay would tell a
      player which of their opponents was not a person.
    - **A 200, not a 404.** Unlike `/metrics` and `/admin/health` above, this one MUST be
      public, so it is the one row in this list where a 404 is the failure. It is served by
      matchsvc under the catch-all, so no Caddy block is needed for it.
    - **`cache-control: no-store`** — read it off the **GET** with `curl -sD - -o /dev/null`,
      NOT with `curl -sI`. matchsvc routes on `req.method === 'GET'`, so a HEAD request falls
      through to the catch-all and returns **404** — this row's own stated failure, produced by
      the command this row used to recommend. A cached copy anywhere makes a flipped flag take
      effect at some unpredictable later time, which is the failure mode that gets reported as
      "the console does nothing".
- [x] Set `ui.maintenanceBanner` in the console, wait a minute, and `curl` the route again —
      the value should be there. Then load the game and confirm the notice appears above the
      main menu. **Clear it afterwards**: it is shown to every player on every host.
      Services poll every 60s and browsers every 5 minutes, so allow for both.


**One artifact of walking this list**: rows 2 and 5 (a WS ticket, and `/store/skus`) both
need a real session, so the 2026-09-09 pass registered account `acc_check_0909` through
`POST /auth/register`. It is still there — it is the only row in `accounts.db`, and it is
what makes the console's Players tab show something rather than an empty state. Removing it
is a write to player data, which by design neither the console nor the deploy key can do:
it needs a CLI script on the box (§5). Left deliberately rather than quietly, because a
leftover test account that nobody wrote down is indistinguishable from a real one.

## 5. Ops

**Before changing any file in this directory, `Dockerfile`, `docker-compose.yml` or
`scripts/build.mjs`, run `npm test -w server`.** Two suites cover exactly those files
(design/18-test-strategy.md "Layer 6", added 2026-09-07):
`test/deploy.manifests.test.ts` cross-checks bundle names, ports, externals, the base image's
Node major and every compose env var against what `src/` actually reads — including that a
healthcheck polls its own service's port, that no secret is inlined where `env_file: .env` is
the mechanism, and that this script's payload check matches what CI ships;
`test/deploy.bundle.test.ts` builds the bundles and boots each one as a bare `node` process
with ONLY `deploy/package.json`'s dependencies available, so a missing external fails locally
instead of on the box. Neither runs Docker.


```bash
# Logs (or, since 2026-09-09, the Backend dashboard at https://bb.gamestao.com/grafana/ — see section 8)
ssh blightbloom 'docker compose -f /home/deploy/blightbloom/docker-compose.yml logs -f'

# Redeploy after a code change (build locally, then re-ship + rebuild)
cd server && npm run build
rsync -av dist Dockerfile docker-compose.yml deploy/package.json monitoring caddy blightbloom:~/blightbloom/
ssh blightbloom 'cd /home/deploy/blightbloom && docker compose up -d --build'

# Pull the automated backups off the box (see the Backups section below — the snapshots
# themselves are taken on the box, daily, by the `backup` service; this is the off-box copy)
rsync -av blightbloom:~/blightbloom/backups/ ./backups/

# Tear down entirely. Unlike on the borrowed box there is no neighbour to be careful of and
# no foreign Caddyfile block to remember — but this now takes the PROXY down too, so it is a
# total outage rather than one service disappearing from somebody else's reverse proxy.
ssh blightbloom 'cd /home/deploy/blightbloom && docker compose down && rm -rf /home/deploy/blightbloom'
```

### Backups — automated 2026-09-07

Until this landed, "the backup procedure" was the two `scp` lines that used to sit in the
block above: a procedure exactly as reliable as somebody remembering it, protecting the two
things this project cannot regenerate — `accounts.db` (who somebody is) and `billing.db`
(what they paid for).

Now the compose project runs a fourth process, `bb-backup` (`src/backup/`), and there
is nothing to remember:

- **Daily**, and once immediately at start, it snapshots both databases with SQLite's
  `VACUUM INTO` — a point-in-time consistent copy taken while the services keep running.
  `cp` of a live database is what this deliberately is not: it captures a torn page set that
  opens fine and fails on the page that mattered.
- **It cannot write to either database.** The two data directories are mounted `:ro`, and
  the SQLite handle is opened read-only (`VACUUM INTO` works that way — verified, see
  `src/backup/snapshot.ts`). Its only writable mount is `~/blightbloom/backups`.
- **Each snapshot is verified before it is published**: `PRAGMA integrity_check` on the copy,
  then gzip, then an atomic rename. Nothing in that directory is ever a file that merely
  looks like a backup — an interrupted run leaves a `.part`, which the pruner neither counts
  nor deletes.
- **14 per database are kept**, pruned per source, and only after that source's own
  snapshot succeeded — so a database that has been failing for a week keeps its last good
  snapshots instead of ageing them out on schedule.

```bash
# Is it working? (this is what the container's own healthcheck runs)
ssh blightbloom 'docker exec bb-backup node backup.mjs --health && echo HEALTHY'
ssh blightbloom 'cat /home/deploy/blightbloom/backups/status.json'
ssh blightbloom 'ls -lh /home/deploy/blightbloom/backups'
docker ps --filter name=bb-backup   # STATUS shows (healthy)/(unhealthy)

# Force a cycle now (it runs one at start, so a restart is a manual backup)
ssh blightbloom 'cd /home/deploy/blightbloom && docker compose restart backup'
```

**Restoring.** A snapshot is an ordinary gzipped SQLite file, so a restore needs no tooling
from this repo:

```bash
ssh blightbloom
cd /home/deploy/blightbloom
docker compose stop matchsvc                      # nothing may hold the file open
cp data/matchsvc/accounts.db data/matchsvc/accounts.db.before-restore
gunzip -c backups/accounts-2026-09-07T02-00-00Z.db.gz > data/matchsvc/accounts.db
docker compose start matchsvc
curl -fsS http://127.0.0.1:8788/health            # or the Caddy route from §2
```

Same for `billing.db` with `billsvc`. Keep the `.before-restore` copy until the restore is
confirmed — a restore is the one operation here that can lose data that still existed.

**What it deliberately does NOT do: it does not copy anything off the box.** A snapshot beside
the database survives every failure this project has actually had (a bad migration, a
hand-edited row, an `rm` in the wrong directory) and none of the ones that take the host with
it. The off-box copy is the `rsync` line in §5 and it is a human step — stated here rather
than papered over, because a backup system that quietly protects less than it appears to is
worse than one whose limit is written down. "The host is gone" is a real
scenario.

**Its verification is part of the deploy.** `ci-deploy.sh` asks the worker for a healthy
cycle after `docker compose up`, alongside the three `/health` polls, so a deploy that
silently stops backing up fails in CI. `test/backup.*.test.ts` covers the config refusals,
the retention rules and the health verdict; `test/deploy.bundle.test.ts` builds the real
bundle, runs it against a real SQLite file, decompresses what it wrote and reads the row
back.

> #### It took ZERO backups for its first 18 hours (2026-09-08)
>
> Worth reading before trusting any of the above, because two independent faults lined up and
> each one alone would have been caught:
>
> 1. **A bind mount hides the image's `chown`.** The Dockerfile does
>    `mkdir -p /data /backups && chown -R node:node`, but Docker creates a MISSING bind-mount
>    source as `root:root` on the host, and the mount then replaces the image's directory —
>    ownership included. So the deploy directory's `backups/`, created by the very deploy that introduced
>    this service, was root-owned, the container user (uid 1000 = `node`) could not write to
>    it, and every cycle failed `EACCES`. The container sat in a restart loop for 18 hours,
>    which is `--health`'s staleness arm working exactly as designed — nobody was looking.
> 2. **The check that would have caught it was never installed.** The backup-health poll
>    described above was added to `ci-deploy.sh` in the same commit as the worker, but the
>    LIVE copy of that script is hand-installed on purpose (§6 — the CI key must not be able
>    to rewrite its own forced command) and had not been updated. The deploy therefore ran the
>    previous script: no `dist/backup.mjs` in the payload check, no backup verification, green
>    in 46s. That script's own surviving comment reads *"a silently failed deploy is exactly as
>    bad as a silently failed backup."*
>
> Fault 1 is now fixed by construction: `ci-deploy.sh` normalises the ownership of every
> bind-mounted state dir before `compose up`, acting only on a dir that is actually wrong, and
> `deploy.manifests.test.ts` pins that list to compose's real mounts so a NEW mount cannot
> reintroduce it. Fault 2 has no code fix available — that is the point of the hand-install —
> so the standing rule is: **after changing `deploy/ci-deploy.sh`, re-install it (§6) or the
> change does nothing.** Diff the two before believing otherwise:
>
> ```bash
> ssh blightbloom 'cat /home/deploy/blightbloom-ci-deploy.sh' | diff - <(tr -d '\r' < server/deploy/ci-deploy.sh) && echo IN-SYNC
> ```

## 6. CI-based deploy — DONE (2026-09-07)

`.github/workflows/server-deploy.yml` + `server/deploy/ci-deploy.sh`, same shape as
a sibling project's own `deploy.yml`/`deploy/ci-deploy.sh`: push to `main` touching
`server/**`/`engine/**`/`client/src/**` (or manual dispatch) → builds the bundles → ships
them over SSH with a key that can do exactly one thing on the VPS.

Everything is wired and verified:
**Re-pointed at the dedicated box on 2026-09-15**, with a new key — the old one is a
credential for a machine this project no longer has any business on, so it was replaced
rather than moved.

- Dedicated keypair (`D:\cloud\blightbloom_ci_ed25519` — the only readable copy, since a
  GitHub Secret is write-only), private half in the repo Secret `SERVER_DEPLOY_KEY`.
- `server/deploy/ci-deploy.sh` installed at `/home/deploy/blightbloom-ci-deploy.sh` (outside
  the deploy target on purpose — see its own header), `chmod 700`, owned by `deploy`.
- Repo Variables: `SERVER_SSH_HOST=62.238.1.182`, `SERVER_SSH_USER=deploy`,
  `SERVER_SSH_KNOWN_HOSTS` (pinned, fingerprint cross-checked three ways — the scanned line,
  the local `known_hosts` entry from first contact, and the box's own
  `/etc/ssh/ssh_host_ed25519_key.pub` read back over the trusted channel — never
  `StrictHostKeyChecking=no`), `SERVER_API_BASE=https://bb.gamestao.com`,
  `SERVER_DEPLOY_ENABLED=true`.
- The forced-command `authorized_keys` line is installed. On the borrowed box this was the
  one step that needed a human, because the file was root-owned and `sudo` wanted an
  interactive password; here it is just a step. **Verified it actually restricts**: asking
  the key to run `cat /etc/shadow; id` does not run it — the forced command runs
  `ci-deploy.sh` regardless, which then correctly rejects the non-tar.gz stdin rather than
  doing anything with it — and `ssh -tt` over the key is refused with `PTY allocation request
  failed`, so `restrict` is doing its half too.
- **Proven twice**: once manually (`tar czf - dist Dockerfile docker-compose.yml
  deploy/package.json | ssh -i ... <user>@<old-host>`, all three containers rebuilt and
  came back healthy), then for real via `gh workflow run server-deploy` — a genuine CI
  run that went green end to end (build → SSH deploy → public `/health` check). Re-proven
  against the new box after the 2026-09-15 move, the same way.

Push-to-`main` deploys are now live for anything touching `server/**`/`engine/**`/
`client/src/**`.

## 7. Still open

- **Paddle credentials**, which is the actual reason billsvc exists at all
  (design/19-server-platform.md §9). Until those exist, billsvc stays in dev-stub mode and
  the store is not really "for sale" — it just proves the proxy plumbing end to end.
  **This one is not an engineering task**: it means opening a real Paddle seller account
  with real business/bank/tax details and going through their merchant-domain review
  (§9 already documents that funny was rejected twice on exactly that). No agent should
  do this part — it needs a human with the authority to accept a Merchant of Record
  agreement and hand over real financial/business information.
- **The OFF-BOX copy of the backups — SUPERSEDED 2026-09-15, not closed.** Everything below
  described the problem correctly and proposed the wrong fix, and the difference is worth
  keeping: the owner's answer is that **player data moves off SQLite onto a database**, at
  which point "get a verified copy of `accounts.db` somewhere else" stops being this
  project's problem to solve and becomes a property of whatever that database is. So no
  scheduled pull and no object-store upload is being built here. What does NOT go away with
  the move is the requirement — identity and money need a copy that survives the box — so
  this item stays open until the new store actually has one, rather than being ticked off by
  a decision. The old text, for whoever does that migration:

  The `backup` service (§5, "Backups") takes and
  verifies a daily snapshot of both databases and keeps 14 of each, on the same disk as the
  databases. Getting them somewhere else is still the `rsync` line in §5, run by a person.
  What would close it: a scheduled pull from a machine that is not this VPS, or an
  object-store bucket the worker uploads to. A PULL is still the better shape even now that
  the box is ours — a push credential stored on the server is a credential an attacker who
  reaches the server also gets, and "the backups were deleted along with the originals" is
  the failure that makes having them pointless. Deliberately not guessed at here: it needs a
  destination somebody owns.

  The move to dedicated hardware made this **more** urgent, not less. On the borrowed box
  the machine itself was somebody else's to keep alive, with their snapshots and their
  monitoring around it; now a single Hetzner VM holds the only copy of `accounts.db` and
  `billing.db`, and nothing outside it would notice their loss. Hetzner's own backups are one
  checkbox away (Options → BACKUPS → Enable, about 20% of the server price) and are worth
  turning on as a floor under this, but they are a whole-disk snapshot rather than a
  verified database copy, so they do not close the item.
- ~~**The retired deploy key on the old box**~~ **— revoked 2026-09-15.** `~/.ssh/authorized_keys`
  there is root-owned, so the line could not be deleted from this side; the owner ran two
  prepared scripts instead. The live file is three lines and none of them is this project's, and
  the key material appears in no `authorized_keys.bak-*` beside it either. Verified by searching
  for the KEY, not for its label — which is the part worth keeping: that key line was labelled
  with the box's neutral naming and never contained the word `blightbloom`, so the first script's
  own residue check (a grep for the project name) reported clean on the one line it existed to
  find.

  Everything else this project left behind there was swept on 2026-09-15: two SQLite
  snapshots of live account and billing data in a home directory, four observability probe
  scripts, four version-pinned images no other tenant used, the buildx refs naming this
  project's build paths, and the build cache holding its source layers. A `compose down`
  removes the deployment; it does not remove the project from the machine.

## 8. Observability — Loki + Alloy + Prometheus + Grafana (2026-09-09)

**What it answers.** Before this, "what happened on the server?" meant `ssh` +
`docker compose logs`, over a 10 MB × 3 rotating buffer, on a box only one person can
reach. "What happened in a player's browser?" had no answer at all — every device-side bug
this project has had (the blank WeChat labels, the CrazyGames SDK calls that were silent
no-ops, the CORS preflight that failed as a bare `Failed to fetch`) was found by somebody
happening to have devtools open at the time.

**Where it lives.** Four containers in the same compose project, `obs-`prefixed
(`bb-loki` / `-alloy` / `-prometheus` / `-grafana`), configured from
`server/monitoring/`. They run no code from this repo. Nothing the game serves depends on
them: a dead Grafana cannot affect a match, and `docker compose down` still removes the
whole footprint in one command.

| | image | what it does |
| --- | --- | --- |
| `obs-loki` | `grafana/loki:3.4.2` | the log store, 14-day retention, filesystem, no published port |
| `obs-alloy` | `grafana/alloy:v1.7.5` | reads container stdout off the Docker socket (read-only), pushes to Loki |
| `obs-prometheus` | `prom/prometheus:v3.13.3` | scrapes `/metrics` on each service + the box's own cAdvisor/node-exporter |
| `obs-grafana` | `grafana/grafana:11.5.2` | the only one a human opens, at `/grafana/` |

Three dashboards, provisioned from files (`monitoring/grafana/dashboards/`) rather than
clicked into existence, so a panel is reviewed like code and a fresh volume comes up
already working:

- **Backend — logs** — every container's stdout, by service and level, plus a *service
  liveness* panel that counts the 5-minute heartbeat every process emits.
- **Client — browser logs** — the same store, `source="client"`. Filter by build target,
  build version, session id or account id; the last panel replays one visit in order.
- **Server status** — container CPU/RAM, host CPU/RAM/disk, process uptime (a sawtooth is
  a restart loop), matchmaking queue depth, live rooms, and billsvc's undelivered-purchase
  count.

### How a browser log gets there

`client/src/net/clientLog.ts` keeps a 200-entry ring buffer of everything, wraps
`console.error`/`console.warn` and the global error handlers, and flushes what is at or
above `warn` every 30 seconds and once on `pagehide`. matchsvc's `POST /client/log`
validates it, attaches the account from the bearer token (never from the body), and
forwards it to Loki.

Two things in that path are load-bearing and easy to break by "cleaning up":

- **`fetch(..., { keepalive: true, credentials: 'omit' })`, never `navigator.sendBeacon`.**
  `sendBeacon` always sends credentialed, which makes the browser require
  `Access-Control-Allow-Credentials: true` — and matchsvc answers
  `Access-Control-Allow-Origin: *`, which by specification cannot be combined with
  credentials. The client is on `b.gamestao.com` and the server on `bb.gamestao.com`, so
  every send is cross-origin. Swap it and the exit flush silently never lands.
- **Every outcome is `200 {ok, accepted}`.** A 4xx teaches a client to retry, and a client
  retrying a malformed batch retries it forever. A refused batch reports `accepted: 0`.

Verify it end to end without playing anything — open the game, then in its console:

```js
console.error('smoke test from', location.href)
```

...and within ~30s it is in **Client — browser logs**. Nothing appearing there is a real
signal; work down `BB_LOKI_PUSH_URL` → the network tab's `POST /client/log` → Loki's
`/ready`.

### If a dashboard is empty

In this order, because each step rules out everything below it:

```bash
# 1. Is the stack even up?
ssh blightbloom 'cd /home/deploy/blightbloom && docker compose ps'

# 2. Is Loki accepting? (`ready` = yes)
ssh blightbloom 'docker exec bb-loki wget -qO- http://127.0.0.1:3100/ready'

# 3. Is anything in it? (should list backend + client)
ssh blightbloom 'docker exec bb-grafana wget -qO- "http://obs-loki:3100/loki/api/v1/label/source/values"'

# 4. Is the collector attached, and to OUR containers only?
ssh blightbloom 'docker logs --tail 50 bb-alloy'

# 5. For the client half specifically — the variable that silently drops everything
ssh blightbloom 'docker exec bb-matchsvc printenv BB_LOKI_PUSH_URL'

# 6. Are the metrics targets up? (all eight are ours since 2026-09-15 — see below)
ssh blightbloom 'docker exec bb-prometheus wget -qO- "http://127.0.0.1:9090/api/v1/query?query=up"'
```

### Three things this stack inherited from the borrowed box

All three are still in the code; two of them no longer guard what they were written to
guard, and saying so is the point of this section. A rule whose reason has quietly expired is
one nobody can evaluate later.

**The `obs-` prefix was a collision guard, and is now a role marker.** The compose project
used to join the host's shared external network, where compose publishes each service
NAME as a network alias — and the owner's stack already answered to `loki`, `grafana`,
`prometheus` and `promtail` there. A service called `loki` would have put two containers
behind one DNS name, with their collector's pushes landing in our store or ours in theirs,
intermittently, and nothing failing anywhere. The network is ours since 2026-09-15 and that
cannot happen; the prefix stays because `prometheus.yml`, `datasources.yml`, every dashboard
and `ci-deploy.sh` all spell it out, and because it is what makes `docker compose ps` say at a
glance which half of the stack a container belongs to.
`server/test/deploy.observability.test.ts` still fails the build on a name that drops it —
deliberately, so that dropping it is a decision and not a drift.

**Alloy's `bb-` discovery filter was a boundary, and is now hygiene.** It was written because
an unfiltered collector on that box would have copied another team's logs into our store (in
the other direction their promtail scraped the same socket unfiltered, and this file could
never close that half — every line our containers wrote between 2026-09-07 and the move is
still in their Loki under the neutral container names, along with some `blightbloom-*`
streams from a short-lived naming on 2026-09-07, because log CONTENT carries the name
regardless of what the container is called). Here there are no neighbours. What the filter still prevents is duller
and real: any container run on this host outside the compose project — a five-minute
debugging shell, a `docker run` from some future runbook — would otherwise be collected and
kept for Loki's full 14 days, and the first symptom of that is storage, not an error.

**Prometheus stopped borrowing, which removed the one dependency this stack could not fix.**
It scraped the host owner's own cAdvisor and node-exporter containers —
measuring the whole machine, ours included. The right trade at the time: a second privileged
cAdvisor mounting `/`, `/sys` and `/dev/kmsg` on hardware we did not own, to recompute numbers
that already existed one DNS name away, would have been rude and pointless. But it meant that
if that team ever stopped or renamed either container, every infra panel emptied for reasons
nobody here could see. `docker-compose.yml` now runs `obs-cadvisor` and `obs-node-exporter`
itself; `infra.json`'s queries are unchanged, because `--path.rootfs=/rootfs` was carried over
deliberately (it strips the prefix from the `mountpoint` label, which is what makes the disk
panel's `mountpoint="/"` selector match anything at all).

### Before touching any of it

```bash
npm test -w server        # test/deploy.observability.test.ts + test/deploy.manifests.test.ts
```

`deploy.observability.test.ts` cross-checks the six config files against each other and
against the code — the Loki push URL against the compose service and its port, Prometheus's
targets against each service's real port, Grafana's sub-path against the Caddy route, every
dashboard's datasource uid against what provisioning declares, and **Alloy's log-parsing
regex against a line the real `src/log.ts` produces**. That last one is the cross-check
worth knowing about: two files, one regex, one formatter, no compiler between them, and the
failure mode is a `level` label quietly going missing.

