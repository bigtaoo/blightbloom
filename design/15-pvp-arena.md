# PvP arena: battle royale, zone, environment, anti-cheat

The concrete design behind `05`'s PvP section (ROADMAP Phase 4.1, decided). This is the single source of truth for the **`ArenaMap`/`ArenaRoom`/`CellTrait` schema** (the map editor's output contract), the **shrinking-zone stage machine**, the unified **`EnvironmentSystem`** that drives both zone damage and authored hazard tiles, the **team/hostility model** PvP needs that PvE never did, and the **PvP-specific netcode additions** (periodic anti-cheat checkpoints, sparse input sync) that extend `06`.

## The decisions (locked)

- **Battle royale: 8-player, squad or solo, elimination + shrinking zone.** Not a symmetric team arena. ✅ **Shipped (`ENGINE_VERSION` 30):** squads are chunks of `SQUAD_SIZE` (4) seats sharing one `teamId`, formed via a pre-formed party invite code (`server/src/PartyService.ts`) or filled with solo queuers/bots when a party is smaller than a squad; **the room code is six decimal digits** since 2026-09-21 (was five characters of a no-0/O/1/I alphabet — digits are dictatable and typable in all eight shipped locales and let a phone show a keypad, at the cost of a 1M rather than 33.5M keyspace; `randomCode` in `server/src/routes/party.ts`, and `PartyService.create` redraws a code already in use up to `CODE_DRAW_ATTEMPTS` times rather than looping forever). **That keyspace is what the two `/party/*` per-IP budgets defend, from opposite sides** (2026-09-22): `JOIN_RATE_LIMIT` bounds GUESSING — 120 in ten minutes, spent before the body is read and charged on a MISS as well as a hit, since a walk over 10^6 is almost entirely misses, which puts one caller's pass over the whole space at roughly two months, slower than the 10-minute TTL of the parties being walked toward — and `CREATE_RATE_LIMIT` bounds MINTING, 60 in ten minutes, because the ratio of 1M codes to a live set is safe only while the live set stays small and the live set is whatever the create route was allowed to mint. Its window is deliberately the party TTL, which makes the budget also the ceiling on how many parties one address can hold at once; any seat count squads don't cleanly divide into (including exactly `SQUAD_SIZE` itself — one squad covering the whole match would leave nobody able to fight) stays the original one-`teamId`-per-seat free-for-all.
- **The zone is a room graph shrinking toward an eye, not a geometric circle.** Rooms are the unit of "safe" — this avoids carving a circle through walls a player physically cannot reach, which a raw-radius zone would do on an indoor map.
- **AI is hazard *and* farm, hostile to every seat.** Reuses PvE's `ENEMY_BLUEPRINTS` (`09`) verbatim — no separate PvP roster.
- **Loot is arena-scoped, same drop *model* as PvE, zero connection to a player's account.** Landing kit is a small opener; the arena's own loot table is the real power curve (`05`).
- **One ~60-room hand-authored map at launch, produced by a dedicated map editor** — not a procedural layout. The editor is the authority on room layout, doors, monster placement, loot markers, and per-cell hazard traits; the engine only consumes the produced data. ✅ **Shipped (2026-08-25):** `arena_launch` — `engine/world/arenas/`, **The Seven Districts**. 60 rooms, 74 doors, 121x95, hand-authored: seven districts (terraces / kilns / cisterns / atrium / barracks / catacombs / foundry) joined only by a twelve-entry artery list, on a hand-drawn 9x8 slot grid with 12 slots left empty. Ten hand-designed interior kits, 25 distinct room footprints, 60 distinct interiors, 3 loot tables, hazards in two districts. Every room's perimeter is real stone and a door is the only hole in it, so **the door graph this doc's two structural rules describe is the graph a player actually moves on** — measured: 0 unenclosed rooms, 0 doors gating nothing, 0 undoored walk-throughs, and a player walking due east from the drop stops at the wall. `npm run audit:arena -w client` reports it; `?arena=arena_launch` walks it in one tab. **The client did not draw that door graph until 2026-08-26**: wall art is clipped away from a passage by `RoomBuilder`'s `bordersDoorNorth` rule, which was fed `GameState.dungeonDoors` and so saw nothing in an arena — 58 of the 74 passages had wall art over them and 36 were buried outright, which read as unbroken deliberate stone rather than as a bug. `RoomBuilder.build` now unions `arenaMap.doors` into that list, which both clips the runs above a passage and paints the worn floor patch across it; door FIXTURES stay dungeon-only, since a `Door` here has no `locked` and no leaf and an arena passage is meant to stay open. **Since 2026-08-26 that report is backed by a GATE** — `engine/content/arenaQuality.ts`'s `auditArenaQuality` turns the load-bearing numbers into 21 rules in two severities (`defect`, zero-tolerance, every one a failure `arena_prototype_60` really shipped; `design`, bands where both ends are a real failure), enforced over the whole catalog by `client/src/game/match/arenaCatalogQuality.test.ts` in the default `npm test`. The thresholds are argued from what makes a PvP arena unplayable or unauthored rather than transcribed from `arena_launch`'s own scores, and that is enforced: `arenaQuality.test.ts` asserts the MARGIN between each bound and the shipped map's number, so a bound quietly retuned onto current content fails there. Scoping is fail-safe — `MATCH_ARENA_IDS` is the catalog minus an explicit `DEV_FIXTURE_ARENA_IDS`, so a new map is gated by default and exempting one is a visible edit — and the exempt fixture is the gate's own control: `landing_basic` is asserted to FAIL it, so a pass on `arena_launch` means the rules can fire on real catalog content. `chokepoints` and `deadEnds` are deliberately NOT gated (this map ships 10 and 8 on purpose). The plan (`launchArenaPlan.ts`) is the thing to edit — the layout is authored there, and the wall-run arithmetic under it is the same derivation the editor's own door tool performs. `arena_prototype_60` — a generated 60-room lattice with `solids: []` everywhere (logical-only rooms and doors) whose pillars and loot markers were authored in the wrong coordinate space, putting 90 of 120 features off the map — was **retired and deleted 2026-08-26**, once its before-picture was in ROADMAP's comparison table and every defect it exhibited had a fixture in `arenaMetrics.test.ts`/`arenaGeometryMetrics.test.ts`; the real-content case those two files used it for now runs against `LAUNCH_ARENA` in `world/arenas/launchArena.test.ts`, which is strictly better (a map neither file authored, and the one a match builds). `landing_basic` remains the `?arenaDemo=1` fixture. **The same pass turned the client's arena floor coverage from an assumption into a measurement**: `groundLayer.floorRegionsPx` used to paint an arena's whole world box because `arena_prototype_60`'s rooms were not a partition of its walkable space, a premise that died with that map. It now derives the answer per map (`scene/floorPartition.ts` — one rasterize + one BFS at room-build time, 3ms), and `arena_launch` reports 0 reachable cells outside its rooms, so its floor stops at them: 322 stamp sprites covering 9,246,720 px of an 11,770,880 px box, with the twelve deliberately-empty slots and the outer margin no longer painted.
- **Anti-cheat is a periodic, cross-client consensus check** (below), not a single end-of-match verdict — but it only activates above a quorum, and only kicks on a *confirmed*, non-transient divergence.
- **Net transport moves to sparse, held-until-changed input deltas** (below), matching the sibling project `funny`'s model, chosen specifically so a future move to full state-sync is a payload-type swap, not a re-architecture.

