/**
 * Engine-global constants (design/09 "all numbers live in @dd/engine config").
 * Balance/content numbers (weapons, enemies, drops) live under content/ and
 * balance/; this file holds only cross-cutting constants and the version guard.
 *
 * `ENGINE_VERSION`'s replay-compatibility changelog lives in ./versionHistory.ts
 * (CLAUDE.md "500-line file convention", form ① — split out because it's a single,
 * ever-growing doc comment on one constant with zero shared state with anything
 * else here); re-exported below so every existing `import { ENGINE_VERSION } from
 * './config'` site is untouched.
 */
import { TICK_RATE, FP_SCALE, type Fp } from './math/fixed';
import { BRAD_FULL } from './math/trig';

export { ENGINE_VERSION } from './versionHistory';

// ── Two-pool health tuning (design/07; final values are 07 "to design") ──────────
// Whole ticks @30Hz. Shield regen is an idle timer, not a heal: after taking ANY
// damage an actor must stay unhit for DELAY ticks before shield refills +1 per
// INTERVAL, capped at maxShield. A DoT tick resets the timer (StatusEffectSystem),
// so clearing a lingering status is a precondition for regen.
export const SHIELD_REGEN_DELAY = 90; // ~3 s idle before regen starts
// ~2 s per +1 shield thereafter. Was 300 (~10 s) through ENGINE_VERSION 40, which
// made the shield pool effectively single-use in a PvE run: a character refills
// 3.2 shield in ~32 s of taking no damage at all, while a dungeon room takes ~8 s to
// clear and the next one is a few seconds' walk away — so a player entered a 37-enemy
// floor with one 9.2-point pool and no way to get any of it back except heal drops
// (`client/sim/pveLevelSim.sim.ts` measured the result: floor 1 cleared in 0% of bot
// runs even after the room garrisons were halved). 60 makes the two-pool split mean
// what design/07 says it means — shield is the RENEWABLE half, HP the permanent half
// that only a heal pickup restores — and makes disengaging between rooms a real
// tactic instead of a formality.
export const SHIELD_REGEN_INTERVAL = 60;

// ── Knockback friction (design/07, v25) ───────────────────────────────────────────
// knockVx/knockVy decay by this per-mille factor every tick (MovementSystem), so a
// shove fades out instead of persisting or drifting forever. 800 = keep 80%/tick —
// a saber swing's 198 fp/tick impulse falls under KNOCKBACK_SNAP_FP within ~20 ticks
// (~0.7s), covering roughly 1 grid unit of total slide. First-pass, tune against real
// play like every other number in this section.
export const KNOCKBACK_FRICTION_PERMILLE = 800;
export const KNOCKBACK_SNAP_FP = 5; // below this magnitude (either axis), snap to exactly 0

// ── k_* on-hit procs (design/03/09, v28) ──────────────────────────────────────────
// How far a ricochet may retarget from its current position — same "reasonable
// nearby range" idea as content/damage.ts's CHAIN_RANGE, kept separate since the two
// are semantically distinct knobs (a lightning chain's hop vs a ricochet's bounce).
// Computed inline (not via content/convert.ts's toFpGrid) to avoid a circular import
// — convert.ts itself imports WORLD from this file.
export const RICOCHET_RANGE_FP = Math.round(6 * FP_SCALE) as Fp;

// ── Per-floor weapon allowance (design/05, 2026-09-05) ────────────────────────
// How many weapon drops one dungeon floor may produce: `MIN` to `MIN + SPAN - 1`,
// i.e. 2 or 3, rolled once per floor from `dropPrng` (SpawnSystem's fresh-floor path)
// and enforced by `DeathDropsSystem` — including a make-up drop on the capstone kill,
// so the range is a guarantee in both directions rather than a cap with a bad tail.
// A range and not a constant on purpose: a fixed 2 makes the third weapon's absence
// information ("no point clearing that side room"), and the point of the allowance is
// to make loot scarce, not to make it predictable.
export const FLOOR_WEAPON_QUOTA_MIN = 2;
export const FLOOR_WEAPON_QUOTA_SPAN = 2; // nextInt(2) -> +0 or +1

// ── Blueprint drop (design/14, ENGINE_VERSION 63) ────────────────────────────
// The chance a BOSS kill rolls a blueprint out of `EARNABLE_BLUEPRINTS`, per mille. 50 = 5%,
// a first-pass number to tune against real clears: at three earnable blueprints it is about
// twenty boss kills per blueprint, which is a long tail by design (this is the earn-by-playing
// path, not a reliable one). Per-mille rather than a float because every probability in this
// engine is an integer against an integer draw (design/06 — a float would be the one place a
// platform could disagree).
export const BLUEPRINT_DROP_PERMILLE = 50;

