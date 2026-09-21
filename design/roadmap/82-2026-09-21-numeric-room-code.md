# Work log — 2026-09-21

Volume 82. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Six digits, deduped, with one home for the shape (2026-09-21, net + ui + test + docs, no engine change)

*"房间码仅用0-9十个数字，长度改为6位，并在服务端去重"*, plus a question about the same feature:
*"请确认组队和匹配功能，是否需要玩家登录"*. The first is a shape change with a keyspace bill
attached. The second turned out to be a question about an **absence**, which is the kind nothing
in a green suite answers.

### The shape, and the bill

The code was five characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — an alphabet chosen in the
2026-07-29 squad pass so a code read aloud could not be misheard (no `0`/`O`, no `1`/`I`). Digits
carry that same argument one step further: no letter is left for a digit to be confused with, the
code is dictatable **and typable** in all eight locales this game ships (a Cyrillic or Chinese
layout reaches a digit without switching; `A` is not always where the player expects it), and a
phone can offer a numeric keypad for a field that can only hold digits.

What it costs is keyspace — 32^5 (~33.5M) collapses to 10^6 (1M) — and the two halves of that bill
are very different, which is why they are recorded separately rather than as one "less secure":

| | before | after | verdict |
| --- | --- | --- | --- |
| collision on mint | ~33.5M | 1M | a non-event; a party TTLs out after 10 idle minutes, so the live set sits orders of magnitude below 1M, and the mint redraws |
| guessing a live code | slow | **feasible in bulk** | not defended, and now written down where it matters |

The guessing half is the honest finding. Nothing in the `/party/*` group rate-limits —
`rateLimit.ts`'s `RateLimiter` exists and is wired to `/auth/*` and the telemetry routes, not here
— so a caller can walk the whole space. What a walk buys is a seat in a stranger's squad, which is
the same prize the old alphabet made slow rather than impossible, so this is an existing gap
widening and not a new one. It is stated beside `randomCode` with the fix named (a per-IP budget on
`/party/join`) rather than filed as a doc TODO nobody greps.

`randomInt` replaced `Math.floor(Math.random() * n)` in the same edit, and not for tidiness: that
expression was uniform for the old alphabet only because **32 is a power of two**, and 10 is not.
The `%` spelling of the same idea is measurably biased; `randomInt` rejects the uneven tail itself,
and it also retires the question of whether one code is predictable from another at a 1M keyspace.

### A `// vanishingly rare` comment that was true of a different number

Dedup already existed. `PartyService.create` drew, and looped:

```ts
while (this.codeToPartyId.has(code)) code = this.deps.newCode(); // vanishingly rare
```

Which was true of a 33.5M-wide code and is exactly the kind of claim that quietly stops being true
when the shape underneath it changes. **An unbounded loop over a saturated keyspace is an infinite
loop on the one event loop that also serves matchmaking, party polling and ladder settlement** — and
a hang there is worse than a refusal, because a refusal is a 503 one player retries and a hang is
every player in the process. It is now `drawFreeCode()`, bounded at `CODE_DRAW_ATTEMPTS = 100`,
throwing `CodeSpaceExhausted`.

100 rather than 10 so that reaching it is *evidence* rather than bad luck: the chance of exhausting
100 draws is `(live/1M)^100`, so ~100k live parties still clears it with room to spare, and 100
`Map.has` calls are microseconds in the case that always happens (the first draw is free).

The route catches it, and the catch is load-bearing rather than defensive. `readJson` invokes its
callback from inside a `.then()`, so a throw escaping the handler becomes an unhandled rejection
that `matchsvc.ts`'s error boundary never sees — `routes/http.ts` says so in its own header — and
the request answers **nothing at all**, leaving the client on its own timeout. Hence 503 for the
condition, 500 plus a log line for anything unexpected, and neither arm re-throwing.

### The duplicate constant that no test could have caught

