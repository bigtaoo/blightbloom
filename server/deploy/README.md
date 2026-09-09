# Deploying the backend

> **Status (2026-09-07): fully live, including CI.** Every container is up and
> healthy on `wnet-server` at `~/wnet-test/`, the Caddy site block is appended and
> reloaded, DNS is in place, and `curl https://bb.gamestao.com/health` returns
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
> re-installing `~/wnet-test-ci-deploy.sh`, and skipping it is not cosmetic: the live copy
> had no `dist/adminsvc.mjs` in its payload check, no `data/adminsvc` in its ownership loop
> and no adminsvc health probe, so the deploy would have created that bind-mount source
> `root:root` and reproduced 2026-09-08's silent-backup failure exactly. See §6.
>
> One thing worth knowing for next time: Caddy attempted the ACME challenge the instant
> the Caddyfile was reloaded, *before* the DNS record actually existed — that attempt
> failed (NXDOMAIN) and Caddy backed off ~10 minutes before its next automatic retry,
> which is what actually succeeded once DNS had propagated. Add the DNS record FIRST,
> confirm it resolves, only then append/reload the Caddy block, and this wait disappears.

Client is on Cloudflare (`b.gamestao.com`, static). This backend runs on the **same VPS
`deutsch` already uses** (`wnet-server` = `92.205.18.79`, Debian 13; see `deutsch`'s own
`deploy/README.md` for how that box got set up in the first place), domain
**`bb.gamestao.com`**.

That machine also runs the company's wnet mock stack (frontend / webapi / mssql / grafana
/ caddy) *and* `deutsch-sync`. This project's footprint on it is the same shape deutsch's
is: **one line added to `~/wnet/docker/Caddyfile`**, everything else self-contained under
`~/wnet-test/`, removable in one command.

**On naming (2026-09-07):** the box is the company's, borrowed for its idle spare
capacity rather than provisioned for this project — so everything visible on the VPS
itself (the directory, the containers, the CI script, the Caddyfile comment) is named
generically (`wnet-test`) instead of after this project. Nothing about the game or its
name appears anywhere on that shared machine on purpose; this repo's own naming
(`blightbloom`/`daydayup`) stays exactly where it always was — in this private repo, and
in the GitHub Actions secrets/variables, neither of which anyone with shell access to the
VPS can see.

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

Unlike deutsch (Node 26 runs `.ts` directly), this server pulls live TypeScript from
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
| A | `bb` | `92.205.18.79` | **DNS only (grey cloud)** |

**Must be grey-clouded.** An orange-clouded (proxied) record means Caddy's ACME
challenge never reaches Let's Encrypt — the cert never signs, and the symptom is a
browser `ERR_SSL_...` with nothing useful in the server logs (deutsch hit this first).

### Secrets

Generate once, keep in a local `server/.env` (never committed — see `.env.example`):

```bash
openssl rand -hex 32   # BB_TICKET_SECRET
openssl rand -hex 32   # BB_INTERNAL_KEY
```

