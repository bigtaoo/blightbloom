# Runs the already-built server bundles (server/dist/*.mjs — see scripts/build.mjs).
# One image, five processes: docker-compose.yml picks which one via `command:`. `COPY
# dist/*.mjs` is also the ONLY way a hand-run tool can reach this image — there is no
# `scripts/`, no TypeScript and no `tsx` in here, which is what the one-time SQLite→MongoDB
# cutover found out the hard way (deploy/README.md §5, 2026-09-16).
# No TypeScript, no workspace source, no monorepo node_modules in here — `npm run build`
# (repo root, or CI) resolves the @dd/engine / @dd/game / @dd/net workspace aliases and
# collapses each entrypoint into one flat ESM file BEFORE this image is built.
FROM node:22-alpine

WORKDIR /app

# `ws` and `mongodb` are the two real runtime dependencies — see scripts/build.mjs's
# `external` list for why neither is bundled.
COPY deploy/package.json ./package.json
RUN npm install --omit=dev

COPY dist/*.mjs ./

# /backups is the backup worker's volume — since the port it reads the CLUSTER and writes
# only here (src/backup/snapshot.ts), so it is the one writable mount left. /data is kept as
# a mountpoint although no service writes to it any more: the box still holds the legacy
# `.db` files, and a one-off container that has to read them mounts them there.
# node:22-alpine already ships a non-root `node` user — run as it rather than root.
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node

ENV HOST=0.0.0.0
