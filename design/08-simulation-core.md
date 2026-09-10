# Simulation core: GameState, step order, commands

How `@dd/engine` is actually shaped. `06-netcode-determinism.md` locks the *principles* (fixed-point, brad angles, injected PRNG, `InputSource`, frame-broadcast lockstep) by mirroring the sibling project **funny** (`C:\Users\TaoWang\Documents\funny`). This doc turns those principles into the concrete structures you write first: the **`GameState` schema**, the **`step()` system order**, and the **`PlayerCommand` shape**. It is the source of truth for *what the engine tick does and in what order* — the one thing every determinism guarantee depends on.

It builds on the entity model (`02`), the weapon system (`03`), and the loop (`05`); detailed collision math and damage rules live in `07-collision-combat.md` — this doc names the systems and their order, `07` fills in the hit/damage bodies.

> **funny mapping.** Files referenced below live in `funny/server/engine/src/`. Blightbloom mirrors the *structure*; it diverges where a real-time twin-stick shooter differs from funny's turn-based lane game — flagged inline as **⟂ diverges**.

## The decisions (locked)

- **One orchestrator, fixed system order.** A single `step(tick, commands)` runs the systems in a **documented, unchanging order** (funny's `engine/loop.ts` doc-comment order). The order *is* part of the determinism contract — reordering systems, or iterating an entity collection in a different order, changes outcomes and desyncs. Any such change bumps `ENGINE_VERSION`.
- **`GameState` is plain data, no Pixi, no methods that decide outcomes.** All entities are plain objects/arrays. Systems are the only code that mutates state. The render layer and server only *read* it. (funny `GameState.ts`; the strict split is `06`'s day-one rule.)
- **Ordered collections only.** Entities live in **arrays whose push order = spawn order = iteration order**. No iterating a `Set`/`Map`/`Object.keys` in a way that leaks insertion or hash order into state (`06` banned list). funny's `projectiles: Projectile[]` — "push order = fire order = deterministic iteration" — is the pattern.
- **Per-tick continuous input command.** ⟂ diverges. funny commands are discrete verbs (`play_card`). Blightbloom's core input is a **per-player, per-tick snapshot** of a twin-stick controller (move vector, aim, held buttons). Discrete actions (weapon swap, interact) are **edge-detected inside the engine** from the button bitfield, not sent as separate commands — so one command type carries a whole frame of input and the wire stays compact.
- **Injected PRNG per concern, distinct derived seeds.** `roomgenPrng`, `aiPrng`, `combatPrng`, `dropPrng`, plus two added for the PvP arena (`15`) — `ringPrng` (eye selection, per-seat spawn assignment) and `integrityPrng` (anti-cheat padding draws, ROADMAP 4.4, never read by any gameplay system) — each `new Prng(seed ^ <distinct constant>)`. Never a global `Prng`, never `Math.random` (`06`). Distinct seeds so streams never alias (funny `GameState` constructor seeds four PRNGs this way; Blightbloom now carries six).
- **Entity ids from a state-local counter.** ⟂ diverges. funny uses module-global id counters reset per match (`resetUnitIds()` in the `GameState` ctor) — a footgun if two engines ever coexist. Blightbloom puts the counter **on `GameState`** (`state.nextId()`), so ids are reproducible without a global reset and headless re-judge can run alongside a live match.
- **Events are the only engine→render channel.** Each step appends transient facts (`bullet_fired`, `melee_swing`, `hit`, `deflect`, `status`, `shield_break`, `death`, `downed`, `revived`, `pickup`) to a per-frame event queue; render/audio consume them once per frame. Engine decides outcomes, never the reverse. **The client reconciles its scene BEFORE it consumes the frame's events** (`GameLoop.stepSim` / `advanceOnline`, both paths, asserted since 2026-09-02) — so a `death` has already removed the view by the time that same frame's `hit` reaches the reactor, and `Scene.actorAt` finds nothing: a killing blow produces its position-anchored burst but no per-actor reaction. Anything that must react to a fatal hit ON the actor has to read state, not the event. (`shield_break` also triggers a character break-passive, but that resolves *inside* the sim — `07`.)
  `melee_swing` (v52) is the melee twin of `bullet_fired` and carries the identical fields, so the render layer answers both with one reaction (`12`'s attack layers). It announces the SWING, not its hits — a swing that touches nothing still has to animate, and `hit`/`deflect` are both conditional on connecting. It is an event rather than a render-side read of the `justSwung` latch that already exists on the weapon **because the online loop does not look at every tick**: `GameLoop.advanceOnline` drains every confirmed frame the server has ready and reconciles the scene once, against the last of them, so a one-tick latch on an intermediate frame is invisible under latency. `session.drive()` returns the whole drained event batch — which is the property this channel exists for.

## `GameState` schema

Plain data, constructed from `seed + config`. Sketch (fp = fixed-point per `06`; brad = binary-radian integer angle per `06`):

```
GameState {
  // ── identity / clock ──
  seed: number
  phase: 'idle' | 'playing' | 'gameover'
  tick: number                 // authoritative sim frame, ++ each step
  nextId(): number             // state-local monotonic entity-id allocator

  // ── injected PRNG (distinct derived seeds) ──
  roomgenPrng: Prng            // dungeon layout/selection (05)
  aiPrng: Prng                 // enemy/boss decisions
  combatPrng: Prng             // spread jitter, crit rolls (03)
  dropPrng: Prng               // in-run drop tables (05)
  ringPrng: Prng               // PvP arena eye selection + per-seat spawn assignment (15)
  integrityPrng: Prng          // anti-cheat padding draw, never read by gameplay (15, ROADMAP 4.4)

  // ── entities (ordered arrays; index/id stable within a match) ──
  players: PlayerActor[]       // one per human; index = PlayerId (== OwnerId)
  enemies: Actor[]             // PvE mobs + boss; empty in PvP
  projectiles: Projectile[]    // bullets in flight; push order = fire order
  pickups: Pickup[]            // in-run drops on the ground (05)

  // ── world ──
  room: RoomState              // collision geometry + spawn/exit data (07 / future 09)

  // ── outcome ──
  winner: PlayerId | 'enemies' | null

  // ── render channel (transient, per-frame) ──
  events: GameEvent[]          // cleared+rebuilt each step; unioned per render frame
}
```

`Actor` / `Weapon` fields follow `02` but **all positional/velocity state is fp and all angles are brad** (`06`): `gx_fp, gy_fp, vx_fp, vy_fp: Fp`, `facing: Brad`, `hp, maxHp: number (integer)`. **Two-pool health (`05`/`07`):** actors also carry `shield, maxShield: number (integer)` and `ticksSinceHit: number` — shield absorbs before HP, and `ticksSinceHit` (reset to 0 by any damage in step 7 or the DoT sub-pass of step 8) drives the idle shield-regen in step 8. A player also carries the two weapon slots + active-slot index (`02`) and, when `downed`, a revive-progress counter. Movement is 2D — there is no z/vz on actors (jump was removed; `z` survives only as a render-side, always-0 offset and on bullets as a cosmetic muzzle height). `PlayerActor extends Actor` with the input-derived intent for the current tick (see commands). The weapon carries `cooldownTicks` counted down in whole ticks, not seconds.

### Why arrays and a state-local id counter

Iteration order over `projectiles`/`enemies` decides, e.g., which of two overlapping bullets resolves a kill first. An array walked front-to-back is identical on every client; a `Set` is not guaranteed to be. Ids from `state.nextId()` (rather than a module global) mean a server running `runHeadless` re-judge in the same process as anything else can't have its id stream perturbed — the divergence from funny is small and removes a real footgun.

## The tick / step loop

Adopt funny's `engine/loop.ts` verbatim in shape (it is already exactly `06`'s "lagging client catches up" behavior):

- `tick(dt)` — accumulator at **30 Hz** (`TICK_RATE`, `06` open question notes 20 Hz as a low-end fallback). Banks wall-clock time, drains it in fixed `stepDt` steps.
- **Catch-up multiplier** (backlog >1s/10s/30s → 2×/3×/5×) and `MAX_CATCHUP_TICKS` spiral guard — copied as-is. Only re-times `step()` calls, never changes which frames run or their order.
- On a net stall (`input.take(frame)` returns `null`) it stops advancing and drops banked time to one step, so playback resumes at natural cadence instead of bursting.
- **Per-frame event union.** `step()` clears+rebuilds `events` each sim step, so a catch-up frame (≥2 steps) must union every step's events and a 0-step render frame must clear stale ones. `tick()` assembles the union and writes it back (funny's `setEvents`). Render reads `state.events` once per render frame.

Render interpolates between the last two sim states (`06`); the engine only needs to expose current positions — interpolation is the render layer's job.

## `step()` — the fixed system order

This ordering is the **determinism contract**. Locked skeleton (bodies for collision/combat come from `07`):

> **The skeleton below is enforced, since 2026-09-03** — `engine/stepOrder.test.ts` parses it and
> fails if its step labels are not exactly the ones `GameEngine.step()` runs, or if any system's
> own `Step N —` header disagrees with its call position. Add a system here and to `step()` in the
> same pass, or the gate goes red. It exists because this list silently omitted `DoorSystem`
> (11.5) for four weeks and three system headers had been off by one since `ENGINE_VERSION` 8
> (`roadmap/16`, design/18 Layer 0).

```
step(tick, commands):
  if phase == gameover: return []          // don't clear events (funny bug fix)
  if phase == idle: phase = playing
  clearEvents(); tick++

  1. Apply input      — for each PlayerActor, fold its confirmed command into intent
                        (move vector, aim brad, firing flag, edge-detected swap)
  2. AI decide        — enemies/boss set their own intent from state + aiPrng
                        [both modes — arena rooms carry enemies too; only the
                        dungeon room-activation gate is PvE-specific]
  3. Weapon fire      — for actors whose fire flag is set & cooldown ready:
                        ranged → spawn Projectile(s) (spread from combatPrng);
                        melee  → start swing (justSwung); the swing IS the parry (03)
  4. Movement         — integrate vx/vy (2D ground plane; no z/gravity — jump removed);
                        resolve actor–solid (round pillars) and actor–actor collision (07)
  5. Projectile step  — advance bullets; resolve bullet–solid (expire/stop) (07)
  6. Deflect          — a melee swing's arc vs enemy bullets caught in it → flip faction + redirect (03, 07)
  7. Hit resolution   — bullet–actor overlap → damage; melee swing arc → damage+knockback;
                        per-type resist + on-hit elemental status applied here (03, 07)
  8. Status effects   — tick burn/poison DoT (shield-first) + chill countdown on tick%DOT_INTERVAL;
                        then advance ticksSinceHit & regen shield (+1/interval after idle delay) (03, 07)
 8a. Zone             — room-graph shrink stage machine → zone damage on actors outside the
                        safe set (15)   [PvP, arena-mode only — ROADMAP 4.2d]
 8b. Environment      — per-actor roomId tracking, then CellTrait hazard damage (always-on or
                        phased) (15)   [BOTH co-resident modes — it no-ops only when neither
                        zoneEnabled nor dungeonEnabled; the roomId half is what DoorSystem
                        (11.5) reads, the hazard half is arena-only]
  9. Death & drops    — hp<=0 → enemy death + roll dropPrng → Pickup (weapon/heal/material);
                        player → downed (revive via INTERACT channel), not removed (05, 07)
 10. Pickup           — player–pickup overlap → apply (weapon→active slot / heal / floor-buffer
                        material) (05); in arena mode also resolves an unrolled 'crate' via
                        rollArenaDrop and scales a picked-up weapon by PVP_SCALE_FACTOR (15)
 11. Spawns           — expand a room's WaveScript into a timed schedule and dispatch it (05)
                        [both modes — one shared WaveScript vocabulary, two spawn-point
                        sources: dungeon rooms, and arena rooms on lazy activation (15),
                        which also drop each room's lootMarker crates]
11.5 Doors           — recompute every room's hasLiveEnemy; on a room's rising edge
                        force-regroup the other players onto its entrance; relock doors
                        (locked = either side in combat) and, only on an actual lock
                        change, rebuild state.walls + the spatial index (05 "Room &
                        door model")   [PvE dungeon only]
 12. Extraction       — per-floor checkpoint → DESCEND, or EXTRACT on the LAST floor
                        only (v61); banks the floor's materials either way
                        (05, ROADMAP 1.4/1.5)   [PvE, floors-mode only]
 13. Revive           — bleedout timer + sustained-INTERACT revive channel for downed
                        players (05, ROADMAP 3.2)   [co-op]
 14. Win condition    — all enemies dead / boss dead / all players down / one PvP seat
                        standing → set winner (or placements, 15), phase
  return events
```

Notes on the order:

- **Fire (3) before movement (4)** so a bullet spawns at the muzzle position of *this* tick's aim, then everything moves together — matches the "weapon socket follows the frame" intent (`02`) once render reads it back.
- **Deflect (6) before hit resolution (7)**: a bullet caught by a swing must change faction *before* the hit pass decides who it damages, or a just-deflected bullet could still register a hit on the swinger the same tick.
- **Status effects (8) after hit (7), before death (9)**: HitResolve only *starts* an elemental status; the DoT that can KILL is applied in step 8, so a burn/poison kill is swept and rolls a drop the same tick as a direct-hit kill (`07`). Added 2026-07-10 (`ENGINE_VERSION` 8). **Shield regen** rides at the end of the same step: because step 7 and the step-8 DoT sub-pass both zero `ticksSinceHit` on damage, advancing the timer + regen *after* them means any actor hit this tick (direct or DoT) cannot regen this tick — the "clear your status to recover shield" rule (`05`/`07`) needs no extra bookkeeping. ✅ Shipped (ROADMAP 0.4): the two-pool shield + regen bumped `ENGINE_VERSION` 11→12 (it changed hit outcomes; no new PRNG draw). The step-9 drop kinds and step-10 apply now speak the design/09 vocabulary (`heal`/`material`/`weapon`/`buff`, ROADMAP 0.6, `ENGINE_VERSION` 14).
- **Zone/Environment (8a/8b) after status (8), before death (9)**: ✅ Shipped (ROADMAP 4.2d). Both hazard passes (room-graph shrink damage, then `CellTrait` tile damage) reuse `takeDamage`'s existing shield-first path, so a zone/trap kill rolls a drop through the same step-9 pass as any other kill. **Exception to "a new step bumps the version":** both were hard no-ops unless `state.zoneEnabled`/`config.arena` was provided, so insertion changed nothing for any pre-existing config. **8a is genuinely arena-only; 8b is not, and calling it that was wrong until 2026-09-03** — `EnvironmentSystem` grew a per-actor `roomId`-tracking half for the dungeon (2026-08-04, `05` "Room & door model") and now returns early only when *neither* `zoneEnabled` *nor* `dungeonEnabled` is set. That half is what `DoorSystem` (11.5) reads to decide which rooms hold live enemies, so in a PvE dungeon 8b is load-bearing, not a no-op.
- **Death/drops (9) before pickup (10)**: a kill this tick can drop a pickup, but it is not collectable until the *next* tick's pickup pass — avoids "kill and auto-vacuum in the same frame" order sensitivity.
- **Doors (11.5) after spawns (11), before extraction (12)**: ✅ Shipped (2026-08-04, `ENGINE_VERSION` 34→35 — `05` "Room & door model"). Both halves are a real ordering requirement, not a convenience. A room's enemies for THIS tick — including anything `SpawnSystem` just dispatched, which sets `roomId` directly rather than leaving it to next tick's inference — must be counted before this system decides which doors lock; and `ExtractionSystem`'s capstone check must see this tick's fresh `hasLiveEnemy`, not the previous tick's. A room is "in combat" purely because it holds a live enemy — never an authored flag, and never re-locked once cleared, since nothing respawns into a cleared room. The wall rebuild is the one thing in the engine that moves a wall mid-run (`state.walls` from `dungeonBaseWalls` + every locked door's passage rect, then `rebuildSpatialIndex()`), which is why `ENGINE_VERSION` 51 had to re-clamp resting pickups after it. **Exception to "a new step bumps the version"** does *not* apply here: unlike 8a/8b and 12, this one shipped with a bump, because it replaced the old one-room swap outright.
- **Extraction (12) before revive (13) before win condition (14)**: ✅ Shipped (ROADMAP 1.4/1.5, then 3.2). Reaching a floor's checkpoint used to be win condition's job (waves exhausted + no enemies → immediate win); that transition now belongs to `ExtractionSystem`, which must run first so win condition sees `state.winner` already set on an EXTRACT resolution and no-ops instead of double-deciding. `ReviveSystem` (13) runs the bleedout timer + revive channel before win condition checks whether every player is down (a team wipe). **The exception to "a new step bumps the version":** step 12 is a hard no-op unless `EngineConfig.floors` was provided (`state.floorsEnabled`), so its insertion changed nothing for any config that predates the feature — verified by keeping every pre-1.4 replay test green without a bump.
- **What each mode actually skips.** PvP skips only **11.5** (`state.dungeonEnabled`) and **12** (`state.floorsEnabled`); PvE skips only **8a** (`state.zoneEnabled && state.arenaMap`) — **not 8b**, which runs in either co-resident mode and is where a dungeon actor's `roomId` comes from. Everything else runs in both. This line used to read "PvP skips steps 2, 10, 11, and 12", which was wrong on three of the four (corrected 2026-09-03): an arena room carries enemies, so **2** drives them (only the dungeon room-activation gate inside it is PvE-specific); **11** is the shared `WaveScript` path for *both* dungeon and arena rooms, and is what drops an arena room's `lootMarker` crates on activation; and **10** is the most arena-aware system of the three — it rolls an unresolved crate through `rollArenaDrop`, scales a picked-up weapon by `PVP_SCALE_FACTOR`, and owns the PvP-only `bandage`. In every mode the confirmed command stream is the only input, which is what keeps two clients byte-identical (funny's `netplay` branch).

Whatever the final order, it is frozen; changing it bumps `ENGINE_VERSION` — except steps 8a/8b and 12, which ship as standing no-ops for any config that doesn't opt in (above).

## `PlayerCommand` — the twin-stick input snapshot

⟂ The core divergence from funny. One command per player per tick, carrying a full frame of controller state. Everything is already quantized for determinism (`06`: move is a quantized stick). **There is no aim field** (`10` v33 — manual aim was removed; facing is engine-decided every tick, see below):

```
PlayerCommand = {
  type: 'input'
  owner: PlayerId          // == index into state.players
  tick: number             // frame this input applies to (matches step's tick)
  moveBrad: Brad           // desired move direction (integer binary-radian)
  moveMag: 0..255          // left-stick deflection, 0 = idle (quantized; fp-scaled in engine)
  buttons: number          // bitfield, edge-detected in the engine:
                           //   FIRE | SWAP_WEAPON | INTERACT
                           //   (no BLOCK — parry is the melee swing; no JUMP — removed)
}
```

- **Move is quantized at the input edge** (`04`/`06`): joystick `dir` (or keyboard 8-way) → `atan2`-free brad on the way in, so the wire value is already deterministic and compact. The engine never sees a float angle.
- **Facing is engine-decided, not input** (`10` v33): `ApplyInputSystem` sets `PlayerActor.facing` every tick — the nearest hostile actor if one exists (unlimited range, same contract `nearestHostile` gives homing/deflect), else the current movement direction, else it holds last tick's facing. A fired shot (and a melee swing's hit-arc) travels along this facing, same as an enemy's own `AIDecideSystem`-computed facing.
- **Discrete actions are edge-detected**, not separate commands: the engine compares this tick's `buttons` to the player's last-tick buttons; a rising edge on `SWAP_WEAPON` toggles the active weapon slot (`02`; picking up then replaces the *active* slot), `INTERACT` opens a chest / takes a pickup / **starts or sustains a revive channel** on a downed teammate (`07`), etc. A held `INTERACT` (level, not edge) is what sustains the multi-second revive. This keeps one command type and makes "held vs tapped" unambiguous and replayable.
- **Empty/absent = idle-hold.** A tick with no command for a player replays as "same buttons, zero move" (sparse replay frames, funny `ReplayFrame`). Movement stops, held buttons are *not* assumed still held — define the idle default explicitly in code and test it in the golden replay.