#### Renaming an existing box's `.env` (`DDU_*` → `BB_*`, 2026-09-08)

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
ssh wnet-server "cd ~/wnet-test && sed -n 's/^DDU_/BB_/p' .env >> .env && grep -c '^BB_' .env"
```

Then merge, let the deploy land, confirm `/health`, and only then drop the old lines:

```bash
ssh wnet-server "cd ~/wnet-test && sed -i '/^DDU_/d' .env && docker compose up -d"
```

---

## 1. Build locally, ship the build

Run from the repo root (`npm run build -w server` needs the whole monorepo present to
resolve the workspace aliases — see the header above):

```bash
npm run build -w server        # → server/dist/{index,matchsvc,billsvc}.mjs
```

Then ship the small built output — NOT the monorepo — from `server/`. `deploy/package.json`
has to land at `~/wnet-test/deploy/package.json` (the Dockerfile's
`COPY deploy/package.json ./package.json` expects it there), which is why it's passed as
its own top-level arg rather than flattened:

```bash
cd server
rsync -av dist Dockerfile docker-compose.yml deploy/package.json monitoring .env wnet-server:~/wnet-test/
```

**No `rsync` on Windows Git Bash** (this is how the first deploy actually happened,
2026-09-07) — `scp -r` works fine for something this small, just do the nested
`deploy/package.json` as its own copy so it lands at the right path:

```bash
ssh wnet-server 'mkdir -p ~/wnet-test/deploy'
scp -rq dist Dockerfile docker-compose.yml monitoring .env wnet-server:~/wnet-test/
scp -q deploy/package.json wnet-server:~/wnet-test/deploy/package.json
```

Then on the server:

```bash
ssh wnet-server
cd ~/wnet-test
docker compose up -d --build
docker compose logs -f          # all three should log "on http://0.0.0.0:..." / "on ws://0.0.0.0:8787/ws"
```

**If matchsvc or billsvc fail on first boot with `unable to open database file`**: same
cause as deutsch — `./data/matchsvc` / `./data/billsvc` are created root-owned by Docker's
first bind-mount, and the image runs as the non-root `node` user (uid 1000).

```bash
docker run --rm -v "$PWD/data:/data" busybox chown -R 1000:1000 /data
docker compose restart matchsvc billsvc
```

Self-check (bypassing Caddy, straight to each container):

```bash
docker exec wnet-test-gameserver node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(console.log)"
docker exec wnet-test-matchsvc  node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.json()).then(console.log)"
docker exec wnet-test-billsvc   node -e "fetch('http://127.0.0.1:8789/health').then(r=>r.json()).then(console.log)"
docker exec wnet-test-adminsvc  node -e "fetch('http://127.0.0.1:8790/admin/health').then(r=>r.json()).then(console.log)"
```

The console's probe is `/admin/health`, not `/health`: every path adminsvc answers lives
under `/admin` so that ONE Caddy `handle` block covers the whole thing. It also refuses any
request carrying `x-forwarded-for` — i.e. anything that came through Caddy — the same way
matchsvc's `/metrics` does, so `curl https://bb.gamestao.com/admin/health` is a 404 by
design and this `docker exec` is the only way to read it.

## 2. Wire up Caddy

