# The planes, entitlements, and the trust seam

Part 1 of the server-platform doc (index: [`design/19-server-platform.md`](../19-server-platform.md)).
Sections **§1–§3**: what the two original planes were, the defects real money turned from tolerable
into wrong, and the seam that now separates a player-facing call from a service-to-service one.

## 1. The two planes today, and the two defects in them

| | Process | Port | Surface |
|---|---|---|---|
| Control plane | `matchsvc.ts` | 8788 | `/auth/*` (`AuthService.ts`, incl. `/auth/portal` — a verified game-portal user token, `portalToken.ts`, `design/20`), `/account/meta`, `/find` `/resume` (`Matchmaker.ts`), `/party/*` (`PartyService.ts`), `/rating/*` (`rating.ts`) |
| Data plane | `index.ts` | 8787 | `/ws` frame broadcast (`RoomManager.ts` / `MatchRoom.ts`), checkpoint hash adjudication |

Since 2026-09-04 `matchsvc.ts` is an **assembly shell only** — service construction, the
bot-fill hook, `/health`, the dispatch chain, `main()` — and every surface in that first row is
a group of free `(req, res, url, deps)` handlers under `server/src/routes/`:
`server/src/routes/auth.ts`, `server/src/routes/account.ts`, `server/src/routes/match.ts`,
`server/src/routes/party.ts`, `server/src/routes/rating.ts`, over a shared
`server/src/routes/http.ts` (the CORS block, `send`, `readJson`). It was one 431-line if/else
chain before, against an empty file-length baseline, and §2 and §3 both add routes to it — so
each seam below now names its own file, and the two passes cannot collide in one file.

The only trust seam between them is the signed ticket (`ticket.ts`): matchsvc signs
`{roomId, owner, seed, playerCount, mode, accountId}`, the gameserver trusts nothing else. That
part is correct and is not changed here. Two things around it were not — both **fixed
2026-09-04** (ROADMAP 8.1, `design/roadmap/29-2026-09-04-internal-trust-seam.md`):

- **D1 — `/rating/report` was unauthenticated.** It is called by the gameserver and by nothing
  else, but it had no key, no origin check, and open CORS. Any client could POST arbitrary ladder
  placements for any `accountId`. Closed by §3's inbound half. (This bullet and the next read
  "Fixed by §4" when the doc was written; §4 is billing, and the seam that fixes them is §3.)
- **D2 — the outbound report never drains its response body.** `reportSettledMatch` in `index.ts`
  is `fetch(...).catch(() => {})`. funny shipped that exact shape and measured the consequence
  under a concurrent burst: unconsumed undici bodies keep their sockets checked out, the
  keep-alive pool jams, and every request fails with `fetch failed` ~30 s later — so *none* of
  them arrived. Low PvP settlement volume is the only reason it never bit here. Closed by §3's
  outbound half.

Neither defect involved billing, and both were fixed first, as planned.

## 2. Entitlements move server-side — SHIPPED 2026-09-04

Until this landed, `/account/meta` (`server/src/routes/account.ts`) was a blind whole-blob upsert:
`INSERT ... ON CONFLICT DO UPDATE SET
data = excluded.data`, with the only validation being that a `data` key is present. That was the
right call when `MetaState` was a localStorage mirror (`design/16-accounts.md` says so) and
nothing in it was worth money.

The fix is not to validate the blob — that is whack-a-mole. It is to move the two account-level,
purchasable things out of it. `server/src/EntitlementService.ts` owns them, over one table in the
existing account database (`server/src/db.ts`):

```
entitlements(id, account_id, sku, source, order_id, granted_at)
  UNIQUE(account_id, sku)        -- SKUs here are own-or-not, never stacked
  source: 'purchase' | 'grant' | 'event' | 'starter' | 'drop'
```

- `meta_state` keeps what the client legitimately authors: materials, loadout selection,
  in-progress forge state. It stays a whole-blob upsert.
- Blueprint and character **ownership** is read from `entitlements`. On `GET /account/meta` the
  server overwrites the ownership fields in the returned blob from its own table; a client that
  POSTs itself extra ownership is ignored rather than rejected, so no pre-existing guest or
  offline path breaks.
- `forge.ts`'s `acquireBlueprint` / `grantCharacter` are already the grant seam
  `design/14-meta-forging.md` reserved for exactly this. What changes is *who may call them*, not
  their shape.
- A guest (no account) is byte-identical to today: local-only, no server row.

