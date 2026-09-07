# Runs the already-built server bundles (server/dist/*.mjs — see scripts/build.mjs).
# One image, three processes: docker-compose.yml picks which one via `command:`.
# No TypeScript, no workspace source, no monorepo node_modules in here — `npm run build`
# (repo root, or CI) resolves the @dd/engine / @dd/game / @dd/net workspace aliases and
# collapses each entrypoint into one flat ESM file BEFORE this image is built.
FROM node:22-alpine

WORKDIR /app

# Only `ws` is a real runtime dependency (node:sqlite is a Node builtin) — see
# scripts/build.mjs's `external` list for why both are left out of the bundles.
COPY deploy/package.json ./package.json
RUN npm install --omit=dev

COPY dist/*.mjs ./

# Data volume mountpoint for matchsvc's accounts.db / billsvc's billing.db
# (DDU_DB_PATH / DDU_BILLING_DB_PATH point here in docker-compose.yml). node:22-alpine
# already ships a non-root `node` user — run as it rather than root.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV HOST=0.0.0.0
