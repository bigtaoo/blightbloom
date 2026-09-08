# Server — co-op frame-broadcast gameserver

The **net layer** for online co-op (design/06, ROADMAP 3.1). A server-driven
frame-broadcast lockstep data plane (the 王者荣耀 / funny `gameserver` pattern): the
server owns the clock and broadcasts one frame packet per pulse, **never waiting for a
client** — a lagging player falls behind the broadcast and catches up alone.

It is deliberately thin. The determinism-critical relay logic lives in **`@dd/engine`**
(`net/FrameBroadcast.ts`) and is consumed identically by client and server — the design/06
anti-drift rule ("one definition, same bytes on both sides"). This package only adds the
**I/O orchestration** around it: seat assignment, the metronome, sockets.

## Layout

This package hosts **both planes** (design/06), each with its own entrypoint but a shared
pure core + the shared ticket module:

**Data plane** — the WebSocket frame relay (ROADMAP 3.1):

| File | Role | `ws`? | Tested |
|------|------|-------|--------|
| `src/MatchRoom.ts`   | One match's lifecycle: fill seats → start → relay → settle. Wraps `FrameBroadcast`. | no | ✅ `test/MatchRoom.test.ts` |
| `src/RoomManager.ts` | `roomId → MatchRoom`; routes `ClientMsg`; first joiner defines the match. | no | ✅ |
| `src/index.ts`       | WebSocket bootstrap — the ONLY file that imports `ws`; wraps sockets as `RoomConnection`s, provides the real-timer `Scheduler`, and **verifies the `/ws?ticket=` handshake**. | yes | typecheck only |

**Control plane** — matchmaking + tickets (ROADMAP 3.3):

| File | Role | I/O? | Tested |
|------|------|------|--------|
| `src/ticket.ts`      | Stateless HMAC-SHA256 sign/verify over `{roomId,owner,seed,playerCount,exp}`. Shared by both planes. | no | ✅ `test/ticket.test.ts` |
| `src/Matchmaker.ts`  | Pure queue: `enqueue`→group-when-full→signed tickets, `poll`. Injected clock/seed/roomId/signer. | no | ✅ `test/Matchmaker.test.ts` |
| `src/matchsvc.ts`    | HTTP bootstrap and assembly shell — the ONLY control-plane file that imports `node:http`; wires the real clock/seed/signer around `Matchmaker`, then dispatches to `src/routes/`. | yes | ✅ `test/matchsvc.http.test.ts` |
| `src/routes/*.ts`    | One module per surface (`auth`, `account`, `match`, `party`, `rating`, `store`, `internalEntitlements`), each a set of free `(req, res, url, deps)` handlers, over a shared `routes/http.ts` (CORS, `send`, `readJson`). | no | ✅ `test/routes.test.ts` + the two `*.http.test.ts` |
| `src/db.ts` / `src/AuthService.ts` | The SQLite (`node:sqlite`) account store: `accounts`/`sessions`/`ratings`/`meta_state`/`entitlements`/`rating_reports` (design/16-accounts.md). | file | ✅ `test/db.test.ts`, `test/AuthService.test.ts` |
| `src/rating.ts` / `src/ladderReport.ts` | The ladder: Elo-ish squad-aware deltas, the store, and the pure placement→rank conversion. `applyMatchOnce` claims `rating_reports.report_key` (`ON CONFLICT DO NOTHING` + `changes()`) inside the same `BEGIN IMMEDIATE` that writes `ratings`, which is what makes the at-least-once settlement report exactly-once (design/19 §3). | no | ✅ `test/rating.test.ts`, `test/ladderReport.test.ts`, `test/ratingReportOnce.test.ts` |
| `src/EntitlementService.ts` | Server-owned blueprint/character ownership (design/19 §2, ROADMAP 8.2) — the reason `/account/meta` is no longer a blind whole-blob upsert. Grant is `ON CONFLICT DO NOTHING` + `changes`, so an at-least-once delivery is idempotent. | no | ✅ `test/EntitlementService.test.ts` |
| `src/routes/internalEntitlements.ts` | `POST /internal/entitlements/grant` (8.7) — the ONLY caller of `EntitlementService.grant`, behind `internalAuth`. billsvc's delivery pump is what calls it. A 4xx here is read as terminal by that pump, so every refusal has to be one the same bytes would earn again. | no | ✅ `test/routes.internalEntitlements.test.ts` |
| `src/config.ts`      | The one place that reads `BB_TICKET_SECRET`, `BB_INTERNAL_KEY`, `BB_MATCHSVC_URL` and `BB_BILLSVC_URL` (env), so all three planes agree on each. | env | ✅ `test/config.test.ts` + `test/config.internalKeys.test.ts` |
| `src/internalAuth.ts` | Inbound service-to-service auth (ROADMAP 8.1): `x-internal-key` against a per-caller registry, hashed before `timingSafeEqual`. A THIRD credential namespace — never a player token. | no | ✅ `test/internalAuth.test.ts`, `test/internalTrustSeam.test.ts` |
| `src/internalFetch.ts` | Outbound service-to-service calls: always drains the response body, explicit per-attempt timeout, opt-in bounded retry. `collectBody`/`internalFetchJson` READ the body instead of cancelling it — the same drain obligation, for the one caller that needs the bytes. | no | ✅ `test/internalFetch.test.ts` |
| `src/routes/store.ts` | `/store/skus`, `/store/order`, `/store/order/:id` (8.8) — matchsvc's proxy in front of billsvc, and the one file where the two credential namespaces meet. Verifies the player's bearer session locally, then forwards over `internalFetch` with the accountId **that session** named. `GET /store/order/:id` is narrowed to the caller's own account (billsvc does not check ownership) and billsvc's 401 becomes a 502, never a relayed 401. | net | ✅ `test/routes.store.test.ts`, `test/store.proxy.http.test.ts` |