`source` is not decoration. It is what makes the operational work in §7 possible — a daily audit
of non-`purchase` grants, and a support path that can hand-issue one and have it look different
from a paid one afterwards.

### What the build settled that the plan left open

- **SKUs are namespaced rather than split across two tables**: `blueprint:<weaponId>` and
  `character:<skinId>`. One `UNIQUE(account_id, sku)` then covers both, a blueprint id can never
  collide with a skin id, and `WHERE sku LIKE 'character:%'` is the whole query §7's
  hand-correctable-with-SQL requirement needs.
- **`entitlements` DOES take the foreign key `ratings` deliberately refuses**, and the contrast is
  the point. A rating key is any opaque id `ladderReport.ts` hands over, including a guest/bot
  `seat:{roomId}:{seatIdx}` scaffold with no `accounts` row at all. An entitlement is only ever
  minted for a real logged-in account — a guest has no row here — so no legitimate id can fail the
  constraint, and `node:sqlite` enforcing foreign keys by default is then exactly what makes a
  typo'd hand-issue fail loudly instead of becoming an orphan that silently never delivers.
- **Two CHECK constraints**, both because §7 rules out an admin service and the schema therefore
  has to survive being corrected by a human at a `sqlite3` prompt: `source` is constrained to the
  enum §7's daily audit groups by, and a `'purchase'` with no `order_id` is rejected as
  unauditable — §7's reconciliation could never match it to anything.
- **The client's POST is normalized on WRITE, not merely overwritten on read.** Ownership is
  stripped before the blob is stored, so `meta_state` never holds a client-authored ownership
  claim that would mislead whoever reads that table with SQL.
- **`GET /account/meta` answers `{ data, entitlements }`**, the second being
  `{ sku, source, grantedAt }` per row — never `order_id`, which addresses a row in billsvc's
  private database. One round trip, and therefore no new route and no edit to `matchsvc.ts`'s
  dispatch chain, which §3 was landing in from a parallel worktree at the same time.
- **Nothing under `client/src/game/` had to change, and the Forge neither flickers nor rolls
  back.** The server returns EMPTY ownership for every account that exists today, and
  `client/src/meta/store.ts`'s `migrate()` already unions `STARTER_BLUEPRINTS` + `FREE_CHARACTERS`
  back in on every load — so ownership before and after a login is identical. What *does*
  disappear is ownership the client granted itself, which is the hole this section exists to
  close (see §9). `client/src/net/entitlements.ts` is the client half: the wire read, a defensive
  parse that drops one malformed entry without discarding the ones around it, and the same
  skip-unknown-namespace projection the server uses.

**Named so it is not mistaken for shipped:** nothing yet *calls* `EntitlementService.grant`. The
delivery path is billsvc's (§4) through an internal-key-authed route (§3), and
`EntitlementService.owns` exists and is tested but no PvP character gate consults it yet.

## 3. The internal trust seam — SHIPPED 2026-09-04

**Status: SHIPPED 2026-09-04** (ROADMAP 8.1), and **exactly-once since 2026-09-05**. Both
modules exist; `POST /rating/report` is behind the key, `reportSettledMatch` goes through the
outbound helper, and the settlement report is now idempotent at the receiver. Three things
the plan below did not anticipate are recorded at the end of this section — the third of them
was left open on 2026-09-04 and is closed under "Exactly-once settlement" after it.

Borrowed from funny's `shared/src/internalAuth` and `shared/src/internalFetch`, cut down.

**Inbound** (`server/src/internalAuth.ts`): an `x-internal-key` header compared with
`timingSafeEqual`, plus an advisory `x-internal-caller` for logs. funny's per-caller key registry
(one key per calling service, independently rotatable) is the right end state but is not worth it
at three calling services — keep the *shape* (a verifier object built from a registry that currently has
one entry) so adding the registry later is not a rewrite. This is a third namespace, deliberately
distinct from player bearer sessions and from the `ticket.ts` HMAC: internal routes never accept a
player token, and the mismatch is structural rather than a check.

Applies to `/rating/report` (D1, `server/src/routes/rating.ts`) immediately, and to every
`billsvc` route except the platform
webhook, which is authenticated by the platform's own signature instead.