## ArenaMap — the map editor's output contract

Structurally closer to `09`'s hand-authored `RoomPiece` library than to the seeded `generateFloor` dungeon assembly — nothing here is procedurally generated at runtime except which *pre-authored* candidate is picked (the eye room, the per-seat spawn assignment).

```
ArenaMap {
  id, sizeGrid                 // total map extent — the WHOLE map is one SIMULTANEOUSLY co-resident
                                //   live world. (This comment used to contrast that with "a PvE
                                //   floor's 5-10 rooms, visited SEQUENTIALLY, one live at a time";
                                //   false since ENGINE_VERSION 34 / 2026-08-04 — a PvE floor is
                                //   co-resident too, which is exactly why it reuses THIS file's
                                //   Door type verbatim and feeds the same Minimap widget.
                                //   Corrected 2026-09-03; 09 carried the same stale line.)
                                //   The real difference from a PvE floor is scale (~60 rooms vs
                                //   5-7) and that nothing here is generated at runtime.
  rooms: ArenaRoom[]           // ~60 at launch
  doors: Door[]                // EXPLICIT adjacency — never inferred from rect adjacency (below)
  spawns: Point[]              // >= seat count; system-assigned per match, no player choice
  eyeCandidates: EyeCandidate[]  // candidate final-circle rooms; one drawn per match (below)
}

ArenaRoom {
  id
  rectGrid: { x, y, w, h }     // this room's bounds within the map — used for both the
                                //   room-membership test (below) and the BFS adjacency graph
  solids: AabbGrid[]            // same vocabulary as 09's RoomPiece.solids
  pillars?: PillarGrid[]        // same as RoomPiece.pillars
  cellTraits?: CellTrait[]      // editor-placed hazard tiles (spikes, freeze, ...) — below
  encounter?: WaveScript        // reuses 09's WaveScript/WaveEntry verbatim — same format the
                                //   PvE dungeon uses, editor-authored per room (not procedural)
  lootMarkers?: LootMarker[]    // { point, tableId } — arena-scoped DropTable (09), not PvE's
  props?: PropPlacement[]       // render-only, same as RoomPiece
}

Door {
  roomA: RoomId; roomB: RoomId
  passageGrid: AabbGrid         // the walkable opening between the two rooms
}

EyeCandidate { roomId: RoomId; weight?: number }   // weight=0 (or omitted default 1) never final
```

Two structural rules, both load-bearing:

- **Adjacency is `doors`, always explicit — never inferred from `rectGrid` proximity.** Two rooms sharing an edge with a solid wall between them are *not* adjacent; inferring adjacency from geometry would silently create a false connection there. The BFS shrink model below (§ zone) is only correct if the adjacency graph is exactly what the editor actually placed doors for.
- **Room membership is a point-in-rect test against `rooms[].rectGrid`**, not a derived quantity. An actor's current room is cached (`actor.roomId`) and re-checked only when it crosses a room's rect boundary — the movement system already knows when that happens, so this is O(1) amortized, not an O(60) scan every tick.

### `CellTrait` — authored hazard tiles (spikes, freeze, etc.)

```
CellTrait {
  id
  rectGrid: AabbGrid           // the tile/area this trait covers
  kind: 'spike' | 'freeze' | …
  timed: bool                  // false = always-on; true = phased (below)
  // always-on (timed: false):
  //   effect applies every tick an actor overlaps rectGrid — same shape as zone damage (below)
  // phased (timed: true):
  phase?: { armTicks, activeTicks, offsetTicks? }   // its own cycle, e.g. spikes retract/extend
}
```

- **Always-on** traits are the simple case: a per-tick AABB-overlap check, structurally identical to the zone's per-room check (below) — both are "is this actor's position inside a triggering region right now," which is exactly why they share one system (`EnvironmentSystem`, below) instead of two.
- **Phased** traits need their own tick-indexed phase state per trait instance, held in `GameState` (so it replicates/replays deterministically) — a small state machine per trap (`armed → active → armed → …`), same shape as the zone's own warn/hold phase machine (below), just running on its own cycle instead of the zone's global stage clock.

## The zone: room-graph shrink

### Eye selection and the safe-set rule

```
1. Match start: draw one eyeCandidate by weight via ringPrng  → eye: RoomId
2. BFS over the doors graph from eye, using rooms[]/doors[] in their AUTHORED array
   order (never a Set/Map — 06's "no hash/insertion-order leak into state" rule
   applies here exactly as it does everywhere else) → dist[room] for every room
3. Stage k's safe set = { room : dist[room] <= R_k },  R_k monotonically decreasing
```

**Why this rule and not "randomly pick rooms to poison":** `dist <= d` is, by construction, always a connected region (every room in it has a path to `eye` staying inside it, since distance is monotonic along that path) and strictly shrinks as `R_k` decreases (nested, never relocates). A random per-stage pick can sever connectivity — a safe room can end up encircled by poison with no reachable path out, an unwinnable trap the room-graph rule structurally cannot produce.

### Stage machine: warn → close → hold

