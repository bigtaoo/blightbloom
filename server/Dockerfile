# Runs the already-built server bundles (server/dist/*.mjs — see scripts/build.mjs).
# One image, five processes: docker-compose.yml picks which one via `command:`. The image
# also carries `migrate.mjs`, the one-time SQLite→MongoDB cutover (deploy/README.md §5),
# which compose does NOT run — an operator runs it once by hand, and this `COPY dist/*.mjs`
# is the only way it gets here at all.
# No TypeScript, no workspace source, no monorepo node_modules in here — `npm run build`
# (repo root, or CI) resolves the @dd/engine / @dd/game / @dd/net workspace aliases and
# collapses each entrypoint into one flat ESM file BEFORE this image is built.
FROM node:22-alpine

WORKDIR /app

# `ws` and `mongodb` are the two real runtime dependencies — see scripts/build.mjs's
# `external` list for why neither is bundled. (`node:sqlite`, which `migrate.mjs` still
# reads the legacy files with, is a Node builtin and needs nothing here.)
COPY deploy/package.json ./package.json
RUN npm install --omit=dev

COPY dist/*.mjs ./

# /backups is the backup worker's volume — since the port it reads the CLUSTER and writes
# only here (src/backup/snapshot.ts), so it is the one writable mount left. /data survives
# as the mountpoint the one-time migration reads the legacy `.db` files through, READ-ONLY
# (deploy/README.md §5); no service writes to it any more. node:22-alpine already ships a
# non-root `node` user — run as it rather than root.
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node

ENV HOST=0.0.0.0
