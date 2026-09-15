# Topology and operations

Part 3 of the server-platform doc (index: [`design/19-server-platform.md`](../19-server-platform.md)).
Sections **§6–§7**: how a client finds a gameserver, and everything that has to be true for a human
to run this — evidence, reconciliation, the anomaly audit, and backups.

## 6. Topology: `GameRegistry`, deferred but shaped now

The gameserver's rooms are in-process `Map`s driven by in-process intervals (`RoomManager.ts`), so
today there can be exactly one. That is fine — a frame-broadcast room is inherently a stateful
shard — but it is currently an accident rather than a decision, and the cheap moment to shape it
is before anything depends on `/find`'s response format.

funny's answer, adopted: a registry inside matchsvc where each gameserver **registers** its public
WS URL and capacity at startup, **heartbeats** its load, and is dropped after 30 s of silence;
`/find` picks the least-loaded healthy instance and returns its URL **in the response, not in the
ticket** — the ticket stays purely a seat authorization and never learns the topology. Two details
from funny that are the actual content:

- **A single-instance deployment does not register at all**; a configured static address seeds one
  entry. So this can land now as the static branch only, with the register/heartbeat routes unbuilt.
- **Registration retries indefinitely with capped backoff, but gives up immediately on a 4xx**, and
  heartbeats deliberately do *not* re-register. A heartbeat that silently re-registered would mask
  a failed startup registration; a registration that gave up on a network blip would leave the
  instance permanently invisible.

This supersedes the "put a gameserver id inside the ticket" sketch that preceded this doc.

### Shipped 2026-09-05 — the static branch, and what building it settled (ROADMAP 8.6)

`server/src/GameRegistry.ts`, consulted by `matchsvc.ts`; `register`/`heartbeat` are methods with no
HTTP route, so the configured static address is the only branch a deployment reaches today.
`ticket.ts` is unchanged, and so is the client. Volume 34 has the full account; three points belong
here because they qualify the bullets above.

- **"A configured static address seeds one entry" must not be read literally.** Nothing heartbeats a
  configured address and nothing reports its load, so as a map entry it sits at load 0 and never goes
  stale — and therefore wins every `pick()` against real instances reporting real numbers. It is held
  in its own field and reached only when no registered instance qualifies. This is also why
  `GameServerEntry.lastSeenMs` is nullable and `capacity` is `Infinity` for that entry: an unknown
  capacity must read as unbounded rather than as full, and "never heard from" is a different state
  from "just checked in".
- **`pick()` returning `null` is a real answer, and the callers had to grow a refusal.** With no
  registered instance and no configured address it is the only answer. `routes/match.ts` answers 503
  `{ error: 'no gameserver available' }` on all three routes, which is what lets `MatchInfo.wsUrl`
  stay non-optional on the client — an `undefined` in the match object would surface not at the
  control plane but as a socket opened on `undefined?ticket=…`. Both `/find` routes ask BEFORE
  touching the queue: `Matchmaker.poll` deletes the waiter on its way to returning `matched`, so a
  503 decided afterwards would destroy the seat the player has been waiting for.
- **The registration rules are enforced or written down, not deferred with the routes.** The 4xx/
  backoff/never-re-register bullet above is in the class header, `REGISTER_BACKOFF_CAP_MS` is
  exported beside `STALE_MS` (equal today, deliberately two constants — one is how long the registry
  waits before disbelieving an instance, the other how long an instance waits before retrying), and
  `heartbeat()` returns `false` for an unknown id and writes nothing, so the half that can be
  enforced today is.

Also settled here rather than in `config.ts`: `BB_GAMESERVER_URL`'s default lives in
`GameRegistry.staticGameserverUrl()`, read per call for the reason `ticketSecret` is. The registry
owns the topology question, so `config.ts` has no reason to.

## 7. Operations — SHIPPED 2026-09-05

**Status: SHIPPED 2026-09-05** (ROADMAP 8.5). None of this was optional once money moved, and all
of it was small because the schema anticipated it — three new sibling modules under
`server/src/billsvc/` plus one at `server/src/grantAudit.ts`, two new tables in billsvc's own
file, and two CLI scripts under `server/scripts/`. `BillingService.ts` did not grow by a line:
each of the three is an independent concern, so each is a sibling file (CLAUDE.md's first split
form), not a method.

- **Log every webhook event, not just the successful one — `server/src/billsvc/webhookLog.ts`.**
  Keyed `${txnId}:${eventType}` so at-least-once redelivery upserts. funny's reason: failed and
  cancelled transactions are otherwise dropped silently by the handler, and "why did my payment
  not go through" then has no evidence behind it at all. Every branch of `POST /webhook/:platform`
  now writes one `webhook_events` row before it answers — the settlement, the replay, the cancel,
  the refusal, the unrecognised event type, and the body that was not even JSON.