```
WARN(warnTicks)   the next stage's soon-to-close rooms are flagged `closing` (HUD/telegraph only,
                   no damage yet)
CLOSE             closing rooms → `poisoned`, damage starts
HOLD(holdTicks)   stable period — this is where fights happen
→ next stage
```

- **The eye pool itself, and the full future stage schedule, are never precomputed and stored.** Only the *current* stage's data and the *next* stage's `closing` set (needed for the WARN telegraph) exist in `GameState` at any time — later stages are derived from `ringPrng` lazily, at the tick the previous stage ends. This isn't primarily an anti-cheat measure (see § anti-cheat below for why full-map content doesn't hide this way) — it's just the natural shape for "the schedule literally doesn't exist yet," and it does still remove the *one* thing that's genuinely runtime-randomized (which eye was drawn, and how the schedule unfolds) from being knowable ahead of the reveal.
- Stage count, per-stage room-count targets, `warnTicks`/`holdTicks`, and the per-tick zone damage are content numbers in `@dd/engine` config (`09`'s "numbers live in one place"), tuned against the **PvP-scaled** HP range (below) — a first-pass table is 4.3 tuning work, not part of this doc's locked shape.
- **The last stage (1 safe room) has no further shrink — only escalating damage.** This gives the match a hard time bound without a separate timeout/draw branch in `WinConditionSystem`: pushing every survivor into one room with ever-increasing zone damage makes indefinite stalling structurally impossible, so there is no need for a tie-break-by-timer path.

### Sim state and events

```
state.zone = {
  eye: RoomId
  stage: number
  phase: 'warn' | 'hold'
  ticksToPhaseEnd: number
  safe: RoomId[]
  closing: RoomId[]        // only the NEXT stage's soon-to-close set — nothing further ahead
}
```

Events: `zone_warn { stage, closing }`, `zone_close { stage }`, `zone_damage { target, dmg }` — render/HUD/minimap read these; they never feed back into sim decisions (`06`'s render/logic split, unchanged).

## `EnvironmentSystem` — one step, two data sources

A new engine step (after `StatusEffectSystem`, same global-tick-cadence style as burn/poison — see `07`'s `DOT_INTERVAL` precedent) that, per actor per tick:

1. Is the actor's cached `roomId` in `state.zone.safe`? If not → apply zone damage via `takeDamage(state, actor, dmg, src, 'zone')` (reuses the existing shield-first-absorb / `ticksSinceHit`-reset / shield-break-trigger path `takeDamage` already provides — **standing in poison correctly blocks shield regen**, for free).
2. Is the actor's position inside any **always-on** `CellTrait` rect, or inside a **phased** trait currently in its `active` phase? → apply that trait's effect the same way.

Both checks are "position vs. a triggering region," which is why one system handles both — not two parallel damage-over-position systems. AI enemies go through the same check as players (§ AI below) — no special-casing needed for "does the zone kill monsters too," it just does.

`zone`/trap damage has **no attacker identity** (same shape as `StatusEffectSystem`'s DoT — `07`'s existing "`src` is derived from the opposite faction" precedent doesn't apply here since there IS no faction on the other side; `takeDamage`'s `src` parameter for environmental damage is a new literal, e.g. `'environment'`, not a team).

## Team / hostility model ✅ (shipped, `ENGINE_VERSION` 18 — this section is kept in its original future tense below, see the note)

**Status, added 2026-09-03: all three bullets below are built.** This section was written before the work and still read as a requirements list — *"today player-vs-player damage does not exist"*, *"which today they structurally are not"* — which is two `ENGINE_VERSION`s of arena work out of date and reads as an open item at a glance. What actually shipped: `isHostile` lives in `state/entities.ts` and the shared `hostileTargets`/`nearestHostile` walkers in `systems/targeting.ts`; `combat.ts`, `HitResolveSystem`, `ProjectileStepSystem`, `DeflectSystem`, `StatusEffectSystem`, `AIDecideSystem` and `WinConditionSystem` all route through them, and none of the faction ternaries survives. `DeflectSystem` flips a parried bullet's `teamId` alongside its faction, so parry-stealing a rival's shot works. `07`'s own locked-decisions list was updated in the same pass — it had described faction as the gate ever since. The requirements text is left as written, because *why* each piece was needed is still the clearest account of it:

PvE's two-member `Faction = 'player' | 'enemy'` union (`entities.ts:18`) and its ~14 `faction === 'player' ? enemies : players`-shaped ternaries are structurally a **2-faction assumption**, and player-vs-player damage did not exist at all (same-faction bullets passed through each other; melee only iterated the enemy array; `DeflectSystem` only deflected enemy-faction bullets). PvP therefore required:

- **`teamId: number` on `Actor` and `Projectile`**, separate from seat `owner` (`state/commands.ts`). ✅ **The squad extension shipped (`ENGINE_VERSION` 30) on this exact schema, no change needed to it**: `teamIdForOwner(owner, playerCount)` (`client/src/game/match/pvpConfig.ts`) assigns the same `teamId` to a contiguous chunk of `owner`s whenever squads apply, and `owner` alone (one seat, one team) otherwise — confirming the field's existence, not its value, was what actually "left the squad interface open."
- **A single `isHostile(a, b)` predicate** replacing the ~14 faction ternaries (`combat.ts`, `StatusEffectSystem.ts`, `HitResolveSystem.ts`, `ProjectileStepSystem.ts`, `DeflectSystem.ts`, `AIDecideSystem.ts`, `WinConditionSystem.ts`) — AI keeps a reserved `teamId` (e.g. `-1`) hostile to every player `teamId`; two players are hostile iff their `teamId`s differ. This is a `ENGINE_VERSION`-bumping change (it changes what a bullet can hit) and is a prerequisite for arena work, not a part of it — flagged as its own ROADMAP line, not folded into "`buildArenaSpecs`" the way the original ROADMAP draft implied.
- **Melee and deflect need to stop being enemy-array-only.** Once `isHostile` exists, the melee arc and `DeflectSystem` iterate all hostile actors' projectiles/bodies, not hardcoded `state.enemies` — this is what makes player-vs-player melee and parry-stealing-a-rival's-bullet actually possible, which before it they structurally were not.

## AI in the arena

- **Same `ENEMY_BLUEPRINTS` as PvE** (`09`) — no new content type.
- **Encounters are fully editor-authored per room** (`ArenaRoom.encounter: WaveScript`), not randomly rolled — the map editor places exactly which monsters go where, same format PvE already uses. There is no PRNG involved in *what* spawns, only in the zone eye and per-seat spawn assignment.
- **Activation is lazy for performance, not for information-hiding.** A room's `WaveScript` only starts dispatching (and `AIDecideSystem` only runs for its actors) once a player first enters that room — pure perf (no need to think for 60 rooms' worth of monsters simultaneously). Since the whole map ships bundled with the client (`09`'s open question leans this way; see § anti-cheat for why this matters), lazy activation does **not** hide monster placement from a client willing to read its own asset bundle — see below.
- **AI drops feed the arena's loot table, not the PvE material bank.** Killing arena AI drops weapons/buffs/heals exactly like a PvE floor; it never touches `state.bankedMaterials` — PvP simply never runs `ExtractionSystem` (`05`'s economy table already says "PvP: normalized out" for materials; this is that rule applying in both directions).

## PvP HP/weapon scaling

`buildArenaSpecs(presetId, skinId)` (`09`) scales **both halves of the fight together** — a character's `(maxHp, maxShield)` and the landing-kit/arena-loot weapons' damage/handling — so relative time-to-kill matches PvE's feel at a bigger absolute number range (PvE's 3–10ish HP pool leaves no room for a shrinking-zone DoT curve to matter; see `05`). This is a **second tuning pass over the same `SkinDef`/`WeaponSpec` content** — a second COLUMN on each character (and a scaled copy of each weapon), never a second roster, and never a change to the PvE numbers themselves. ✅ **Shipped and actually wired**, not just built in isolation: `GameState.buildSeat` (`ENGINE_VERSION` 19→20) branches on `config.arena` to call `buildArenaSpecs`, so a real PvP seat's weapons/`maxHp`/`maxShield` come from the scaled kit — `seat.loadout` (persistent PvE gear) is structurally never read for it. **The two halves are scaled differently, and that is the 2026-09-21 correction (`ENGINE_VERSION` 67).** Weapon damage is still `Math.round(damage × PVP_SCALE_FACTOR)`, currently `5`. The POOLS are no longer derived from it at all — each character authors its arena pair directly (`SkinDef.pvp`): vanguard 30/**16**, skirmisher 15/**30**, juggernaut 55/0, i.e. exactly the numbers the retune below measured. *(The pools were `Math.round(pool × 5)` until then, and that derivation is the whole reason `vanguard.maxShield` was authored as **3.2** — the only fractional design number in the tree, existing solely so `× 5` landed on 16, and printed at the player on the character screen. `07` has the full account, including why the fraction was inert in PvE. This paragraph also read "vanguard 6/4→30/20, skirmisher 3/8→15/40" until 2026-09-03 — the pre-retune inputs, from before the very rebalance the next paragraph describes.)* What the factor buys is unchanged: pools and weapon damage move TOGETHER, which is what preserves relative TTK; two authored integer columns satisfy that exactly as well as one multiplication did, and either scale can now be re-tuned without dragging the other with it. Still first-pass, per real-play tuning below. **`maxEnergy` is the one character stat that deliberately has NO arena number at all** (`ENGINE_VERSION` 60) — an arena seat carries the raw `SkinDef` pool. `(maxHp, maxShield)` get one *because* weapon damage is scaled alongside them, and that pairing is what preserves relative TTK. `energyCost` is not scaled at all, so giving the pool an arena number too would not preserve any ratio: it would hand every arena seat five times the shots at the same price and delete the ammo economy from PvP outright. `GameState.test.ts` asserts the arena pool against the raw `SkinDef` number rather than against "not the arena one", so the claim survives a retune of either scale. **What this is currently worth is unmeasured, and that is worth stating plainly**: across 8 sampled arena matches no seat's bar ever dropped more than one blaster shot below full, because `landing_basic` is sustainable on regen alone and the bot does not swap to looted frames — so the identical win rates either side of the v60 change are an unmeasured result, not a verified one (the same shape as the melee-share gap `ENGINE_VERSION` 59 named). What bounds the risk meanwhile is arithmetic rather than the bot: capacity buys burst and provably not sustain (`03`/`14`).

**The landing kit is a PAIR — one gun + one melee weapon** (`landing_basic` = blaster + saber, both scaled; `ENGINE_VERSION` 45): a one-weapon kit left an arena seat with no second carried slot, which silently removed the swap control from PvP entirely (the HUD's idle-slot chip hides itself below two weapons) and put a parry behind a map drop. Both halves of `03`'s ranged/melee trade-off are now in a player's hands from the drop — which does move bullet-vs-body balance, so it is part of what the real-play tuning below has to settle. "Small kit" means modest NUMBERS, not a missing weapon kind; the invariant is gated by a sweep over `ARENA_PRESET_IDS` (`engine/balance/build.test.ts`), so a second preset is covered the day it is authored.

**A repeatable data source for tuning this now exists (2026-07-28):** `client/sim/pvpBalanceSim.sim.ts` (`npm run test:pvp-sim`, ~6s/180 matches, deliberately kept out of the default test glob) drives `createGameEngine` + a headless `PvpBotController` through the exact same `buildPvpEngineConfig` a real match uses, sweeping seat counts 2/3/4/5/6/8 × 30 seeds each and asserting every match converges (a real regression check on the zone's no-stalemate bound). The first run surfaced a real, sizeable win-rate skew (vanguard 60/juggernaut 30/skirmisher 90 out of 180), caveated in the harness itself (seats are skinned by index, not by seed, so a seat/spawn confound isn't fully ruled out) — treated as a signal, not a tuning verdict. **The skirmisher/juggernaut numbers in `content/skins.ts` were subsequently rebalanced off this signal** (skirmisher nerfed, juggernaut buffed — commit `61ccfd8`, 2026-07-28); `PVP_SCALE_FACTOR` and the zone damage curve itself remain untouched, still first-pass. Exact factor and the zone damage curve stay content-tuning (ROADMAP 4.3), not part of this doc's locked shape.

## Placement, elimination, win condition

- `WinConditionSystem`'s `Winner = number | 'enemies' | null` (`entities.ts:21`) needs a **placement vocabulary**, not a single winner id: as each SQUAD is eliminated (zone/AI/player damage takes down every one of its members, with no reviver left holding a bandage to catch them — see `05`), record its finish order in one batch (`tickPlacement`, `ENGINE_VERSION` 30 — a solo/FFA match is just every squad being a singleton, byte-identical to the pre-squad per-seat behavior). The last surviving squad is 1st; `state.winner`/the `'win'` event still name one representative seat from it. Squad-mates eliminated together still land at adjacent, not tied, individual `placements` entries (the engine-side representation is unchanged, on purpose — every other consumer only cares about seat-index order); **`ladderReport.ts` is now squad-aware on top of that raw data** — see the Ladder rating section's 2026-08-03 update below. **2026-08-04: one consumer wasn't actually squad-aware.** `client/src/game/controllers/RunOutcome.ts` (the result-screen chooser) compared `s.winner === localOwner` by exact seat equality, not team membership — the opposite of what this section's own "squad-mates share the outcome regardless of which one is named" intent requires. In any squad win where the winning squad had more than one surviving member, every winner except the one seat literally named in `state.winner` saw a DEFEAT/"Placed N/N" screen. Found by a full client code review (no test had ever exercised a multi-seat squad win), fixed by comparing `teamId` instead of seat identity.
- **Same-tick double-elimination tiebreak: deterministic, not a coin flip.** If two seats hit zero on the identical tick, break the tie by ascending `teamId` (lower `teamId` places higher) — arbitrary but fixed and replay-stable, so no new PRNG draw is needed for something this rare.
- `MatchRoom.reportResult`'s `reason: 'extract' | 'wipe' | 'disconnect'` (`server/src/MatchRoom.ts`) needs a PvP branch (e.g. `'placement'`) carrying the finish-order array, since neither existing reason describes "ranked 1st through 8th."

## Ladder rating (`matchsvc`-side, ROADMAP 4.6) ✅ shipped

A simplified multiplayer Elo, deliberately kept **outside** `@dd/engine` — it never touches replay/replicated state, by construction, since ranking math has no business being part of the determinism contract. `server/src/rating.ts`'s `computeRatingDeltas` (actual = normalized placement, expected = logistic vs. field average) + a `RatingStore`; `matchsvc.ts` exposes `POST /rating/report` / `GET /rating/:accountId`. **2026-08-03: `RatingStore` persists to `db.ts`'s `ratings` SQLite table** (`matchsvc.ts` passes its own `openDb()` result to `new RatingStore(db)`) — a rating now survives a server restart the same as an account does; the constructor's `db` param is optional and every other caller/test still gets the original in-memory `Map` behavior. `MatchRoom` gained an optional `onSettled` callback (`{roomId, winner, placements, hashOk}`, fired right before `destroy()`), wired in `server/src/index.ts` to POST to matchsvc's endpoint — but **only** when `hashOk` (the checkpoint-verified anti-cheat gate below) and `placements` are both present, so a divergent or non-placement (e.g. co-op) match never touches the ladder. `accountId` is an explicitly-labeled scaffold (`seat:{roomId}:{seatIdx}`) since the project has no account/auth system yet; the placement→rank math itself is real and fully tested.

**Update (design/16-accounts.md, 2026-07-29): real accounts now exist, and ladder rating is bound to them when a seat is logged in.** A logged-in client's real `accountId` rides in the signed ticket (`TicketPayload.accountId`) from `POST /find` through to `MatchRoom`; `SettledMatch.seatAccounts` (seat → accountId, omitted seats fall back to the scaffold above) is threaded into `buildRatingReportBody`'s new optional 4th param. A guest/bot seat still gets the old `seat:{roomId}:{seatIdx}` scaffold — nothing about this requires logging in to play PvP.

**Update (2026-08-03): ladder rating is now squad-aware — the one item explicitly flagged above as "deliberately not done."** Two gaps closed together, since fixing one exposed the other: (1) `state.placements` never lists the winning squad's non-representative members (only `state.winner` names one seat, and `WinConditionSystem.tickPlacement` only ever pushes *losing* squads' seats) — a real seat count was needed to recover them, so `SettledMatch` gained a `playerCount` field (`MatchRoom.reportResult` already knew it) and `buildRatingReportBody` gained a required `playerCount` param; every seat sharing the winner's `teamId` (via the same `teamIdForOwner` formula the engine assigns teams with) is now filled in as tied for 1st. (2) `rating.ts`'s `computeRatingDeltas` gained an optional `teamIds` param (index-aligned with `ratings`/`places`): when present, a participant's ACTUAL score comes from their TEAM's rank among teams (derived from each team's best member place) — so tied squadmates share one actual score — and their EXPECTED score compares their team's AVERAGE rating (not their own) against the field average, so every squad member gets the identical delta, as if the squad were one combined participant. Omitting `teamIds` (or a squad size of 1, i.e. every pre-squad/solo-FFA match) degenerates every formula back to the original per-seat math exactly — proven in `rating.test.ts` by asserting byte-identical output with/without the param. `ladderReport.ts`'s `RatingReportBody` also carries a new `teamIds` array end-to-end (`matchsvc.ts`'s `/rating/report` now accepts an optional `teamIds` alongside `accountIds`/`places`). 14 new tests: `rating.test.ts`/`ladderReport.test.ts`/`MatchRoom.test.ts`, plus 5 real-HTTP-wire tests added to `matchsvc.http.test.ts` covering `/rating/report`'s validation branches (including the new `teamIds`-length check) and `/rating/:accountId` — this endpoint had zero test coverage anywhere before this pass, a pre-existing gap this change happened to touch.

### Who a rating belongs to (locked 2026-09-17)

**A ladder rating is keyed only by an identity the server verified. A guest is not scored,
and the results screen says so.** This closes `design/16-accounts.md`'s hole 3 — and it
closes it by the option that doc's own text argued against ("*telling* the player their
rating is thrown away is not the fix"), so the reversal is recorded here rather than quietly
applied.

**What was actually there.** Hole 3 described a guest being re-keyed every match by
`ladderReport.ts`'s `seat:{roomId}:{seatIdx}` scaffold, with the fix being to carry the
guest's persistent id into the ticket instead. Tracing the wire showed the carry already
happened: `findMatch` sent `accountId: getPlayerId()` in the `/find` body, `postFind` took it
whenever no session outranked it, and it rode the signed ticket through `MatchRoom` into the
report. A guest's rating did accumulate. What *did not* exist was the outranking — the client
sent **no `Authorization` header on `/find` at all**, so `deps.auth.verifySession` never ran
in production and the scored identity was the caller's own unverified claim on *every*
request, for logged-in players too. Posting `{ playerCount, accountId: "<a stranger's id>" }`
and losing was enough to move that stranger's rating.

**Why the key cannot simply be verified instead.** A guest id is client-declared by
construction — it is a UUID in that browser's `localStorage` and there is nothing to check it
against. Making it unforgeable *is* making it an account. So the choice was between a rating
keyed by a claim and no rating; and the three reasons it went the second way:

1. **What authentication buys here is non-impersonation, not scarcity.** `register` is an
   unverified username/password, so an account key is barely scarcer than a guest UUID. But
   non-impersonation is exactly the property a rank needs, and exactly the one a declared key
   cannot have.
2. **A guest rating could never be carried into an account afterwards.** Importing a
   forgeable key's value into an unforgeable one re-imports the forgery, so the number would
   be permanently orphaned — unable to join the account system it is waiting for. (The
   one-time guest merge that hole 1 shipped moves `MetaState`, and deliberately not this.)
3. **Rating is the one piece of state in this project that is not local-first.** design/16's
   "a guest is a first-class player" rests on `MetaState` being local and an account only
   ever mirroring it; `rating.ts` is account-level bookkeeping that never enters engine
   state. So the ladder does not make login a *gate* — a guest still queues, plays, wins and
   sees the result — it makes the ladder the first thing an account is actually **for**.

**What shipped.** `findMatch` sends the stored session's bearer token; `postFind` reads the
account id and display name from the session it verifies and no longer parses the body's
`accountId` at all; a guest seat carries neither, and the per-match scaffold keys it, which
is now correct by design rather than by accident. Deleting the body fallback also fixed
design/20's seat names by the same line — `session?.username` had been `undefined` in
production for the same reason, so the verified roster names had never once been shown.

**And the honest line.** `RunOutcome`'s two arena screens end with one translated row,
`results.guestNotRanked`, gated twice: `canSignIn()` (added to `platform/hostKind.ts`) so it
never appears on WeChat, where no session can persist, or on the portal, which signs the
player in itself and forbids the ask; and `getSession()` so a signed-in player is not told
their rank is being discarded when it is not. It names **no number**, because nothing in this
client has ever displayed a rating — there is still no caller of `GET /rating/:accountId`
anywhere — and a line promising to "keep your rating" would point at a thing the player has
never been shown. Showing the rating itself is its own ROADMAP item; this row only has to
stop the loss from being invisible.

## Anti-cheat: periodic checkpoints, not just an end-of-match verdict

Extends `06`'s existing `runHeadless` backstop (today: one re-simulation, done after the match, from `seed + recorded input`) into something that can act **during** a match, using machinery the engine mostly already has.

### What actually gets compared

**No new "seed" concept needs to go on the wire.** `GameState` already contains every PRNG stream (`aiPrng`/`combatPrng`/`dropPrng`/`roomgenPrng`, plus a new `ringPrng`/`integrityPrng` below) as ordinary state, and `replay.ts` already computes a full deterministic state hash from it. "Compare everyone's seed" is exactly "compare everyone's `stateHash` at the same confirmed tick" — reuse the existing `ClientMsg.result: { stateHash, winner }` shape (`protocol.ts`), generalized from "send once at gameover" to "send every `checkpointTicks`" (a new `ClientMsg` variant, e.g. `{ type: 'checkpoint', tick, stateHash }`). Cadence is **tick-indexed, not wall-clock-timed** — driven by `state.tick % checkpointTicks === 0` so every honest client emits at the identical logical instant, rather than trusting each client's own clock to schedule the check.

### Consensus mechanism: cross-client majority (v1), server-shadow-sim (later)

Two ways to decide "whose hash is wrong," different cost/robustness trade-off:

| | Mechanism | Server cost | Robust when |
|---|---|---|---|
| **v1 (chosen)** | Server just collects each seat's periodic `stateHash` report and flags whichever value disagrees with the majority | **None** — the server today only relays frames (`FrameBroadcast`, `06`); this needs no new server-side simulation capability | Enough honest seats to form a real majority — solid at 8-player FFA |
| **Later escalation** | Server runs its own authoritative shadow copy of `@dd/engine`, driven by the same confirmed frame log it already produces, and treats its own hash as ground truth | Server must actually execute the sim per live match — a real new capability, though a natural extension of the already-headless `runHeadless` from "offline, post-match" to "incremental, live" | Any seat count, including matches too small for a majority to mean anything |

v1 is the right fit for launch: it needs zero new server-side simulation work, and 8-player solo BR is exactly the shape where "majority of 8" is a meaningful signal. The escalation path is explicitly the *same* future move already flagged in `06`'s anti-cheat posture (server-authoritative + fog-of-war) — when that day comes, both the ESP problem and the small-lobby consensus problem get solved by the same investment.

### Quorum and the kick rule

- **Below a quorum of >3 real seats in the match, run no consensus check at all.** Early low-population matches padded with bots are expected to be internally inconsistent in edge cases (each participant may locally see themselves as the winner) — accepted, not worth guarding against; "not enough honest signal to trust a majority of 8" and "not enough population yet to justify guarding it" are the same underlying reason.
- **Only kick on a *confirmed*, non-transient divergence — never on a single disagreeing report.** A client that is merely behind (catching up under the existing lag/backlog multiplier, `06`) can legitimately report a stale hash for a tick it hasn't caught up to yet; that is not a divergence, it just hasn't reached that tick's true state. The rule that avoids punishing this: compare hashes **for the same historical, already-confirmed tick number** (never "whatever tick each client currently claims to be at"), and require the disagreement to **persist across at least two consecutive checkpoints** for that seat before severing it. A transient one-off mismatch is far more likely to be a benign race in when the report was captured relative to a catch-up burst than an actual state fork; a repeat at the next checkpoint, at the same historical tick, is not.
- **Kicked seats reconnect through the existing path** (`ClientMsg.resume` / `ServerMsg.conn_resync`, `06`) — no new reconnect plumbing needed, only the new trigger that decides to sever in the first place.

### Settlement: a per-seat vote, bounds, and a record ✅ shipped 2026-09-26

The end-of-match half of the same idea, decided by the owner on 2026-09-26 (see Open questions) and built the same day. It hardens what the server does with the seats' `result` messages; nothing here replays anything.

- **The seed is a CSPRNG draw.** `matchsvc.ts` draws each room's seed with `crypto.randomInt(SEED_SPACE)` over the 31-bit range tickets and replay files already carry. It was a counter that started at `Date.now()` and stepped by one per room, so a player who saw one seed could predict the next room's, and with it the drops, spawns and zone.
- **Production needs the ticket secret.** `config.ts`'s `ticketSecret()` throws under `NODE_ENV=production` when `BB_TICKET_SECRET` is unset, and both `createGameserver` and `createMatchsvcServer` call it at build time, so the process refuses to start. It used to warn and fall back to the dev secret published in the same file, which also re-opened the raw-param handshake where a client names its own seat and seed.
- **One vote per seat over the whole tuple** (`server/src/settlement.ts`, `voteSettlement`). Each seat's `{stateHash, winner, placements}` is one vote; squads do not pool, and a bot seat votes like any other. Above `CHECKPOINT_QUORUM` seats, a tuple with a strict majority that is also at least the quorum settles the match, and every seat outside it is a dissenter. At or below the quorum, only unanimity settles. This replaced first-reporter-wins: `reportResult` used to check that every hash matched, then copy `winner`/`placements` from whichever seat reported first, so a seat with the right hash and a forged placement array decided the ladder by being quick, and one divergent hash voided the result for all eight.
- **Bounds before rating** (`checkPvpBounds`). The winner must be a real seat and the lowest seat of its squad (the one `WinConditionSystem` names). The placements must be exactly the seats outside the winning squad, each once. The server's broadcast frame at settlement must be at least `MIN_PVP_SETTLE_FRAME` = 450 (15 s): the 2026-09-26 sweep of 180 bot matches over 2–8 seats never ended before frame 954. A failure settles nothing.
- **Checkpoint kicks reach settlement.** `MatchRoom` keeps every seat `reportCheckpoint` ever kicked, including one that reconnected and then voted with the majority, and puts them in the record.
- **The record.** `SettledMatch.integrity` carries the verdict (`clean`, `dissent`, `no_consensus`, `bounds`), the dissenters, the kicked seats, the settle frame, the seed, and — unless the verdict is clean — the input log. `hashOk` now means "a tuple carried the vote and passed bounds". `dissent` still rates; `no_consensus` and `bounds` rate nothing. The gameserver POSTs every non-clean PvP match to matchsvc's internal-key-gated `POST /integrity/report` (`integrityReport.ts` builds it, gzipping the log and dropping it past 4 MB). `IntegrityStore` claims the room id and bumps each suspect account's `suspicion` count in one transaction, so a retried report counts once. A guest or bot suspect is recorded and counts against no one. The ops console's Integrity tab (`21` §3.2) shows both lists.
- **Record, never auto-ban.** Nothing reads a suspicion count but a person. The archived logs, seed and `engineVersion` are there for a replay judge that does not exist yet.

What it does not close: a seat that never sends `result` still holds the room open, since settlement waits for every seat, exactly as before. And a coordinated majority still wins the vote: that is the limit of any consensus check without a server-side simulation, and is the shadow-sim's job in Open questions.

### `integrityPrng` — a dedicated stream for "make divergence show up fast"

The instinct to draw from the PRNG in as many code paths as possible (even ones whose outcome doesn't matter — an "empty" roll on every projectile spawn, every damage instance, every actor refresh) is sound: it raises how much the state hash's PRNG contribution moves per tick, so a client that's actually diverged (skipping/altering logic a cheat would touch) shows up within a shorter window instead of possibly staying silently consistent for a long stretch. **Give these padding draws their own stream, `integrityPrng`, seeded from the match seed like the others but never read by any gameplay system.** Do **not** route them through `combatPrng`/`dropPrng`/`aiPrng` — those numbers *do* determine gameplay outcomes (spread jitter, loot rolls, AI decisions), and mixing padding draws into them would shift the sequence of real draws whenever an unrelated system's padding call count changes, making balance changes and gameplay-affecting bugs harder to reason about for no actual anti-cheat benefit (the padding-vs-hash-sensitivity goal only needs *some* stream to move fast, not specifically the gameplay ones). Same array-order rule as everywhere else (`06`) — padding draws still must not iterate a `Set`/`Map`.

### The honest limit: this catches tampering, not information cheats

Worth restating precisely, because it's easy to oversell: this entire mechanism — v1 or the server-shadow escalation, any `integrityPrng` density — can only ever catch a client whose **simulated state** diverges from the honest one (a patched client that fabricates HP, skips damage, teleports, etc.). It **cannot** catch a client that never diverges state at all and just **reads more than it should** (wallhack/ESP, aim assist) — that class of cheat submits perfectly legitimate inputs from a better-informed human, so every hash matches, always. Two things follow directly from the map being **hand-authored and shipped bundled in the client** (`09`'s leaning; unchanged here):

- **Lazy activation/lazy-eye-reveal is not an information-hiding measure** for anything the editor placed statically (room layout, doors, monster placement, loot markers, hazard traits) — a client willing to read its own shipped asset bundle already has all of that before the match even starts, regardless of when the *engine* activates it. The only things a client genuinely cannot know ahead of the runtime reveal are the parts that are **actually randomized at match time**: which `eyeCandidate` got drawn, and which seat landed at which spawn.
- **The map-design lever (cover density, sightline breaks — the editor's job, not code's) is the only thing that meaningfully narrows the read-only-information-cheat gap**, and even that only reduces its *value*, not its existence. The structural fix — server-authoritative state + fog-of-war culling — stays exactly where `06` already placed it: an explicit future escalation, not a launch commitment.

## Net: sparse input deltas (extends `06`)

A parallel change to the transport, chosen so a future move to full state-sync only swaps *what* is sparse, not *how* sparse updates are consumed:

- **A `PlayerCommand`'s meaningful fields (`moveBrad`/`moveMag`/`buttons`) are transmitted only on change, not resent every tick.** (There is no `aimBrad` anymore — design/10 v33 removed manual aim; facing is engine-decided.) The receiving side (engine input source) holds the **last received command per owner** and reuses it for every tick until a new one supersedes it — this is the same "held input" model the sibling project `funny` uses, and it is how a twin-stick game should behave anyway (a player holding a direction steady has nothing new to say).
- **"Changed" for aim reuses the existing brad quantization**, not a raw-float delta threshold: aim is already quantized to an integer brad for determinism (`06`); an update is worth sending only when the *quantized* value changes, which naturally coalesces sub-quantization stick jitter into "no change" — one existing mechanism doing double duty (determinism *and* now compression), not a second threshold invented on top.
- **Buttons are already edge-shaped** (`FIRE`/`SWAP_WEAPON`/`INTERACT` bit flips) — a press/release is inherently a change; nothing new needed there.
- **This is a wire-format change only — the engine still receives a command for every simulated tick internally** (gaps are filled by holding the last one), so nothing about `@dd/engine`'s determinism or `ENGINE_VERSION` moves. It lives entirely in `net/protocol.ts` / `FrameBroadcast` / `NetInputSource` and their client counterparts.
- **Why this specifically sets up a future state-sync swap for free:** the client-side reconciliation layer this needs (extrapolate/hold between sparse updates, correct — snap or lerp — when a new one arrives) is **exactly** what `LocalPredictor` (`06`, ROADMAP 3.3-follow-up) already does for the local player's movement/aim. The day the project can afford a server that runs real simulation authority (the same escalation named in both the anti-cheat section above and `06`'s original anti-cheat posture), the payload that arrives sparsely changes from "an input that gets applied" to "an authoritative position/state delta" — but the "hold, then reconcile on arrival" consumption pattern on the client is unchanged. Building the sparse/held-update discipline now, even for the cheaper input-relay model, means that switch is a payload-type change, not a rewrite of the client's update-consumption logic.

