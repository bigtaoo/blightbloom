# Work log — 2026-09-17

Volume 75. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The account's untested halves, and the two decisions hiding in them (2026-09-17, server + client + test)

Two questions, in order: *"登录和账号部分做完了吗"* and then *"你看看还有测试可以加吗"*. The first is
answered by [volume 70](70-2026-09-17-home-and-login-design.md)'s three holes being closed in
[73](73-2026-09-17-guest-merge-and-session-check.md) and [74](74-2026-09-17-ladder-identity.md).
This is the second, and it found four things — two of which turned out to be decisions about
behaviour rather than missing tests, and one of which was a live authentication defect.

### The instrument said the opposite of where the work had been

A full `npm run coverage` (client 97.75/93.36, engine 97.71/93.77, server 98.62/97.72 — all green)
was the starting point, read against the account surface rather than against the total. **The
server had no gaps worth the name**: `routes/auth.ts` and `routes/account.ts` are at 100% on every
column, `AuthService` at 98.27/95.45, and volumes 73 and 74 had left the guest-merge contract, the
`x-guest-id` preflight and nine `/find` identity cases behind them. Every gap was on the client,
and the two worst were in the two files the whole login flow runs through:

| | lines | branches | functions | what was never executed |
| --- | --- | --- | --- | --- |
| `net/session.ts` | 69.23% | 53.84% | 100% | `createWebSessionStore`'s entire body |
| `screens/LoginScreen.ts` | 80.86% | 62% | **42.3%** | every path from a button to `do*` |

Both are the same shape and it is worth naming, because a 90/90 gate cannot see it: **the tests
inject a fake and the shipped implementation is what is left over.** `session.test.ts` passes a
`fakeStore` to every case, and this runner has no `localStorage`, so the store that actually ships
on web and portal had never once run — including the `catch` that decides whether a corrupt stored
session reads as *logged out* or throws out of boot. `LoginScreen.test.ts` calls `doLogin` directly,
so `beginLogin` → `promptCredentials` → the overlay had never run either.

What that second one was hiding is the finding of the pass: **`password: true` is passed in exactly
one place and was asserted in none.** Deleting the word left 4000+ green client tests and a
player's password rendered in plain text on screen as they typed it — and `autocapitalize` would
have upper-cased it on a phone, because this overlay's default is the party join-code field.
`TextInputOverlay`'s own suite named the option only in its module doc.

### Four gaps, and what each one turned into

1. **The shipped session store, and the key it reads.** `createWebSessionStore` now has its own
   block (round trip, corrupt value, a `getItem` that throws, quota on save, `save(null)` REMOVING
   the key rather than storing `"null"`, and the no-`localStorage` no-op that is the WeChat shape).
   Then the part that is not about this file at all: `'daydayup.session.v1'` appears **once** in the
   tree and nothing pinned it. Neither do the other six. Since the rename to Blightbloom was
   deliberately left unfinished (2026-09-06), "tidying up the last of the old name" silently turns
   every existing player into a new one — their save, their settings, their run and their login all
   read as absent, because absent is what a different key returns. `client/src/storageKeys.test.ts`
   is now the gate: the exact set of seven, each in exactly one module, with the CONVERSE asserted
   (no `blightbloom.*` twin) because a half-finished rename is what would leave one.
2. **The input path.** The real `TextInputOverlay` is driven through a stubbed `document`, so the
   assertions are on the element a browser would get: `type="password"`, `autocapitalize="off"`,
   `autocomplete="current-password"`, and the converse on an ordinary field so the flag cannot be
   hard-wired on. Plus what the screen decides around it — two steps in order, `maxLength` 20 then
   64, the username trimmed, an empty one refused **without ever opening the password prompt**, and
   `begin*`'s own busy guard, which is a different line from the `do*` guard already covered.
3. **A password change did not revoke anything.** Not a missing test — a missing behaviour, and the
   one the screen exists for: "somebody else is in my account" was answered by leaving the
   intruder's bearer token live for the rest of its thirty days. `changePassword` now takes a
   `keepToken` and deletes every other session for the account; `/auth/change-password` passes the
   caller's own token, so the device doing the changing stays signed in and every other one does
   not. A REFUSED change revokes nothing, or a wrong guess becomes a way to sign somebody out.
4. **`/auth/register` was unbounded and expensive.** The only route in this server that was both:
   every call mints a row and pays a full scrypt hash, with no ceiling here and none at the edge.
   Both halves were fixed together — `REGISTER_RATE_LIMIT` (thirty per ten minutes per address, its
   OWN limiter rather than telemetry's, spent BEFORE the body is read) and scrypt moved off the
   event loop onto the threadpool. Either alone is half an answer: the limiter bounds how much work
   a caller can ask for, the async form bounds what that work freezes while it runs — and what it
   was freezing was matchmaking, party and ladder settlement, which share the one loop.

The budget is deliberately far looser than adminsvc's ten-in-five-minutes login: there a false
positive inconveniences an operator who can wait, here it is a real player who cannot make an
account, and a carrier-grade NAT can put a city behind one address.

### The defect that fell out of the scrypt move

`verifyPassword` splits the stored `salt:hash`, guards `!saltHex || !hashHex`, and then asks scrypt
for a key the length of the decoded hash. A stored value of `'aa:zz'` walks past that guard with
both halves non-empty — and `Buffer.from('zz', 'hex')` is **empty**, so the old code asked for a
zero-length key and compared it against a zero-length expectation. `timingSafeEqual(<empty>,
<empty>)` is `true`. **Any password logged in.**

It takes a damaged or planted row to reach, which is what makes it latent rather than open, and the
existing "corrupted stored password hash" case could never have found it: `'garbage'` has no colon,
so it stops at the earlier guard. Fixed with an explicit length check ahead of the comparison, and
pinned by a case that uses `'aa:zz'` specifically. Worth stating plainly: the password check
answering `true` is not a failure mode to leave to the storage format's good behaviour.

### The battery

Fifteen mutants, each patching one shipped line back and running only the file that should catch
it: **15 killed, 0 survived, 0 NO-MATCH** (the find-string count is asserted, because a mutation
that matches nothing reports as a clean run). They cover both halves of each decision — the
revocation and the sparing of the caller's own token; the limiter and its ORDERING against the body
read (the one thing real HTTP cannot show, since `fetch` always finishes sending); the masking flag
on both sides of the overlay boundary; the storage key under a rename; the corrupt-value catch; and
`save(null)` storing `"null"` instead of removing, which `load()` alone cannot tell apart.

Server **1881** tests (was 1863), client **6798** (was 6779), `tsc --noEmit` and the file-length
gate clean.

`net` `ui` `test`
