// Which FLOOR a `RoomBuilder.build` was built from — so `room_enter` stops rebuilding a floor it
// already has (split out of RoomBuilder 2026-09-28, 500-line convention; form ①, pure functions).
//
// A floor has been one co-resident map since the dungeon rework (`SpawnSystem.tickDungeon`): every
// room is placed, walled and doored when the floor is generated, and `room_enter` fires the first
// time a player steps into each one of them — i.e. several times per floor, mid-fight, while the
// camera is panning. Each of those events rebuilt the whole floor: measured on a 1080p desktop, ~11
// ms of build plus ~12 ms more in the next render re-triangulating the new floor mottle, so every
// doorway dropped one or two frames on a machine that otherwise holds 60/60 (and several on a phone).
//
// It rebuilt the SAME floor. Mid-floor, `state.walls` only changes through `DoorSystem`, which adds
// a locked door's own `passageAabb` — a wall `build()` already skips by identity — and
// `updateDoors()` restyles the fixtures on the `door_locked`/`door_unlocked` events that follow.
// Frame-diffed live: a same-floor rebuild changes 0 pixels, and a lock change applied through
// `updateDoors` alone differs from a fresh build by at most 6/255 in a door-sized strip once the
// door's crossfade has settled. The rebuild was in fact what DEFEATED that crossfade: it rebuilt the
// door already locked, so the following `setLocked` had nothing to fade.
//
// A new floor is recognised by what `SpawnSystem.generateAndPlaceFloor` replaces: it clears and
// refills `dungeonRooms` with freshly placed rooms, so the FIRST room's object identity changes
// even where two floors happened to share an index. The state object is part of the key because a
// new run is a new state, and a key never outlives `RoomBuilder.clear()`.
import type { GameState } from '@dd/engine';

export interface FloorKey {
  readonly state: GameState;
  readonly floorIndex: number;
  readonly firstRoom: object | undefined;
}

export function floorKeyOf(s: GameState): FloorKey {
  return { state: s, floorIndex: s.floorIndex, firstRoom: s.dungeonRooms[0] };
}

/** True when `built` describes the floor `s` is on now, i.e. a rebuild would redraw it unchanged.
 *  A floor with no placed rooms (flat and arena modes) is never "the same" — nothing here can vouch
 *  for its geometry, so those keep rebuilding exactly as they did. */
export function isSameFloor(built: FloorKey | null, s: GameState): boolean {
  return (
    built !== null &&
    built.firstRoom !== undefined &&
    built.state === s &&
    built.floorIndex === s.floorIndex &&
    built.firstRoom === s.dungeonRooms[0]
  );
}
