# 21 — Ops and analytics: retention, a read-only console, and flags

**Status: Phase A is SHIPPED and verified end to end (2026-09-09). Phases B and C are
designed, not built.** This document is the plan for three things the project has never had —
retention instrumentation, a way to look at a player without an SSH session, and a runtime
switch that does not need a deploy. It is written to be implemented in the order of §7, and
each phase is meant to be shippable and useful on its own.

Phase A, as code: the shared vocabulary (`client/src/net/analyticsEvents.ts`), the ingest
boundary and the store (`server/src/analytics/`), `POST /client/events` beside the log route
(`server/src/routes/telemetry.ts`), the rollup job and its gauges on matchsvc's `/metrics`,
the client SDK (`client/src/net/analytics.ts`) and the derived events
(`client/src/game/analyticsTracking.ts`), the install id reusing the id the game already
stores (`client/src/net/identity.ts`), `analytics.db` as a third backup source
(`server/src/backup/config.ts`), the compose wiring, a Grafana dashboard, and the
privacy-policy rewrite (`client/public/privacy.html`). 100% lines and branches on every new
server module; 100% lines on every new client module.

**Delivered by §2.5's own definition — a real measurement, off a real client and a real
server.** One visit through the real dev client produced, in order:

```
session_start
screen_view{menu} → screen_view{mode_select} → screen_view{forge}
screen_view{playing} → run_start{character: char_vanguard}
screen_view{paused} → run_end{outcome: abandon, floor: 1} → screen_view{forge}
```

plus `session_end{duration_s: 141}` from the previous visit's exit flush, an `accepted: 3`
for a four-event batch whose fourth name was not in the vocabulary, and a rollup line in
matchsvc's log on boot. Running it is also what found the two defects in
*What running it found* below.

It exists because of a request to borrow the sibling project `funny`'s ops backend
(`server/admin` + `tools/ops`, 5,285 + 6,756 lines) — *"主要的用户管理和留存打点肯定是要的"*.
Most of that is not borrowed, and §6 says which parts and why. What matters more is the two
things that are already here and change the shape of the answer entirely.

## What this is built ON (and what that removes from scope)

**The log store landed first, and it is not part of this document.** Loki, Alloy, Prometheus and
Grafana are deployed alongside the three services; the client ships its console to
`POST /client/log`; every service serves `/metrics`. That work is design/19's own section and a
separate pass, landed 2026-09-09. It means two of `funny`'s ops pillars arrive here for
free:

- **The monitoring half is already answered.** `funny`'s monitor routes and its ops
  "Monitor" page exist to show online counts, queue depth and trends. `server/src/metrics.ts`
  already exports those numbers and Grafana already graphs them. Nothing in this document
  re-implements it.
- **Grafana IS an ops frontend.** It is deployed at `https://bb.gamestao.com/grafana/` behind
  its own login, with users, permissions, provisioned datasources and reviewed dashboards.
  `funny` hand-wrote 6,756 lines of ops frontend because it had no such thing in front of the
  same data. Re-enacting that here would be building a worse Grafana.

That is the single most important scoping decision in this document, so it is stated as a rule:
**anything expressible as a time series goes to Prometheus and is drawn by Grafana; a bespoke
page is only justified for what a time series cannot express.** Exactly one thing qualifies —
a row per player — and that is all §3 builds.

## The decisions (locked)

