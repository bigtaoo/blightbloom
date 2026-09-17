# Work log — 2026-09-17

Volume 72. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Two of design/16's three holes, closed — the guest merge and the session that was never checked (2026-09-17, client + server)

[Volume 70](70-2026-09-17-home-and-login-design.md) found three live defects by reading the boot
path against the account path and fixed none of them. This pass takes the first two. They were
asked for together and belong together: both land inside `OnlineMatch.syncMetaWithSession`, and
both were the same line — `setMeta(remote ?? d.run.meta)` inside a bare `try`/`catch` — throwing
away something the player had, in two different directions.

The third (a guest's ladder rating keyed per match) is on the server's ladder path and shares
nothing with these but a date. It is still open, and `design/16` says so.

### Hole 1 — logging in discarded this browser's guest progress

The `??` only ever reached the brand-new-account branch, where `pullAccountMeta` returns `null`.
So a guest who banked materials here and then signed into an account they had made on another
device lost the bank, with no prompt and no message — and the "support migrating local guest
progress upon login" requirement `design/20` quotes was satisfied for exactly the case where
there was nothing to migrate.

**The rule that shipped is the narrow one volume 70's reflection arrived at**, not the obvious
one. A field-by-field union on every login is wrong on a shared computer: the guest progress on
that browser belongs to whoever used it last, and unioning it into the account of whoever logs in
now hands one player another's materials. So: **this device merges once, on its first association
with any account, and the account is the truth afterwards.**

The mechanism, bottom up:

- `accounts.mergedGuestIds` — the guest install ids this account has been offered a merge on.
  Keyed on the pair, not on the device: the same browser is still unmerged against a *different*
  account, which is the shared-computer case the whole rule is shaped around.
- `POST /account/guest-merge` — claims one id, and answers whether the claim was this caller's to
  make. **One conditional update, never a find followed by a write.** Two tabs finishing the
  confirmation screen at the same moment is the case that matters, and a look-before-write would
  let both of them merge — which adds the local bank to an account that already absorbed it, with
  nothing afterwards able to tell. `modifiedCount` is the database's answer rather than ours; the
  same shape `AuthService.register` uses for a taken username and design/19 §4's AMENDMENT 2
  requires of billing.
- `GET /account/meta` gains `guestMerged`, answered for the id in the **`x-guest-id` request
  header** — a header rather than a query parameter because every proxy in front of this logs
  query strings and an install id is the analytics cohort key (design/21 A2). It is in
  `routes/http.ts`'s CORS `access-control-allow-headers` for the same reason `authorization` is,
  and with the same failure if it were not: the browser refuses the request at preflight, with no
  server log at all.
- `meta/guestMerge.ts` — the arithmetic, pure and on the client, because the client is what owns
  `MetaState`'s shape. Bank ADDS per key; blueprints and characters UNION; loadout and
  `selectedSkin` stay the account's (two staged choices cannot be added, and "the account is the
  truth" has to mean something); `hasSeenTutorial` ORs, because `MetaState` documents it as
  guest-local and a player who has already been through the tutorial on this browser must not be
  recommended it again by a fresh account.
- `game/ui/AccountPrompt.ts` — the confirmation, with *use the account's* as the primary button.

**Three decisions inside that are worth more than the mechanism.**

1. **The claim is spent on the ANSWER, not on the merge, and for both answers.** What it records
   is the question having been asked. Record the answer instead and a player who declined is
   asked again on every login, forever.
2. **An empty account side merges without asking.** The account has a saved blob, so this is not
   the brand-new-account branch — the blob is just a fresh one. There is nothing to choose
   between, a modal whose two buttons do the same thing is worse than none, and taking the
   account's empty state there would be this hole again on the shape where it is most obviously
   wrong.
3. **A lost or failed claim does NOT merge.** Declining once is visible and recoverable; a bank
   counted twice is neither, and nothing afterwards can tell it happened.

**One thing the merge cannot promise, and it is not a bug.** ROADMAP 8.2 moved
`unlockedBlueprints`/`ownedCharacters` to the server's `entitlements` table: `POST /account/meta`
strips them out of the blob and `GET` writes the server's own answer back over them. So the
ownership half of the union lives for the session and not for the round trip. Today the only
client-granted ownership is `ForgeActions.acquireBlueprint`'s `demo: free grant` scaffold, which
already vanishes on any login and which `accountSync.ts` has said so about since 8.2. Unioning it
is still right — a player who pressed COMBINE should not watch a blueprint disappear between the
button and the Forge — but granting a real entitlement from the client is precisely the free-money
hole 8.2 closed, so the merge does not try. The bank, which is the half a guest actually
accumulates, is stored verbatim and does survive.

### Hole 2 — a stored token was trusted forever

`fetchMe` (`GET /auth/me`) existed, was tested, and had **zero production callers**. Boot read
`localStorage['daydayup.session.v1']` and believed it; `SESSION_TTL_MS` is thirty days that
`issueSession` writes once and nothing extends. So an expired, revoked or deleted session rendered
as `Hi, {name}` while every bearer call 401'd into a `.catch()` — the player believed they were
signed in, and cloud save had never once worked.

**No request was added.** Volume 70's reflection had already reversed its own first answer here:
`/account/meta` is called on the way in, so its 401 answers the same question. `fetchAccountState`
returns it as the value `ACCOUNT_UNAUTHORIZED` and keeps throwing on everything else, and the
status is read **before the body is touched**, so a 401 behind a proxy's HTML error page is still
a clean sign-out rather than a parse failure wearing its clothes.

What the three answers now do, which is the whole of the fix:

- **401** → clear the session, announce it through `platform/sessionEvents.ts` (the same
  announcement `portalAuth.ts` makes, and what walks the lobby chip back from `Hi, {name}` to
  LOGIN), show a notice. **Local `MetaState` is not touched.** That is the rule, not an
  implementation detail: the blueprints and the bank are on this device and are still the
  player's, and a sign-out that also cleared them would turn an expired token into data loss.
- **Network failure** → nothing at all. **Offline is not logged out**, and both used to arrive
  through one `catch`, which is why signing out from that `catch` was never an option.
- **200** → as before.

`fetchMe` and `fetchAccountMeta` were **deleted rather than left unused**. Two tested readers with
no callers are what made this hole look like a check that existed; their suites passing was
evidence about the tests and about nothing else. `GET /auth/me` stays on the server — it is a
documented route with its own tests — but nothing in the client calls it now.

**One deviation from the design's wording, and it is the interesting one.** The design said "a
toast". `HudView`'s toast queue lives inside `hudView`, which every hub screen sets
`visible = false` (`ScreenFlow.showMenu`) — and a 401 fires at the lobby *by definition*, since it
is the answer to the meta pull a login or a boot just made. A toast would have been pushed into a
hidden container and the player would have been silently demoted to a guest: this same hole, moved
down one layer. It is a dismissible panel on the new modal instead.

### What the tests are, and what was done to them

Every fix here was put back the way it was and the suite re-run, which is the only thing that
distinguishes a test of the fix from a test written beside it. Six reverts, six red runs:

| Put back | Suite that caught it |
| --- | --- |
| `setMeta(remote ?? local)` | `OnlineMatch.test.ts` — 4 failures |
| the 401 falling through silently | `OnlineMatch.test.ts` — 3 failures |
| the 401 thrown instead of returned | `entitlements.test.ts` + `accountSync.test.ts` — 2 |
| the material bank unioned instead of added | `guestMerge.test.ts` — 1 |
| the claim reporting success every time | `routes.account.test.ts` — 2 |
| `guestMerged` hardcoded true | `routes.account.test.ts` + `matchsvc.http.test.ts` — 4 |

Three notes on where the cases went, because the placement was the judgement:

- **The server's claim is tested against a real database**, not a fake. The whole question is
  whether two claims for one id produce one write, and a fake that returns what it was told would
  answer it by construction.
- **The route is tested through real HTTP as well as at the unit layer.** The handlers being
  correct says nothing about the DISPATCH, and an unwired route answers 404 while an unwired
  header answers `guestMerged: true` forever — which reads as "everything is fine, nobody needs a
  merge". The CORS preflight for `x-guest-id` is asserted there too, next to the 2026-09-08 case
  for `authorization` that a real browser found and no unit test could.
- **The new modal joined both layout sweeps.** `labelFit` measures its three buttons in all eight
  locales — two of them are whole sentences rather than the one-word verbs most rows carry — and
  `viewportFit` checks both modes against a 390 px-tall landscape phone.

### Three gaps the first round of tests left, found by asking

A pass over the suite afterwards — *what can still break with all of this green?* — found three,
and each one is a different way for a green test to be about nothing.

**1. Nothing met the other half of the wire.** `routes.account.test.ts` builds a request by hand;
the client suites answer their own `fetch` with whatever they like. Four literals live on both
sides — `x-guest-id`, the `guestId` body key, `claimed`, `guestMerged` — and each suite reads the
value it writes. `accountMerge.contract.http.test.ts` drives the SHIPPED client
(`@dd/net/auth`, `@dd/net/entitlements` through the alias) against a real matchsvc, the same shape
`store.proxy.http.test.ts` already uses.

The header of that file first claimed the unit suites were blind to all four renames. **Measured,
they are not, and the claim was corrected to the table instead**:

| one-sided rename on the server | client unit suites | `routes.account.test.ts` | contract |
| --- | --- | --- | --- |
| `guestMerged` → `merged` | green | RED | RED |
| `claimed` → `ok` | green | RED | RED |
| body `guestId` → `installId` | green | RED | RED |
| header `x-guest-id` → `x-install-id` | green | **green** | RED |

The client column is green on all four, which is the durable finding: no client suite can ever
notice the server disagreeing, because its `fetch` is a `vi.fn()`. And the last row is the one
that earns the file on its own — the server's suite imports `GUEST_ID_HEADER` from the source, so
renaming the constant renames both sides of its own assertion and it stays green over a header no
browser will ever send. **A test that reads the value it writes cannot catch a rename of that
value.**

**2. Nothing asserted the merged state was PERSISTED.** Every case read `run.meta`, which a plain
field assignment satisfies — so `d.run.setMeta(next)` becoming `d.run.meta = next` was invisible,
and it is the worst failure available here: the merge looks perfect for the rest of the session,
is gone on the next login, and the device has already spent its one claim so it can never be
offered again. Confirmed by making exactly that edit and watching the suite go red.

**3. Nothing asserted the prompt is ONE object.** `AccountPrompt` is reached from three places
assembled independently — mounted into the menu layer, handed to `ScreenNav` for the resize hook,
handed to `OnlineMatch` as the thing it asks. Three different instances type-check and leave every
unit suite green, and what a player gets is a modal asked on an unmounted copy: a question with no
answer but closing the tab. It is the half-moved-assembly shape, only an assembled `Game` can see
it, and **identity rather than behaviour is the assertion** — `gameViewport.test.ts` now pins that
the view `OnlineMatch` opens is the one in the layer and the one `ScreenNav` relayouts.

### Two existing guards had something to say

Two existing guards had something to say about the new file, and both were right. `AccountPrompt`
became the **second** floating widget in the menu layer, and `gameViewport.test.ts` asserted the
SETTINGS button was the last child — its own comment already said a second float should extend
that invariant rather than relax it, so it now states "above every screen, below every later
float". And `buttonCueConventions.test.ts` reads button FIELD NAMES to decide which may carry
`ui.back`, so `dismissBtn` became `closeBtn`: the convention is the list of leaving-verbs, not a
regex that happens to match.

### Numbers

Client 6,452 tests green, server 1,845, engine 1,599. Coverage 97.73%/93.30% client,
97.71%/93.77% engine, 98.58%/97.73% server — every gated half well clear of 90/90.
`tsc --noEmit` clean on both workspaces; the 500-line, doc-path, roadmap-index and
WeChat-package gates all pass.

Eight reverts in total, eight red runs: the six on the fixes themselves, plus the two on the
gaps found afterwards. The four one-sided renames above are a ninth through twelfth, and those
were run to *measure* a claim rather than to confirm one — which is why the claim changed.

### Still open

**A residual of this pass's own, found while auditing and deliberately not fixed here.** The claim
is spent BEFORE the merged blob is pushed: `resolveAccountMeta` claims, returns the merged state,
and `setMeta`'s push to `/account/meta` is fire-and-forget. If that one push fails — the window is
a single round trip on a connection that just worked — the device is recorded as merged while the
account still holds the un-merged blob, and the next login takes the account's state with
`guestMerged` now `true`. It is the same loss this pass exists to close, narrowed to a rare
window, which is exactly the shape worth writing down rather than leaving to be re-found.

The fix is to stop making it two requests: have `POST /account/guest-merge` take the merged blob
alongside `guestId` and write it in the same handler, guarded by having won the claim, so the
claim and the blob land together or not at all. The client already computes the merge before it
claims, so it is a smaller change than it sounds. Not taken here because it is a route-shape
change and this pass was scoped to the two holes.

Also open: hole 3 (a guest's ladder rating keyed `seat:{roomId}:{seatIdx}`, so nothing
accumulates) and all of volume 70's P1 front-door work — co-op's missing bot backfill, PvP's
30-second wait, CONTINUE RUN's absence from the lobby — which other passes on the same day are
taking.

`net` `ui`
