# Deploying the backend

> **Status (2026-09-07): fully live, including CI.** All three containers are up and
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

Three processes, one image (`server/Dockerfile`, `server/docker-compose.yml`):
`gameserver` (WS data plane, design/06), `matchsvc` (control plane — matchmaking,
accounts, store proxy) and `billsvc` (billing plane). **billsvc runs in dev-stub mode**:
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
rsync -av dist Dockerfile docker-compose.yml deploy/package.json .env wnet-server:~/wnet-test/
```

**No `rsync` on Windows Git Bash** (this is how the first deploy actually happened,
2026-09-07) — `scp -r` works fine for something this small, just do the nested
`deploy/package.json` as its own copy so it lands at the right path:

```bash
ssh wnet-server 'mkdir -p ~/wnet-test/deploy'
scp -rq dist Dockerfile docker-compose.yml .env wnet-server:~/wnet-test/
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
```

## 2. Wire up Caddy

matchsvc answers everything except the WS upgrade, which is path-pinned to `/ws`
(`server/src/index.ts`'s `WebSocketServer({ path: '/ws' })`) — so the site block is a
two-line path split, not a whole-host proxy the way deutsch's single-service one is:

```caddyfile
bb.gamestao.com {
	reverse_proxy /ws* wnet-test-gameserver:8787
	reverse_proxy wnet-test-matchsvc:8788
}
```

Same backup-append-validate-reload sequence deutsch's README uses (`reload`, not
`restart` — the wnet stack's own connections stay up):

```bash
ssh wnet-server 'cd ~/wnet/docker && cp Caddyfile Caddyfile.bak-$(date +%Y%m%d-%H%M%S) \
  && cat >> Caddyfile <<EOF

bb.gamestao.com {
	reverse_proxy /ws* wnet-test-gameserver:8787
	reverse_proxy wnet-test-matchsvc:8788
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

- [ ] `curl https://bb.gamestao.com/health` → `{"ok":true,"service":"daydayup-matchsvc"}`,
      cert issued by Let's Encrypt
- [ ] A WS client can open `wss://bb.gamestao.com/ws?ticket=...` and receive frames
- [ ] `docker compose logs billsvc` shows `[DEV RECEIPT STUB ENABLED]` — confirms billsvc
      is NOT accidentally in production mode
- [ ] `docker inspect wnet-test-billsvc --format '{{.Config.Env}}'` does **not** show
      `NODE_ENV=production` (that combination is refused at the process level, but the
      compose file should never even attempt it)
- [ ] A `/store/skus` request through matchsvc returns the SKU table (proves the
      matchsvc → billsvc internal hop works even with billsvc in dev-stub mode)

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
# Logs
docker compose -f ~/wnet-test/docker-compose.yml logs -f

# Redeploy after a code change (build locally, then re-ship + rebuild)
cd server && npm run build
rsync -av dist Dockerfile docker-compose.yml deploy/package.json wnet-server:~/wnet-test/
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
