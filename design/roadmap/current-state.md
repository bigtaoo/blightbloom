# Current built state

The running “what is actually built right now” note, moved out of [../ROADMAP.md](../ROADMAP.md)
so the index stays readable. Kept verbatim; it is prose, not a spec.

> **This file is not the authority on `ENGINE_VERSION`.** `engine/versionHistory.ts` is, and
> `ENGINE_VERSION_HISTORY.md` is the per-version account. The number in the paragraph below has
> drifted before. When the two disagree, the code wins.
>
> **It is drifting right now: the prose below stops at 51, and the shipped version is 60.**
> Not corrected in place, deliberately, and the reason has held up over three separate passes
> since — the missing bumps belong to different pieces of work (52/53 the melee attack and its
> hit window; 54 the heal-at-full-HP rule; 55/56 mob standing volume and approach slots; 57/58
> the per-floor loot allowance and the checkpoint floor cards; 59 weapon energy and the roster's
> first melee mobs; 60 the energy card and energy capacity as a character stat), and rewriting another pass's paragraph from outside it is how this file got
> long in the first place. Each has a full account in `ENGINE_VERSION_HISTORY.md` and a work-log
> entry; read those, not this heading. The number above is the only thing kept current here.

**Current built state (engine notes below written 2026-08-20; content/render passes have landed since — 2026-08-25 the hand-authored PvP launch arena `arena_launch` plus the arena audit, 2026-08-26 the arena floor stopping at its rooms and the retirement of `arena_prototype_60`, 2026-08-30 an open door reading as a passage instead of a black wall (2026-08-30b: still not enough on its own, so the recess now shows the room's own floor and the open state got an illustrated warm-gold light-curtain asset of its own — `door_curtain_raw.png` — to match the locked hazard leaf's visual weight), 2026-08-30 a wall standing over a dropped item now fades permanently instead of only while the player happens to be near it, 2026-09-03 every door standing at one height whatever wall it is cut into, and later the same day the doors getting a CLOCK at all — until then nothing in the project could animate a scene fixture, so every door was a still image and `Portal.interpolate` had been drawing one frozen frame since 2026-08-12 with no caller anywhere in the repo; `RoomBuilder.tickFixtures` drives both now, and "can I walk through this" is answered by which way the motion travels rather than by colour alone ([the doors get a clock](18-2026-09-03-door-fx.md)) — none of which touches the tick order or bumps a version). **Seven engine bumps have landed since: 2026-08-30's `ENGINE_VERSION` 47**, a north-face brim on free-standing wall blocks so a character stops beside one the way they already stop beside a pillar — see [The wall swallowed the character and the pillar did not](11-2026-08-28--08-31.md#the-wall-swallowed-the-character-and-the-pillar-did-not-2026-08-30-engine-engine_version-47) — **and the same day's `ENGINE_VERSION` 48**, live feedback on 47 itself (circled screenshot: half the character still read as sunk into a free-standing block, wanted down to about a quarter; a monster's own tiny wall clearance let it stand visibly closer than any player could; a dropped kill's loot could land inside the band no actor's collision would ever let them reach): the brim widened from 16 to 23 px (the largest value the shipped arena's tightest corridor tolerates before a route seals — see "what the north brim costs the launch map" in `launchArena.test.ts`), every enemy blueprint now stops at its own body radius against a wall or pillar instead of the smaller feet circle (re-verified against the PvE bot sim — every balance gate still passes, no softlock), and `geom.clampToWalkable` (where a death drop and an arena crate land) was made brim-aware to match. See `ENGINE_VERSION_HISTORY.md`'s v48 entry for the full account, including the one thing it does NOT fix (a room-boundary/kerb wall's own worst-case coverage, untouched by a constant that only ever governs a free-standing block's north face). **And the same day's `ENGINE_VERSION` 49**, which came out of a test pass rather than a report — `design/18-test-strategy.md`, written to answer "what stops a change to a wall's blocking range or a bullet's spawn point from silently desyncing the logic". Building its gates found five things, all fixed in 49: the v47/v48 brim was **inert over the whole PvE campaign** (the shipped ember JSON pieces carried no `freeStanding` at all, so two versions of tuning applied only to the launch arena — 34 interior blocks are now flagged, route-safety measured per floor); a pair shove could park an actor 6 px inside a wall for 103 consecutive ticks, because wall resolution ran before `resolveActorPairs` and the "corrected next tick" belief was false for two bodies pinned against stone; `clampToWalkable`'s world clamp undid its own push-out at the map edge; and `DeathDropsSystem`/`DoorSystem` each clamped by `footprintRadius` under a comment asserting the opposite, a premise that had been stale since v43/v48. **And 2026-08-31's `ENGINE_VERSION` 50**, the third round of the unpickable-loot report (*“依然有掉落的物品无法拾取”*), which arrived with the reporter's own diagnosis: *“怪物不能跑进阻挡区域，掉落物品也不能掉在阻挡区域”*. Both rules shipped — every enemy's `solidRadius` is now floored at the player's own (v48 gave mobs the player's rule and left them their own smaller number, so four of eight blueprints could stand, die and drop inside a 31 fp band no player could enter), and all three drop-placement sites clamp by the player's clearance instead of the pickup's collect padding. **Neither is the reported bug**: 903 real drops across 16 bot-driven runs of all five floors, plus a static sweep of every death cell on floor 1 and the launch arena, found zero unreachable and zero embedded in stone before the change. What v50 really buys is that both rules are now invariants checked every tick rather than margins that happen to hold — see [The rules were right and the bug was somewhere else](11-2026-08-28--08-31.md#the-rules-were-right-and-the-bug-was-somewhere-else-2026-08-31-engine--client-engine_version-50), and `design/18-test-strategy.md`'s “What v50 added” for which of the new gates actually discriminate. The report stayed open after v50, and the conclusion drawn then — that the engine was ruled out — **was wrong, though not because any of those measurements were**: every rule and gate v50 shipped asks whether a drop SITE is legal, and **2026-09-01's `ENGINE_VERSION` 51** found the question nobody had asked — whether a resting place STAYS legal. `DoorSystem.rebuildWalls` is the only thing in the engine that moves a wall mid-run, and an item lying in a passage when its door locked was sealed inside stone with nothing re-clamping it (a mob dying on a threshold, or a weapon swapped in a doorway, then the room activating — an ordinary sequence). v50's sweep did re-check on every wall-set change; the case simply never arose in those 16 runs, so it returned the same zero a working check returns. Fixed by re-clamping every alive pickup at `dropClearance()` after the rebuild — see [Two days of features, audited for what the tests did not say](13-2026-09-01-asset-phases.md#two-days-of-features-audited-for-what-the-tests-did-not-say-2026-09-01-engine--client--build-engine_version-5051). **Confirmed 2026-09-07: v51 WAS the report** — several days of play on builds carrying it, symptom gone (`design/18`'s “Answered” note). It closed by the absence of the symptom over real play rather than by the recorded run four rounds of sweeps had been asking for; the replay ask stays the right ask for the next report of this shape. **Then 2026-09-02's `ENGINE_VERSION` 52 and 53, both melee** — 52 gave a swing an event at all (`melee_swing`, so a sword at empty air can animate; `deflect` only fires when a swing catches a bullet and `hit` only when it connects, so the render layer was never told a swing happened), and 53 landed `MeleeSpec.swingSec` as a real **active hit window** after two months authored-but-unread — every blade had had a one-tick window, so the hammer and the spear were identically timed. See `ENGINE_VERSION_HISTORY.md`'s v52/v53 entries and design/07 step 7. Also on 2026-08-31, client-only, `?pickupDebug=1` shipped — a render-side instrument that draws each player's real ground point and every drop's real collect gate straight off `GameState`, so the next repro can be screenshotted rather than measured — see [A render-side instrument for the still-open report](11-2026-08-28--08-31.md#a-render-side-instrument-for-the-still-open-report-2026-08-31-client-only-no-engine-bump). The number in this heading has drifted before and is not the authority — `engine/versionHistory.ts` is. `ENGINE_VERSION` **43** (32: ground-weapon pickup is
click-driven; 33: manual aim removed entirely; 34: co-resident PvE room/door model, engine +
client rendering; 35: fully-realized branching — see [Room & door model](01-2026-07-24--08-05.md#room--door-model--co-resident-pve-floors--2026-08-04-engine_version-3334);
same-day map-editor door placement, the `layout: 'graph2d'` real-2D-layout follow-up, AND the
"graph2d content" pass that switches `EMBER_DUNGEON` to it are all additive, no version bump;
36: two Room & door model bug fixes, `onDeathSpawn` roomId + negative-offset floor bounds —
see [Room & door model](01-2026-07-24--08-05.md#room--door-model--co-resident-pve-floors--2026-08-04-engine_version-3334); 37: enemies/bosses actually move now — a live player
report ("怪物的AI不会移动的吗？目前的怪物和boss只会原地开枪") found that `AIDecideSystem` had
always been true to its own doc comment ("Enemies are stationary in the slice"): every mob
turned to face the nearest player and fired, but no system ever wrote a non-zero `vx`/`vy`
into one, so `MovementSystem`'s per-enemy integration was a correct no-op the whole time — an
`AIDecideSystem` gap, not a `MovementSystem` bug. Fixed with a first-pass `chase()`: close the
distance in a straight line until within `EnemyActor.engageRangeFp` (new, defaults to ~5.6
grid — deliberately much shorter than a gun's own max bullet travel, or the mob would rarely
be seen moving in a normal-size room), then stop and shoot; `moveSpeedPerTick`/`engageRangeFp`
are new optional per-blueprint knobs (`content/enemies.ts`) for a future kiting/rush/sniper
variant, unused by any blueprint yet. No steering/pathfinding/kiting — see
`ENGINE_VERSION_HISTORY.md`'s v37 entry for the full account; 38: level 1 is now a fully
hand-authored 5-floor descent — 5/6/7/6/5 rooms, every room 15x15..20x20 with 15-30 enemies
scaled by cell count, all five floors present in `EMBER_DUNGEON.floorMaps` so a run costs zero
`roomgenPrng` layout draws, content as editor-tunable JSON under `world/dungeons/ember/`; see
the "Level 1 is now fully hand-authored" entry under Room & door model below, and design/05's
matching subsection; 39: a DESCEND no longer carries the floor's stranded enemies and their
in-flight bullets into the next floor — the co-resident model's checkpoint only requires the
*capstone* room to be cleared, so anything still alive elsewhere used to ride along holding a
`roomId` for a room that no longer existed and a position measured against geometry that had
just been torn down. Narrow before 38; with 38's floor sizes a beeline to the capstone can
strand ~100 enemies per floor. See the Stranded-enemy section below); 40: enemies only open
fire once actually within their own `engageRangeFp`, fixing a live player report ("现在增加
了怪物之后，我一进入地图就被几十个怪物集火，瞬间就死了" — the instant I enter the map, dozens
of monsters focus-fire me and I die instantly). `AIDecideSystem` set `firing = true` for every
enemy in an activated room unconditionally, the same tick the room activated, regardless of
distance — `engageRangeFp` (37) only ever gated `chase()`'s stop-moving decision, never
whether a mob was allowed to shoot at all. With 38's 15-30-enemies-per-room floors and
`ENEMY_GUN_SIM`'s ~30-grid bullet travel comfortably outranging a room's diagonal, that was a
whole-room alpha strike on tick 1 with zero reaction time. Fixed the same way Soul Knight/Enter
the Gungeon split room-wide aggro from per-enemy attack range: a room's enemies still all wake
up and start closing distance the instant the room activates (unchanged — the room stays the
aggro unit), but only the ones already within `engageRangeFp` actually fire; the rest must
visibly cross the room first. See `ENGINE_VERSION_HISTORY.md`'s v40 entry for the full account;
41: a per-ROOM concurrent-fire budget + staggered room wake-up, because v40 turned out to buy
only about half a second — a garrison simply closes to engage range as one blob and opens up
together, which no per-enemy number can fix. Measured, not reasoned about, by a purpose-built
PvE level simulator; see [PvE level simulator](03-2026-08-17--08-19.md#pve-level-simulator--the-level-1-rebalance-it-forced-2026-08-17-engine_version-40-41); 42: the room *feel* pass —
enemy↔enemy push-out re-enabled (the one faction exception in `resolveActorPairs`, which in
practice let a converging garrison stack into a single unreadable blob of sprites), a new
per-mob perception radius INSIDE the existing room-activation gate (an un-noticed mob doesn't
move, fire, or even turn), and enemy move speed 4 → 2.6 px/tick. See the "Room feel pass"
section below and `ENGINE_VERSION_HISTORY.md`'s v42 entry; 43: the player stops at its own
body radius against a wall or a pillar (`Actor.solidRadius`, split off `footprintRadius`,
which keeps its old job and value for actor↔actor push-out) — see the "Sunk into the wall"
section below and `ENGINE_VERSION_HISTORY.md`'s v43 entry; 44: a door's passage rect lands on a
whole grid cell. `DOOR_EDGE_MARGIN_GRID` is 1.5 and the anchor step is `span / 4`, so a drawn
passage could sit on a HALF or a QUARTER cell; `carveDoorGaps` cuts exactly what the rect says, so
whatever was left of the wall run past the gap inherited the offset as its own DEPTH. That is why
four runs in shipped level-1 content stood 16 px deep where every other wall on all five floors is
a full 32 — the worst case for the standing-wall tones, and the geometry that made the occlusion
x-ray need its face-fading pass. The snap now lives in one shared `world/dungeon/doorAnchor.ts`
instead of a verbatim copy in each of the two placement functions. See "The 16 px wall runs" below
and `ENGINE_VERSION_HISTORY.md`'s v44 entry.
Render-only in between (no `ENGINE_VERSION` bump — 🟢): 2026-08-19's four-report wall-corner pass,
and 2026-08-20's occlusion x-ray — a standing block or pillar drawing over the local player fades
out of the way, from a report that the character *"跑到墙下面去了"*; the coverage sweep it produced
(`occlusionCoverage.test.ts`) measured 5.5% of level 1's standable floor as having made the player
*completely* invisible, and none of it leaves more than half hidden now. See "The character
disappeared behind a wall" below. That sweep is also what turned up v44's four wall runs.
Also render-only (no `ENGINE_VERSION` bump — 🟢): 2026-08-30's **open-door lighting**, from a
report with a screenshot circling one — the locked state reads as a fire door, but *"when it is
passable it looks like a black wall."* It was: every cue the standing-door fixture carried was
`visible = locked`, so "you can walk through here" was rendered as the ABSENCE of one, and what
remained measured as the darkest thing in view. An open door now gets three additive layers of its
own — a lit passage floor ramped up from the threshold and masked by the arch art's own stone, a
warm floor pool sharing the hazard bloom's exact geometry, and a lit reveal up both jambs. Every
number swept on a live frame; the one that mattered was cross-state, and alpha turned out to be the
wrong quantity to compare (the warm white is 2.3x the hazard red's luma at equal alpha, so the
quiet state was shouting 1.5x louder until it was set by `alpha x colour` instead). See "An open
door is lit from beyond" in design/01. `doorLightCoverage.test.ts` is its coverage half, in the
lineage of `doorStandCoverage`/`doorSpillCoverage`: all 24 shipped doors through the real pipeline,
confirming the lit band is 55.1 px on each of the 13 perimeter doors and 13.2 px on each of the 11
kerb ones rather than a sliver on most of them. 19 mutants across the two rounds, no survivors.

**Update, same day (2026-08-30b):** the lighting pass above still wasn't enough — two more live
reports, in sequence. First: the recess itself was still the SAME near-black wall-stone darkening
for both states, only the light on top of it differed, so the open state now draws the room's own
floor swatch across the opening (darkened by a far lighter version of the same ramp) instead of more
wall stone. Second, after that had shipped: *"依然不行...被阻挡时的火焰很明显，但是可以通过的效果太弱
了"* — the locked leaf is a whole illustrated hazard panel, and no amount of gradient tuning was ever
going to match that visual weight with a procedural ramp. `door_curtain_raw.png`, a new illustrated
warm-gold light-curtain asset, now fills the opening in the same additive slot the through-light
occupied, replacing it when loaded. Shipped with one real bug along the way: the curtain sprite was
sized correctly and visible but never positioned, so it drew below the threshold into the room floor
instead of into the opening — present, additive, invisible. See "The recess itself is still shared
stone, and then it is a whole illustrated curtain" in design/01, and `design/13`'s environment
fixture list for the art itself.

Two coverage gaps closed the same day, both confirmed real by mutation first: `RoomBuilder.test.ts`
had no test proving `RoomBuilder` actually passes `getFloorTexture()`/`getDoorCurtainTexture()` into
the door skin at all (deleting both from the call site left the full suite green), and
`doorCurtainCoverage.test.ts` — sibling of `doorStandCoverage`/`doorSpillCoverage`/`doorLightCoverage`
— sweeps the curtain's position across all 24 shipped doors rather than trusting the one hand-built
opening `doorRender.test.ts` uses, since that is exactly the kind of shape-dependent bug this repo has
shipped before.

Also render-only: 2026-08-20's **drop and portal art** — the five in-run pickup kinds and the
extraction gate's masonry arch become sprites. See "The drops and the gate get real art" below. That
entry called itself "the last of the scene's Graphics placeholders" and was wrong by one:
`RoomPiece.props` was still drawing Graphics silhouettes, closed 2026-08-24 by the room-prop art
pass below. What is left on procedural geometry now is bullets (deliberately) and the in-world
health bar — and `propRender.ts`'s fallback, kept on purpose so the next prop kind has something
to draw before its art exists.
Earlier, also render-only (no `ENGINE_VERSION` bump — 🟢): the DEFEAT/VICTORY result
screen's confirm gesture changed from tap-anywhere-on-the-panel (plus a raw fire-button
rising edge, `confirmEdge.ts`, now deleted) to a single explicit CONFIRM `Button` — the same
player report that flagged the alpha-strike above also read the almost-instant swarm death
as "the level just exited on its own," which traced to a stray click/held-fire from the fight
itself being able to dismiss the results screen before it was ever read. `Screens.ts` now has
no full-panel pointerdown handler at all; `GameLoop.ts`'s `pollConfirm`/`prevFire` rising-edge
poll is gone with it — every screen, including this one, is now "driven exclusively by its own
Buttons," closing the one holdout `confirmEdge.ts`'s own doc comment already named. New
`results.confirmButton` i18n key across all 8 locales, `results.confirmHint` retired (no
remaining callers). Followed same-day by a "加测试" pass closing real gaps a first
pass left open — not just re-asserting the same behavior: an off-by-one boundary check
(one fp past `engageRangeFp` must NOT fire, complementing the existing "exactly at the
boundary DOES fire" case), a per-enemy `engageRangeFp` override proven to drive the
firing gate too (not just the movement-stop it already drove), a `WeaponFireSystem`
composition test (cooldown ticks down every tick regardless of `firing`, so an
approaching enemy's gun is already re-armed the instant it crosses into range — no
extra wait on top of travel time), a `Screens.ts` layout-regression test for the new
buttons' actual pixel offsets, and — the one genuinely new coverage surface, not
reachable from any unit test — a full `createGameEngine` end-to-end regression in
`dungeonrun.test.ts` reproducing the reported bug shape directly: one room, two
real spawned enemies (one beside the player, one clear across the room), driven
through the real tick order, confirming the near one engages immediately while the
far one fires zero bullets until it closes the distance. **6544 tests green across all 8
workspace packages** (engine 1104 / client 4380 / server 189 / animator 444 / map-editor 282 /
png-pipeline 42 / desktop-shell 81 / root build-script 22, `npm run check`, re-measured
2026-09-02 from `main` with no worktree checked out, after the character-reaction CUE pass
(client +30: the local-seat gate on `hurt`/`death.player` in both directions, the spawn count's
arithmetic and its one piece of wiring, `Scene.spawnedActors` describing one reconcile rather
than accumulating, and the closed-form invariant `tools/audio-pipeline/` reads out of the synth
voice table) and, before it the same day, the hurt/death/spawn CLIP pass (client
+67 cases over the base-layer lifecycle state machine, the second overlay, the two drawn marks
that now follow the body's clip, and the shipped bundles' own hurt/death/spawn data, plus +26
from the gap audit that followed it — `placeSphereShade`'s first direct tests, the overlay-over-
lifecycle branch, the low quality tier's own collapse, and the reconcile-before-events order on
both loop paths) and, before it the same day, the attack-animation pass (client +86 over the additive clip layer, the melee
swing envelope, `paintModuleContacts` and the shipped bundles' clip data; engine +8 over
`melee_swing`) and the muzzle pass before that. The root leg reads 22 rather than the 13 recorded below because it now runs TWO files
(`versionManifestPlugin` + `wechatAssetSync`), not because a worktree inflated it — the caveat
that follows is still exactly right and is why this number was taken with none present.
Previously 5320, re-measured 2026-08-27 after the void return (+48 client: the two new scene modules, `powerRamp`, the call-site
tests two battery survivors asked for, and a second round covering the return's batching, its x-ray
group and the passages that can never need one) and, before it, the room-model unification
(`engine/state/roomModel.test.ts` +8, plus +3 from its
second battery) and, before it the same day, the floor-clip pass (`floorClipCoverage.test.ts` +53, whose sweeps were then widened
from one map to six) — which followed the
ground-cull pass earlier the same day (`groundCulling.test.ts` +6, `groundGeometryBudget.test.ts` +7)
and the two mutation batteries after it (+3: the low-tier cull, `cameraFrame`'s room-list
precedence, and `roomLight`'s stacked-alpha bound) — and **measure it from the MAIN checkout with no sibling
worktree checked out**, which is the mechanism that has been corrupting this block rather than
ordinary drift. The root leg of `npm run test` is `npx vitest run build/versionManifestPlugin.test.mjs`
run from the repo root, and `.claude/worktrees/<name>/` lives *inside* the repo, so vitest globs
each worktree's copy of that file as well: the honest count is 13, it reads 26 with one worktree
checked out and 39 with two — which is exactly the "13 → 39" this block recorded a few hours
earlier as if it were growth. The same caveat that has always been here still applies to the
other seven numbers, which are genuine: re-measure rather than trusting them) after fixing two real bugs found from a live player report ("cleared
the room, door's unlocked, still can't walk through it") — see the Room & door model
section below for the full account. Before that, closing a real gap the test-coverage audit
pass had flagged and left open: `onRequestSave` (tools/desktop-shell/src/preload.ts) now
catches a *synchronously*-thrown save callback too, not just a rejecting one, so
`nw:save-ack` always fires. That audit pass itself (see the Test coverage audit pass section
below) closed ~50
previously-untested files and found zero dead/obsolete tests to remove; before that, a full
client code-review pass
(2026-08-04, see the Phase 3/4 updates in [ROADMAP.md](../ROADMAP.md) and the [Client hardening pass](01-2026-07-24--08-05.md#client-hardening-pass--2026-08-04)) that found
and closed a real Phase-3 gap (mid-match reconnect was server-ready but never actually wired
from the client) plus a real Phase-4 squad-scoring bug, alongside a dozen smaller correctness/
robustness fixes across net, render, and UI. **Phases 0–4, 6 and 7 are closed with no deferred items**: the deterministic
engine and the locked content model (0), the full in-run loop — frame library, room pieces,
seeded dungeon generation, extraction checkpoints, materials (1), the meta/forge loop and the
3-character roster (2), online co-op — frame-broadcast lockstep, downed/revive, matchmaking
with signed tickets, render-layer local prediction (3), 8-player solo-or-squad PvP on a real
60-room arena map with a shrinking zone, placement scoring, anti-cheat checkpoints and an Elo
ladder (4), username/password accounts bound to ladder rating and forge progress (6), and an
English-canonical i18n system with a 中文 translation (7). **Phase 5 (presentation) is the only
partially-open phase** — the widget kit/HUD/screens (now including a menu-driven Mode Select,
a real Matchmaking connecting/error screen, a standalone tutorial level, a local-player downed/
revive HUD, a PvP match-preview screen, and a left-handed control-layout toggle, all 2026-08-03 —
see that entry under [Phase 5](../ROADMAP.md#phase-5--presentation--platform)), the `.tao` art pipeline with a fully bound roster,
post-processing, particles, all four fidelity-roadmap custom shaders (5.4), and (2026-08-03,
see that entry under [Phase 5](../ROADMAP.md#phase-5--presentation--platform)) 5.4's dynamic-lighting milestone all ship; the project's art direction is
now GPT-Image-2-generated art treated as final production art (an explicit scope decision, not a
tooling change — see the 5.3 update under [Phase 5](../ROADMAP.md#phase-5--presentation--platform)). **Audio (5.1) has since closed too**: the SFX
set, the four `ui.*` screen cues, two music loops with a real two-deck runtime (2026-08-31) and,
2026-09-02, the four cues a character makes about itself (`swing`/`hurt`/`spawn`/`death.player`,
which also split the old `death` cue into `death.enemy`/`death.player`) — **61 shipped cue files
and 2 loops, all of which play on both targets**. So what remains in Phase 5 is a master for the
third music track (`dungeon.ember` borrows `menu`'s as a declared placeholder), 5.5 WeChat device
verification (blocked on hardware), and the one thing no measurement can close: **nobody has
listened to any of it.** A repo structure pass (bottom
of this doc) made the engine its own DOM-free package and the repo an npm workspace. Per-item
detail, including what each phase deliberately did *not* build, is in the volumes under [design/roadmap/](.); the
[Dependency summary](../ROADMAP.md#dependency-summary) in the index is the one-screen version.

## Distribution targets and accounts, as of 2026-09-08

Appended rather than folded into the phase paragraph above, which was written before Phases 8–9
existed and describes the engine/content state it was written for. Per-item detail is in volumes
[40](40-2026-09-07-deploy-tests.md), [41](41-2026-09-07-crazygames.md),
[42](42-2026-09-07-rewarded-ad.md) and [43](43-2026-09-08-portal-accounts.md).

- **Four build targets ship**: our own domain (`b.gamestao.com`), the WeChat mini-game, the
  Capacitor shells, and a game portal (`npm run build:crazygames -w client`). The portal target
  loads **`crazygames-sdk-v3.js`** — the shipped v2 script has no `updateRoom`/`leftRoom`/
  `isInstantMultiplayer`, which is the whole of that platform's room requirement.
- **The backend is deployed** — `gameserver`/`matchsvc`/`billsvc` plus a backup worker on the
  borrowed VPS at `bb.gamestao.com`, and the portal build points at it by default.
- **Accounts have a second provider.** Username/password is unchanged and still never required to
  play; a game portal additionally signs a player in silently through its own user token
  (`POST /auth/portal`), and on that host our credential screen is unreachable because the
  platform disallows it. `accounts` gained `display_name`, applied by this project's first real
  schema migration — **so the first `matchsvc` start after that deploy alters the live database.**
- **Not yet done, and none of it is code**: the portal upload and its review round trip, a
  registered portal domain (without which banner fill, real ad playback and whether the account
  module is enabled at all cannot be settled), a hosted privacy/terms URL, `DDU_CG_GAME_ID` on
  the deployed matchsvc, and one question for the platform — its SDK logs that `getUser` is still
  in BETA, and the whole silent-login path rides on it.