matchsvc answers everything except the WS upgrade, which is path-pinned to `/ws`
(`server/src/index.ts`'s `WebSocketServer({ path: '/ws' })`), and — since 2026-09-09 —
except `/grafana*` and `/admin*`. So the site block is a FOUR-way path split, not a
whole-host proxy the way deutsch's single-service one is:

```caddyfile
bb.gamestao.com {
	handle /ws* {
		reverse_proxy wnet-test-gameserver:8787
	}
	handle /grafana* {
		reverse_proxy wnet-test-grafana:3000
	}
	handle /admin* {
		reverse_proxy wnet-test-adminsvc:8790
	}
	handle {
		reverse_proxy wnet-test-matchsvc:8788
	}
}
```

**`handle` blocks, not three bare `reverse_proxy` lines with matchers.** With more than
two paths, "which directive wins" stops being obvious from reading the file, and the
failure is not an error — it is Grafana's assets being answered by matchsvc's 404 handler,
i.e. a blank page with a 200. `handle` is mutually exclusive and first-match, so the file
says what it does.

**The Grafana prefix is NOT stripped.** `handle_path` would remove it, and Grafana is
configured with `GF_SERVER_SERVE_FROM_SUB_PATH=true`, meaning it expects to receive the
prefix and generates its own links with it. Strip it and every asset 404s.

**The `/admin*` prefix is not stripped either, and for a different reason.** adminsvc's own
route table IS `/admin/...` — `/admin/`, `/admin/login`, `/admin/logout`, `/admin/health`
(`server/src/adminsvc/routes.ts`) — so the prefix is not a mount point it is served under,
it is part of every path it knows. That is deliberate: the session cookie is scoped
`Path=/admin` so it never rides along on a player's `POST /client/events`, and one `handle`
block covers the console because there is nothing outside the prefix to cover.
`handle_path` here would deliver `/login` to a server that 404s it.

**`/admin*` must come BEFORE the catch-all**, which is what `handle` guarantees: the blocks
are mutually exclusive and first-match, so the ordering in the file is the ordering that
runs. This is design/21 §3.4's named trap, and the reason it is worth naming is that
getting it wrong is not an error — it is the console's page being answered by matchsvc's
404 handler, i.e. a blank page with a 200.

#### Before that deploy: the Grafana password must already be in `.env`

`docker-compose.yml` declares `GF_SECURITY_ADMIN_PASSWORD: ${BB_GRAFANA_ADMIN_PASSWORD:?…}`,
and `.env` is the one file CI never ships (`ci-deploy.sh`). The `:?` is deliberate —
Grafana's own default is `admin`/`admin` and this login page is on the public internet —
but it means a box whose `.env` predates the Grafana service fails `docker compose up` for
**every** service, not just Grafana. Same shape as the `DDU_*`→`BB_*` rename above: do it
first, on the box, by hand.

```bash
ssh wnet-server "cd ~/wnet-test && printf 'BB_GRAFANA_ADMIN_PASSWORD=%s\n' \"\$(openssl rand -hex 16)\" >> .env && grep -c BB_GRAFANA .env"
ssh wnet-server "grep '^BB_GRAFANA_ADMIN_PASSWORD=' ~/wnet-test/.env"   # note it down — this is the only copy
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

#### ...and the THIRD hand step: re-install `~/wnet-test-ci-deploy.sh`

The live script is hand-installed by design (§6 — the CI key must not be able to rewrite
its own forced command), so **editing the repo copy does nothing and CI going green is not
evidence the new check ran**. That is not a general caution: on 2026-09-09 the live copy
predated adminsvc entirely — no `dist/adminsvc.mjs` in the payload check, no
`data/adminsvc` in the ownership loop, no `adminsvc:8790:/admin/health` in the health loop
— so the deploy would have let compose create that bind-mount source `root:root` and
reproduced 2026-09-08's 18 hours of silent EACCES, with CI reporting success. Same failure
class as the backup guard that shipped only to the repo.

```bash
# install (LF only — the worktree holds CRLF under core.autocrlf, and a CRLF shell script
# dies on the box with `$'': command not found`)
tr -d '' < server/deploy/ci-deploy.sh | ssh wnet-server   "cat > ~/wnet-test-ci-deploy.sh && chmod 700 ~/wnet-test-ci-deploy.sh && bash -n ~/wnet-test-ci-deploy.sh"
# then prove it, which is the standing check before believing anything about a deploy step
ssh wnet-server 'cat ~/wnet-test-ci-deploy.sh' | diff - server/deploy/ci-deploy.sh && echo IN-SYNC
```

**And a NEW state dir under `data/` cannot be created by the deploy user at all.**
`~/wnet-test/data` is uid-1000-owned (container `node` == host `elkadmin`) while the deploy
account `tao` is 1001, so the script's own `mkdir -p` — a silent no-op for the dirs that
already existed — failed hard on `data/adminsvc` with `Permission denied` and aborted the
deploy before compose ran. Fixed in `ci-deploy.sh`: creation falls back to a root container
mounting the parent, and only on that path. Nothing to do by hand, but if a future service
adds a state dir and the deploy dies there, this is why.

**First read the file, because this snippet APPENDS a whole site block.** It is written for
the first-time setup, and it has been edited in place twice since (Grafana, then `/admin*`) —
so if a `bb.gamestao.com { … }` block is already there, running it verbatim adds a SECOND
one. That failure is loud (`caddy validate` rejects a duplicate site address, and the
`validate &&` in the chain means nothing is reloaded), but it wastes a round trip and reads
like a broken snippet rather than a wrong instruction. So:

```bash
ssh wnet-server 'grep -n "bb.gamestao.com" -A 20 ~/wnet/docker/Caddyfile'
```

- **No block** → append, with the snippet below exactly as it stands.
- **A block already there** → edit it in place instead, adding only the `handle` blocks it
  is missing. `/admin*` must land **before** the final bare `handle { }`; that trailing block
  is the catch-all, and `handle` is first-match, so anything after it is unreachable. This is
  design/21 §3.4's named trap, and getting it wrong is not an error — it is the console's page
  answered by matchsvc's 404 handler, i.e. a blank page with a 200.

#### The Caddyfile is a FILE bind mount, so HOW you edit it decides whether it lands

This cost a full diagnosis on 2026-09-09 and it looks like success the whole way through.
`docker inspect docker-caddy-1` shows the mount as
`/home/tao/wnet/docker/Caddyfile -> /etc/caddy/Caddyfile`: a single **file**, so the mount
is bound to that file's **inode**, not to its path. Any editor that writes a new file and
renames it over the old one — `mv new Caddyfile`, and `sed -i`, which does exactly that
internally — leaves the host path pointing at a NEW inode while the container keeps the
OLD one. The host file is then correct, and:

- `docker exec docker-caddy-1 caddy validate --config /etc/caddy/Caddyfile` reads the OLD
  inode and says **Valid configuration**,
- `caddy reload --config /etc/caddy/Caddyfile` reloads the OLD config and logs
  `adapted config to JSON`,
- and `/admin/` is answered by matchsvc's 404 handler — `{"error":"not found"}`,
  byte-identical to the catch-all's own 404, which is the trap two sections up wearing a
  different hat.

Every command reports success and the config never changed. Compare the two inodes to see
it, which is also the only check that actually proves a Caddyfile edit reached Caddy:

```bash
ssh wnet-server 'stat -c "host %i" ~/wnet/docker/Caddyfile; docker exec docker-caddy-1 stat -c "container %i" /etc/caddy/Caddyfile'
```

**So edit IN PLACE and keep the inode**: `cat >> Caddyfile` (what the snippet below does,
which is why the Grafana pass worked), or `cp new Caddyfile` — never `mv` over it, never
`sed -i`. `cp` and `>>` both truncate/append through the existing inode.

**If you already replaced it**, the container's mount is read-only so you cannot write
back through it, and the old inode has no name left on the host — there is nothing to
repair. Two ways out:

```bash
# Zero downtime: load the correct file through the admin API from a path you CAN write.
ssh wnet-server 'docker cp ~/wnet/docker/Caddyfile docker-caddy-1:/tmp/Caddyfile.new   && docker exec docker-caddy-1 caddy validate --config /tmp/Caddyfile.new --adapter caddyfile   && docker exec docker-caddy-1 caddy reload --config /tmp/Caddyfile.new --adapter caddyfile'
```

That fixes routing immediately, but it leaves ONE landmine: the container's
`/etc/caddy/Caddyfile` is still the stale inode, so the next person who reloads from that
path silently reverts whatever the file gained since. `docker restart docker-caddy-1`
re-resolves the bind mount to the host path and collapses the split permanently — correct,
but it is the company's shared proxy fronting `wnet-mock.elk.de`, the IP/hostname device
block and `sync.gamestao.com`, so it costs all of them a second of downtime. Prefer it at a
moment somebody has agreed to.

Both were done on 2026-09-09, in that order — the admin-API load to get `/admin*` serving,
then the restart once it was agreed. **The split is collapsed**: both inodes read the same,
the container's own copy carries the `/admin*` block, all four site blocks answer, and a
reload from `/etc/caddy/Caddyfile` is safe again.

After any reload, check the neighbours rather than just your own site — a reload replaces
the WHOLE config, so a mistake takes their sites with it, from inside the box so the
self-signed device cert does not confuse the result:

```bash
ssh wnet-server 'for h in wnet-mock.elk.de wnet-server sync.gamestao.com bb.gamestao.com; do
  printf "%s " "$h"; curl -sk -o /dev/null -w "%{http_code}
" --resolve "$h:443:127.0.0.1" "https://$h/"; done'
```

Same backup-append-validate-reload sequence deutsch's README uses (`reload`, not
`restart` — the wnet stack's own connections stay up):

```bash
ssh wnet-server 'cd ~/wnet/docker && cp Caddyfile Caddyfile.bak-$(date +%Y%m%d-%H%M%S) \
  && cat >> Caddyfile <<EOF

bb.gamestao.com {
	handle /ws* {
		reverse_proxy wnet-test-gameserver:8787
	}
	handle /grafana* {
		reverse_proxy wnet-test-grafana:3000
	}
	handle /admin* {
		reverse_proxy wnet-test-adminsvc:8790
	}
	handle {
		reverse_proxy wnet-test-matchsvc:8788
	}
}
EOF
  && docker exec docker-caddy-1 caddy validate --config /etc/caddy/Caddyfile \
  && docker exec docker-caddy-1 caddy reload --config /etc/caddy/Caddyfile'
```

To undo: restore the `.bak` file and reload again.

Once DNS has propagated, Caddy signs the cert automatically:

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
- [x] `docker inspect wnet-test-billsvc --format '{{.Config.Env}}'` does **not** show
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
      five minutes, and **Server status** shows every scrape target `up`
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
docker compose -f ~/wnet-test/docker-compose.yml logs -f

# Redeploy after a code change (build locally, then re-ship + rebuild)
cd server && npm run build
rsync -av dist Dockerfile docker-compose.yml deploy/package.json monitoring wnet-server:~/wnet-test/
ssh wnet-server 'cd ~/wnet-test && docker compose up -d --build'

# Pull the automated backups off the box (see the Backups section below — the snapshots
# themselves are taken on the box, daily, by the `backup` service; this is the off-box copy)
rsync -av wnet-server:~/wnet-test/backups/ ./backups/

# Tear down entirely (zero effect on wnet or deutsch-sync — remember to also remove the
# Caddyfile block above)
ssh wnet-server 'cd ~/wnet-test && docker compose down && rm -rf ~/wnet-test'
```

### Backups — automated 2026-09-07

Until this landed, "the backup procedure" was the two `scp` lines that used to sit in the
block above: a procedure exactly as reliable as somebody remembering it, protecting the two
things this project cannot regenerate — `accounts.db` (who somebody is) and `billing.db`
(what they paid for).

Now the compose project runs a fourth process, `wnet-test-backup` (`src/backup/`), and there
is nothing to remember:

- **Daily**, and once immediately at start, it snapshots both databases with SQLite's
  `VACUUM INTO` — a point-in-time consistent copy taken while the services keep running.
  `cp` of a live database is what this deliberately is not: it captures a torn page set that
  opens fine and fails on the page that mattered.
- **It cannot write to either database.** The two data directories are mounted `:ro`, and
  the SQLite handle is opened read-only (`VACUUM INTO` works that way — verified, see
  `src/backup/snapshot.ts`). Its only writable mount is `~/wnet-test/backups`.
- **Each snapshot is verified before it is published**: `PRAGMA integrity_check` on the copy,
  then gzip, then an atomic rename. Nothing in that directory is ever a file that merely
  looks like a backup — an interrupted run leaves a `.part`, which the pruner neither counts
  nor deletes.
- **14 per database are kept**, pruned per source, and only after that source's own
  snapshot succeeded — so a database that has been failing for a week keeps its last good
  snapshots instead of ageing them out on schedule.

```bash
# Is it working? (this is what the container's own healthcheck runs)
ssh wnet-server 'docker exec wnet-test-backup node backup.mjs --health && echo HEALTHY'
ssh wnet-server 'cat ~/wnet-test/backups/status.json'
ssh wnet-server 'ls -lh ~/wnet-test/backups'
docker ps --filter name=wnet-test-backup   # STATUS shows (healthy)/(unhealthy)

# Force a cycle now (it runs one at start, so a restart is a manual backup)
ssh wnet-server 'cd ~/wnet-test && docker compose restart backup'
```

**Restoring.** A snapshot is an ordinary gzipped SQLite file, so a restore needs no tooling
from this repo:

```bash
ssh wnet-server
cd ~/wnet-test
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
worse than one whose limit is written down. On a borrowed box, "the host is gone" is a real
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
>    ownership included. So `~/wnet-test/backups`, created by the very deploy that introduced
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
> ssh wnet-server 'cat ~/wnet-test-ci-deploy.sh' | diff - server/deploy/ci-deploy.sh && echo IN-SYNC
> ```

## 6. CI-based deploy — DONE (2026-09-07)

`.github/workflows/server-deploy.yml` + `server/deploy/ci-deploy.sh`, same shape as
deutsch's own `deploy.yml`/`deploy/ci-deploy.sh`: push to `main` touching
`server/**`/`engine/**`/`client/src/**` (or manual dispatch) → builds the bundles → ships
them over SSH with a key that can do exactly one thing on the VPS.

Everything is wired and verified:
- Dedicated keypair (`D:\cloud\wnet_test_ci_ed25519` — the only readable copy, since a
  GitHub Secret is write-only), private half in the repo Secret `SERVER_DEPLOY_KEY`.
- `server/deploy/ci-deploy.sh` installed at `~/wnet-test-ci-deploy.sh` (outside the deploy
  target on purpose — see its own header), `chmod 700`.
- Repo Variables: `SERVER_SSH_HOST=92.205.18.79`, `SERVER_SSH_USER=tao`,
  `SERVER_SSH_KNOWN_HOSTS` (pinned, fingerprint cross-checked against the VPS's own
  `/etc/ssh/ssh_host_ed25519_key.pub` — never `StrictHostKeyChecking=no`),
  `SERVER_API_BASE=https://bb.gamestao.com`, `SERVER_DEPLOY_ENABLED=true`.
- The forced-command `authorized_keys` line — the one step that needed a human with the
  VPS's `sudo` password, since that file is root-owned — is installed. **Verified it
  actually restricts**: sending an arbitrary command (`whoami`) over this key does not run
  it; the forced command runs `ci-deploy.sh` regardless, which then correctly rejects
  non-tar.gz stdin rather than doing anything with it.
- **Proven twice**: once manually (`tar czf - dist Dockerfile docker-compose.yml
  deploy/package.json | ssh -i ... tao@92.205.18.79`, all three containers rebuilt and
  came back healthy), then for real via `gh workflow run server-deploy` — a genuine CI
  run that went green end to end (build → SSH deploy → public `/health` check).

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
- **The OFF-BOX copy of the backups.** The `backup` service (§5, "Backups") takes and
  verifies a daily snapshot of both databases and keeps 14 of each, on the same disk as the
  databases. Getting them somewhere else is still the `rsync` line in §5, run by a person.
  What would close it: a scheduled pull from a machine that is not this VPS (the box is
  borrowed, so a push credential stored ON it is the thing not to add), or an object-store
  bucket the worker uploads to. Deliberately not guessed at here — it needs a destination
  somebody owns.

## 8. Observability — Loki + Alloy + Prometheus + Grafana (2026-09-09)

**What it answers.** Before this, "what happened on the server?" meant `ssh` +
`docker compose logs`, over a 10 MB × 3 rotating buffer, on a box only one person can
reach. "What happened in a player's browser?" had no answer at all — every device-side bug
this project has had (the blank WeChat labels, the CrazyGames SDK calls that were silent
no-ops, the CORS preflight that failed as a bare `Failed to fetch`) was found by somebody
happening to have devtools open at the time.

**Where it lives.** Four containers in the same compose project, `obs-`prefixed
(`wnet-test-loki` / `-alloy` / `-prometheus` / `-grafana`), configured from
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
ssh wnet-server 'cd ~/wnet-test && docker compose ps'

# 2. Is Loki accepting? (`ready` = yes)
ssh wnet-server 'docker exec wnet-test-loki wget -qO- http://127.0.0.1:3100/ready'

# 3. Is anything in it? (should list backend + client)
ssh wnet-server 'docker exec wnet-test-grafana wget -qO- "http://obs-loki:3100/loki/api/v1/label/source/values"'

# 4. Is the collector attached, and to OUR containers only?
ssh wnet-server 'docker logs --tail 50 wnet-test-alloy'

# 5. For the client half specifically — the variable that silently drops everything
ssh wnet-server 'docker exec wnet-test-matchsvc printenv BB_LOKI_PUSH_URL'

# 6. Are the metrics targets up? (two of them are the BOX OWNER's exporters — see below)
ssh wnet-server 'docker exec wnet-test-prometheus wget -qO- "http://127.0.0.1:9090/api/v1/targets?state=any" | head -c 2000'
```

### Two things about running this on a borrowed box

**The box's own monitoring already sees us, and this stack cannot change that.** The
machine runs its owner's wnet stack, which includes their own Loki/Promtail/Grafana — and
their promtail scrapes the Docker socket **unfiltered**, so every line our containers have
ever written is already in their store, labelled `wnet-test-*`. (Confirmed 2026-09-09 by
querying it; it also still holds `blightbloom-gameserver` / `-matchsvc` / `-billsvc`
streams from a short-lived container naming on 2026-09-07, i.e. the game's name did reach
that box despite the naming policy above, and log CONTENT carries it regardless.) Closing
that would mean editing *their* promtail config, which is not this project's to change
unilaterally — raise it with the box's owner if it matters.

Our own Alloy does the opposite, deliberately: `monitoring/alloy/config.alloy` filters
discovery to `wnet-test-*` twice over (a Docker-side filter and an Alloy-side `keep`), so
we do not collect their containers' logs into our store.

**Every service name here is `obs-`prefixed, and that is not cosmetic.** This compose
project joins the host's shared `docker_default` network, and compose publishes each
service NAME as a network alias on it. The owner's stack already answers to `loki`,
`grafana`, `prometheus` and `promtail` there. A service called `loki` would put two
containers behind one DNS name on a shared network — their collector's pushes could start
landing in our store and ours in theirs, intermittently, with nothing failing anywhere.
`server/test/deploy.observability.test.ts` fails the build on a colliding name.

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

