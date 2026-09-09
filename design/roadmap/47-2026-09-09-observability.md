# Work log — 2026-09-09

Volume 47. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## One store for both halves: the backend's logs and the browser's (2026-09-09, server + client + deploy + docs, no engine change)

*"在后端的container里，集成grafana，集中展示后端和服务器状态相关的日志，并用于收集和展示前端的日志。可以参考funny项目"*

design/19 §8 had a row saying not to do this, and the row was right when it was written:
*"its monitors exist to feed a sink this project does not have, so a literal port computes
correct numbers and drops them."* What changed is the premise, not the argument — since
2026-09-07 there is a live backend on a real domain, and since 2026-09-08 a public client
on three build targets. There is a sink worth having now.

**Two questions had no answer.** "What happened on the server?" meant `ssh` plus
`docker compose logs`, against a 10 MB × 3 rotating buffer, on a box one person can reach.
"What happened in a player's browser?" had no answer *at all* — and that is the more
expensive gap, because every device-side bug this project has actually had was found by
somebody happening to have devtools open at the time: the blank WeChat labels (volume 12),
the CrazyGames SDK calls that were silent no-ops (volume 41), the CORS preflight that
failed as a bare `Failed to fetch` (design/16). That is not a method, and it stops working
the moment a player is not us.

### The finding that reframed the whole thing, before a line was written

**The box already runs a full Grafana + Loki + Promtail + Prometheus + cAdvisor stack —
its owner's — and their promtail scrapes the Docker socket UNFILTERED.** So every line our
four containers have ever written was already in their store, and had been since the first
deploy. Querying it also turned up `blightbloom-gameserver`, `blightbloom-matchsvc` and
`blightbloom-billsvc` streams from 2026-09-07: a short-lived container naming from before
the generic-naming rule was applied, which means **the game's name did reach that shared
box** despite the policy in `server/deploy/README.md`, and would have anyway — the log
*content* says `blightbloom matchsvc (control plane) on …` regardless of what the container
is called.

That did not change the decision (a self-contained stack, per the owner's call), but it
changed two things about it. Closing the leak means editing *their* promtail config, which
is not this project's to change unilaterally, so it is recorded rather than fixed. And it
established the constraint that turned out to matter most:

**Every service name here is `obs-`prefixed, and that is not cosmetic.** This compose
project joins the host's shared `docker_default` network, and compose publishes each
service NAME as a network alias on it. Their stack already answers to `loki`, `grafana`,
`prometheus` and `promtail` there. A service called `loki` would have put two containers
behind one DNS name on a shared network — their collector's pushes landing in our store, or
ours in theirs, intermittently, with **nothing failing anywhere**. That is a whole class of
bug that only exists because the deployment is a guest on somebody else's machine, and it
is invisible to every test that does not know the host. `deploy.observability.test.ts`
fails the build on a colliding name.

### What shipped

Four off-the-shelf containers in the existing compose project — `obs-loki` (3.4.2, 14-day
retention), `obs-alloy` (v1.7.5, Docker socket read-only), `obs-prometheus` (v3.13.3),
`obs-grafana` (11.5.2, at `https://bb.gamestao.com/grafana/` behind its own admin login) —
and three things in this repo: `src/log.ts`, a `/metrics` route on each service, and
`POST /client/log`. Three dashboards, provisioned from files so a panel is reviewed like
code.

**Prometheus runs no exporters of its own.** The box's cAdvisor and node-exporter already
measure the whole machine, ours included, one DNS name away on the same network. A second
*privileged* cAdvisor mounting `/`, `/sys`, `/var/run` and `/dev/kmsg` on borrowed hardware
to recompute numbers that already exist is the wrong trade. The cost is stated where it can
be seen rather than discovered: if the owner stops those containers, the infra panels
empty — so `infra.json`'s first panel graphs `up`, which says *target down* instead of
showing zero.

### Five decisions, each with a way it would have gone wrong

**Labels are a fixed, tiny set; everything identifying goes in the LINE.** `source`, `svc`,
`level` for the backend; `source`, `level`, `host` for the client. Session id, build
version, account and tag are logfmt fields parsed at query time. A label per session id is
one Loki stream per player per visit — the standard way to make a log store unqueryable —
and on `/client/log` those values arrive from the open internet. The test asserts the label
key set **exactly**, not as a superset, because a fourth label added carelessly is a stream
multiplier.

**The log line is human-readable text, not JSON.** `12:34:56.789 WARN  [matchsvc] store
refused route=/store/order status=502`. `docker compose logs -f` over `ssh` is still the
first thing anybody reaches for, and a screen of JSON is a screen nobody reads. Two rules
the formatter enforces so call sites cannot break the parse: a line is **one line**
(control characters collapse — a stack trace pasted into a message would otherwise arrive
as N entries, N−1 of them with no level, no tag and no context, which are exactly the lines
you need), and a field value is **one logfmt token** (a value with a space is quoted, or
`| logfmt` reads `msg=two` and then treats `words` as a valueless key, silently dropping
every field after it on the line).

**Telemetry may never affect a player.** Every outcome of `/client/log` is
`200 {ok, accepted}` — a refused batch reports `accepted: 0` rather than a 4xx, because a
4xx teaches a client to retry and a client retrying a malformed batch retries it forever.
The Loki push is `void`-ed, never awaited (asserted with a deliberately slow stub: the
response comes back in under 2 s against a 5 s push). And the client logger swallows its
own failures whole — a logger that surfaces its breakage to a player has become the bug it
was installed to find.

**A device clock is not a clock.** Client entries carry client timestamps, and a browser's
clock can be wrong by years — forward past Loki's future-sample rejection, back past its
retention window, either of which drops the batch *at the store*, with a 400 nobody at our
end is watching for. So a client timestamp is never used directly: the server converts each
entry to an AGE relative to the client's own send instant, bounds it, and subtracts from the
SERVER's clock. Relative timing inside a session survives (tested: two entries 2 s apart
stay 2 s apart off a clock a year out); an absurd device clock cannot push anything outside
the window. Nanoseconds are `BigInt` — `ms * 1e6` exceeds `MAX_SAFE_INTEGER` and past 1e21
`String()` yields `"1e+21"`, which Loki rejects outright. funny shipped that bug.

