import type { EngineConfig } from '@dd/engine';

// Ignored the moment any real content is added past the border (flat mode has no
// room-geometry swap, unlike dungeon mode's per-room worldW/H) — a modest fixed square,
// small enough to keep the teaching enemy within melee-deflect reach, big enough that
// move/aim practice isn't cramped against a wall immediately.
const WORLD = 900;
const WALL_THICKNESS = 24;

// Arbitrary and fixed — never varies, unlike a real run's `SEED_BASE + runCount`
// (Game.ts), since the tutorial is the same lesson every time, not a fresh roguelite run.
export const TUTORIAL_SEED = 0xdead10;

/** A ranged repeater + a melee hammer (design/10 tutorial) — two meaningfully different
 * weapons so weapon-swap has something real to switch between, and the hammer can
 * deflect the teaching enemy's bullets (`DeflectSystem`, any melee weapon qualifies). */
export const TUTORIAL_LOADOUT: readonly string[] = ['repeater', 'hammer'];

function perimeterWalls(w: number, h: number): readonly (readonly [number, number, number, number])[] {
  const t = WALL_THICKNESS;
  return [
    [0, 0, w, t], // top
    [0, h - t, w, t], // bottom
    [0, 0, t, h], // left
    [w - t, 0, t, h], // right
  ];
}

/**
 * The standalone tutorial level (design/10 screen-flow gap). A fixed, flat — NOT
 * `dungeon`/`RoomPiece`/`generateFloor` — 2-floor `EngineConfig`: one small hand-built
 * arena reused across both floors (no room-geometry swap, no procedural generation),
 * fully deterministic (`TUTORIAL_SEED` never varies).
 *
 * Floor 0 (`waves`) is a single wave with ONE weak ranged enemy (`content/enemies.ts`'s
 * `BASIC_ENEMY` — already fires the shared enemy gun, so it's deflectable with zero
 * special-cased content) positioned across the arena from the player's spawn. This is
 * deliberately NOT the last floor (`floors.length === 1` → 2 floors total), so once it's
 * cleared the checkpoint shows the REAL interactive Portal/PortalPrompt rather than a
 * scripted stand-in.
 *
 * **What that portal offers changed under the level, 2026-09-10 (`ENGINE_VERSION` 61,
 * design/05 "Only the boss floor ends a run").** This comment used to say floor 0's
 * checkpoint shows "Bank-and-Extract vs Descend" — a real two-way choice — and that was the
 * point of putting the lesson on a non-last floor. There is no such choice any more: an
 * interior checkpoint offers DESCEND alone, and only the last floor offers EXTRACT.
 *
 * The level is still right, and arguably teaches better than it did: floor 0 teaches the
 * descend, floor 1 teaches the extract, which is exactly the shape of a real five-floor run.
 * What it no longer teaches is a decision, because the game no longer has one there. Keep the
 * two floors for that reason — a one-floor tutorial would only ever show the Extract button
 * and would leave a first-time player meeting DESCEND for the first time in a real run.
 *
 * Floor 1 (`floors[0]`) — the last floor — is one more trivial enemy: descend from floor 0,
 * clear it, and the run ends normally through the real result screen on an explicit EXTRACT
 * press (the last floor has not auto-resolved since 2026-08-12 — see `ExtractionSystem`).
 *
 * No static pickups are placed (PvE `RoomPiece`/flat-mode content has no such field —
 * pickups only ever arrive as enemy drops) — the weapon-swap lesson is taught by the
 * starter loadout alone (two different weapons already equipped), not by a scripted
 * pickup. `TutorialHintController` (render-only) drives the actual teaching beats off
 * this config's state, never the engine.
 */
export function buildTutorialConfig(opts: { skinId: string }): EngineConfig {
  return {
    seed: TUTORIAL_SEED,
    worldW: WORLD,
    worldH: WORLD,
    playerStart: [160, WORLD / 2],
    skinId: opts.skinId,
    loadout: TUTORIAL_LOADOUT,
    walls: perimeterWalls(WORLD, WORLD),
    waves: [[[WORLD - 220, WORLD / 2, 'basic']]],
    floors: [[[[WORLD / 2, WORLD / 2, 'basic']]]],
  };
}