Wire encoding (bit-packing `buttons` + brads for the frame-broadcast packet) is `06`'s "per-frame input packet budget" open question; the typed object above is the engine-facing form.

## `InputSource`, replay, headless

Reuse funny's seam unchanged (`net/InputSource.ts`):

- `submit(cmd)` / `take(frame): PlayerCommand[] | null` / optional `confirmedLead(frame)`.
- `take` returns `null` when the frame isn't confirmed yet → engine stalls (net only; `LocalInputSource` never stalls).
- Three impls, one logic path: `LocalInputSource` (single-player PvE, delay 0), `NetInputSource` (server `frame_batch`), `ReplayInputSource` (recorded frames). Migration step 5 in `06` routes the current demo through `LocalInputSource` first.
- **Replay = `seed + config + input stream`, never state** (funny `Replay`); a fresh engine on the same seed reconstructs every frame. `runHeadless(config, input, maxTicks)` is the shared authoritative loop for post-match re-judge / anti-cheat backstop (`06`).
- **`ENGINE_VERSION`** guards replays: bump it whenever a change to the core could make an old recorded stream diverge (system reorder, fp/brad table change, new PRNG draw site). `ReplayInputSource` refuses a mismatched version — fails loud instead of replaying garbage.

### Getting a replay OUT of a live session ✅ (2026-08-31)