| # | Decision | Why |
|---|---|---|
| A1 | Analytics ingest **reuses the `POST /client/log` trust boundary** — a sibling route beside `server/src/routes/telemetry.ts`, not a new endpoint with its own rules | That boundary is already built out of refusals (bounded body, per-IP limit, caps and allowlists on every client value, account id resolved server-side from the bearer and never read from the body). A second public write endpoint written from scratch is a second chance to get all of that wrong |
| A2 | Identity for retention is a **first-party install id** — random, browser-local, clearable by the player. **It is the id the game already stores** (`daydayup.playerId.v1`), so analytics adds no new stored identifier at all. Nothing else new about a person is collected | D1–D7 retention is *by definition* a question about repeat visits, so it needs an id that survives one. This is the smallest thing that answers it: no email (none is collected anywhere), no fingerprinting, no third party, no cross-site value — and, once the existing id is reused, no new storage either (see §2.1) |
| A3 | The event vocabulary is a **closed enum in shared code**, refused server-side | An open `track(name, props)` surface is an open write to our own log store from the internet. `funny`'s audit found an uncapped id field amplifying ~200× into its store; a closed vocabulary is the version of that lesson that cannot be forgotten by the next call site |
| A4 | **One writer to `analytics.db`** — matchsvc. Everything else opens it read-only | SQLite's happy path, and the reason the console in §3 can be a total statement rather than a careful one |
| A5 | The **daily rollup table is the record; Prometheus is a 15-day view** | `--storage.tsdb.retention.time=15d`, and a gauge cannot be backfilled. A D7 cohort chart that silently starts at "two weeks ago" is the kind of instrument that lies quietly. The rollup can always re-derive |
| B1 | The console is a **fifth process** (`server/src/adminsvc/`), and it holds **no write handle to player data at all** | Blast radius. An auth bug in the thing every player talks to is worse than an auth bug in the thing one operator talks to. The backup worker already proved `readOnly: true` `node:sqlite` handles work on this box |
| B2 | The public console is **read-only over player data**. Every player-data mutation — password reset, ban, entitlement grant — stays a **CLI script run on the box** | This is the decision that makes a *publicly exposed* console proportionate. SSH access is the second factor, and it is one we already have and already protect. It also deletes RBAC, the approval workflow and the audit-visibility matrix from scope in one move: there are no writes to gate |
| B3 | **One operator, one credential, no roles** | A role matrix with one subject is ceremony. `funny`'s four roles exist because it has a support team; when a second operator appears, revisit |
| C1 | Feature flags are an **allowlist of names and types in code**; nothing security-relevant is ever a flag | A flag that could re-enable billsvc's dev stub is a remote "mint me free entitlements" button. The allowlist is what stops the flag table from growing one |
| P1 | The privacy policy is rewritten **in the same pass as the instrumentation**, not after | See §5. Shipping collection against a live policy that denies it is the failure this ordering exists to prevent |

---

## 1. What this answers, and what it does not

Three questions, in the order they are worth money:

1. **Do people come back?** D1–D7 retention, DAU, by host (`web` / `wechat` / `crazygames`).
2. **Where do they stop?** A funnel: loaded → first run → run finished → came back.
3. **Who is this account, and what does it own?** One row per player, without an SSH session
   and a `sqlite3` prompt.

Explicitly not answered, and each of these is a decision rather than an omission:

- **Individual behaviour tracking.** The event vocabulary (A3) has no per-action stream, and
  the console (§3) reads aggregates and account facts, not a person's session history.
- **A/B testing.** Flags (§4) are on/off operational switches, not a bucketing framework.
- **Attribution / acquisition.** No campaign parameters, no referrer capture, no third-party
  SDK. There is no ad spend to attribute.

## 2. Phase A — retention instrumentation

### 2.1 Identity: no new fact about a person

**The plan said a new `install_id`; the build found it already existed.** `net/identity.ts`
has stored a random UUID at `daydayup.playerId.v1` since the PvP squad work — a "which
browser is this" grouping key, with a storage port that already covers WeChat and a
non-`crypto` fallback for an older WebView. Analytics reuses it, and that changes three
things for the better: nothing new is stored, existing players keep the id they have (so
retention is continuous from the day this ships rather than starting at zero), and there is
one fewer thing for somebody clearing their site data to have to find.