## Relationship to the other docs

- **`05`:** the PvP section there is the summary; this doc is its full schema and the ROADMAP 4.1 answer.
- **`09`:** `ArenaMap`/`ARENA_PRESETS`/`buildArenaSpecs` slot into the existing `world/arenas/*.ts` config layout; `CellTrait`/zone state are new `GameState` fields alongside the existing `RoomPiece`/dungeon shape.
- **`06`:** the anti-cheat and sparse-sync sections here are additive extensions of its netcode model and anti-cheat posture — no change to the frame-broadcast-lockstep decision itself, and no `ENGINE_VERSION` implication (both are `net/`-layer, outside `@dd/engine`'s deterministic core, except the `teamId`/`isHostile` refactor which is explicitly called out above as its own version bump).
- **`14`:** the PvP fairness wall (weapons structurally walled, characters the one exception) is unchanged by any of the above.

## To design

- Exact zone stage count / per-stage room-count targets / `warnTicks`/`holdTicks` / zone damage curve, tuned against the PvP HP scale factor (real play required).
- ~~The PvP HP/weapon scale factor's actual value.~~ **First-pass value shipped:** `PVP_SCALE_FACTOR = 5`. The character-side skew it surfaced (skirmisher/juggernaut win rates) was already rebalanced off the `pvpBalanceSim` harness above (commit `61ccfd8`); the scale factor itself and the zone damage curve remain real-play-tuning work.
- The arena's own `DropTable`/loot-marker weighting (analogous to PvE's `DropTable`, `09`, but a separate arena-scoped table).
- ~~Squad revive numbers~~ **Shipped, `ENGINE_VERSION` 30:** bandage cost is a flat 1 per completed revive (spent on completion, never on interruption), channel time is the same `REVIVE_CHANNEL_TICKS` PvE uses, and downed is confirmed **not** invulnerable in PvP (the "leaning no" above is now the shipped rule). The bandage drop table weight (5/100 on the arena table) is the one number still first-pass, same as every other arena drop weight.
- `checkpointTicks` cadence and the exact "confirmed divergence" persistence window (">=2 consecutive checkpoints" above is a first-pass proposal, not tuned).
- Map-editor file format / round-trip tooling for `ArenaMap` (mirrors `09`'s open "TS modules or JSON" question for `RoomPiece`).

## Open questions

- Server-shadow-sim escalation and server-authoritative state-sync (this doc's anti-cheat and net sections) are both explicitly deferred until population/revenue justify the server cost — tracked here so it isn't a surprise later, not because it's undecided in principle (`06` already named the same escalation for a different reason).
  - **DECIDED 2026-09-26, by the owner: before any replay, harden the seed-and-consensus layer the way the sibling project `funny` verifies a match — and do no server replay yet.** **Shipped the same day**; see "Settlement: a per-seat vote, bounds, and a record" above for what was built. The list below is the decision as recorded, before the build. That rules out both replay forms for now: the shadow-sim above, and `funny`'s peer judge (a third client re-running the recorded frames), which is a replay run elsewhere. What it does mean, against what the code does today:
    - **The seed is unpredictable.** matchsvc's seed is `Date.now() & 0x7fffffff` plus one per match (`server/src/matchsvc.ts`) — signed into the ticket, but guessable. It becomes a `crypto.randomInt` draw.
    - **Only a signed ticket admits a seat in production.** The legacy query-string handshake (`?roomId&owner&seed&count`, taken when `BB_TICKET_SECRET` is unset) stays dev-only, and a production gameserver without the secret refuses to start.
    - **Settlement compares the whole report, per seat.** `MatchRoom.reportResult` today requires every end hash to match (one divergent seat voids the ladder for all eight) and copies `winner`/`placements` from whichever seat reported first. It becomes a vote over the full `{stateHash, winner, placements}` tuple, **one vote per seat, squads included**: above `CHECKPOINT_QUORUM` seats the majority settles provided it reaches the quorum, and the dissenters are flagged; at or below it, unanimity as now.
    - **Bounds checks before rating.** `placements` is a permutation of every seat but the winner, the winner is in range, and match length is plausible; a failure settles nothing and is recorded.
    - **Checkpoint kicks reach settlement.** A seat `reportCheckpoint` kicked for divergence counts as suspect in the settled record, where today it only reconnects.
    - **Record, never auto-ban.** A divergent match is stored with a per-account suspicion count and surfaced in the ops console; the input log is archived so a later replay has something to judge, but nothing judges it yet.
- Whether `eyeCandidates` ships as a handful of authored options (current assumption) or eventually itself becomes a larger pool for map variety at scale — not blocking with one launch map.
