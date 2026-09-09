# Work log — 2026-09-09

Volume 50. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The switch that did nothing, wired to something (2026-09-09, client + server + docs, no engine change)

Volume 49 shipped a feature-flag table with two of its four rows inert, said so in the type,
on the page and in a test, and filed the missing half in
[design/21-ops-analytics.md](../21-ops-analytics.md) §9. This is that half: a public
delivery path, the two consumers it exists for, and the three open questions in §9 closed
by decision rather than left to age.

### §9 proposed a shape that does not exist

The filed plan was *"a PUBLIC field on a response the client already fetches"*, chosen to
avoid adding a public surface. There is no such response. A browser makes exactly two
unauthenticated calls to matchsvc — `POST /client/log` and `POST /client/events` — and both
are batched on a 30-second timer, fire-and-forget, absent entirely on the WeChat shell, and
(for the analytics one) behind an opt-out that §9's own consent question would switch off.

That matters because of what the two flags are *for*. The rewarded-ad switch is read when a
run ends, so half a minute of latency costs nothing. The maintenance banner is read by
somebody who needs to be told the servers are going down, and a banner that arrives thirty
seconds into a visit — and never at all for a player who declined analytics — is not a
delivery path for that. Riding an existing response would also have coupled an operational
switch to the analytics opt-in, which is the wrong dependency in the wrong direction.

So the path is `GET /client/flags` on matchsvc: unauthenticated, uncached, answering from
the flag values that process already polls. Every property of it is a refusal to do more:
it reads no database (there is no `ops.db` handle in matchsvc at all — B1 keeps that in
adminsvc), it is not rate-limited (`/health` beside it is the precedent: no work, no state,
and a per-IP limit here would meet a school NAT long before an attacker), and it answers
`x-forwarded-for` requests happily, which is the exact opposite of `/metrics` in the same
dispatch chain. That last one is in the test with `/metrics` as its control, because a
copy-paste of `/metrics`' guard into this handler would produce a route that works from a
test and 404s for every real player.

### The contract lives in the CLIENT tree, and the server imports it

`client/src/net/publicFlags.ts`, imported by `server/src/flags/defs.ts` through the
`@dd/net/*` alias — the same direction `analyticsEvents.ts` is imported by
`server/src/analytics/ingest.ts`. The reason is not symmetry: **the client is the half that
cannot be redeployed in lockstep**, so a value it may receive has to have a compiled-in
meaning on the day it arrives, and the module that defines that meaning is the one the
client compiles.

