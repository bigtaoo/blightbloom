# Observability: one store for both halves

Part 4 of the server-platform doc (index: [`design/19-server-platform.md`](../19-server-platform.md)).
Section **§10**: the logging/metrics stack, the five decisions worth recording, what was scaled
down from funny, and the two host facts that expired.

## 10. Observability: one store for both halves — SHIPPED 2026-09-09

§7 is about knowing what happened to a purchase. This is about knowing what happened at
all — and it is the first section here whose second half is not on the server.

**The two questions that had no answer.** "What happened on the server?" meant `ssh` plus
`docker compose logs`, against a 10 MB × 3 rotating buffer, on a box one person can reach.
"What happened in a player's browser?" had no answer of any kind: every device-side bug this
project has actually had — the blank WeChat labels (design/04), the CrazyGames SDK calls
that were silent no-ops (design/20), the CORS preflight that failed as a bare
`Failed to fetch` (design/16) — was found because somebody happened to have devtools open.
That is not a method, and it stops working the moment a player is not us.

**The shape.** Four off-the-shelf containers in the existing compose project — Loki (store),
Alloy (collector), Prometheus (metrics), Grafana (query) — plus three things in this repo:
a structured logger every process writes through, a `/metrics` route on each service, and a
`POST /client/log` ingest route the browser flushes to. Both halves land in ONE store,
which is the property the whole design is arranged around: a player reports a failure, and
the answer is their session's lines and the server's lines on one timeline.

### The five decisions worth recording

**1. Labels are a fixed, tiny set; everything identifying goes in the LINE.** `source`,
`svc`, `level` for the backend; `source`, `level`, `host` for the client. The session id,
the build version, the account, the room id, the order id are all logfmt fields parsed at
query time. This is not tidiness: a label per session id is one Loki stream per player per
visit, which is the standard way to make a log store unqueryable — and on `/client/log`
those values come from the open internet. funny reached the same rule and states it the
same way.

**2. The log line is human-readable text, not JSON.** `HH:MM:SS.mmm LEVEL [tag] msg k=v`
(`server/src/log.ts`). `docker compose logs -f` over `ssh` remains the first thing anybody
reaches for when the box is misbehaving, and a screen of JSON is a screen nobody reads. The
collector regex-parses the prefix into the `level` label and leaves the rest alone. This is
the "logger *shape*" §8's old row already said was worth taking; what it did not anticipate
is that the shape is what makes the collector's job one regex.

**3. Telemetry may never affect a player.** Every outcome of `/client/log` is
`200 {ok, accepted}` — a refused batch reports `accepted: 0` rather than a 4xx, because a
4xx teaches a client to retry and a client retrying a malformed batch retries it forever.
The push to Loki is `void`-ed, never awaited, so a log store that is down or slow cannot
delay a response by a millisecond. And the client-side logger swallows its own failures
entirely: a logger that surfaces its own breakage to a player has become the bug it was
installed to find.

**4. A device clock is not a clock.** Client entries carry client timestamps, and a
browser's clock can be wrong by years — forward past Loki's future-sample rejection, or back
past its retention window, either of which drops the batch at the store with a 400 nobody at
our end is watching for. So a client timestamp is never used directly: the server converts
each entry to an AGE relative to the client's own send instant, bounds that age, and
subtracts it from the SERVER's clock. Relative timing inside a session survives; an absurd
device clock cannot push anything outside the ingestible window.

**5. The account id is written by the server or not at all.** `/client/log` needs no
session — the errors most worth having are the ones that happen INSTEAD of a login, and
gating on a session would collect logs from exactly the players whose client is working. So
when a bearer token is present the account is resolved from it, server-side, and a body
field claiming an account is ignored. The one field that says whose session this was must
not be the one field anybody can set.

### What was scaled down from funny, and what was left behind

funny runs two client channels: a **targeted** one behind four feature flags with a
per-player allowlist, and an **anomaly** one with six typed event kinds, per-type cooldowns,
a device-context envelope and a localStorage crash sentinel. Neither is ported whole.

- **The targeting is not ported at all**, because this project has no feature-flag system
  and building one to gate a logger is the wrong order. One always-on channel instead,
  made safe by caps rather than by an allowlist: 200 entries per request, 1000-char
  messages, a per-IP rate limit, a bounded body, and the fixed label set above. funny's own
  audit of its unguarded endpoint (`claudedocs/server-audits` (funny)) found ~200× amplification
  into its store from a single request; those caps are that lesson applied before rather
  than after.
- **The anomaly channel's TRANSPORT is ported verbatim, and it is the single most
  important line here**: `fetch(..., { keepalive: true, credentials: 'omit' })`, never
  `navigator.sendBeacon`. `sendBeacon` always sends credentialed, which makes the browser
  require `Access-Control-Allow-Credentials: true` — and `routes/http.ts` answers
  `Access-Control-Allow-Origin: *`, which by specification cannot be combined with
  credentials. The client is on `b.gamestao.com` and this server on `bb.gamestao.com`, so
  every send is cross-origin. Getting it wrong makes the exit flush silently never land,
  which is precisely the report you most wanted.

  > **Amended 2026-09-09 (design/21 Phase A), and it is the other half of this same bullet.**
  > `keepalive` protects a request the page has already STARTED — it does nothing for a request
  > still waiting on a CORS PREFLIGHT. The shared `CORS` block in `routes/http.ts` set no
  > `access-control-max-age`, so a browser cached no preflight and every flush was an `OPTIONS`
  > followed by a `POST`: observed one-for-one in live traffic. On the exit path that is two
  > sequential round trips behind an unloading document, which is the same failure this bullet
  > exists to prevent, reached a different way. `access-control-max-age: 600` fixed it — verified
  > live as one preflight for three POSTs — and every other route on this server gets the same
  > saving, since the block is shared.