**Billing plane** — orders, receipts, IAP, entitlement delivery, operations (ROADMAP 8.3/8.4/8.5/8.7, design/19 §4/§5/§7):

| File | Role | I/O? | Tested |
|------|------|------|--------|
| `src/billingDb.ts` | billsvc's OWN SQLite file (`BB_BILLING_DB_PATH`): `orders`/`receipts`/append-only `ledger`/`deliveries`, plus 8.5's `webhook_events`/`review_queue`. Six tables, and a test asserts exactly those and no more. Deliberately NOT `db.ts`'s `openDb` — money gets its own file, and a shared opener is how that gets undone. | file | ✅ `test/billingDb.test.ts` |
| `src/billsvc/BillingService.ts` | The five §4 rules. `settle` claims the receipt row AND the ledger row (`ON CONFLICT DO NOTHING` + `changes()`), then updates the order and grants — one `BEGIN IMMEDIATE`, so a refused grant rolls all of it back. | no | ✅ `test/billsvc.BillingService.test.ts` |
| `src/billsvc/delivery.ts` | The entitlement seam, called from INSIDE that transaction — synchronous and `void`, so a throw rolls the settlement back. `ledgerOnlyDelivery` is the explicit opt-out, no longer the default. | no | ✅ (above) |
| `src/billsvc/outbox.ts` | The DURABLE half of the closed loop (8.7): one synchronous INSERT into `deliveries`, in the settlement transaction, keyed on the LEDGER row's id. After the COMMIT the delivery is OWED on disk. | no | ✅ `test/billsvc.outbox.test.ts` |
| `src/billsvc/deliveryPump.ts` | The ASYNC half: drains `deliveries` into matchsvc's `POST /internal/entitlements/grant` over `internalFetch`. Opportunistic after a settlement + a startup sweep + a bounded backstop. 4xx is terminal and loud; 5xx/network stays owed forever. Since 8.5 a terminal row is also FILED into `review_queue`, in the same transaction that makes it terminal. | net | ✅ `test/billsvc.deliveryPump.test.ts`, `test/billsvc.deliveryLoop.test.ts`, `test/billsvc.moneyTaken.test.ts` |
| `src/billsvc/skus.ts` | The server-side price table. `createOrder` has no `amount` parameter, so a body price cannot be plumbed in. | no | ✅ `test/billsvc.skus.test.ts` |
| `src/billsvc/iap/*.ts` | One module per platform behind `createReceiptVerifier` AND `createPlatformOrderLister` (8.5's reconciliation port), plus the `product:<sku>` dev stub and its authored `DevStubOrderBook`. Missing credentials FAIL on both — never fall back to the stub, and never answer an order listing with an empty list. | net | ✅ `test/billsvc.iap.test.ts`, `test/billsvc.reconcile.test.ts` |
| `src/billsvc/startupGuard.ts` | Second fail-closed check: refuses to START with a dev flag under `NODE_ENV=production`. Shares no code with the first, on purpose. | no | ✅ `test/billsvc.startupGuard.test.ts` |
| `src/billsvc/server.ts` | HTTP surface — the ONLY billing file that imports `node:http`. Every route behind `internalAuth` except `/health`, `/skus` and the platform webhook. | yes | ✅ `test/billsvc.http.test.ts` |
| `src/billsvc/main.ts` | Process entry on `BILL_PORT` (8789). Asserts startup safety BEFORE binding a port or creating a file. | yes | ✅ `test/billsvc.main.test.ts` |
| `src/billsvc/webhookLog.ts` | 8.5: EVERY platform callback, not just the one that settled — keyed `${txnId}:${eventType}` and upserted, with an order-id and then a raw-bytes-hash fallback so an unparsable payload still gets its own row. `raw` keeps the FIRST body; `divergences` counts redeliveries that changed it. | no | ✅ `test/billsvc.webhookLog.test.ts`, `test/billsvc.webhookEvents.http.test.ts` |
| `src/billsvc/reconcile.ts` | 8.5: the local↔platform comparison design/19 §4 leaves open, over an injected `PlatformOrderLister`. A platform that could not be asked lands in `unreconciled` and `complete` goes false — there is no path that reports clean for a check that did not run. Driven by `scripts/reconcile.ts`. | no | ✅ `test/billsvc.reconcile.test.ts` |
| `src/billsvc/reviewQueue.ts` | 8.5: the one place a human is told to look. Two producers (the grant audit, and the pump's money-taken-nothing-granted rows), `ON CONFLICT DO NOTHING` on a producer-minted key, and nothing in this server ever acts on an entry. | no | ✅ `test/billsvc.reviewQueue.test.ts` |
| `src/grantAudit.ts` | 8.5: counts non-`purchase` `entitlements` grants per account per UTC day and FILES anything over the threshold. `design/15`'s checkpoint-quorum principle — exactly AT the threshold is not an anomaly, an uncounted source is skipped, nothing is ever revoked. Control-plane table, so it is a module + `scripts/grantAudit.ts`, not a matchsvc route. | no | ✅ `test/grantAudit.test.ts` |

A player's client talks to the **control plane only**. It never reaches the billing plane's port:
the store routes above are the proxy in front of it, and billsvc's own routes are internal-key or
platform-signed (design/19 §3).

`MatchRoom`/`RoomManager` take an injected `Scheduler` (the metronome clock) and
`RoomConnection`s (per-seat senders), so the whole lifecycle is unit-tested with a fake
clock and fake sockets — no network, no timers. The relay *content* (command ordering,
the monotonic watermark, the reconnect log) is proven in `@dd/engine`'s
`framebroadcast.test.ts`, including a **loopback test** that runs
`FrameBroadcast → NetInputSource → engine` and asserts it reproduces a plain replay
byte-for-byte.

**Deploy artifact** — what actually runs in production (design/19 §9, ROADMAP 9.0):

| File | Role | Tested |
|------|------|--------|
| `scripts/build.mjs` | esbuild-bundles the four entrypoints into `dist/*.mjs`, resolving the `@dd/engine` / `@dd/game/*` / `@dd/net/*` aliases at BUILD time; `ws` and `node:sqlite` stay external. Exports `entries`/`external`/`target` so the tests read the real values. | ✅ `test/deploy.bundle.test.ts` |
| `Dockerfile` / `docker-compose.yml` / `deploy/package.json` | One image, four processes selected by `command:` — the three HTTP planes plus the `backup` worker; the image installs only the deploy manifest's dependencies and runs as non-root. | ✅ `test/deploy.manifests.test.ts` |
| `deploy/ci-deploy.sh` | The forced command the CI deploy key is pinned to (see `deploy/README.md`). Its payload check is cross-checked against the workflow's `tar` list. | ✅ `test/deploy.manifests.test.ts` |

The bundle test builds into an OS temp directory and boots each `.mjs` as a bare `node` process,
so anything the deploy manifest does not declare fails there the same way it would in the
container — the whole point being that `src/`'s coverage says nothing about the artifact. The
three HTTP bundles have to answer their own `/health` with their own service name; the worker,
which serves nothing, is driven through its output instead — its snapshot is gunzipped and a row
read back out of it, then the same bundle is asked for its health verdict the way compose asks.


**Backup worker** — the fourth process, and the only one that serves nothing (design/19 "Backups", `deploy/README.md`):

| File | Role | I/O? | Tested |
|------|------|------|--------|
| `src/backup/config.ts` | Reads `BB_DB_PATH` / `BB_BILLING_DB_PATH` (the SAME names the owning services use) + `BB_BACKUP_DIR`/`_INTERVAL_HOURS`/`_KEEP`. Mostly refusals: no source, a zero/garbage interval or a source inside the backup directory is a startup error, because a backup worker with nothing to do looks exactly like a working one. An EMPTY var counts as unset. | env | ✅ `test/backup.config.test.ts` |
| `src/backup/snapshot.ts` | One consistent copy: `VACUUM INTO` through a **read-only** handle (so this process cannot write to a live database), `integrity_check` on the copy, gzip, atomic rename. The timestamp lives in the FILENAME, since a restore or an `rsync -a` rewrites mtimes. | file | ✅ `test/backup.snapshot.test.ts` |
| `src/backup/prune.ts` | Pure retention: newest N **per source**, and only files matching what `snapshot.ts` writes are ever candidates. The one function here whose bug destroys data rather than failing to protect it. | no | ✅ `test/backup.prune.test.ts` |
| `src/backup/runner.ts` | One cycle (per-source failures recorded, never thrown, so one bad database cannot cost the other its backup), the `status.json` it publishes atomically, and the health verdict read back off it — unhealthy when any source failed OR the last cycle is too old. | file | ✅ `test/backup.runner.test.ts` |
| `src/backup/main.ts` | Two modes, one bundle: the loop (one cycle immediately, then every interval) and `--health`, which is the container's healthcheck. Refuses to start (exit 2) rather than idle. | file | ✅ `test/backup.main.test.ts`, `test/deploy.bundle.test.ts` |

It holds no writable handle on `accounts.db` or `billing.db` at all — compose mounts both data
directories `:ro` — and it copies nothing off the box, which is stated as still open in
`deploy/README.md` §7 rather than papered over.

## Protocol

Shared wire types live in `@dd/engine/net/protocol.ts` (`ClientMsg` / `ServerMsg`).
Messages are newline-free JSON — `PlayerCommand` is already compact plain data (integer
brad/mag/buttons), so JSON is fine for the co-op MVP; a WeChat/production build would swap
a binary codec in behind the same seam. The server **never interprets** a command's
meaning; it only buckets commands by frame and broadcasts them, stamping each with the
sender's authoritative seat (`owner`) so a client can only ever move its own player.

- `match_start` — sent when the room fills; carries `seed`, `playerCount`, and this
  client's `localOwner`. The client builds `EngineConfig.players` of length `playerCount`.
- `frame_batch` — one broadcast pulse: the confirmed `toFrame` watermark + any non-empty
  frames since the last pulse. `NetInputSource` folds it into the engine's confirmed stream.
- `conn_resync` — reconnect catch-up: the frame log past the client's `lastFrame`.
- `match_over` — the settled outcome (also re-judged client-side via `runHeadless`).

Tick rates: **sim 30 Hz**, **net 10 Hz** (one batch / 100 ms covering 3 sim frames) —
the funny defaults; both `FrameBroadcast` and `NetInputSource` take these as options so
the pairing stays in lock-step. (design/06 leaves 30 vs 20 Hz open, to decide after WeChat
CPU measurement.)

## Run

One package of a root npm workspace — `npm install` once at the repo root covers it.

```bash
npm run dev:server    # data plane: ws://0.0.0.0:8787/ws  (PORT/HOST env override)
npm run dev:matchsvc  # control plane: http://0.0.0.0:8788  (MATCH_PORT env override)
npm run billsvc -w server   # billing plane: http://0.0.0.0:8789  (BILL_PORT env override)
```

Two operational jobs, both CLI-only and neither scheduled by anything yet (ROADMAP 8.5):

```bash
npm run reconcile -w server -- --days=1        # local orders vs the platform's list; --strict to exit 1
npm run audit:grants -w server -- --dry-run    # non-purchase grants per account per UTC day
```

`reconcile` reports **INCOMPLETE** for the four real platforms, because none of them has a
credential in this project — that is the honest answer, not a failure of the run. `audit:grants`
opens the account database **read-only** and files into billsvc's `review_queue`; re-running it
over a day it has already filed produces nothing.

Or from inside `server/`: `npm test` (ticket / Matchmaker / MatchRoom / RoomManager),
`npm run typecheck` (incl. all four entrypoints), `npm run dev`, `npm run matchsvc`, `npm run billsvc`.

**Handshake (ROADMAP 3.3):** the client calls the control plane to matchmake —
`POST /find {playerCount}` then poll `GET /find/:queueId` — and receives a **signed
ticket**. It then opens the data-plane socket with it: `ws://host:8787/ws?ticket=<token>`.
The gameserver verifies the ticket and derives the trusted `{roomId, owner, seed,
playerCount}` from it, so a client can no longer claim another seat or a different seed.

**Ticket secret:** set `BB_TICKET_SECRET` to the SAME value on both processes for any real
deployment — then a valid ticket is mandatory (invalid/absent → close `4401`). Unset, both
default to a shared insecure DEV secret (with a warning) and the gameserver *also* still
accepts the legacy raw-param handshake (`/ws?roomId=..&owner=..&seed=..&count=..`) for local
manual testing. Where the two services physically deploy is an ops call; the architecture split
(design/06) is settled.

**Gameserver address (ROADMAP 8.6, design/19 §6):** set `BB_GAMESERVER_URL` on matchsvc so the
`wsUrl` it returns points at the data plane (default `ws://localhost:8787/ws`). It is read by
`GameRegistry`, not baked into the ticket — the ticket is a seat authorization and carries no
topology, so a seat granted while one instance was serving is redeemable against whichever instance
is current when it is presented. Today the registry holds only that configured address:
`register`/`heartbeat` exist as methods with **no HTTP route**, because a single-instance deployment
does not register at all. With no configured address and nothing registered, `/find`, `GET
/find/:queueId` and `/resume` answer **503 `{"error":"no gameserver available"}`** rather than
issuing a ticket with nowhere to redeem it.

**Billing (ROADMAP 8.3/8.4/8.5, design/19 §4/§5/§7):** `BB_BILLING_DB_PATH` is billsvc's own SQLite
file and is deliberately a DIFFERENT variable from `BB_DB_PATH` — one operator setting one
variable must not be able to point both planes at one file. `BB_BILLING_DEV_STUB=1` enables the
`product:<sku>` receipt stub, which is what makes the whole create → pay → callback → delivered
chain drivable with no merchant account; under `NODE_ENV=production` it is ignored AND the process
refuses to start with it set. No Apple/Google/WeChat/Stripe credential exists in this project, so
those adapters return failure rather than granting anything (`BB_APPLE_SHARED_SECRET`,
`BB_GOOGLE_SERVICE_ACCOUNT_JSON` + `BB_GOOGLE_PACKAGE_NAME`, `BB_WECHAT_MCH_ID` +
`BB_WECHAT_API_V3_KEY`, `BB_STRIPE_SECRET_KEY` are read but cannot be verified) — and, since
8.5, cannot be reconciled against either. `BB_BILLING_DEV_ORDERS` points at a JSON array of
platform orders that becomes the dev platform's own order book, which is what makes reconciliation
drivable at all with no merchant account; it is deliberately AUTHORED rather than derived from
`orders`, since a platform side computed from the local side could only ever report zero
differences. `BB_GRANT_AUDIT_THRESHOLD` overrides the grant audit's per-account-per-day ceiling
(default 3; the comparison is `>`, so exactly at it is not an anomaly).

**Internal key (ROADMAP 8.1, design/19 §3):** set `BB_INTERNAL_KEY` to the SAME value on
all three HTTP processes (the backup worker makes no internal calls and gets none of this), the same way as the ticket secret and for the same reason — it is what the
gameserver presents on `POST /rating/report` and what billsvc presents on
`POST /internal/entitlements/grant`, both of which are INTERNAL routes and refuse anything
else. billsvc also needs `BB_MATCHSVC_URL` to know where to deliver (default
`http://localhost:8788`); with it wrong or the control plane down, a settled purchase stays
`pending` in `deliveries` and is retried rather than lost. It is a **third** credential namespace, distinct from player sessions (`Authorization:
Bearer`) and from the ticket HMAC; an internal route never accepts a player token. Unset, it
falls back to a published insecure DEV key with a warning so the local two-process setup
works out of the box — **except under `NODE_ENV=production`, where an unset key means every
internal call is refused** rather than falling back to a key printed in this repository.
A refused settlement report is logged (room, attempt count, failure kind), so a missing key
shows up in the gameserver log rather than as a ladder that quietly stops moving.

**Exactly-once settlement (2026-09-05, design/19 §3):** the report carries a `reportKey`
(`{roomId}:{digest}`, from `ladderReport.ts`), and matchsvc claims it in `rating_reports`
inside the same transaction that moves the ratings — so the retry the paragraph above
describes can no longer double-credit a match. A redelivery is answered **200 with
`duplicate: true`** and not 409, because the sender counts every non-2xx a failure and would
otherwise log a failure for a report that landed *and* keep retrying it; a report whose apply
throws is answered 500, which is the one status that IS retried, and the claim has already
rolled back. A report with no `reportKey` at all (an older gameserver mid-deploy) is applied
the old, non-deduped way and logged — a 4xx is never retried, so refusing it would lose that
match's rating for good.

**Reconnect (design/06, wired end-to-end 2026-08-04):** the join handshake above only
ever succeeds while a room is still `WAITING` (filling seats) — a socket for a room
already `IN_MATCH` gets `4403` from that path. A dropped mid-match connection instead
calls `POST /resume {token}` with its *original* (by now likely expired) join ticket:
matchsvc re-verifies its signature while ignoring `exp` (proof the caller once
legitimately held that seat — a match runs far longer than a ticket's 30s TTL, so the
original can't just be redeemed again) and mints a fresh one for the same
`{roomId,owner,seed,playerCount,teamId,mode}`. The client then reopens `/ws?ticket=` with
that fresh ticket; the gameserver detects the room is already `IN_MATCH` (not `WAITING`)
and, instead of trying `join()`, waits for the client's own `{type:'resume', lastFrame}`
message, which `MatchRoom.resume()` answers with `conn_resync` (the frame log past
`lastFrame` + the current watermark) and resumes the metronome once every seat is back.
A resume against a room that's already settled/destroyed gets `{type:'error',
code:'resume_failed'}` instead of hanging silently. **This was dead code from 3.1 until
this pass** — `resume`/`conn_resync` existed and were unit-tested in isolation, but
nothing on the client ever called `resume`, and the handshake above would have rejected
the attempt anyway; a real disconnect just froze the match forever. See design/06's
"Mid-match reconnect" open question and `client/src/net/reconnect.ts`.

## Not in scope (by design)

Anti-cheat beyond the post-match `runHeadless` re-judge (design/06: full state is
client-held; casual-first PvP accepts maphack at launch), and PvP settlement/ELO (Phase 4).
The matchmaking here is deliberately minimal — a first-come queue keyed by seat count, no
**accounts/auth** (a ticket identifies a seat, not a user) and no **skill matching/MMR**.
Co-op is cooperative and latency-tolerant, so it is playable on the confirmed stream +
catch-up alone; **local prediction** (rendering your own movement/aim ahead of the confirmed
frame) shipped as a client-side render-layer concern on top (`client/src/game/controllers/LocalPredictor.ts`)
and never touches this data plane — the server stays the pure confirmed-frame relay.