For about an hour the shape was two constants: `CODE_LENGTH = 6` in `routes/party.ts` and
`ROOM_CODE_LENGTH = 6` in `PartyScreen.ts`, the second carrying a comment justifying the copy —
*nothing in `client/src` may import from `server/src`*. True, and **the wrong direction.** The
sharing in this repo already runs the other way: `server/src/config.ts` re-exports
`SQUAD_SIZE`/`teamIdForOwner` from `@dd/game/match/pvpConfig`, with a comment there saying why —
*"instead of two hand-mirrored copies that could drift (design/06's own stated lesson)"*.

So the duplicate was precisely the mistake the neighbouring file warns about, and the reason it
matters is that **it is not a testable defect**. Each constant is independently correct; a drift
mints six digits into a field five wide with every suite on both sides green, because the server
tests the server's number and the client tests the client's. The fix is to delete it rather than
test it: a new pure module `client/src/game/match/roomCode.ts` owns `ROOM_CODE_LENGTH`,
`ROOM_CODE_DIGITS`, `ROOM_CODE_PATTERN`, `isRoomCode` and `normalizeRoomCode`, and the server
reaches all five through the alias it already uses. One `6`. `normalizeRoomCode` went the same way
— both sides had a bare `.trim()`, which was one claim spelled three times in three files.

`isRoomCode` takes `unknown`, not `string`, and the narrowing is the point rather than fussiness.
**The mistake a digit-only code invites is sending it as a number**, which also truncates `004271`
to `4271` on the way, and a predicate typed to `string` would let the first of those through a
`test()` coercion. Both are refused with a 400, distinctly from the 404 a well-formed but unknown
code gets — *"that is not a room code"* and *"no room has that code"* being different answers, and
the 400 also keeping arbitrary strings out of the lookup map.

`match/roomCode.ts` is listed in `pureLayerBoundary.test.ts`, where it matters more than for an
ordinary pure module: the **server** imports it, so "stays loadable with no browser behind it" is
not a testability nicety here, it is matchsvc booting.

### The question about an absence: no, a squad needs no login

Audited, and the answer is that **no part of party or matchmaking requires an account** — a
decision, not a gap (`design/16`'s *"logging in is never required to play"*). `requireAuth` gates
`/account/*` and `/store/*` and nothing else; all five `/party/*` routes plus `/find`,
`/find/:queueId` and `/resume` are open. `/find` *does* verify an `Authorization: Bearer` when one
is present, but a missing or invalid one means **guest**, not 401, and the only thing withheld is
the durable ladder rating, which falls back to the one-match `seat:{roomId}:{seatIdx}` scaffold.

The half worth writing down is why the audit needed tests at all. An absence of auth checks is
scattered across eight route registrations and is exactly what no test asserts by accident, so both
directions are now pinned: the whole squad flow (create → join → poll → start → `/find` → leave)
runs with **no `Authorization` header**, and — the converse, which the first cannot rule out — a
**valid bearer token is ignored**, with `playerId` still naming the member and the session holder
still refused as a non-leader. Without that second case, a route that silently preferred the
session over `playerId` would pass, and a member who logged in mid-lobby would change identity under
their own party. `matchsvc.findIdentity.http.test.ts` already pinned the matchmaking half
(*"still gets a playable seat — nothing but the ladder key is withheld"*); this is the party half.

`PartyService.ts`'s header said *"no account system backs this (none exists anywhere in this
project)"*, which predated `design/16` and stopped being true on 2026-07-29. Rewritten to say what
is actually the case, which is a stronger statement than the one it replaced.

### The battery, and a survivor that was right to survive

29 mutants, **28 killed, all 3 controls surviving, 0 skipped**, baseline green before *and* after
(which is what proves every revert landed). Shared-module mutants were judged against **both**
packages, since that is what sharing the constant buys.

The survivor is `^[0-9]{6}$` → `^\d{6}$` with the `u` flag, and it is **equivalent, not a gap**:
JavaScript's `\d` is ASCII-only whatever flags it carries, unlike .NET or Python's `re` on `str`.
Nothing can kill it and nothing should try — the third verdict from the `win`-outcome battery
(2026-09-02), where the action is a comment rather than a test or a deletion.