What the reuse could not take is `getPlayerId()` itself, and the difference is the reason
`getInstallId()` exists beside it. `getPlayerId` **prefers the account id** once a session
exists, which is right for a ladder key and wrong for a cohort: a player who logs in halfway
through their second visit would change identity mid-cohort and read as one install that
vanished plus one that appeared. Retention has to be a question about the browser. So the two
functions read the same stored value and disagree on purpose, each with the test that fails
when they are confused.

The account is still recorded, server-side, from the bearer token — the same rule the client
log module states, for the same reason: a field the client can write is a field that says
nothing.

Three properties worth stating because they are what the privacy rewrite in §5 promises:

- It is **first-party and single-purpose**. It is never sent anywhere but this server, and it
  keys nothing except the tables in 2.4.
- It is **clearable**, and the policy says so.
- It is **not joined to an identity we hold elsewhere**. The account link exists in the events
  table because the server attaches it, and that is the boundary — no profile is assembled
  across it.

> **Found while writing the policy: the localStorage list in `client/public/privacy.html` was
> already wrong.** It said "there are three items" and named three, while the shipped game has
> been writing `daydayup.playerId.v1` as a fourth since long before this pass. That is a
> disclosure gap independent of anything designed here, and it is why the rewrite in §5 was
> the right place to fix it rather than a follow-up.

### 2.2 The event vocabulary

A closed list, defined once in shared code, refused by name at the boundary. "Shared" is
literal: the table lives in `client/src/net/` and the server imports it through the `@dd/net/*`
path alias, because two copies that drift produce no type error and no red test — they produce
an event the client sends forever and the server discards forever, which is indistinguishable
from "nobody does that any more".

First cut:

| Event | Fields beyond the common ones | What it is for |
|---|---|---|
| `session_start` | — | DAU, the retention cohort |
| `session_end` | duration seconds (bounded) | Session length; the exit half of the funnel |
| `run_start` | character | Q2's second step; whether the roster is used |
| `run_end` | outcome, floor reached, duration | The difficulty curve, and where runs actually end |
| `screen_view` | screen name (allowlisted) | Where people stop before they ever start a run |
| `store_purchase` | sku | The commerce funnel, once anything is on sale. There is no `store_open`: opening the store is a `screen_view`, and the rollup counts those per screen |
| `ad_offer_shown` / `ad_completed` | — | The rewarded-ad offer's real take-up rate |

Common fields, attached by the client: `install_id`, `session_id` (per visit), host, build
version, locale. Attached by the server: account id (when there is a bearer), receive time.

Every enumerated field is capped or allowlisted the way `server/src/clientLog.ts` caps its
own; an event whose name is not in the list is dropped and counted, never 4xx'd — a 4xx
teaches a client to retry, and a client retrying a malformed batch retries it forever.

Two things the build settled, both of them guards that were deleted rather than tested:

- **The parser walks the SPEC, never the payload.** A loop over the incoming object's own keys
  is a loop whose length the caller chooses, and it is how an unknown prop gets stored by
  accident. Walking the table means an unnamed prop is not *rejected* — it is unreachable, and
  a `__proto__` key cannot even be looked at. It also makes a per-event prop CAP pointless: the
  count is bounded by the vocabulary. The first version had one, it could not be reached, and
  an unreachable guard is a coverage hole and a dead branch arriving together.
- **`specFor` is the membership test.** Asking `isEventName` first and then looking up the spec
  left the spec-missing branch unreachable for the same reason. One lookup, both answers.

### 2.3 Ingest

A sibling of the existing log route, on matchsvc (the one service Caddy proxies wholesale):
`POST /client/events`, sharing the rate limiter, the body-limit reader and the bearer
resolution. Same fire-and-forget posture on the client — a batch flushed on a timer and on
`pagehide`, `fetch` with `keepalive` and never `sendBeacon` (the CORS-credentials constraint
`client/src/net/clientLog.ts` documents applies identically here, and porting it wrong makes
the exit flush silently never land).

**One deviation from the log route, and it is the reason this is not just more logging:** these
rows go to SQLite, not to Loki. Loki is a log store. Funnel counts are expressible in LogQL,
but a D1–D7 cohort is a join of a day's set of install ids against the following seven days'
sets, and that is a query a log store should not be asked to do.