**A THIRD CALLER, AND THE ONE RULE IT ADDED (2026-09-05, ROADMAP 8.8).** matchsvc's `/store/*`
proxy made the control plane an internal CALLER as well as a callee, and put the two namespaces
one function apart for the first time: a player's bearer session is verified in-process and an
internal-key call goes out carrying the accountId that session named. The boundary reads the same
in both directions — an internal route never accepts a player token, and a player route never
trusts an accountId the client asserted — but proxying adds a rule neither end had needed. **A
peer's 401 must not be relayed to the player.** billsvc refusing our internal key is a
misconfiguration on our side; forwarded verbatim it reaches the client as "your session is bad",
so a deploy that missed `BB_INTERNAL_KEY` would present to every player as a login problem and to
no operator as anything at all. It becomes a 502 and an error line naming the variable. The
outbound helper also grew the one thing a proxy needs that a fire-and-forget caller does not —
`collectBody`/`internalFetchJson`, which READ the response body rather than cancelling it. That is
obligation 1 discharged differently, not waived: `res.text()` releases the socket exactly as
`cancel()` does.

**Outbound** (`server/src/internalFetch.ts`): one helper that every cross-service call goes through,
which cannot forget the three things a bare `fetch` forgets:

1. **always drain or cancel the response body**, even when the real answer arrives elsewhere (D2);
2. **an explicit per-attempt timeout** — undici's `fetch` has no default, so a stuck socket hangs
   for tens of seconds instead of failing fast;
3. **bounded retry only for calls that are idempotent and not self-healing.** A settlement report
   is worth retrying; a periodic heartbeat is not, because the next tick re-sends it. Retry is
   therefore **opt-in**: `retry` absent means exactly one attempt, so a caller who never thought
   about it cannot accidentally get at-least-once delivery.

### What building it changed (2026-09-04)

- **The key comparison hashes both sides before `timingSafeEqual`.** The plan said
  "compared with `timingSafeEqual`", which is what `ticket.ts` already does — behind an
  `a.length !== b.length` guard, because that function *throws* on a length mismatch. That
  guard is right for an HMAC, which is always the same length, and wrong for an
  operator-chosen shared secret: it turns the real key's length into something an attacker can
  measure. Hashing first makes every comparison 32 bytes against 32 bytes, so it neither
  throws nor leaks the length. Without it a wrong-length key is a 500, not a refusal.
- **An unset key in production yields an EMPTY registry, not the dev key.** `config.ts` gives
  the internal key the same posture it already gives `BB_TICKET_SECRET` (real env var →
  production; unset → a published dev key plus one loud warning, so the two-process local
  setup works out of the box) with exactly one difference: under `NODE_ENV=production` an
  unset `BB_INTERNAL_KEY` refuses *every* internal call rather than falling back. A key
  printed in this repository is not a weaker credential than none — it is the same one — and
  the fallback would look configured. This is §5's "fail closed in production" rule, which
  that section states for the billing dev stub, reaching one section earlier than expected.
- **`/rating/report` was at-least-once, and retrying it double-applied a rating.**
  `RatingStore.applyMatch` carried no dedupe key, so a report that was delivered but whose
  response was lost was applied twice on retry — which is why the settlement budget shipped as
  a deliberate 3. **CLOSED 2026-09-05**, with exactly the shape §4 specifies for billing
  delivery: a dedupe key threaded through `ladderReport.ts`, a `UNIQUE` column in `db.ts`, and
  a claim-then-`changes()` check rather than SELECT-then-INSERT. See "Exactly-once settlement"
  below; the budget is now 5, because a retry can no longer multiply a rating.

### Exactly-once settlement — SHIPPED 2026-09-05

`ladderReport.ts` puts a `reportKey` in the report body, `db.ts` gains a `rating_reports`
table whose `report_key` PRIMARY KEY *is* the mechanism, and `RatingStore.applyMatchOnce`
claims that key with `INSERT ... ON CONFLICT DO NOTHING` + `changes()` **inside the same
`BEGIN IMMEDIATE` that writes `ratings`**. Four things the build settled that the sentence
above did not say.

- **The claim and the ratings roll back together, and that direction matters more.** Losing
  the claim and applying anyway is the original defect: a redelivery double-credits. Winning
  the claim and then failing is worse — the key is burned for a match whose deltas were never
  written, so that match's rating is gone permanently and every retry is answered "already
  applied". A double-credit is at least visible in the ladder and reversible. Both directions
  have their own tests, the failing-write one forced by a real SQLite trigger rather than a
  mocked driver, because the point is that the *database* aborts the write the claim is tied to.
- **A lost claim answers 200 with `duplicate: true`, deliberately not 409.** The sender is an
  at-least-once retry ladder, and `internalFetch` counts every non-2xx a failure: a 409 would
  log "ladder report failed" for a match whose rating actually landed, and keep asking. 200 is
  what *ends* at-least-once delivery meeting an idempotent receiver, so the marker goes in the
  body where an operator can still tell the two apart. A thrown apply is a 500 for the mirror
  reason — 500 is the one status that IS retried, and the claim has already rolled back.