- **The heartbeat is ported**, and is more load-bearing here than its five lines suggest:
  an idle log store and a broken one draw the same empty dashboard. funny ran for months in
  exactly that state. Every process logs `heartbeat` once at start and every five minutes,
  at `info` — deliberately not `debug`, so a deployment quieting things to `warn` cannot
  silence the one line that proves the pipeline works.

### Two facts about the host that shaped the deployment — BOTH EXPIRED 2026-09-15

Neither was about observability; both would have been bugs if ignored. Both were true of a
BORROWED box, and the backend moved onto dedicated hardware on 2026-09-15
(server/deploy/README.md), so both are now history. They are kept rather than deleted because
the shapes they left behind are still in the code, and a reader who finds a rule with no
surviving reason has no way to tell a deliberate keep from a fossil.

- **Service names were `obs-`prefixed because the network was shared.** The compose project
  joined the host's shared external network, and compose publishes each service NAME as a network
  alias on it. The box's owner ran their own Loki, Grafana, Prometheus and Promtail there
  under exactly those names. A service called `loki` would have put two containers behind one
  DNS name — their collector's pushes landing in our store, or ours in theirs, intermittently,
  with nothing failing anywhere. *Now:* the network is this project's own, the collision is
  impossible, and the prefix is **kept as a role marker** — it is what every scrape target,
  datasource and dashboard spells out, and what makes `docker compose ps` legible. The test
  that enforces it says so in its own comment, so keeping it stays a decision.
- **Their collector read our containers, and this stack could not change that.** Their
  promtail scraped the Docker socket unfiltered, so every line ours wrote between 2026-09-07
  and the move is in their store, permanently, under the neutral container names this
  project used while it was a guest. *Now:* nothing outside
  this project reads this box's socket. The one-way leak is a closed set rather than an
  ongoing one — worth remembering if anything sensitive was ever logged in that window, since
  removing it is not this project's to do.
- **What the move ADDED to this section:** Prometheus stopped borrowing the host's cAdvisor
  and node-exporter and runs its own (`obs-cadvisor`, `obs-node-exporter`). That removes the
  stated failure mode where another team stopping a container emptied every infra panel here
  — and it removes the reason the `up` alert below had to name their exporters.

### Still open

- **No alerting.** Everything here is pull: somebody has to open a dashboard. The gap that
  matters is `bb_billsvc_outbox_pending` — a count that stops falling means players have paid
  for things they do not own, with every container green. Deliberately not guessed at: an
  alert needs a destination somebody actually reads, and this project has none yet.

  **The move to dedicated hardware made this worse in one specific way, and it is worth
  stating rather than discovering.** On the borrowed box the machine had an owner who watched
  it — their monitoring, their uptime, their problem if it died. A single Hetzner VM has
  nobody watching it but this project, and this project's watching is a person opening
  Grafana. "The whole box is gone" is now a state that produces **no signal at all**: the
  dashboards that would report it are ON it. Whatever closes this item has to run somewhere
  else.

  **Its twin has since been decided differently (2026-09-15), and that changes what is left
  here.** The off-box backup copy (server/deploy/README.md §7) was the other half of "run
  something that is not this box", and the owner's answer to it is to move player data off
  SQLite onto a database rather than to build a copier. That is a good answer to THAT problem
  and not to this one: a managed store survives the VM, but nothing in it notices that the
  game stopped answering. So the two stopped being one problem with one answer — this one is
  now on its own, and still wants a destination somebody actually reads.
- **No trace correlation.** funny threads a `roomId` across its services so one match can be
  reconstructed with `| logfmt | roomId="…"`. The fields exist here in some lines and not
  others; making it a rule is a pass through every call site, and worth doing the first time
  a cross-service question is actually hard to answer.
- **Client logs are `warn` and above.** The ring buffer holds everything, so the lines
  leading up to a failure are captured, but only the tail from `warn` up is sent. Lowering
  it is a volume decision that needs a real traffic number, and there is not one yet.
- **Only the web build reports a real build version.** Every batch carries a `ver` field so
  "is this error only on the new build?" has an answer, and it resolves for `web` from the
  baseline the reload watcher already fetches. It is `unknown` on the other two, for reasons
  that belong to those targets rather than to this one: the WeChat config never runs the
  version-manifest plugin, and the portal build is served from a sub-path while the manifest
  URL is absolute, so the fetch 404s there (a pre-existing property of the reload watcher —
  design/20's no-self-managed-reload rule is why it was never fixed). Closing either means
  changing that target's build, not this layer.
