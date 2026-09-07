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
openssl rand -hex 32   # DDU_TICKET_SECRET
openssl rand -hex 32   # DDU_INTERNAL_KEY
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

```bash
# Logs
docker compose -f ~/wnet-test/docker-compose.yml logs -f

# Redeploy after a code change (build locally, then re-ship + rebuild)
cd server && npm run build
rsync -av dist Dockerfile docker-compose.yml deploy/package.json wnet-server:~/wnet-test/
ssh wnet-server 'cd ~/wnet-test && docker compose up -d --build'

# Back up both SQLite files
scp wnet-server:~/wnet-test/data/matchsvc/accounts.db ./accounts-backup-$(date +%F).sqlite
scp wnet-server:~/wnet-test/data/billsvc/billing.db   ./billing-backup-$(date +%F).sqlite

# Tear down entirely (zero effect on wnet or deutsch-sync — remember to also remove the
# Caddyfile block above)
ssh wnet-server 'cd ~/wnet-test && docker compose down && rm -rf ~/wnet-test'
```

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