### 2.4 Storage — a third database

`analytics.db`, beside `accounts.db` and `billing.db`, written only by matchsvc:

- **`events`** — the raw rows, pruned at **90 days** (matching `funny`).
- **`daily_active(day, install)`**, unique — the dedup table the cohort query actually reads,
  so retention never scans `events`. Pruned at **180 days**, on its own window.
- **`daily_rollup(day, metric, labels, value)`** — one row per computed number per day. This is
  A5's record, and it is kept without a time limit because it holds no id of any kind.

**The two windows have to differ, and the gap is load-bearing.** A single window would make
retention depend on the prune: the day `events` drops its oldest week, D7 for that week
silently becomes `0` rather than unknown — the same failure §2.5 spends its length avoiding,
arriving through the retention policy instead of through the arithmetic. And the longer window
is 180 days rather than "keep forever" because the privacy policy has to state the number and
a number has to be defensible: 180 is what a full three-month return curve needs (90 days of
cohorts plus 90 for the newest to age), and anything past that would be data kept in case a
question is asked later.

It joins the backup worker by adding one entry to `SOURCE_VARS` in `server/src/backup/config.ts`
— the worker's retention is already per-source, so a third source needs no other change. Worth
saying out loud that this database is the one of the three whose loss is survivable; it is
backed up anyway, because the cost is one string and the alternative is a special case.

### 2.5 The rollup, and its two outputs

A daily job in matchsvc (it owns the write handle) computes, for each of the last N days:
DAU by host, the funnel counts, and the D1–D7 return rates of each cohort. It writes them to
`daily_rollup` and exposes the most recent as gauges on the existing `/metrics`:

```
bb_dau{host="web"}                     # yesterday's distinct install ids
bb_events_total{event="run_start"}     # counter, per event name
bb_retention_ratio{d="1"}              # the cohort that is now d days old
```

Prometheus's own scrape history then gives the trend for free, with no new datasource, no new
frontend and no Grafana plugin. **A5 is the caveat that has to be repeated wherever this is
read:** those gauges are 15 days deep. The `daily_rollup` table is the authority, and §3.2 is
where it gets rendered properly.

Two traps to write tests for rather than discover:

- **A cohort that has not aged yet is not a zero.** A D7 rate for a cohort three days old is
  *unknown*, and `funny`'s own doc records the distinction it had to make (`d[n] === undefined`
  renders `—`, `d[n] === 0` renders `0%`). A gauge has no undefined, so the metric must simply
  be **absent** for an unaged offset — never emitted as 0.
- **The instrument must be shown to see the change.** The first measurement is the deliverable,
  not the code. A rollup that reports plausible numbers on an empty database is the same
  failure as a probe that returns 0 pixels because nothing was drawn.

### 2.6 Client-side placement

The SDK is a pure module (buffer, batching, wire format) plus a thin install file that touches
the browser — the same split `clientLog.ts` / `clientLogInstall.ts` already use, and for the
same testability reason. Call sites are
`Game.ts`'s phase transitions and the four screens the vocabulary names; nothing under
`client/src/game/` gains a dependency on the network layer beyond the one call.

### What building it settled

- **`store_open` came out of the vocabulary.** Opening the store IS
  `screen_view { screen: 'store' }`, and once the rollup counts screen views per SCREEN
  (`screenViewCounts`) the conversion denominator already exists as its own gauge. Two events
  for one act is two panels somebody has to keep in agreement by hand.
- **`run_start` lost its `weapon` field, and that is a finding rather than a trim.** No
  AUTHORED weapon id survives into the simulation state: a `WeaponState` carries a
  `WeaponSimSpec` — the numbers the sim reads — and nothing naming which weapon it came from,
  whereas an actor keeps `atlasKey` because something has to draw it. A field nothing can
  populate is an always-empty column and an always-empty panel, so it is gone until there is a
  source. `character` reports `atlasKey`.