- **Reconciliation, daily — `server/src/billsvc/reconcile.ts`.** Pull the platform's recent order
  list, compare against local `orders`. This is the check that covers the platform↔local tear §4
  leaves open, and it is the reason the ledger is append-only. Joined on `platform_txn_id`; four
  difference kinds (`local-not-on-platform`, `platform-not-local`, `amount-mismatch`,
  `sku-mismatch`).
- **A daily anomaly audit that files rather than acts — `server/src/grantAudit.ts`.** Count
  non-`purchase` entitlement grants per account per day; anything over a threshold goes to a
  review list. funny's two audits (`coinAnomalyAudit`, `anticheatAudit`) share one principle worth
  stating here because it is the same one `design/15-pvp-arena.md`'s checkpoint quorum already
  follows: **with no evidence, skip — never convict.** No automatic revocation.
- **No admin service.** funny has a whole one. Here the requirement is weaker but real: the schema
  must be queryable and hand-correctable by a human with SQL, which is what `source` on an
  entitlement and an append-only ledger buy. Revisit when the first refund arrives. The review
  list above is a TABLE for that reason, not a dashboard: `review_queue` in billsvc's own file,
  worked at a `sqlite3` prompt.

  > **SUPERSEDED 2026-09-09 by `design/21-ops-analytics.md`** — and NOT by the trigger this
  > bullet named. No refund has arrived; what arrived is a need to measure retention and to look
  > at a player without an SSH session. A console is designed (§3 there) as a fifth process with
  > `readOnly: true` handles, and **built on 2026-09-09** (`server/src/adminsvc/`) — refused
  > twice over, by SQLite and by `:ro` bind mounts.
  >
  > **The requirement above survives intact, and design/21 leans on it rather than replacing
  > it.** Its decision B2 — the publicly exposed console is read-only over player data, and every
  > player-data mutation stays a CLI script run on the box — is only proportionate *because* the
  > schema is hand-correctable with SQL. So this bullet's actual content became load-bearing at
  > the moment its conclusion stopped being. What did change is the sentence "no admin service":
  > read design/21 §6 for the eight things funny's admin has that are still deliberately absent.

Five things the plan above did not say, each because it only appears once the code is real.

**AMENDMENT 1: `${txnId}:${eventType}` needs two fallbacks, and they are not a detail.** A
callback that carries no transaction id is not an edge case to shrug at — it is precisely the
malformed or unparsable payload whose evidence is worth the most, and a naive key collapses every
one of them into a single row that each new bad payload overwrites. `webhookEventKey` falls back
to the merchant order id (`order:<id>:<event>`) and, failing that, to a truncated sha256 of the
raw bytes (`raw:<hash>:<event>`). The hash is a legitimate key rather than a giving-up value,
because a platform retry of an unparsable body repeats the same bytes — so the redelivery still
lands on its own row, which is the whole property the key exists for.

**AMENDMENT 2: an unknown event type must not settle.** Before this pass, `server.ts` special-cased
`failed`/`cancelled` and sent *everything else* into `settle` — so a platform that started sending
`refunded` or `chargeback` would have had it treated as a purchase callback. `webhookEventType`
now narrows to a known set and anything else is recorded with outcome `ignored` and answered 200
(200, not 4xx: a platform retrying an event this server has simply not implemented is noise, and
the row is where anyone finds out it started arriving). This is the one behaviour change in §7 as
opposed to an addition, and it is the reason "log every event" was worth doing as a pass rather
than as a line.

**AMENDMENT 3: reconciliation cannot be honest here without saying what it did NOT check.** §9
records that no merchant account exists on any of the four real platforms, so there is no platform
order list to pull. That is handled the way §5 handled the identical problem for verification:
"list the platform's recent orders" is an injected PORT (`PlatformOrderLister`), the dev stub
implements it against an **authored** order book (`DevStubOrderBook`, seeded from
`BB_BILLING_DEV_ORDERS`), and the four real adapters each carry the call they would make and
return not-implemented. Two consequences are load-bearing:

- A platform whose port refuses does **not** contribute zero differences — it lands in the
  report's `unreconciled` list, and `complete` is false whenever that list is non-empty. There is
  no code path that can report a clean reconciliation for a check that did not run, and the
  formatted first line says COMPLETE or INCOMPLETE *before* it says how many differences.
- The dev platform's book is authored and never derived from `orders`. A dev platform computed
  from the local tables could only ever report zero differences — a reconciliation that passes by
  construction, which is worse than none because it looks like evidence.