Everything above shipped in Stage E and then sat unused for months: **nothing in `client/`
or `server/` ever called `toReplay`**, so the engine could replay a match nobody could
record. A bug report could carry a seed, and a seed is not a repro — where a monster dies,
and therefore where its loot lands, is a function of the input stream. That gap is what
made the recurring "无法拾取的掉落物" report unanswerable after the engine sweeps came
back clean (ROADMAP v50): the missing evidence was the moment, not more content.

- **`engine/replayFile.ts`** — the file envelope: `kind`/`fileVersion`/`engineVersion`,
  wall-clock metadata, human-supplied `marks` (a tick plus a note: "it happened HERE"),
  and the `Replay` itself. `parseReplayFile`/`parseReplayFileText` validate an untrusted
  file field by field and throw rather than replaying a malformed stream as idle-hold —
  the same "fail loud, never replay garbage" rule `ReplayInputSource` already applied to
  the version. Pure data, no host API, so the engine stays host-free.
- **The whole `EngineConfig` is embedded**, not a "how to rebuild it" descriptor. It costs
  ~18 kB and buys the property the format exists for: the geometry in the file IS the
  geometry the run had. A descriptor would rebuild the world from today's content, and
  content is not covered by `ENGINE_VERSION`, so nothing else would catch the drift.
  Measured: ~100 B/tick for the stream, i.e. ~360 kB/minute, ~7 MB for a 20-minute run,
  both budgets gated in `replayFile.test.ts`.