What made it worth the hour is the edit **one character away** that is not equivalent. Measured in
node rather than reasoned about:

| input | `[0-9]` | `\d` + u | `[\p{Nd}]` + u |
| --- | --- | --- | --- |
| `123456` | ✓ | ✓ | ✓ |
| full-width `\uff11…\uff16` | ✗ | ✗ | **✓** |
| Arabic-Indic `\u0661…\u0666` | ✗ | ✗ | **✓** |
| Devanagari `\u0966…\u096b` | ✗ | ✗ | **✓** |
| CJK numerals `\u4e00…\u516d` | ✗ | ✗ | ✗ |

`[\p{Nd}]` accepts six glyphs a human reads as an ordinary code, keying `PartyService`'s map as
something the server could never have minted. Confirmed that the near-miss list **does** kill that
mutant — and that the server's own list does not, which is correct now that the shape is shared: one
of each script sits in `roomCode.test.ts`, the shape's authority, and the server's list keeps only
what a *stale client* sends. So the generalisable move, filed in the assertion-craft notes: **when a
survivor is a character-class swap, enumerate the other swaps the same tidy-up could produce and
test those.** An equivalent survivor and a catastrophic one look identical in a diff, and the battery
only asked about the one that happened to get written.

Two process findings came out of the same run and are in the battery notes rather than here:
stopping a battery early leaves a **live mutant** in the source, because `finally` does not run
through a process kill and `git status` cannot see it when your own edits are in the same file; and
the "mutant payload absent" half of a cleanliness check lies for any mutant whose payload is a
substring of its anchor.

### Numbers

- Server **1,894 → 1,897**, client **7,077 → 7,100**, engine 1,630 — all green, measured on the
  merged tree with volumes 78–81 present so both sides of each number come from the same suite.
- Coverage, `npm run coverage`: client **98.03% / 93.86%**, engine 97.71 / 93.77, server
  **98.63% / 97.74%**. All three green; the client's measured scope grew 279 → 280 files with
  `match/roomCode.ts`.
- 29-mutant battery: 28 killed, 3/3 controls survived, 1 equivalent survivor.
- `check:logic`, `check:docpaths`, `check:roadmapindex`, `check:filelength`,
  `check:wechatpackage` clean; `tsc --noEmit` clean for `client`/`engine`/`server`.
- No `ENGINE_VERSION` bump — nothing in `@dd/engine` was touched.

### Still open

**`/party/join` has no rate limit**, against a keyspace this pass shrank to 1M. The mechanism
already exists (`rateLimit.ts`'s `RateLimiter`, wired to `/auth/*` and telemetry) and the fix is a
per-IP budget on that one route; what it protects is a squad seat, which is why it is named here
rather than done here.

**`pureLayerBoundary.test.ts`'s "pure but unlisted" survey only walks `controllers/`.** So
`match/pvpConfig.ts` — imported by the server exactly as `match/roomCode.ts` now is — has never been
offered up for listing. Not a decision, just a scope nobody has widened.

Nothing in this pass, but worth the line because it cost an hour here and the answer already
existed: `tools/png-pipeline`'s two `.mjs` suites fail in a fresh `git worktree` and pass in
`D:/daydayup` on byte-identical content. The cause is **`#!` plus CRLF in the IMPORTED module**,
not in the test — `core.autocrlf=true` with no `.gitattributes` gives a new checkout CRLF, and a
file whose first two bytes are `#!` then dies in vitest's transform, which is why `pngCodec.mjs`
(starting `/*`) is fine while `alphaClamp.mjs` and `lumaCurve.mjs` are not. Seven `build/*.mjs` are
shebanged too, so the root test leg fails the same way. Rewriting those 13 files to LF in the
working tree — never staged, since git wants CRLF back — makes `npm run check` whole. This was
already resolved on 2026-09-04 and is in the worktree notes; I re-derived it instead of reading
them, which is the actual lesson.
