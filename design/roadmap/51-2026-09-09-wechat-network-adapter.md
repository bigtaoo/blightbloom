# Work log — 2026-09-09

Volume 51. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The two globals a mini-game does not have, and the four features waiting on them (2026-09-09, client + docs, no engine change)

Volume 48 shipped retention instrumentation and deliberately left one host out. Volume 50
shipped flag delivery and left the same host inert. Both filed the same fix in
[design/21-ops-analytics.md](../21-ops-analytics.md) §9, and both were right to: the WeChat
mini-game shell has **no `localStorage` and no `fetch`**, and four separate features were
paying for those two absences by being switched off. This is the pass that wrote the two
adapters — `client/src/platform/wechat/weChatStorage.ts` and
`client/src/platform/wechat/weChatFetch.ts` — and turned three of the four back on.

### Why storage was the one that mattered, and `fetch` was not

The two absences had been filed as one item, and they are not the same kind of gap.

`installPublicFlags` was already called from `main.wechat.ts` and did nothing there, because
the poll has no `fetch` to issue. That is an **absence**: no banner, and the rewarded-ad
switch at the value the build shipped with — the same fail-safe state as an unreachable
server, which the flag module is built to be indistinguishable from.

Analytics was different, and that is why volume 48 refused to install it. Every row is keyed
by the install id from `net/identity.ts`, whose store reads `localStorage`; the availability
check was false on every boot here, so `load()` answered null, `save()` dropped the write, and
a fresh id was minted per visit. Retention would have read 0% rather than being absent, which
is bad — but **DAU would have reported the number of VISITS while labelled *distinct
installs***, which is worse, because it is a plausible number nobody would question. No data
beats wrong data. So the ordering of this pass was decided by which state costs a measurement
rather than a convenience: the storage adapter is the point, and the `fetch` shim is what it
needs to be worth anything.

### `IdentityStore` was already the seam; what was missing was a way to reach it

`net/identity.ts` has had a storage port since the PvP squad work, and `createWebIdentityStore`
beside it. What it did not have was any way for an entry point to install the other
implementation, because the two production readers take no arguments — `installAnalytics` calls
`getInstallId()` and the ladder report calls `getPlayerId()`, and neither has any business
knowing which platform it is on. So this pass added the module sink the rest of this codebase
already uses for exactly this shape (`setAssetHost`, `setHostKind`, `setUiAudio`):
`setIdentityStore(store)`, defaulting to the web one, `null` to put it back.

Two details in it are load-bearing:

- **It drops both id caches on the way in.** An id already handed out came from the store that
  was installed then; continuing to answer with it would make the swap silently a lie.
- **`main.wechat.ts` calls it BEFORE `installAnalytics`.** The install id is read once, during
  the install, so a store swapped in afterwards arrives one visit late and the first-ever boot
  still persists nothing — which is indistinguishable, in the data, from the bug this fixes.
  There is no way to observe a boot ordering from inside a module, so it is pinned as a
  source-order assertion, the technique `render/wechatPhasedBoot.test.ts` already uses for the
  asset phases.

The WeChat store reuses the SAME key as the web one (`daydayup.playerId.v1`, now exported as
`IDENTITY_STORAGE_KEY` rather than duplicated). A player's id is one value with one name across
hosts, which is also why nothing new is stored on this platform either. The one behaviour of
`wx.getStorageSync` that a caller has to encode: a key that was never written reads back as
`''`, not `null`, so a store that trusted the raw value would persist the empty string as an id
and collapse every row keyed by it into one.

### The `fetch` shim, and the four ways it could have been quietly wrong

`wx.request` is the only road out of this runtime — there is no `fetch`, no `XMLHttpRequest`
and no `sendBeacon`. All three consumers already took a `fetchImpl`, so wiring them was one
argument each; the work was in the shim's edges, every one of which fails in the direction of a
plausible wrong answer rather than an error:

- **`dataType` defaults to `'json'`**, which makes the runtime `JSON.parse` the body and hand
  back `undefined` for anything that is not JSON. `net/clientFlags.ts` rests on an HTML error
  page from something in front of the server being a FAILED parse that leaves the shipped
  values; pre-parsing turns it into an answer that reads as empty. The shim asks for the raw
  string and parses it itself — and the test asserts `dataType !== 'json'`, i.e. that a default
  was overridden.
- **A 404 must RESOLVE with `ok: false`**, the way `fetch` does, because that is the case
  `clientFlags.ts` separates from a transport failure (a deployment predating the route).
- **A `fail` callback, and a synchronous throw out of `wx.request`, must both reject.** A
  promise that never settles would hang a caller's `await` forever instead of reaching the
  `catch` every consumer already has.
- **Request headers must survive**, because the one that matters is `authorization`: lose it
  and every event this host sends is anonymous. That is not hypothetical — `funny` shipped
  2,848 unattributable `session_end` rows for a related reason, recorded in
  `net/analyticsInstall.ts`'s header.

`credentials: 'omit'` and `keepalive: true` are accepted and ignored, and the test passes them
so that the arm which ignores them is the arm that runs. Both are load-bearing on the web (a
wildcard CORS origin, and a page that can unload mid-flush) and meaningless here: no origin, no
cookie jar, no page.

