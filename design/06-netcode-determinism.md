# Netcode & determinism

How Blightbloom goes online. This is the single source of truth for the simulation-core / netcode split. It mirrors the proven architecture of the sibling project **funny** (`C:\Users\TaoWang\Documents\funny`, Notebook Wars) — a shipping TS+PixiJS deterministic-lockstep game on the same platforms (Web / WeChat) — and records where Blightbloom must diverge because it is a **real-time twin-stick shooter**, not a turn-based game.

## The decision (locked)

- **Model:** server-driven frame-broadcast lockstep (帧转发服务器, the 王者荣耀 pattern) + **client-side prediction of the local player only**.
- **Not** peer-to-peer lockstep, and **not** full peer rollback (GGPO-style).
- **Simulation runs on a shared deterministic engine** consumed identically by client (prediction/render) and server (authority/replay), reusing funny's `@nw/engine` blueprint.

### Why this and not the alternatives

| Model | Verdict for Blightbloom |
|-------|----------------------|
| Peer lockstep (wait for slowest) | ✗ Packet loss freezes the whole match; unacceptable for action. |
| **Server frame-broadcast lockstep** | ✓ Server is the clock, **never waits for a client**; a lagging player falls behind and catches up alone. Scales to 5v5+ (王者荣耀 proves it), so an 8-seat lobby is comfortable. |
| Full peer rollback | ✗ Built for 2-player fighting games. In a bullet-hell with up to 8 players, re-simulating N frames × many entities blows the frame budget on low-end phones / WeChat. |
| Server-authoritative + state sync | Best anti-cheat & scaling, but heaviest to build and wastes the deterministic-engine investment. Kept as a **later escalation path** if competitive PvP demands it. |

