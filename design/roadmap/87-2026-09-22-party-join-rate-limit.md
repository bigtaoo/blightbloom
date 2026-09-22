# Work log — 2026-09-22

Volume 87. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A ceiling on the room-code walk (2026-09-22, net + ui + test + i18n + docs, no engine change)

> *"给 /party/join 加上限流"*

The one item [volume 82](82-2026-09-21-numeric-room-code.md) left open, and it left it open in
the honest way: the room code became six digits the day before, the keyspace went from 32^5
(~33.5M) to 10^6, and `randomCode`'s header spent a paragraph stating that GUESSING was now
feasible in bulk, that nothing in `/party/*` rate-limited, and naming the fix — a per-IP budget
on `/party/join`. A named fix in a comment is still an absent fix. This is it.

### The number is an argument about a rate, not about a ceiling

`JOIN_RATE_LIMIT` is **120 requests per ten minutes per address**, and neither half of that was
picked for roundness.

A per-IP budget cannot make a keyspace walk impossible — a flood spread over many addresses walks
around any of them — so the only question it can answer is *how fast*. Unbounded, one caller at a
modest 50 requests a second draws ~4.3M codes a day, several times the whole space, and lands in
essentially every party that is live while it runs. At 120 per ten minutes the same caller draws
17,280 a day, one pass over 10^6 takes about **two months**, and the expected number of live
parties it stumbles into falls by the same three orders of magnitude. The walk does not become
impossible; it becomes **slower than the thing it walks toward**, because a party TTLs out after
10 idle minutes and takes its code with it.

That is also why the number is four times looser than `/auth/register`'s thirty, rather than
copied from it. The two routes have incomparable false positives. A refused registration is a
player who waits; a refused join is a player who cannot get into the squad their friend is
already sitting in, having done nothing wrong — and a carrier-grade NAT can put a city's worth of
mobile subscribers behind one address. A human enters one code, or three with a typo. 120 leaves
room for dozens of humans inside one window and still costs a bulk walk everything.

`/party/create` is deliberately left unbounded, and there is a test asserting that rather than a
comment claiming it: minting a code is not guessing one, and a collision was already a non-event.

### Where the budget is spent, and what that choice costs

Before the body is read, exactly as `postRegister` does it, for the reason written there — a
flood's next request arrives while this one is parked on its body, so a limiter taken afterwards
is one the flood has already walked past.

The cost is real and is written down beside it: charging on entry charges a **successful** join
too, where a budget aimed purely at guessing would charge only the misses. Charging only the
misses was the first design and it needs something this codebase does not have — a way to ask
`RateLimiter` "is this key exhausted" *without* spending from it. Without that peek, an exhausted
walker still gets its probe answered before it is refused, which is the single thing the budget
exists to prevent. Adding a method to a class the telemetry, auth and adminsvc routes all share,
to buy headroom that a wider number buys for nothing, is the worse trade.

### The half of this that is not the server

`doJoin`'s `catch` was a bare one, and rendered `party.invalidCode` for every failure. That was
correct while every refusal meant the same thing to a player — a bad code, a full party, a server
that was not there. A 429 is the first refusal that is **not about the code**, and answering it
with "Invalid or full code" is not merely inaccurate: the only action that message suggests is to
type the code again, which is precisely the action that spends more of a budget the player has
already run out of. A rate limit whose error message drives retries is a rate limit arguing with
itself.

So `net/party.ts` throws a `PartyRequestError` carrying the **status** — not the parsed message,
because the message is the server's prose and a client that branches on prose breaks the day the
prose is reworded — and the screen says `party.joinThrottled` for a 429 and nothing else. Eight
locales, because `Translations<typeof en>` makes a missing key a compile error and there is no
way to ship seven of them.

### What the tests pin, and the three mutants that prove it

`server/test/matchsvc.joinLimit.http.test.ts` is new (12 cases), modelled on the register-limit
file: the budget served then refused, per-address isolation, the last forwarded hop, separation
from the telemetry and registration counters, the stalled-body ordering case that real `fetch`
cannot express, and the shipped constant pinned against an injected one.

The case that carries the file is **"a wrong guess is charged"** — its own server, with no party
ever created on it, so every well-formed code is absent by construction rather than by a
1-in-10^6 hope. A budget charged only on a join that LANDED passes every other case in the file
and leaves the walk completely unbounded, since a walk is almost entirely misses. Its neighbour
does the same for the 400s, because charging the 404s alone would leave the budget spendable only
by well-formed traffic, which is exactly the traffic an attacker has no obligation to send.

Three mutants, each killed by the case written for it and by no more than it:

| mutant | killed by |
| --- | --- |
| limiter removed entirely | 9 of 12 |
| limiter moved after the body read | 1 — the stalled-body case, alone |
| only successful joins charged | 4 — both "is charged" cases, the refused-lookup case, the ordering case |

The client half was mutated both ways too, which matters more than it looks: forcing `throttled`
false (the old catch-all) kills only the new throttle case, and forcing it **true** kills three —
including the pre-existing "an invalid code surfaces a status message" — so the branch is pinned
from both sides rather than just proven reachable.

### Numbers

Server **1,897 → 1,909**, client **7,204 → 7,208**, `tsc --noEmit` clean in every workspace,
`check:docpaths` and `check:roadmapindex` green. No engine change and no `ENGINE_VERSION` bump —
nothing here is inside the sim.

Docs corrected rather than appended to: `design/15-pvp-arena.md` names the budget beside the
keyspace cost it defends (the doc that states a cost has to state its mitigation), and
`design/16-accounts.md`'s audit line — *"resolve no session and refuse nobody"* — now says *on
identity grounds*, because one of those eight routes does refuse somebody now, on a rate rather
than a session, and a guarantee left one word too broad is how the next audit reads a false one.

`net` `ui` `test` `i18n` `docs`