- **Three events are DERIVED from the frame, not announced by a call site.** `screen_view`,
  `run_start` and the `abandon` half of `run_end` all come from one per-frame comparison in
  `analyticsTracking.ts`, called from `GameLoop.update` — the same argument `powerBudget.ts`
  makes from the same call site. Fifteen places write `RunState.phase`; a `track()` in each
  would be fifteen chances to forget one, and a forgotten one reads as a funnel step that is
  merely unpopular. It also means **abandonment is detected rather than reported**, so a quit
  route nobody thought of is still counted.
- **`session_start` / `session_end` are emitted by the install layer**, so "exactly one per
  visit" is structural rather than a convention a fourth entry point can forget.
- **The screen ids are an explicit `Record<Phase, string>` table.** Not decoration: the
  server's id charset is `[a-z0-9_.:-]`, so `modeSelect` and `pvpPreview` would be REFUSED at
  the boundary and their funnel steps would silently never appear. Exhaustiveness makes a new
  phase a compile error, which forces the question "is this a funnel step, and what is it
  called?".
- **Collection is opt-in by env var, with no default path.** `BB_ANALYTICS_DB_PATH` unset
  means `POST /client/events` still answers 200 and stores nothing, and `/metrics` carries no
  analytics gauges at all. The same name is what the backup worker discovers the file by, so
  "collected" and "backed up" are one condition rather than two that can disagree.
- **A new gate, `deploy.dashboardMetrics.test.ts`**: every `bb_*` metric a Prometheus panel
  queries must be one the server actually emits. A dashboard is the one artefact whose broken
  state looks exactly like its working state, and this project had already paid for that once
  — the log store's "errors by build version" panel was fully populated and meaningless
  because nothing could supply the field. Proven non-vacuous by breaking a metric name and
  watching it fail.

### What RUNNING it found (and neither test nor review did)

**Every abandoned run reported no floor and no duration.** Quitting to the forge tears the
engine down, so by the frame the phase change is observed `activeState()` is already `null` —
and the props were read from the CURRENT state. The event survived, because a run whose floor
is unknown is still an abandoned run; the single number it exists to answer, *how far did they
get before they stopped*, was missing from every row. No test could have caught it: at that
seam the state is an argument, and a test that passes one on the transition frame is testing a
caller that does not exist. `analyticsTracking.ts` now snapshots the last live run frame, and
four cases pin it — including that a snapshot may not survive into the NEXT run, which would
report the previous run's floor and look perfectly plausible.

**Every flush paid its own CORS preflight, including the exit one.** Live traffic showed one
`OPTIONS` per `POST`, because `routes/http.ts`'s shared CORS block set no
`access-control-max-age`. This is the one request that cannot be retried: the telemetry routes
flush on `pagehide`, `keepalive` protects a request the page has already STARTED, and an
uncached preflight makes the exit flush two sequential round trips behind an unloading
document — i.e. exactly the `session_end` half of the churn funnel, which is the event `funny`
lost outright to the same class of mistake. `access-control-max-age: 600` fixed it, verified
in live traffic as one preflight for three POSTs, and every other route on the server gets the
same saving.

**A verification note worth keeping.** In the in-app browser pane, wall time and SIMULATED
time diverge by roughly 300× — 59.6 s of ticker time advanced the sim by 6 ticks — because the
pane composites in bursts and Pixi clamps a long `deltaMS`. So a `duration_s` read off a
pane-driven run is meaningless, and a test asserting "duration > 0" from one would be flaky
rather than wrong. This is a sharper case of the known "a hidden pane pauses rAF" trap: the
pane does not stop the clock, it starves it.

## 3. Phase B — the read-only console

### 3.1 Why a fifth process rather than routes on matchsvc