// ── Chest rooms (design/05 "Chest rooms", ENGINE_VERSION 63) ──────────────────
// How close a player must stand to work a chest, and how far out its mechanisms sit.
//
// `CHEST_INTERACT_RANGE_GRID` matches `REVIVE_RANGE_GRID` exactly, and that is a decision
// rather than a coincidence: INTERACT drives both, so a player standing where they can reach
// a downed teammate can also reach a chest, and the arbitration between the two (ChestSystem
// yields to a revive in progress) is about intent, never about a geometry the player has to
// learn twice.
export const CHEST_INTERACT_RANGE_GRID = 1.5;
// The ring radius a big chest's mechanisms are derived onto. Wide enough that standing on one
// plate is visibly NOT standing on the chest (so the coordination reads), narrow enough that
// the whole ring fits inside the smallest authored room (15x15) with its perimeter ring and a
// body radius of clearance on either side: 15 - 2 (walls) - 1 (bodies) leaves 12, so a
// diameter of 6 sits comfortably inside even after `clampToWalkable` has its say.
export const CHEST_MECHANISM_RING_GRID = 3;
// How close a player's centre must be to a mechanism's centre to count as standing on it.
// Deliberately larger than a body radius: a plate a player has to find the exact centre of is
// a precision task, and nothing about this mechanic is meant to be one.
export const CHEST_MECHANISM_RADIUS_GRID = 1;
// What a small chest pays, regardless of party size (design/05: the big chest is the one whose
// reward scales, and it is the coordination that earns the scaling).
export const CHEST_SMALL_WEAPONS = 1;

// ── Co-op downed / revive (design/05/07, ROADMAP 3.2). Whole ticks @30Hz. A lethal
// hit sends a player `downed`; a teammate revives via a sustained INTERACT channel.
export const DOWNED_BLEEDOUT_TICKS = 900; // ~30 s downed before permanent death (paused while being revived)
export const REVIVE_CHANNEL_TICKS = 450; // ~15 s sustained INTERACT to complete a revive (design/05 locked)
export const REVIVE_HP = 2; // HP a revived player comes back with (a small amount, design/07)
export const REVIVE_RANGE_GRID = 1.5; // how close the reviver must stand, grid units

// ── PvP anti-cheat periodic checkpoints (design/15, ROADMAP 4.4) ──────────────────
// Generalizes the existing end-of-match `ClientMsg.result.stateHash` (replay.ts
// hashState) into a tick-indexed check DURING a match. Design/15 is explicit these
// numbers are a first-pass proposal, not tuned ("real play required").
export const CHECKPOINT_TICKS = 150; // ~5s @ 30Hz cadence between periodic reports
// Below this many REAL (connected) seats, run no consensus check at all — an early
// bot-padded low-population match is expected to be internally inconsistent
// (design/15), and "not enough honest signal to trust a majority" applies at any
// seat count this low regardless of population stage.
export const CHECKPOINT_QUORUM = 3;
// A seat is only kicked once it disagrees with the majority at the SAME historical
// tick across this many CONSECUTIVE checkpoints — never a single stray mismatch
// (which is more likely a client still catching up under the lag/backlog
// multiplier than an actual state fork, design/15).
export const INTEGRITY_KICK_STREAK = 2;