**The account id is written by the server or not at all.** `/client/log` needs no session,
deliberately: the errors most worth having happen INSTEAD of a login, and gating on a
session collects logs from exactly the players whose client is working. So when a bearer
token is present the account is resolved from it server-side, and a body field claiming an
account is ignored — the one field that says whose session this was must not be the one
field anybody can set.

### The line worth porting verbatim from funny

`fetch(..., { keepalive: true, credentials: 'omit' })`, **never** `navigator.sendBeacon`.
`sendBeacon` always sends credentialed, which makes the browser require
`Access-Control-Allow-Credentials: true` — and `routes/http.ts` answers
`Access-Control-Allow-Origin: *`, which by specification cannot be combined with
credentials. The client is on `b.gamestao.com` and this server on `bb.gamestao.com`, so
every send is cross-origin. Get it wrong and the exit flush — the *only* chance to hear
about a crash — silently never lands, which is precisely the report you most wanted. funny
hit this and wrote it down; it is the single highest-value thing this pass took from there.

### The console is wrapped, not the call sites rewritten

~100 `console.error`/`console.warn` calls across the client, from boot to render to audio,
and most of them are exactly the lines worth having. Rewriting all of them is a large diff
whose only failure mode is *silence*: a call site missed is a class of error that never
reports, and nothing goes red. So `clientLogInstall.ts` wraps the two methods, always
calling through, and captures every one of them — including lines from inside PixiJS and
inside a platform SDK, and lines in code written later that has never heard of this module.
`console.log` is deliberately not wrapped (frame chatter). The wrapper is installed once and
remembers the originals, because a double install makes each line log twice and each install
after that exponentially.

### The heartbeat, which is five lines and load-bearing

Every process logs `heartbeat` once at start and every five minutes. **An idle log store and
a broken one draw the same empty dashboard** — funny ran for months in exactly that state —
so "Grafana shows nothing" has to become a question with an answer. It is `info`, not
`debug`, so a deployment quieting things to `warn` cannot silence the one line that proves
the pipeline works; the test asserts both halves, including that at `warn` the beat *is*
suppressed, which is why compose pins `BB_LOG_LEVEL: info` on every service.

### Two deploy-shaped things

**The metrics endpoint would have been public.** matchsvc is the one service Caddy proxies
wholesale, so `/metrics` on it — queue depth, gameserver availability — would have been a
free readout for anybody on the internet. Caddy stamps `x-forwarded-for` on everything it
proxies, so its presence is what "came from outside" means, and the answer is a plain 404
rather than a 403: a 403 confirms the route exists. gameserver (`/ws*` only) and billsvc
(never proxied) need no gate, and the tests say so per service rather than uniformly.

**A missing password stops the whole deploy, and that is the correct behaviour.**
`GF_SECURITY_ADMIN_PASSWORD: ${BB_GRAFANA_ADMIN_PASSWORD:?…}` — Grafana's own default is
`admin`/`admin` and this login page is on the public internet, so a fallback is not
available. But `.env` is the one file CI cannot write, so a box provisioned before this
service fails `compose up` for *every* service. Same shape as volume 45's `DDU_*`→`BB_*`
migration: do it on the box first, by hand. `ci-deploy.sh` checks for it and fails with that
explanation, rather than letting compose's own "required variable is not set" be the only
clue — and `--force-recreate` is now on the `up`, because changing a bind-mounted config
file does not change a container's definition, so a plain `up -d` finds nothing to do and
the OLD dashboard keeps running while CI reports a successful deploy.

### The gate the new layer needed

`deploy.observability.test.ts`, sibling to `deploy.manifests.test.ts` and the same argument
one layer over: this pipeline is six config files that reference each other **entirely
through text no compiler compares** — a service name in a URL, a port in a scrape target, a
datasource uid in a dashboard, a regex in a collector that has to match a format produced by
a TypeScript module. Every one of them fails identically: silently, as a panel showing
nothing, which is indistinguishable from a quiet week. That cannot be the failure mode of
the layer built to end it.