matchsvc is proxied wholesale, so a route added there is public the moment it exists —
`/metrics` had to explicitly refuse proxied requests to avoid becoming a free readout of how
many players are online. Building an admin surface on that same server means every future
admin route inherits "public unless it remembers not to be", which is the wrong default for
this specific thing.

A separate process inverts it, and buys the property in B1: **adminsvc opens `accounts.db` and
`billing.db` with `readOnly: true`, and `analytics.db` read-only too.** It is not that the
console *does not* write player data; it is that it *cannot*, and that is a sentence that
survives a bug in it.

### 3.2 What it shows

One page, three sections, all read-only:

- **Players** — search by username or display name; a row per account: id, provider (`local` /
  `cg`), created, display name, rating, entitlements owned, last active day (from
  `daily_active`). This is the query that today requires SSH and `sqlite3`.
- **Commerce** — the `review_queue` and `webhook_events` tables billsvc already writes. The
  data has existed since 2026-09-05 with nothing to look at it through; this is a view over
  existing rows, not a new feature.
- **Retention** — the `daily_rollup` cohort table rendered as a proper D1–D7 grid, which is
  A5's answer to Prometheus's 15-day window and the one number that genuinely needs a bespoke
  page.

### 3.3 Auth on a panel that is on the public internet

Given: **the console is exposed publicly**, at `https://bb.gamestao.com/admin/`, like Grafana
beside it. The posture that makes that proportionate:

- **One seeded operator credential from the environment**, no self-registration, no account
  management UI, no password reset for the operator (rotate the env value and redeploy).
  Grafana's compose block already establishes the pattern, including `:?` on the secret so a
  missing value fails `compose up` rather than booting a default.
- **A login rate limit**, reusing the per-IP limiter the telemetry route already owns.
- **Session cookie, `HttpOnly` + `Secure` + `SameSite=Strict`, short TTL.**
- **Every request logged** — to the store that now exists, with the operator and the path. Not
  an audit *system* (there are no writes to audit, per B2); an audit *line*.
- **No player-data write exists to be reached.** This is the actual control. Everything above
  is defence in depth behind the fact that the worst outcome of a total compromise of this
  panel is disclosure, not modification.

### 3.4 The page

Served by adminsvc itself — same origin, so no CORS story, no third deploy target, and a page
that cannot go stale against its own API. A fifth esbuild entry in `server/scripts/build.mjs`,
a compose service, one `HTTP_SERVICES` entry in the manifest gate (which will force the port
decision rather than let it default), and one Caddy line.

> **Known trap for whoever wires Caddy:** the site block's `reverse_proxy` to matchsvc is a
> catch-all. A path-matched route added beside it must actually take precedence, and Caddy's
> handling of overlapping matchers within one site block is the thing to verify against a live
> request rather than assume — the `/grafana*` route lands in the same block and hits the same
> question first.

## 4. Phase C — feature flags

The one thing on this list that changes how the project is *operated* rather than how it is
observed: today every switch is a deploy.

`funny`'s shape transfers cleanly, and it is the one part of its admin backend that does:
adminsvc owns a small `ops.db` with the flag rows; the services do not connect to it but poll
an internal endpoint (`x-internal-key`, the seam design/19 §3 already built) and merge what
they get over their compiled-in defaults. Fail-safe by construction: an unreachable adminsvc
means every service keeps its default, which is the shipped behaviour.

C1 is the whole safety argument, so it is worth being concrete about which side of the line
things fall on:

- **Legitimate flags:** the rewarded-ad offer on/off; the PvP practice-bot backfill delay; a
  maintenance banner; matchmaking queue timeouts.
- **Never flags:** anything that changes an authentication decision, anything that could put
  billsvc into or out of dev-stub mode, anything that disables a validation at a trust
  boundary. These are deploys, permanently.

This is also the first write in the whole design, which is why it is last: it is the phase that
has to answer "what if the panel is compromised" with something other than B2's "there is
nothing to write".

## 5. Privacy: the sentence that stops being true

