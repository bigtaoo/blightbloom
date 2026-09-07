#!/bin/sh
# The ONLY command CI is allowed to run on wnet-server, deploying the backend.
#
# ── Why it has this shape ──
# The deploy key is registered in the server's `~/.ssh/authorized_keys` as:
#
#   command="/home/tao/blightbloom-server-ci-deploy.sh",restrict ssh-ed25519 AAAA...
#
# `command=` is OpenSSH's FORCED COMMAND: whoever holds this private key, whatever they
# ask sshd to run, sshd runs only this script. That pins this key's capability down to
# "deploy the backend once" instead of "log into this box as tao" — a box that also runs
# the company's wnet stack. `restrict` turns off port/agent forwarding, pty and X11
# (otherwise those could be used to route around the forced command).
#
# ── Why it lives OUTSIDE ~/blightbloom-server ──
# Because it must not be deployable content itself — installed inside the deploy target,
# a deploy could replace this script and the forced-command constraint would be gone at
# that point. So the LIVE copy is `~/blightbloom-server-ci-deploy.sh`; this file in the
# repo is only a copy — editing it here does nothing until it's re-installed by hand
# (deploy/README.md's CI section has the command).
#
# ── Why it only moves five things ──
# `docker-compose.yml` and `.env` are never touched. That keeps this key unable to write a
# compose file that bind-mounts the host's `/` into a container to get host root — the
# single biggest hole in "CI can deploy containers" — closed here rather than anywhere
# downstream. Cost: changing compose or env vars still needs a manual server-side edit
# (server/deploy/README.md §5), a handful of times a year at most.
set -eu

TARGET="$HOME/blightbloom-server"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# CI side sends `tar czf - -C server dist Dockerfile docker-compose.yml deploy/package.json
# | ssh ...`, so the payload arrives on stdin.
tar xzf - -C "$STAGE"

for path in dist/index.mjs dist/matchsvc.mjs dist/billsvc.mjs Dockerfile docker-compose.yml deploy/package.json; do
  if [ ! -e "$STAGE/$path" ]; then
    echo "payload is missing $path, aborting (no half-finished deploy)" >&2
    exit 1
  fi
done

rm -rf "$TARGET/dist"
cp -R "$STAGE/dist" "$TARGET/dist"
cp "$STAGE/Dockerfile" "$STAGE/docker-compose.yml" "$TARGET/"
mkdir -p "$TARGET/deploy"
cp "$STAGE/deploy/package.json" "$TARGET/deploy/package.json"

cd "$TARGET"
docker compose up -d --build
docker compose ps --format '{{.Name}} {{.Status}}'

# Success is "the services actually answer", not "the command returned 0" — without this,
# a container that never comes up healthy would still show green in CI, and a silently
# failed deploy is exactly as bad as a silently failed backup.
for svc in gameserver:8787 matchsvc:8788 billsvc:8789; do
  name="${svc%%:*}"
  port="${svc##*:}"
  container="blightbloom-$name"
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