- **`roomId` alone would have been a correct key, and is not the one that shipped.** A room
  settles at most once (`MatchRoom.reportResult` latches and destroys) and `matchsvc.ts` mints
  room ids with `randomUUID()`, and the mode does not change this: a PvE/co-op settlement takes
  the same `onSettled` path and is filtered per-REPORT by `reportSettledMatch`'s
  `hashOk`/`placements`/`winner` guard, so whatever gets through still gets through once per
  room. What breaks it is that the room id is not always ours — `index.ts`'s legacy dev
  handshake reads `roomId` off the query string, and the room is gone once it settles, so a
  local `?roomId=dev` can host a second, genuinely different match. So the key is
  `{roomId}:{16 hex of sha256 over the report}`: the prefix is what an operator greps, the
  digest is what keeps two matches apart, and it is stable across the retry ladder because it
  is a pure function of the body.
- **A report with NO `reportKey` is applied the old, non-deduped way, and logged.** The route
  has exactly one legitimate caller, so a keyless report means version skew during a rolling
  deploy. The two options are asymmetric: accept it and risk the bounded double-apply that
  stood until today, or 400 it and lose those matches' ratings for good, since a 4xx is never
  retried. The recoverable failure wins. This is not a hole worth closing — the route is
  key-gated, and anyone who can reach it can already post whatever placements they like.

### The ladder gate stops asking the players — SHIPPED 2026-09-05

The other half of "who may move a rating", and the one the key does not cover. Authentication
settled *who* may call `/rating/report`. It did not settle *which settlements the gameserver
sends*, and until 2026-09-05 that was decided by data the clients supply.

`reportSettledMatch`'s guard read
`!match.hashOk || !match.placements || typeof match.winner !== 'number'`, and only the first of
those is trusted. `hashOk` is the room's own work — `MatchRoom.reportResult` compares every seat's
end-of-match state hash and sets it itself. `placements` and `winner` are `reports[0]`'s values,
relayed verbatim out of the seats' own `result` messages, with `hashOk` saying only that every
seat sent the *same* hash, never that any of it describes a real match. So `placements`-is-present
was doing double duty: a legitimate precondition for `buildRatingReportBody`, and — per the comment
above it — the test for "was this PvP", which is a question the seats were answering about
themselves.

A co-op/PvE squad that plays a room out, agrees on a hash (they already do; same deterministic
sim) and all send a fabricated `placements` array plus a numeric `winner` therefore produced a
real ladder report for a match nobody competed in. The accounts moved are real: `seatAccounts`
comes from the verified ticket, so they never had to lie about who they were, only about what they
were playing.

**This is the qualification on the bullet above.** "Anyone who can reach the route can already post
whatever placements they like" is true of the route, and was the right call for a keyless report.
It understated the population: the gameserver — correctly authenticated, holding a real key — was
forwarding placements authored by ordinary clients who hold no key at all.

The room already knew better. `MatchRoomDeps.mode` is set from the verified ticket
(`resolveSeat` → `RoomManager.join` → the constructor), `RoomManager.join` rejects a joiner who
disagrees about it, and `index.ts`'s reconnect arm was already cross-checking `modeValue` to refuse
a stale or foreign ticket. Settlement just never consulted it — deliberately, and the comment said
so: "its presence, not the room's own knowledge of match type, is what selects the `'placement'`
reason — MatchRoom stays generic infrastructure". That reasoning is right about `match_over`'s
`reason` string, which is cosmetic. The mistake was letting a rule about a display string govern a
decision with ratings attached.

`SettledMatch` now carries `mode` and the guard leads with `mode !== 'pvp'`. Three notes:

- **`mode` is required, not optional.** An optional field would leave a future producer that omits
  it with `undefined`, which is not `'pvp'` and so fails closed *by luck*. Required makes it a
  compile error, and it found the one construction site at once.
- **`placements`/`winner` stay in the guard**, as the shape check `buildRatingReportBody` needs —
  not as evidence of the match type. They are on their own line so the file reads that way.
- **`MatchRoom` still imports nothing from matchsvc.** `mode` was already in `MatchRoomDeps`, so
  the room reports a fact about itself and the entrypoint decides what it means.

Recorded in [`roadmap/33-2026-09-05-ladder-mode-gate.md`](../roadmap/33-2026-09-05-ladder-mode-gate.md).