`client/public/privacy.html` — live at `b.gamestao.com/privacy`, written 2026-09-08 — currently
says:

> **No gameplay analytics or telemetry.** The game does not report your play sessions, events,
> or behaviour to us or to any analytics provider.

That sentence was verified true when it was written. It was **already in tension** with the
client log shipping that landed after it (the client reports console errors and a per-visit
session id), and Phase A falsifies it outright. Per P1 the rewrite shipped in the same pass as
Phase A's core, and it describes both.

What replaced it had to be specific rather than merely permissive — a policy that says "we
may collect usage data" is worse than the old one, because it is true of anything. The rewrite
says what is actually collected, in the same enumerated style the rest of the page already
used:

- **Gameplay analytics, first-party only.** Named the events, said what they are used for
  (which parts of the game are used, whether players return), said explicitly that it is not
  sold, not shared, and not sent to any analytics provider.
- **The `install_id`**, added to the existing localStorage table, described as a random value
  with no meaning outside this game, and clearable through the same site-data controls the
  page already documents.
- **Error and diagnostic logs from the game client**, which is the sentence the log store
  needs and does not currently have.
- **Retention** for both, matching what the prune in 2.4 actually does — not a longer number
  and not a vaguer one.
- The **"no advertising identifier and no cross-site tracking"** paragraph stays, because it
  remains true and it is the distinction that matters.

Two consequences beyond the file: the CrazyGames data declaration was made on the same premise
and may need the same update (design/20), and `/terms` should be checked for a matching
sentence.

### What writing it settled

- **The callout at the top was the real problem, not the bullet.** "Playing without an account
  collects nothing on our server" is the sentence a reader actually acts on, and it is exactly
  false for analytics — a guest is *who retention is about*. It now names the two things that
  are sent without an account and points at the section describing them.
- **Every number in the policy is a number the code deletes on**: 90 days for events, 180 for
  the day-level cohort rows, 14 days for error reports (checked against the log store's own
  `retention_period: 336h` rather than asserted), and "no time limit" for day-level totals,
  which is honest precisely because those rows contain no id.
- **The strongest remaining claims are the narrow ones**, so they are the ones stated: no
  third-party analytics provider, no advertising identifier, no cross-site tracking, no sale
  or sharing, and no free text (the vocabulary is a closed list of names and numbers, which is
  a property A3 enforces in code and not a promise).
- `/terms` needed no change — it makes no collection claim.
- **Not resolved here, and named as a question in §9: whether a consent banner is required.**
  A legitimate-interest basis is stated for both new rows, and reusing an id the game already
  stores for gameplay means analytics creates no new storage access. Neither of those settles
  the ePrivacy question for an EU audience, and that is a decision for the operator (with
  advice if they want it) rather than something this document should quietly assert.

## 6. Deliberately not built (from `funny`'s admin)

| Not adopted | Why not here |
|---|---|
| Compensation approval workflow (initiate → approve → execute, via mail) | There is no mail system and no server-side wallet. The nearest equivalent already exists: an entitlement with `source='grant'`, issued by a CLI, audited daily by `server/src/grantAudit.ts` |
| RBAC, four roles, capability matrix, audit visibility split | B2 removed the writes these gate, and B3 removed the second operator. This is the largest single block of `funny`'s admin and the whole thing drops out of one decision |
| Reports / appeals / feedback queues | No chat, no UGC, nothing to moderate. `server/src/usernameFilter.ts` is the entire content surface and it is a compiled-in list |
| Promo codes, gacha pools, limited-time events, shop price overrides | No system to attach any of them to; design/14 locks bounded direct purchase with no gacha |
| Ladder season operations | Ratings exist; seasons do not |
| Player ban / unban | `accounts` has no `disabled` column and nothing has needed one. A real requirement the day it is real — and then it is a schema change plus a CLI, per B2, not a console button |
| A hand-written ops frontend | Grafana. See the header |
| An independent admin account database | One credential from the environment (B3). The database exists to hold accounts, roles and an audit trail; there is one account, no roles, and the audit is a log line |