Match scope driving this: **PvP is an 8-player solo battle royale, positioned casual-first** (this revises the original "3v3/4v4" framing this section carried before `15` locked the mode — see `05`'s PvP section and `15-pvp-arena.md` for the current shape). Casual tolerance means the inherent maphack weakness of client-held full state is acceptable for launch (mitigation below).

## Two layers, kept strictly separate

```
┌─────────────────────────────────────────────────┐
│  @dd/engine  — deterministic simulation core     │  ← no Pixi, no DOM, headless-runnable
│  fixed-point math · injected PRNG · fixed tick    │
│  InputSource · systems · GameState (plain data)   │
└─────────────────────────────────────────────────┘
        ▲ reads state, interpolates      ▲ drives authority, replays
┌───────────────────┐          ┌──────────────────────────┐
│  client render     │          │  server (frame broadcast, │
│  (Pixi, this repo) │          │   headless authority)      │
└───────────────────┘          └──────────────────────────┘
```

The engine is the **only** code that decides game outcomes. The render layer and the server both sit *outside* it and only touch its public surface. This is funny's SLG_DESIGN §16.7 lesson: they had two hand-mirrored copies of the logic (client + server) that inevitably drifted and desynced, and had to extract `@nw/engine` to kill it. **We build it extracted from day one.**

## The deterministic core (`@dd/engine`)

Package layout mirrors funny's `server/engine/`; client references it via webpack alias + `tsconfig` paths, server via npm-workspace dependency. Same bytes on both sides.

### Fixed-point arithmetic — mandatory

Floating point is **not** bit-identical across JS engines (WeChat runs JavaScriptCore on iOS, V8 on Android; browsers differ). Any divergence → desync. So the logic layer never touches native floats.

Adopt funny's `math/fixed.ts` almost verbatim:

- `FP_SCALE = 1000`, one grid unit = 1000 fp integer units.
- A **branded `Fp` type** so TypeScript rejects assigning a raw `number` to an fp field at compile time.
- Helpers `toFp / fp / addFp / subFp / mulFp / scaleFp / negFp`; `fromFp` is **render-layer only**.
- **Integer `isqrt`** (bit-by-bit) for distances — never `Math.sqrt`.

### Deterministic trig — the twin-stick-specific hazard

funny's units advance along grid columns, so it barely needs trig. **Blightbloom fires bullets at arbitrary angles**, so `Math.atan2 / cos / sin` are everywhere in the current demo (`Game.ts` facing, bullet velocity, block-arc test). These are float and platform-divergent — they must leave the logic layer:

- **A `PlayerCommand` field may carry STATE, not just an edge — and `cardVote` does** (`ENGINE_VERSION` 58, `05`'s floor cards). Most discrete actions are one-tick pulses the engine edge-detects (`SWAP_WEAPON`, `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`) or one-shot values it consumes immediately (`pickupTargetId`). A floor-card vote is neither: `ApplyInputSystem` copies a non-zero `cardVote` onto the seat and leaves it there until the checkpoint consumes the offer, so `0` means "not changing my vote" rather than "no vote". That is a determinism requirement and not a convenience — the winning card is decided by a tally over every seat, computed independently on every client, so the votes have to live in shared simulated state rather than in whatever happened to arrive on one tick. The tally itself (`tallyCardVote`) is total and order-independent for the same reason: ties resolve to the lowest slot, never to a re-roll.
- **A new PRNG stream is a version bump even when nothing else changes.** `cardPrng` (`ENGINE_VERSION` 58) draws three times per checkpoint and is hashed by `serializeState` like every other stream. It is its OWN stream rather than a share of `dropPrng` on purpose: a checkpoint's three cards and a kill's loot are independent decisions, and sharing would make "how many enemies did you kill on this floor" silently decide which cards you are offered at the end of it.
- **Quantize move direction on input.** A `PlayerCommand` carries the move direction as an **integer angle** (e.g. `0..65535` binary-radians, "brad"), not a float. This makes the input itself deterministic and compact on the wire. (There used to be a separate aim field quantized the same way; `10` v33 removed manual aim entirely — facing is now computed inside the engine from the already-brad-quantized move direction and `atan2Brad`, never from a float.)
- **Fixed-point trig tables.** `cos_fp(brad) / sin_fp(brad)` via a precomputed integer lookup table (+ interpolation in fp). Bullet velocity, facing, and block-arc all derive from these.
- Angle math (differences, arcs) done in the integer brad space, not radians.

> This is the single biggest new determinism surface vs funny. Design the fp-trig + brad-angle module early; the whole weapon/ballistics system depends on it.

### Deterministic RNG

funny's `math/prng.ts`: an LCG (`Math.imul`-based, uint32), `Math.random()` banned in logic. Reused as-is. **Injected instances** (each subsystem/roomgen holds its own seeded `Prng`), never a global — so drop tables, bullet-spread jitter, and dungeon generation are all reproducible from `seed + input stream`.

### Fixed tick + the loop

- Logic tick **30 Hz** (match funny's `TICK_RATE`); render runs at a **capped** rate — 60 fps in a run, or 30 if the player picks it, and 30 on any screen that is not a run (`client/src/game/powerBudget.ts`, 2026-09-08; it read "display rate (60 fps)" until then, which stopped being true on a 120 Hz panel) — and **interpolates** between the last two sim states. The cap is presentation-only: the sim steps off the loop's own fixed accumulator, so two clients rendering at different rates stay byte-identical.
- Loop is the accumulator pattern from funny's `engine/loop.ts`, including its **catch-up multiplier** (backlog >1 s/10 s/30 s → 2×/3×/5×) and `MAX_CATCHUP_TICKS` spiral guard. This is *exactly* the "lagging client falls behind the broadcast and speeds up to resync" behavior we need — already written.

### Banned in the logic layer (enforced)

`Math.random()` · `Date.now()` / `new Date()` · native float in stored state · `Math.sqrt/sin/cos/atan2` · iteration over `Set`/`Map`/`Object.keys` in a way that leaks insertion/hash order into state · variable `dt`. All arithmetic goes through fp helpers; all randomness through injected `Prng`; all angles through brad + fp-trig tables.

## Netcode model in detail

### Server as frame broadcaster

- The server owns a fixed-rate clock. Every tick it **broadcasts one frame packet** to all clients in the match: the set of player commands it has received for that frame, or an **empty frame (frame number only)** if none arrived.
- The server **does not wait** for any client. Late-arriving input is folded into a later frame (or dropped past a deadline). One player's bad network never stalls anyone else.
- Clients advance their sim strictly by the confirmed frame stream. A client behind the broadcast uses the catch-up multiplier to resync.

### Unified input pipeline (funny's `InputSource`)

The engine pulls the confirmed command set per tick from an abstract `InputSource`, agnostic to origin — so single-player, online, and replay share **one** logic path:

| Impl | Used for | Command source |
|------|----------|----------------|
| `LocalInputSource` | single-player PvE / practice | self-forward, 0 delay |
| `NetInputSource` | online PvE/PvP | server `frame_batch`; `take(frame)` returns `null` until confirmed |
| `ReplayInputSource` | replay / headless re-judge | recorded frames |

### Client-side prediction (the twin-stick feel fix)

Frame-broadcast alone leaves **local input delay ≈ one RTT** (your press must reach the server, get framed, and broadcast back). Fine for turn-based, mushy for a shooter. Fix:

- The client **predicts its own actor immediately** — local movement applies the instant the input is read, running the shared engine ahead of the confirmed frame with the local input filled in. (Facing is NOT predicted, `10` v33 — it's engine-decided, not player input, so the predictor reads it straight off the last confirmed frame instead of re-deriving it client-side.)
- When the authoritative frame arrives, the client **reconciles**: if the confirmed input matches what it predicted (the common case, since it's your own input), nothing visible happens; on mismatch it rolls its *own* actor back to the confirmed state and replays.
- **Scope is the local player only.** Other players and enemies are shown from confirmed frames (with short interpolation). This is "rollback scoped to your own input" — an order of magnitude cheaper than peer rollback, and enough for a casual 8-player BR lobby.
- Remote bullets/enemies may pop slightly on correction; acceptable at this positioning.

### Sparse input transmission (held-until-changed)

A transport-layer change alongside the BR arena work (`15`), applying to both PvE and PvP: a `PlayerCommand`'s fields are sent only when they change, not resent every tick. The receiving side holds **the last received command per owner** and reuses it for every tick until superseded — matching sibling project funny's model, and matching how a twin-stick player actually behaves (holding a direction steady has nothing new to transmit). Aim's "changed" test reuses the existing brad quantization (an update is worth sending only when the *quantized* value moves, which already absorbs sub-quantization stick jitter); buttons are already edge-shaped. This is purely a wire-format change — the engine still receives a command for every simulated tick internally (gaps filled by holding the last one), so it touches none of `@dd/engine`'s determinism or `ENGINE_VERSION`.

The reason to build this now, even though frame-broadcast lockstep would work without it: the client-side consumption pattern it needs — extrapolate/hold between sparse updates, then reconcile (snap or lerp) when a new one lands — is **exactly** what `LocalPredictor` (below) already does for the local player. Building sparse/held-update discipline into the input channel now means that if this project ever affords the server-authoritative escalation named in the anti-cheat section, the only thing that changes is *what* arrives sparsely (an authoritative state delta instead of an input), not how the client consumes it.

### PvE vs PvP

- **PvP (8-player solo BR, `15`):** the full model above.
- **PvE (co-op boss):** same transport, but cooperative and latency-tolerant. Can start as `LocalInputSource` single-player (validate feel first), then the same `NetInputSource` broadcast for co-op. Enemy/boss AI runs *inside* the deterministic engine off injected PRNG (like funny's `AISystem` / `WaveDirector`), so it stays identical on every client.

## Anti-cheat posture

Frame-broadcast lockstep means **every client holds full match state** → maphack/wallhack is inherently possible. Given casual-first PvP:

1. **Launch:** accept it for information-only cheats (ESP/wallhack/aim-assist). No ranked integrity promised against those specifically — see the honest limit below.
2. **Backstop, now periodic rather than end-of-match only:** `runHeadless` (funny's headless driver) can **re-simulate a finished match from `seed + recorded input`** server-side and compare the reported outcome. The BR arena (`15-pvp-arena.md`) extends this from a single post-match check into a **periodic, tick-indexed checkpoint** — clients report their `stateHash` (already computed for the existing end-of-match `ClientMsg.result`) every `checkpointTicks`, and a **cross-client majority vote** flags whichever seat disagrees (v1 — needs no new server-side simulation, since the server today only relays frames). This only activates above a **quorum (>3 real seats)**, and only kicks on a divergence **confirmed at the same historical tick across ≥2 consecutive checkpoints** — never on a single stray mismatch, which is more likely a client still catching up under the backlog multiplier above than an actual fork. Full mechanism, the `integrityPrng` padding-stream trick, and the escalation to a server-run shadow simulation (any seat count, heavier cost) are in `15`.
3. **Escalation (only if competitive PvP is ever added):** move to server-authoritative state sync with fog-of-war culling. The deterministic engine is reusable there too — the engine investment is never wasted. This is the *only* thing that would meaningfully address the information-cheat class (2 above doesn't and structurally can't — a client that never diverges state, just reads more than it should, passes every hash check by construction).

## Persistent vs in-run state

Follow funny's split (ADR-002): **in-run resources/drops are engine state, wiped each match; persistent progression is server-authoritative meta**, loaded into the engine as initial config at match start. In Blightbloom's concrete form (`05`/`14`) the persistent side is **materials** (banked out of a run) plus the **account-level blueprint and character unlocks** they (or purchase) buy; the brought-in loadout weapon is *crafted* from an unlocked blueprint + materials at match start but, like every weapon, is itself wiped at run end (`05` "weapons are ephemeral; materials are the only carry-out"). The architecture is unchanged — meta in as initial config, in-run state out each match. Rewards are recomputed server-side, never trusted from the client (funny ADR-006). The fairness split (`14`): crafted weapons are compile-time barred from PvP, only character choice reaches it — so persistent meta never becomes a PvP power ladder, keeping casual-first intact under a bounded, no-gacha monetization model.

## Numbers live in one place

All balance/config numbers live in the engine (funny's ADR-001: `config.ts` inside `@nw/engine`, client reads via alias). Prose docs only snapshot them with a date. Prevents the "same number, four different values across four docs" drift funny hit.

## Migrating the current demo — ✅ all six steps done

Kept as the record of how the engine got here, and of the order to follow if a comparable
refactor ever comes up again. The starting point was a vertical slice (`client/src/game/`)
that was float + variable-`dt` + logic-fused-into-Pixi (`Actor`/`Enemy`/`Bullet` **were**
`Container`s; state lived in display objects; `sync()` copied to Pixi x/y). The rule that made
it work: refactor in phases — do not bolt netcode on before the split.

1. ✅ **Split state from view.** Introduce plain-data sim entities (no Pixi) inside `@dd/engine`; the render layer owns Pixi objects that *read* sim state each frame. `sync()` becomes the render layer's job. Existing `01-rendering` tricks (Y-sort, height/shadow, per-weapon z) stay in the render layer unchanged — they read `gx/gy/z` off sim state.
2. ✅ **Fixed timestep.** Replace `ticker.deltaTime` variable stepping with the 30 Hz accumulator loop; render interpolates.
3. ✅ **Fixed-point + brad-angle + fp-trig.** Convert movement, facing, ballistics, collision, block-arc from float to fp; move `atan2/cos/sin` into the fp-trig module; quantize aim input to brad.
4. ✅ **Injected PRNG.** Replace any `Math.random` (enemy spawns, spread) with seeded `Prng`.
5. ✅ **`InputSource` seam.** Route input through `LocalInputSource` → validate single-player still plays identically (golden-replay check: same seed + same input → identical end state). ✅ shipped (Stage E).
6. ✅ **Server broadcast + `NetInputSource` + local prediction.** Only now add the online layer. ✅ **shipped (ROADMAP 3.1; prediction followed in 3.3, see the end of this bullet).** The engine gained multi-seat construction (`EngineConfig.players`) — the actual second player, additive/byte-identical for single-player. `@dd/engine/net` holds the shared wire protocol, `NetInputSource` (confirmed frame-stream + jitter cushion + catch-up), and `FrameBroadcast` (the pure server relay). The `server/` package is the WebSocket shell around `FrameBroadcast` (`MatchRoom`/`RoomManager`, injected clock + sockets, unit-tested with fakes); the client `CoopSession` drives the engine off the confirmed stream. Loopback tests prove `FrameBroadcast → NetInputSource → engine` and the full client↔server `CoopSession` loop reproduce a plain replay byte-for-byte. **Local-player prediction/reconcile — SHIPPED (ROADMAP 3.3 follow-up):** a render-layer predictor (`LocalPredictor`) draws the local seat's movement/aim ahead of the confirmed frame and eases back (snap-vs-lerp) on each confirmed frame, hiding RTT without touching the sim. Scope is movement/aim; local firing stays sim-confirmed (bullets are sim entities — no rollback). See the resolved open question below. **The matchmaking control plane in front of this shipped too (ROADMAP 3.3):** `matchsvc` (HTTP) pools players and issues signed HMAC tickets, the gameserver verifies `/ws?ticket=` and derives the trusted seat/seed from it, and the client `?online=1` path (matchmaking → ticket → `CoopSession`) is browser-verified two-tab (two independent clients matchmade into one room, byte-identical lockstep). See the resolved open question below.

Steps 1–5 were the determinism foundation and were worth doing regardless of when
multiplayer shipped — step 6 only became safe to attempt because they landed first.

## Open questions

- Logic tick rate: 30 Hz (match funny) vs 20 Hz (cheaper on low-end/WeChat, coarser aim). Decide after measuring WeChat CPU under a full bullet-hell.
- Brad resolution (angle quantization granularity) and fp-trig table size vs accuracy.
- ~~Prediction reconciliation smoothing (snap vs lerp).~~ **RESOLVED (ROADMAP 3.3 follow-up):** shipped as a **render-layer** predictor (`client/src/game/controllers/LocalPredictor.ts`), scoped to the local player's **movement** (the dominant twin-stick feel). It dead-reckons the local sprite/camera at the sim's own speed ahead of the confirmed frame, then on each confirmed frame corrects toward the authoritative position — **snap** above `snapPx` (teleport/room transition/large desync), **lerp** by `correctionGain` below it (the two tuning constants). The confirmed sim is **never** touched (no GameState rollback — that costly path stays rejected for casual/WeChat, so local **firing** stays sim-confirmed). Tune the constants against real RTT via the `?lag=<ms>` `LaggyTransport` harness; verified two-tab that the predicted pose leads under lag and converges while both clients stay byte-identical. **Narrowed further (design/10 v33):** aim dropped out of scope entirely when manual aim itself was removed — facing is engine-decided, so the predictor reads it straight off the last confirmed frame rather than predicting it.
- ~~Server transport / where the frame-broadcast server lives.~~ **RESOLVED (ROADMAP 3.3):** a two-service split like funny — a **control plane** (`matchsvc`, HTTP) that pools players and issues **signed HMAC tickets**, and a **data plane** (`gameserver`, the raw-WebSocket frame relay, ROADMAP 3.1). The client calls matchsvc to matchmake, then redeems its ticket on the gameserver socket (`/ws?ticket=`); the gameserver verifies the ticket and derives the trusted `{roomId, owner, seed, playerCount}` from it instead of raw params (closing the seat/seed spoof hole). Ticket = stateless `b64url(payload).b64url(hmac-sha256)` over a shared secret (`BB_TICKET_SECRET`); no shared store. A real secret makes tickets mandatory; unset falls back to the dev raw-param handshake. Where the two services physically deploy (host/Docker) is a separate ops call, not an architecture question.
- Match size ceiling and per-frame input packet budget for WeChat.
- ~~Mid-match reconnect.~~ **RESOLVED (ROADMAP 3.1 update, 2026-08-04):** the wire protocol/server plumbing (`resume`/`conn_resync`, `MatchRoom.resume()`, `NetInputSource.resumeFrame()`/`onConnResync`) existed since 3.1 but was never actually reachable — nothing on the client called `resume`, and the gameserver's own `/ws` handshake unconditionally tried `join()` first, which rejects any socket for a room already `IN_MATCH`. A full client code review caught this (a dropped connection mid-match just froze the game forever with no recovery) and closed it end-to-end: `matchsvc` mints a fresh short-lived ticket for the same seat via `POST /resume` (proven by the caller's own now-expired original ticket's still-valid signature, since a match runs far longer than a ticket's 30s TTL); the gameserver handshake now detects an in-match room and waits for `resume` instead of always calling `join()`; `CoopSession.reconnect(transport)` swaps the live transport without touching engine/`NetInputSource` state, so `conn_resync` folds into the SAME confirmed-stream catch-up path a merely-backgrounded tab already used; a bounded client-side retry driver (`net/reconnect.ts`) with backoff, surfaced to the player via a reconnecting/reconnected HUD toast and a real "connection lost" result screen if every attempt is exhausted.

## One field on the wire that the sim cannot see (2026-09-08)

`MatchStart.names` and `ConnResync.names` (`engine/net/protocol.ts`) carry seat index → display
name, so a client can label the other players (`design/20` — a game portal requires the platform's
own usernames be shown in-game). It is worth naming here because it is the first thing this
protocol carries that is **not** an input to the simulation, and the contract this document states
is what makes that safe:

- It never travels in a `PlayerCommand`, is never hashed, and no system reads it. A frame's output
  stays a function of its commands, so the golden-hash fixture is untouched and a room where nobody
  is logged in puts nothing new on the wire at all (`undefined`, not an array of nulls).
- It is **server-supplied**, from the bearer session `POST /find` verifies — never client-declared.
  A name is the one field in a match that other players SEE, which makes a self-declared one an
  impersonation primitive rather than a cosmetic.
- It rides on `conn_resync` as well, because a reconnecting client never sees `match_start` again.