The cross-check worth naming runs **Alloy's log-parsing regex against a line the real
`src/log.ts` produces**, at every level and for a child tag, plus two negatives (a Node
`ExperimentalWarning`, a bare stack frame) that must NOT match so unparsed lines keep their
raw form. It needs one translation — Alloy's regexes are Go's RE2, so `(?P<x>` becomes
`(?<x>` — and that caveat is written into the test rather than left implicit. A test that
merely re-stated the pattern as a string would catch a changed format and not a broken
pattern; this catches both.

Also caught by writing it: the "All" level filter on the backend dashboard has to be `.*`
and not `.+`. A line Alloy could not parse carries no `level` label, and in Loki an absent
label matches the empty string — so `.+` would have silently hidden every unparsed line,
which is where Node warnings, container startup output and stack-trace continuations live.

**And the manifest reader nearly took the whole file down.** `parseCompose` read `command:`
as `JSON.parse(value)` because every service had it inline; `obs-prometheus` writes a YAML
block list, so `value` is `''`, and `JSON.parse('')` throws at module scope — every
assertion in `deploy.manifests.test.ts` included. The bind-mount rule needed the same care:
it used to be "every `./`-mount is a state dir the deploy must chown", and read-only config
mounts are not that. It is now grouped by host path and decided by whether **any** mount of
it is writable — which is the accurate rule anyway, since `./data/matchsvc` is legitimately
mounted writable by matchsvc and `:ro` by the backup worker.

### Totals

18 files added, 14 changed. `src/log.ts` / `heartbeat.ts` / `clientLog.ts` / `lokiPush.ts` /
`metrics.ts` / `routes/telemetry.ts` on the server, `net/clientLog.ts` /
`net/clientLogInstall.ts` on the client, six config files and three dashboards under
`server/monitoring/`. 129 new tests. Server coverage **98.97% lines / 97.89% branches**,
client 97.64% / 92.93%, all three packages green on the 90/90 gate; `npm run check` clean.

**Still open, and stated so the next pass does not re-derive it.** No alerting: everything
here is pull, and somebody has to open a dashboard. The gap that matters is
`bb_billsvc_outbox_pending` — a count that stops falling means players have paid for things
they do not own, with every container green — and `up` on the two scrape targets that are
the box owner's. Deliberately not guessed at: an alert needs a destination somebody actually
reads. No trace correlation either: funny threads a `roomId` across its services so one
match reconstructs with `| logfmt | roomId="…"`, and here the fields exist in some lines and
not others. And client logs are `warn` and above — the ring buffer holds everything, so the
lines leading up to a failure are captured, but lowering what is *sent* is a volume decision
that needs a real traffic number, and there is not one yet.

### Two things found after the section above was written

Both landed the same day, `fc60cbe`, and the second is not about this feature at all.

**The build stamp on a client log batch had no source.** `net/clientLog.ts` sends a `ver`
field so a dashboard can answer *"is this error only on the new build?"* — the entire reason
the field exists — and the getter that supplies it was optional, with nothing passing one. So
every real client reported `unknown`, and the "Client errors by build version" panel rendered
a populated-looking bar chart of a single meaningless bucket. **A field that is always the
same value is worse than an absent one**: absent, the panel would have been empty and
obviously unfinished; constant, it looked like an answer. It reads the baseline `autoReload`
already fetches now, rather than adding a second poller for the same `/version.json`. It is
still honestly `null` → `unknown` in three cases, each annotated where it occurs: a dev build
(the manifest plugin is `apply: 'build'`), the WeChat mini-game (whose Vite config never runs
that plugin), and the portal build (served from a sub-path while `VERSION_URL` is absolute,
so the fetch 404s — a pre-existing property of the reload watcher, inherited rather than
papered over). Only the web build reports a real version today; the panel says so.

**`git add` is not safe in this shared checkout, and knowing about the tree is not enough.**
`D:/daydayup` is shared with concurrent sessions ([[daydayup-worktree-editing-gotcha]] in
memory), and this pass already knew that — the first commit here was deliberately scoped to
an explicit path list, checked against `git status`, and landed clean. The follow-up commit
then swept 21 files of a peer session's in-progress analytics feature in under this commit's
message, because **the git INDEX is shared state too**: the peer had staged their work, and
`git add -- <my paths>` adds to whatever is already there. `git commit` with no pathspec then
commits the index, not the addition.

Caught by the post-commit `--name-only` check, repaired with `reset --soft` plus
`restore --staged` of only the peer's paths, re-committed with the four intended files.
Nothing was pushed and every byte of theirs survived. The two rules worth keeping:

- **Check `git diff --cached --name-only` BEFORE committing, not after.** The verification
  existed here and ran one step too late.
- **`git add` + bare `git commit` is the unsafe pair.** `git commit -- <paths>` takes the
  working-tree version of exactly those paths and ignores the rest of the index — which is
  what this pass's *first* commit should have used, and could not, because that form does not
  work for untracked files. For a commit that introduces new files in a shared checkout there
  is no one-liner: stage, verify the staged list, then commit.
