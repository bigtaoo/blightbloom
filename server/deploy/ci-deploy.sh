#!/bin/sh
# The ONLY command CI is allowed to run on the host, deploying the backend.
#
# ── Why it has this shape ──
# The deploy key is registered in the server's `~/.ssh/authorized_keys` as:
#
#   command="/home/tao/wnet-test-ci-deploy.sh",restrict ssh-ed25519 AAAA...
#
# `command=` is OpenSSH's FORCED COMMAND: whoever holds this private key, whatever they
# ask sshd to run, sshd runs only this script. That pins this key's capability down to
# "deploy the backend once" instead of "log into this box" — a shared box borrowed for
# spare capacity, not owned by this project. `restrict` turns off port/agent forwarding,
# pty and X11 (otherwise those could be used to route around the forced command).
#
# ── Why it lives OUTSIDE ~/wnet-test ──
# Because it must not be deployable content itself — installed inside the deploy target,
# a deploy could replace this script and the forced-command constraint would be gone at
# that point. So the LIVE copy is `~/wnet-test-ci-deploy.sh`; this file in the repo is only
# a copy — editing it here does nothing until it's re-installed by hand
# (deploy/README.md's CI section has the command).
#
# ── What it moves, and the one capability that comes with it ──
# `.env` is never touched: the ticket secret, the internal key and (eventually) the Paddle
# credential live only on the box, and this key cannot read or replace them.
#
# `docker-compose.yml` IS replaced, and that is a deliberate capability rather than an
# oversight — it is what lets a deploy add or change a SERVICE (the `backup` worker landed
# that way, 2026-09-07) instead of needing a hand-edit on a box nobody logs into. Be clear
# about what it costs, because an earlier version of this comment claimed the opposite and
# was wrong for long enough to be worth naming: whoever holds this key can ship a compose
# file that bind-mounts the host's `/` into a container, i.e. can reach host root on a box
# this project only borrows. The bounding facts are that the compose file is tracked in
# git and reviewed like code, and that the key already ships `dist/*.mjs` and the
# Dockerfile — arbitrary code inside the containers either way. If the box's owner ever
# wants that capability gone, the change is to drop `docker-compose.yml` from BOTH this
# script's copy list and the workflow's `tar`, and to hand-install compose changes again
# (server/deploy/README.md §5).
set -eu

TARGET="$HOME/wnet-test"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# CI side sends `tar czf - -C server dist Dockerfile docker-compose.yml deploy/package.json
# | ssh ...`, so the payload arrives on stdin.
tar xzf - -C "$STAGE"

for path in dist/index.mjs dist/matchsvc.mjs dist/billsvc.mjs dist/backup.mjs Dockerfile docker-compose.yml deploy/package.json monitoring; do
  if [ ! -e "$STAGE/$path" ]; then
    echo "payload is missing $path, aborting (no half-finished deploy)" >&2
    exit 1
  fi
done

rm -rf "$TARGET/dist"
cp -R "$STAGE/dist" "$TARGET/dist"
# Replaced wholesale rather than merged, same as dist/: these are the observability stack's
# config files (Loki retention, Alloy's scrape filter, Prometheus's targets, Grafana's
# provisioned datasources and dashboards), all bind-mounted READ-ONLY into their
# containers. A merge would leave a deleted dashboard on the box forever.
#
# Two of them only take effect on a container REBUILD, which is what makes the
# `--force-recreate` below load-bearing rather than belt-and-braces: changing a
# bind-mounted file does not change the container's definition, so a plain
# `docker compose up -d` sees nothing to do and the old config keeps running. funny's own
# deploy carries the same flag for the same reason.
rm -rf "$TARGET/monitoring"
cp -R "$STAGE/monitoring" "$TARGET/monitoring"
cp "$STAGE/Dockerfile" "$STAGE/docker-compose.yml" "$TARGET/"
mkdir -p "$TARGET/deploy"
cp "$STAGE/deploy/package.json" "$TARGET/deploy/package.json"

cd "$TARGET"

# ── Bind-mount ownership, before anything tries to write through one ──
# Docker creates a MISSING bind-mount source as `root:root`, and the image's own
# `chown node:node /data /backups` (Dockerfile) is invisible once a mount is in place —
# the mount replaces that directory, ownership included. So a state dir the host doesn't
# already own correctly is one the container user (uid 1000 = `node`) cannot write to,
# and the process finds that out at runtime rather than at deploy time.
#
# This is not hypothetical: `backups/` was created root-owned by the 2026-09-07 deploy
# that introduced the worker, which then spent 18 hours in a restart loop failing EACCES
# on every write — with CI green, because the live copy of THIS script predated the
# backup check at the bottom of it. Zero snapshots were taken in that window.
#
# Idempotent by construction: the chown container only runs for a dir that is actually
# wrong, so the steady state costs one `stat` per dir and starts nothing.
for dir in data/matchsvc data/billsvc backups; do
  mkdir -p "$TARGET/$dir"
  if [ "$(stat -c %u "$TARGET/$dir")" != "1000" ]; then
    echo "fixing ownership of $dir (was uid $(stat -c %u "$TARGET/$dir"), needs 1000)"
    docker run --rm -v "$TARGET/$dir:/fix" --entrypoint chown alpine:latest -R 1000:1000 /fix
  fi
done