**AMENDMENT 4: the threshold comparison is `>`, and the audit reads a database it cannot write.**
Exactly at the threshold is not an anomaly: the threshold is the largest count anyone has said is
fine, so a count equal to it is a case somebody already accepted. And the "never convict" half is
enforced structurally rather than by comment — `server/scripts/grantAudit.ts` opens the account
database **read-only** (`entitlements` is the table it is judging) and the billing database
read-write for `review_queue` alone. A source that is not on the counted list is SKIPPED rather
than counted, including one a later migration adds to `db.ts`'s CHECK: it arrives uncounted, and
whoever adds it decides. `(accountId, dayKey)` in UTC is the idempotency key, so re-running the
audit over a day already filed produces nothing — not a duplicate, not a reopened row, not a
refreshed timestamp. An audit an operator is afraid to re-run is an audit that stops being run.

**AMENDMENT 5: the review queue already had a producer waiting for it.** §4's outbox (2026-09-05)
made a 4xx from the control plane terminal and logged it as an error naming the account — money
taken, nothing granted, the only class in Phase 8 where that is true — and a `console.error` was
its entire disposition: no owner, no second reader, gone on the next rotation. `deliveryPump.ts`
now files that row into `review_queue` **in the same transaction** that makes the delivery
terminal, because a crash between the two would leave a terminal row nobody is ever told about,
which is worse than either failure alone. Both terminal paths file: the deliberate 4xx and the
outbox row whose `grants_json` can never be read. A *retryable* failure files nothing, and that
distinction has teeth — a 5xx row is still owed and a peer that comes back heals it, so filing it
would tell a human to hand-grant a purchase the next sweep is about to deliver.

**Where the two new tables live, and why one of them is in the "wrong" file.** `webhook_events`
and `review_queue` are both in billsvc's own SQLite file (`billingDb.ts`), six tables now rather
than four. `review_queue` holding findings about the CONTROL PLANE's `entitlements` table is
deliberate: that file is the one an operator already opens when money is the question, the delivery
pump has that connection and no other, and a second queue in the account database would mean a
human has to know which of two places to look.

### Backups — SHIPPED 2026-09-07

§7 is about knowing what happened. This is about still having it. Two SQLite files hold the
only two facts this project cannot regenerate — `accounts.db` (identity, ladder, meta) and
`billing.db` (orders, entitlements, the outbox) — and until this landed the backup procedure
was two `scp` lines in `server/deploy/README.md`: a procedure exactly as reliable as somebody
remembering it, guarding the data that a launch makes irreplaceable.

The worker is a **fourth compose process** (`server/src/backup/`, bundled as `backup.mjs` by
the same `scripts/build.mjs`), not a host cron job, and that is the load-bearing choice: the
CI deploy key runs one forced command and installs `dist/` + `Dockerfile` +
`docker-compose.yml`, so a service rides the existing deploy while a host-level cron entry
would be a manual install nobody re-does — the same class of failure as §9's "a value written
into an env file is not a value the process can see".

Four properties worth locking down, each with a test that fails if it is dropped:

- **`VACUUM INTO`, not `cp`.** A copy of a live database captures a torn page set that opens
  fine and fails on the page that mattered. `VACUUM INTO` runs in a read transaction, so the
  destination is a point-in-time consistent snapshot with no cooperation from — and no
  interruption of — the running service.
- **The worker cannot write to a live database.** `VACUUM INTO` works through a *read-only*
  SQLite handle (verified against `node:sqlite`, not assumed), so both data directories are
  mounted `:ro` and its only writable mount is its own `backups` volume. "The backup job
  corrupted the database" is not a failure mode it has.
- **A snapshot is verified before it is published.** `PRAGMA integrity_check` on the copy,
  then gzip, then an atomic rename — so the directory never holds a file that merely looks
  like a backup, and an interrupted run leaves a `.part` that the pruner neither counts nor
  deletes.
- **Retention is per SOURCE and only advances on success.** 14 each, pruned after that
  source's own snapshot succeeded. A directory-wide count would let a busy database age out
  the other one's history, and pruning on schedule regardless of success turns a retention
  policy into a countdown to having nothing.

**It is observable, which is the other half of the problem.** A worker with no port is a
worker nothing polls, so each cycle publishes `status.json` and the same bundle answers
`node backup.mjs --health`: unhealthy when any source failed OR when the last cycle is too
old — the second is what stops a worker whose loop died after one good cycle from reporting
green forever off a stale success. That is the container's healthcheck, and `ci-deploy.sh`
asks for it after `docker compose up`, so a deploy that silently stops backing up fails in
CI. It also **refuses to start** with no source configured, rather than idling green: an
empty `BB_DB_PATH` is treated as unset, which is §9's own env-var trap applied one file over.

**Two limits, stated rather than papered over.** Nothing is copied OFF the box — a snapshot
beside the database survives every failure this project has actually had and none of the ones
that take the host with it, and on hardware this project only borrows that is a real
scenario; the off-box copy is a human `rsync`, filed as still open in
`server/deploy/README.md` §7. And a restore is downtime plus a shell (`docker compose stop`,
`gunzip -c > …`, start) — documented step by step there, deliberately needing no tooling from
this repo, because the day it is needed is the wrong day to depend on a script nobody has run.