### `session_end` is absent on this host, on purpose

`installAnalytics` attaches its exit flush to `pagehide` on `globalThis`. That global exists
here (Pixi's `EventSystem` needs it) and this runtime never dispatches that event, so the
listener is dead weight rather than a second flush.

`wx.onHide` is the nearest signal and is deliberately NOT routed into the event. It fires on
every backgrounding and is followed by `onShow` when the player comes back, so feeding it in
would multiply the row the churn funnel counts and understate every duration — the same shape
of plausible wrong number that kept analytics off this host in the first place. The entry point
uses it for the FLUSH alone, which is the half of `pagehide` that is honest here, and which
matters because a backgrounded mini-game can be killed with no further notice.

So on `wechat`: DAU and retention are complete, and the exit half of the funnel is missing. An
absence, by the same rule.

### Wiring it up found a label that had been wrong all along

Not a bug this pass introduced, and one it made live: `platform/hostKind.ts` defaults to `web`
and only `main.crazygames.ts` ever called `setHostKind`. This entry carried a comment asserting
that `hostKind` was "already `wechat` because this entry point exists" — it was not, and nothing
had ever set it.

That was invisible for a reason worth keeping: while `isPortalHost()` was the only reader the
answer was false either way, so the wrong value had no consequence. `clientLog` is a reader of a
different kind — it does not SWITCH on the host, it **labels every batch** with it, and
`server/src/clientLog.ts` allowlists that value and turns it into a Loki stream label. So a
missing declaration is not a no-op falling back to a safe default; it is every WeChat failure
filed under `web` and `host="wechat"` matching nothing, forever, with nothing red anywhere. The
fix is one line, and the sweep is the point:

- `main.wechat.ts` declares `wechat`, before `installClientLog` — the ordering rule the portal
  entry's own comment already spelled out.
- `main.ts` declares `web` too, even though it would get it by default. A default that an entry
  point silently relies on cannot be told from one a new entry point forgot.
- `client/src/platform/hostKind.test.ts` sweeps all three entries: each declares its own host
  before installing the logger, and the three declarations are each other's controls (a
  copy-pasted entry declaring somebody else's host is a wrong label rather than a missing one,
  and reads identically in the store). A single-entry check only exists where somebody thought
  of it, which is exactly how this was missed for as long as the entry has existed.

### What the tests can and cannot reach

Three files, and the shape follows `render/wechatRuntimeFake.ts`'s discipline: the globals a
mini-game does not have are **removed** rather than merely unused. `fetch` exists in Node, so
without deleting it every assertion about this platform would pass through a road the platform
does not have.

`weChatNetInstall.test.ts` drives the real installers against a `wx` fake with storage and
request — and asserts the DEVICE shape rather than assuming it (no `document`, `window`,
`localStorage`, `XMLHttpRequest` or `createImageBitmap`), because the trap this platform has
paid for twice is that the DevTools simulator has a `document` and a handset does not. Each
case carries the control that makes it evidence:

- a flag arrives and `publicFlag('ui.maintenanceBanner')` changes — with the same shell and no
  shim as the control, where the values stay as compiled in and nothing is sent;
- an analytics batch leaves the host labelled `wechat`, carrying `authorization`, keyed by the
  id that is **in the wx store** rather than one that merely looks like an id;
- two visits report the SAME install — and the control is the bug: the same two visits with the
  default web store, in a runner that has no `localStorage`, produce two distinct ids. That is
  the number that would have been reported as DAU, and it still reproduces;
- a log batch leaves the host labelled `wechat`, with the undeclared batch beside it reading
  `web` as its control (the section above);
- and one boot-shaped case installs all three against one shell and asserts exactly three
  requests, `GET /client/flags` + `POST /client/log` + `POST /client/events`. No per-feature
  case can see a shim wired to two of the three, which looks exactly like this case's absence.

The ordering claim is pinned twice, deliberately: as a source-order assertion, and
behaviourally — install analytics before the store and the id it reports is one the store never
saw, which in the data is indistinguishable from the per-visit-id bug the whole pass fixes.

What none of it can reach is the pair of operational gates, because they need a real account and
a real handset. `wx.request` refuses plain http, and a plain `npm run build:wechat` bakes in
`http://localhost:8788` (`VITE_MATCHSVC_URL` is injected by the web deploy workflow, and this
target has no CI build); and `bb.gamestao.com` has to be in the account's **服务器域名**
whitelist, where an un-whitelisted host fails on a device while DevTools with 不校验域名 ticked
succeeds. Both are silent and fail-safe, which is the problem: **zero `wechat` rows in
`daily_active` is the symptom of both of them and of a build nobody played, and the events store
cannot tell them apart.** Filed as design/04's checklist item 18, as a POSITIVE check — play a
run on a device, then look for the row.

### Still not wired

`meta/store.ts` and `settings/store.ts`, the two items on §9's list that were only ever a
convenience. The primitive they need is exported from `weChatStorage.ts` alongside the identity
store; what is left is each store's own question rather than the adapter — a meta save that has
never persisted on this host means the first load after wiring reads a fresh account, and
`migrate` is what would have to be right about it.