- **Recording is free and always on** (`client/src/game/match/MatchRecorder.ts`).
  `LocalInputSource` has always retained every command it was handed — an offline run was
  already holding its own replay in memory — so the recorder only keeps the config beside
  it and packs the two on demand. That is what makes the save control work at all: the
  moment worth recording is one nobody planned for, so an opt-in flag is exactly what
  fails. Online runs are excluded: their authoritative record is the server's confirmed
  stream.
- **Two entry points, one verb**: the **F9** hotkey and a **record button on the HUD**
  (`ui/HudView.ts`'s `replayBtn`, '●', beside the pause button). The button exists for the
  same reason the pause button does — a touch/WeChat player has no keyboard at all, and
  that is the platform a bug report is most likely to come FROM. It hides itself when the
  run cannot be saved (online, or while watching a replay) rather than offering a dead
  control, and `saveMarkedReplay` returns a typed result so all three outcomes — saved /
  nothing to save / this device cannot — are localised through `t()` (design/17) rather
  than baked into the module that writes the file as an English sentence.
- **Playback runs inside the real client** (`?replay=<url>`, `match/replayPlayback.ts`),
  because the open half of that report is a render-vs-sim disagreement and no headless
  re-run can see a frame. `GameLoop` submits nothing while a recording drives the engine
  (`ReplayInputSource` is read-only and throws — the guard is enforced by a real source,
  not by a spy), and the sim **holds at the marked tick** while the render loop keeps
  running, which is what a screenshot of the reported moment needs. Pair it with
  `?pickupDebug=1`.
- **Offline analysis**: `DD_REPLAY=<path> npm run replay:inspect`
  (`client/sim/replayInspect.sim.ts`) reports, per drop, how close the player ever got,
  how close their PATH came, the gate it was judged against, and whether the engine's own
  `pickup` event ever fired for it. Two traps found by running it rather than reading it:
  `PickupSystem` collects DURING a tick, so the one tick a drop was collectible is the one
  tick a post-step observer cannot see it — the first run called four collected drops
  "never collectible"; and the per-tick sample is not the closest the player's path came,
  which is a distinct answer to "I walked right over it".

## Engine assembly

Mirror funny's mixin chain (`GameEngine.ts`) *only if* the engine grows past one file; start as a single `GameEngineImpl` and split by domain (loop / commands / spawns / wincondition / helpers) when it does. The factory `createGameEngine(config, input?)` defaults `input` to `LocalInputSource` so single-player and tests need no net setup. Keep `GameEngineBase` holding construction/mode setup; systems are separate classes (`MovementSystem`, `CombatSystem`, …) each with a `tick(state)` method, instantiated once and called in the fixed order above.

## Relationship to the other docs

- **`06` (netcode):** owns fp/brad/PRNG/tick/`InputSource` *principles* and the frame-broadcast model; this doc is their concrete data+order form. Must not contradict it.
- **`07` (collision & combat):** owns the *bodies* of steps 4–9 (collision shapes, hit tests, damage/knockback/i-frames, deflect redirect math). This doc owns their *order and interfaces*.
- **`02` / `03`:** `Actor`/`Weapon` fields and fire/parry behavior; here they become fp/brad plain-data on `GameState` and steps 3/6/7.
- **`05` (gameplay):** run seeding, drops, wave director, win/lose live as steps 8–11 and the injected PRNGs.

## To design

- **`RoomState` / collision-geometry schema** — deferred to `07` (+ a future `09-content-data.md` for the room-piece data format `05` calls for).
- **Fixed system bodies** — collision resolution, hit tests, damage pipeline (`07`).
- **`config.ts` schema** in `@dd/engine` — the single home for balance numbers (`06`); weapon specs (`03`), enemy blueprints, drop tables. Likely `09`.
- **Interpolation snapshot format** — what minimal per-entity fields the render layer reads for the two-state lerp (`06` snap-vs-lerp open question).
- **Idle-default semantics** for a missing per-player command — write it down and pin it with a golden-replay test.

## Open questions

- **Move quantization:** `moveBrad + moveMag`, or a quantized `(dx,dy)` fp pair? Brad+mag composes with the fp-trig tables already needed for aim (`06`); a raw vector avoids a second table lookup but needs its own quantization grid. Decide with the fp-trig module.
- **Command coalescing:** if the render/input rate (60 Hz) produces more than one input per 30 Hz sim tick, which sample wins — last-before-tick, or a merged hold? Affects feel and must be deterministic.
- **Per-tick command size** for a full 8-player PvP lobby (`15`, 8 commands/frame) vs the WeChat packet budget (`06`).
- **AI determinism boundary:** does boss/enemy AI read *only* `state + aiPrng`, or may it read `tick`? Reading `tick` is fine (deterministic) but tempting to smuggle wall-clock in — enforce via the `06` banned-list lint.