// ── Standing-wall north brim (design/01 height model, v47; widened v48) ───────────
/**
 * Extra clearance, in fp, between an actor and the NORTH face of a FREE-STANDING wall block
 * (`AABB.freeStanding`).
 *
 * **This exists because of how tall things are DRAWN, not because of what they are.** Everything
 * in this view is drawn upward from a grounded origin (`screen.y = gy - z`), so a standing block
 * paints its own footprint PLUS one full wall height of floor to its north
 * (`client/.../wallGeometry.ts`, `occlusion.ts`'s `Occluder.top`). How far an actor ends up
 * buried in that art is therefore `drawn height - clearance`, and until v47 the two standing
 * shapes in a room disagreed about it by a body's worth (a pillar sinking an actor 40 px, a wall
 * sinking the WHOLE silhouette at 54 px — see ENGINE_VERSION_HISTORY for that account). v47's
 * 16 px brim closed that gap (wall sink 70 - 32 = 38 px, matching the pillar's 40).
 *
 * **Widened from 16 to 23 px in v48** (live report, circled screenshot: *"角色被挡住的部分...大概
 * 当前角色的一半可以进入墙...改为1/4的位置"* — a free-standing block was still reading as burying
 * about half the character; wanted down to about a quarter). Wall sink against `WALL_H_INTERIOR`
 * drops from 38 to 31 px (`occlusion.test.ts`'s wall/pillar geometry assertion pins the new
 * number) — a real reduction, though **not** the full doubling a naive "half to a quarter" read
 * would suggest: 23 px is not a target, it is a CEILING. `launchArena.test.ts`'s "what the north
 * brim costs the launch map" suite rasterizes the shipped arena's standable floor with and without
 * the brim and asserts the two connect the same rooms into the same regions — at 24 px one of the
 * map's single-grid-cell gaps stops fitting a player and a route seals; 23 is the largest value
 * that still measures zero lost routes there. Widening further needs the room/kit geometry itself
 * loosened (more spacing around a free-standing block), not just this constant. `solidRadius`
 * itself was deliberately left alone — widening THAT floats a character off a wall's east/west
 * face, which v43 tuned to land exactly tangent.
 *
 * **This constant does not touch every case a character can read as "sunk into a wall."** It only
 * ever applies to a FREE-STANDING block's north face — see "Only free-standing blocks" below. The
 * shipped floors' worst-case occlusion sample (`occlusionCoverage.test.ts`, 43.75%) is a position
 * no block's `occludes()` rule fires for at all (just under `MIN_COVER_FRACTION`) and is untouched
 * by this widening; a screenshot of a character against a room's own boundary wall or a kerb is a
 * different case than the one this constant governs.
 *
 * **Only free-standing blocks.** A perimeter wall must keep exact-footprint collision: its ring
 * is what door passages are carved through (`carveDoorGaps`) and a brim on it would narrow every
 * passage from both sides, and a room's SOUTH boundary is drawn as a 22 px kerb
 * (`WALL_H_KERB`) whose whole purpose is that an actor CAN stand tangent to it — brimming that
 * would re-open the v43 report ("角色...感觉陷进去了") from the opposite side, floating the
 * character off a lip that was never covering them.
 *
 * **Since v48 this also governs where a dropped pickup may land** (`geom.clampToWalkable`): a
 * point clamped only against a free-standing block's bare footprint could settle inside this same
 * brimmed band — on screen, but past where any actor's own `solidRadius` will ever let them stand
 * (live report: *"角色根本无法拾取掉落的物品"*). `clampToWalkable` now pushes a point out of the
 * brimmed top edge exactly like `MovementSystem.resolveWalls` does for a live actor.
 *
 * **It did nothing at all in the PvE campaign until v49.** Everything above was built in v47,
 * widened in v48, and tuned against the LAUNCH ARENA — which flags every kit solid. The five
 * shipped ember floors flagged none: all 14 `world/dungeons/ember/pieces/*.json` carried zero
 * `freeStanding`, so the 34 rects the renderer stands at `WALL_H_INTERIOR` reserved no extra
 * floor and a character north of one was buried by the full pre-v47 amount. Two versions of
 * work were inert over the entire campaign, and nothing said so, because the flag is authored
 * content and the constant is code. v49 authored it (18 piece-local solids → those 34
 * placements); `client/.../simRenderParity.test.ts` now fails if level 1 ever loses them again.
 *
 * **Where this value is actually pinned**, since a doc comment is not a guard: the wall-vs-pillar
 * cover assertion is `client/src/game/scene/occlusion.test.ts` ("buries a character LESS than a
 * pillar does"), the no-route-sealed ceiling is `engine/world/arenas/launchArena.test.ts` ("what
 * the north brim costs the launch map"), the standoff itself is `engine/systems/rooms.test.ts`'s
 * computed `NORTH_STANDOFF`, and the sim-vs-render agreement is `simRenderParity.test.ts`. The
 * v47 comment cited a `client/.../standingCoverParity.test.ts` for this; that file was never
 * created — the assertion it named landed in `occlusion.test.ts` instead. See
 * design/18-test-strategy.md.
 */
export const WALL_NORTH_BRIM = Math.round((23 / 32) * FP_SCALE) as Fp;

/**
 * World scale — the anchor for every human-unit → fp/brad conversion (design/09).
 * 1 grid unit = 32 px. The demo slice runs render @60fps; the sim runs @30Hz.
 */
export const WORLD = {
  pxPerGrid: 32,
  tickRate: TICK_RATE,
  fpScale: FP_SCALE,
  bradFull: BRAD_FULL,
} as const;

export { TICK_RATE, FP_SCALE };