## 7. Order of work

Each phase is separately shippable and separately useful.

**A. Retention instrumentation — SHIPPED 2026-09-09.** The client SDK and its install seam,
the closed vocabulary, `POST /client/events` on the existing boundary, `analytics.db` and its
three tables, the daily rollup, the gauges, a Grafana dashboard, the backup source entry —
**and the privacy rewrite, in the same pass, per P1.** Delivered against the definition it was
given: a real measurement off a real client, not a merged branch. One host is deliberately
excluded — see §9 on WeChat.

**B. The read-only console** — adminsvc as a fifth process with read-only handles, the login,
the three views, the compose service and manifest entries, the Caddy route.

**C. Feature flags** — `ops.db`, the internal poll endpoint, the compiled-in allowlist, the
merge-over-defaults reader in each service, the two write paths in the console.

Deferred, and filed rather than forgotten: player ban/disable (needs a schema change and a
real incident to shape it), a second operator (needs B3 revisited), and anything that would
make the console write player data (needs B2 revisited, which is a security decision and not a
convenience one).

## 8. What this changes in the docs that already exist

- **design/19 §7** locks *"No admin service. funny has a whole one... Revisit when the first
  refund arrives."* That decision is **superseded by this document**, and not by the trigger it
  named — the reason is retention measurement and operability, not refunds. §7's actual
  requirement (*"the schema must be queryable and hand-correctable by a human with SQL"*)
  survives intact and is in fact what B2 relies on: the CLI-and-`sqlite3` write path is not a
  workaround here, it is the design.
- **design/19 §8**'s deliberately-not-built table gains no row from this document but should
  lose or amend the *"Loki / Alloy / Grafana"* row on the observability pass's own account.
- **design/20** records that no analytics exists in the tree; that becomes false at Phase A.

## 9. Open questions

- **Is a consent banner required?** The policy states legitimate interest for both new rows,
  and reusing `daydayup.playerId.v1` means analytics adds no new storage access — but ePrivacy
  asks about the PURPOSE of reading terminal storage, not only about whether the read is new,
  and first-party product analytics is the contested case. The design is built so that either
  answer is cheap: `setAnalytics(null)` is already the default and already a no-op at every
  call site, so a consent gate is a call site rather than a redesign. **An operator decision,
  not an engineering one.**
- **DECIDED 2026-09-09: analytics is NOT installed on the WeChat entry point**, and the
  reason is worth keeping because it is not caution. Every row is keyed by the install id,
  which persists through `createWebIdentityStore` — and that reads `localStorage`, a global
  that shell does not have. The store's availability check is false on every boot, so a FRESH
  id is minted per visit. The consequence is asymmetric, and that is what decides it:
  retention would read 0% instead of being absent, which is bad, but DAU would report the
  number of VISITS while labelled *distinct installs*, which is worse — a plausible number
  nobody would question. No data beats wrong data.

  What it needs is not an analytics change. `IdentityStore` is already the seam, and a
  `wx.getStorageSync`/`setStorageSync` implementation of it would fix this, the meta save
  (`meta/store.ts`'s own header calls that adapter "a later platform impl", and a WeChat
  guest's progress does not survive a reload today either) and the settings store in one go.
  Adding one call in `main.wechat.ts` is the whole change once it exists.

  The portal build IS installed, and its weaker case is stated rather than discovered: the game
  runs in an embedded frame and some browsers block storage for embedded content — the same
  fact `client/public/privacy.html` §4 already tells players — so for those viewers the id is
  per-visit, DAU on that host reads slightly high and their retention reads as churn. A
  fraction of viewers rather than all of them is what separates it from the WeChat case.
- **Prometheus retention.** 15 days is right for infrastructure and wrong for a retention
  chart. Either raise it for this data (it is tiny) or accept that §3.2's table is the only
  full history. Decide before the first month of data ages out, not after.