# ── The one value this script cannot supply ──
# docker-compose.yml declares `GF_SECURITY_ADMIN_PASSWORD: ${BB_GRAFANA_ADMIN_PASSWORD:?}`,
# and `.env` is the file this key deliberately cannot write. So a box whose `.env` predates
# the Grafana service fails `compose up` for EVERY service, not just Grafana — a loud stop
# rather than a public admin/admin, but one whose real cause ("compose refused to
# interpolate") reads like a broken compose file. Named here so the deploy log says which
# it is. server/deploy/README.md §2 has the one-liner that fixes it.
if ! grep -q '^BB_GRAFANA_ADMIN_PASSWORD=..*' .env; then
  echo "BB_GRAFANA_ADMIN_PASSWORD is missing or empty in ~/wnet-test/.env." >&2
  echo "compose will refuse to start ANY service until it is set — see deploy/README.md section 2." >&2
  exit 1
fi

docker compose up -d --build --force-recreate
docker compose ps --format '{{.Name}} {{.Status}}'

# Success is "the services actually answer", not "the command returned 0" — without this,
# a container that never comes up healthy would still show green in CI, and a silently
# failed deploy is exactly as bad as a silently failed backup.
for svc in gameserver:8787 matchsvc:8788 billsvc:8789; do
  name="${svc%%:*}"
  port="${svc##*:}"
  container="wnet-test-$name"
  docker exec "$container" node -e "
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let i = 0; i < 15; i += 1) {
        try {
          const res = await fetch('http://127.0.0.1:$port/health');
          if (res.ok) {
            console.log('$container health', JSON.stringify(await res.json()));
            process.exit(0);
          }
        } catch {
          /* not up yet */
        }
        await wait(1000);
      }
      console.error('$container: /health did not answer within 15s, deploy counts as failed');
      process.exit(1);
    })();
  "
done

# The backup worker serves nothing, so it is verified the way compose does it: by asking
# its own bundle. It runs one cycle immediately at start, so a healthy answer here means a
# real snapshot of both databases was taken and verified seconds ago — and a deploy that
# silently stopped backing up is exactly the failure this loop's own comment above refuses
# to wave through.
# ── The observability stack ──
# Checked the same way and for the same reason as everything above: this stack's whole
# failure mode is being quietly absent, which is indistinguishable from a quiet week. A
# deploy that leaves Loki unable to ingest, or Grafana unable to boot its provisioning,
# should be red here rather than discovered the next time somebody has a question.
#
# They are checked AFTER the four application services on purpose: if both halves are
# broken, the failure worth reading first is the one that affects players.
for probe in obs-loki:3100:/ready obs-prometheus:9090:/-/healthy obs-grafana:3000:/grafana/api/health; do
  name="${probe%%:*}"
  rest="${probe#*:}"
  port="${rest%%:*}"
  path="${rest#*:}"
  container="wnet-test-${name#obs-}"
  ok=""
  for _ in $(seq 1 20); do
    if docker exec "$container" wget --spider -q "http://127.0.0.1:$port$path" 2>/dev/null; then
      echo "$container ok"
      ok=1
      break
    fi
    sleep 2
  done
  if [ -z "$ok" ]; then
    echo "$container: $path did not answer within 40s, deploy counts as failed" >&2
    exit 1
  fi
done

# ── Alloy, which cannot be probed the way the three above are ──
# It is the collector — if it is dead, both dashboards go quiet and nothing else here
# notices — and it is also the one container with no HTTP client inside it at all (no wget,
# no curl, no nc, no busybox; /bin/sh is dash, so not even /dev/tcp), which is why
# docker-compose.yml gives it no healthcheck. So it is checked from OUTSIDE, by asking
# Prometheus whether its scrape of `obs-alloy` is up. That is a stronger statement than a
# self-probe: it proves the endpoint answers AND that the container resolves by name on the
# shared network — the property the `obs-` prefix exists to protect.
#
# `grep` over the raw JSON rather than a JSON parser, because this script may only assume
# a POSIX shell and Docker. Prometheus needs one scrape interval (30s) before it has an
# answer at all, hence the wait rather than a single shot.
alloy_ok=""
for _ in $(seq 1 25); do
  if docker exec wnet-test-prometheus wget -qO- \
      'http://127.0.0.1:9090/api/v1/query?query=up{svc="alloy"}' 2>/dev/null |
      grep -q '"value":\[[0-9.]*,"1"\]'; then
    echo "wnet-test-alloy ok (up{svc=\"alloy\"} == 1)"
    alloy_ok=1
    break
  fi
  sleep 2
done
if [ -z "$alloy_ok" ]; then
  echo "wnet-test-alloy: prometheus does not see it up within 50s, deploy counts as failed" >&2
  echo "  (logs are still being written; they are just not being COLLECTED)" >&2
  exit 1
fi

docker exec wnet-test-backup node -e "
  const { execFileSync } = require('node:child_process');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    for (let i = 0; i < 15; i += 1) {
      try {
        execFileSync(process.execPath, ['backup.mjs', '--health'], { stdio: 'pipe' });
        console.log('wnet-test-backup health ok');
        process.exit(0);
      } catch {
        /* no verified cycle yet */
      }
      await wait(1000);
    }
    console.error('wnet-test-backup: no healthy backup cycle within 15s, deploy counts as failed');
    process.exit(1);
  })();
"