One consequence is that each default, the banner's 140-character cap and the forbidden
character class are now **one literal each** rather than a client copy and a server copy.
That is worth more than it looks: a server that accepted a banner the client refuses is a
notice set in the console, visible in the console, and invisible in the game, with nothing
anywhere saying why. The contract test drives both validators — `coerceFlag` (what the
console's write path calls) and `isUsableBanner` (what the browser calls) — over the same
strings, so it asserts their agreement rather than the identity of a constant.

### The marker, and the question it asks

`FlagDef.public` is the server-side half; membership of `PublicFlags` is the other. A flag
reaches a browser only if it is in **both**, which are two edits in two workspaces, so
publishing a flag cannot happen as a side effect of adding one. Absent means private.

The test of whether a flag may be public is deliberately not *"is it harmless"* — it is
**"is its value already visible to the player it is delivered to"**. The banner IS its own
disclosure; the ad offer is a button a player can read off their own screen. The useful
negative is `match.pvpBotBackfillDelayMs`: it is not a secret, and publishing it would still
tell a player which of their opponents was not a person. The contract test pins the public
set as a literal and asserts the two timings are absent, for the reason
`flags.defs.test.ts` pins the allowlist — it is the mechanism, not a check.

`publicFlagValues` is written as an explicit literal rather than a filter-and-cast so that a
name added to `PublicFlags` and forgotten is a compile error. An
`Object.fromEntries(...) as PublicFlags` would type-check whatever it produced and serve an
object with a name missing — which the client's all-or-nothing parse then refuses wholesale,
leaving every browser on its defaults with nothing red anywhere.

### Fail-safe, and the one place the rule had to be stated differently

`clientFlags.ts` follows `server/src/flags/client.ts` exactly, because a flag that means one
thing in a service and another in a browser is worse than no flag: the store starts at the
compiled-in defaults and is replaced wholesale only by a complete usable answer. The test
walks eight ways a poll can fail — a `fetch` that throws, a 404 from a deployment older than
the route, a 503 with an HTML body, a 200 that is not JSON, an empty body, a missing name, a
banner over its cap, a wrongly-typed value — each with a successful poll as the control,
without which "the values did not change" is satisfied by a stub that never ran.

Two places needed their own thinking:

- **All-or-nothing has a deploy ordering.** A client that knows a name the server does not
  yet send falls back to defaults for **all** of them, so adding a third public flag means
  shipping the SERVER half first; a client-first deploy costs one window in which every
  override is off, including a banner somebody has just put up. The reverse is safe because
  a client ignores names it does not know, and that half has its own test.
- **A stale response cannot be allowed to win.** Two fetches can overlap, and without a
  guard the older one lands last and reverts a flag for a whole five-minute interval — a
  state nobody set, that resolves itself, and that no log line would explain. A monotonic
  generation counter drops any response a newer fetch has superseded, and the check runs
  BEFORE the health update rather than after: dropping only a stale *success* would still let
  a stalled poll's failure mark the client unhealthy and emit a warning after a newer poll
  had already succeeded, which is a log line contradicting the values in use. Constructed in
  a test rather than waited for, since it cannot be observed on demand.

The interval is **five minutes, not the services' sixty seconds**, because the cost scales
with players rather than with processes: four services at one request a minute is noise, and
every live client at one request a minute is a load pattern chosen for nothing. The
warning is a transition rather than a cycle, and — the half that matters — nothing is warned
before the first success, so a dev client with no server behind it and every offline player
stay silent instead of writing a line into the log store on every boot.

### The two consumers, and where each read goes

**The ad offer becomes a FIFTH refusal** in `RunOutcome.doubleOffer`, beside the four that
were already there and each already a test case. Read per offer, not at install time:
`main.crazygames.ts` could have declined to install the rewarded ad at all when the flag is
off, and that switch would only take effect on a reload — the same mistake `Matchmaker`'s
two captured timings made on the server side, which volume 49 records as *"a flag captured
at construction is not a flag"*. The test that pins it uses ONE `RunOutcome` across two runs
with a flip in between, because a test that built a fresh one after the flip cannot tell the
two implementations apart. The stub ad is fully working in that case, so `offer === null`
can only be the flag, and it asserts the SDK was never asked for an ad — a refusal that
still requested one would burn the platform's fill rate on an offer nobody can accept.

**The banner is new UI** in `MainMenu`, and three things about it are decisions:

- **It does not affect the layout.** It hangs at a fixed offset above the title rather than
  adding a row the way quick-play's `extra` does, so a banner arriving while the menu is on
  screen needs no re-layout — and the geometry `viewportFit.test.ts` measures every screen
  against does not change depending on whether an operator has typed something. Anchored at
  its BOTTOM edge so wrapping grows it upward and its last line stays a fixed distance above
  the title instead of pushing into it. Positioned unconditionally, hidden or not, which is
  what lets the live refresh change only the text and the visibility.
- **It is not localised, and cannot be.** The value is one line an operator typed; there is
  no key to look up. That is the honest cost of a switch that works without a deploy, and it
  is why the flag is capped and refuses markup rather than being a rich message with a
  schema.
- **It is stroked, not carded.** A backing `Panel` would have to be sized from
  `Text.height`, and reading that forces a canvas text measurement — the thing every
  position in that file already avoids, and the reason those screens are unit-testable with
  no `document`.

`gameWiring.ts` subscribes the menu to the flag store, so a notice set while a player is
already sitting in the menu appears without them navigating away and back — which is
precisely the player a notice about a shutdown in twenty minutes is written for. ONE
listener slot rather than a list, so the second consumer is a decision somebody has to make
rather than a registration they can add; and `setPublicFlags` notifies only on an actual
CHANGE, without which a five-minute poll would re-run a screen refresh forever.

WeChat installs the poller and is **inert**, which is a different call from volume 48's
analytics decision on the same host. That shell has no `fetch` at all, so the values stay as
compiled in — an absence, not a wrong number, where analytics there would produce a
plausible number that is wrong. The call is present rather than omitted so that the day a
`wx.request` adapter exists this host delivers flags without anybody remembering a missing
line; §9's WeChat note already names that adapter as the fix for three things, and this is
the fourth.

### What the SWEEP found, which nothing else could have

Adding `MainMenu (maintenance banner)` to `viewportFit.test.ts` failed at five of seven
viewports immediately: **`wordWrap` alone breaks at spaces, so a 140-character banner with
none cannot wrap at all and runs off both edges of the screen.** `breakWords: true` is the
fix, and the value that triggers it is entirely legal — the contract refuses markup and
control characters, not long words, so a URL or a long compound would do it.

The general shape is the one that file's own header already records for the store: a sweep
built by `new MainMenu(); show()` reads the flag store, the store starts empty, and the
banner is never drawn. **The sweep was structurally blind to the state it needed to measure
until the state was put in front of it** — a zero with no evidence the case arose. The entry
sets a maximum-length banner for the same reason the Forge entry turns `storeEnabled` on:
the taller of two layouts is the one the fit has to clear.

### What RUNNING it found, and what it confirmed

Driven end to end against the seeded console (`scripts/seedOpsDemo.ts`), then against a real
client in a browser. The loop works with nothing hand-assembled in it: a value typed into
the console's own form reached `ops.db`, matchsvc's 60-second poll picked it up
(`flags changed ui.maintenanceBanner="…"` in its log), `GET /client/flags` served it
carrying **only** the two public names, and the real menu drew it above the title.

Two things came out of it:

- **A non-ASCII banner needed checking, and the first check lied.** `Wartung 14:00 UTC —
  维护中，稍后再来` round-trips byte-identically through the form, `ops.db`, the poll and the
  public route — but the first attempt reported a `U+FFFD` in the stored value. That was the
  test harness, not the code: a shell on this machine sends an em dash as cp1252, so the
  server correctly decoded invalid UTF-8 to a replacement character. Re-driven with the
  encoding under control, it is exact. Worth recording because the banner is the one flag
  whose value a player reads, and because the same cp1252 trap has produced a false failure
  in this repo before.
- **The page reads correctly, which is the half no assertion covers.** The `public` pill is
  on the two published rows and on neither timing; `not delivered` and the warning above the
  table are gone from the real page, not merely from a hand-built view — asserted as an
  ABSENCE in `flags.http.test.ts`, since the previous version asserted only that the markers
  were present. And the banner is legible over the hub art in both scripts at once.

The console now also says the thing an operator has to know before typing into the box: a
`public` flag's value is **published**, not just applied, and browsers poll on a different
cadence (5 minutes) from the services (60 seconds). Without that on the page, *"I set the
banner and it is not showing"* is a real bug report with no bug behind it, filed during the
four minutes when both statements are true.

### The three open questions in §9, closed

All three were the owner's call and all three were made:

- **No EU consent banner.** Legitimate interest for both new rows, and analytics adds no new
  storage access — it reuses `daydayup.playerId.v1`. Recorded with its reasoning rather than
  left open, and the design stays built so the other answer is cheap: `setAnalytics(null)` is
  already the default and already a no-op at every call site, so a gate remains a call site.
- **Prometheus retention stays at 15 days, accepted.** It is right for infrastructure and
  wrong for a retention chart, and the console's cohort grid is now the full-history answer —
  so the resolution is to say which store owns which question, not to keep two sources of the
  same number.
- **The client delivery path** is this pass.

### Still open

- **Nothing is deployed.** `main` is now 7 commits ahead of `origin/main`, and a push
  deploys both halves. Two hand steps have to precede the first push that brings adminsvc up,
  in this order, both in `server/deploy/README.md` §2: `BB_ADMIN_PASSWORD` into
  `~/wnet-test/.env` (16-character floor; compose's `:?` fails EVERY service without it), then
  a `handle /admin*` block in the Caddy site file AHEAD of the catch-all. Getting the Caddy
  block wrong is not an error — it is the console's page answered by matchsvc's 404 handler,
  a blank page with a 200, which is why §4's acceptance checklist has a row for exactly that.
- **A `wx.getStorageSync` `IdentityStore`** would switch WeChat analytics on and make this
  host's flag delivery live, and would fix the meta save and the settings store in the same
  change (design/21 §9).
- **`matchsvc.ts` is at 491 lines** against an empty file-length baseline. It has nine lines
  of headroom and the next thing added to that dispatch chain will cross it.
