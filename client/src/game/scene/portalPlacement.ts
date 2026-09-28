// Where a floor's portal stands (split out of RoomBuilder.buildPortal 2026-09-28, 500-line
// convention; form ①, one pure function).
//
// Placement bug fix (2026-08-12, live screenshot report): this used to center on `(w/2, h/2)` —
// but in dungeon mode `w`/`h` are `fpToPx(s.worldW/worldH)`, the bounding box of the WHOLE floor's
// co-resident rooms (buildFloorGeometry), not the single room the checkpoint actually belongs to.
// On any floor with more than one room that box's center can land in a corridor or on top of a
// wall instead of inside the capstone (extraction/boss) room. `state.dungeonRoomRects` — populated
// per room by SpawnSystem, always with the capstone LAST (ExtractionSystem's own "capstone = last
// entry" convention, generateFloor always appends it last) — gives the correct room to center on.
// Flat (non-dungeon) runs never populate `dungeonRoomRects` (SpawnSystem only pushes into it in the
// dungeon branch), where `w/h` already IS the single room's own size, so the old `w/2, h/2` center
// is kept as the fallback for that mode.
import type { GameState } from '@dd/engine';
import { fpToPx } from '../coords';

export function portalCenterPx(s: GameState, w: number, h: number): { x: number; y: number } {
  const capstone = s.dungeonRoomRects[s.dungeonRoomRects.length - 1]?.rect;
  return capstone
    ? { x: fpToPx(capstone.x) + fpToPx(capstone.w) / 2, y: fpToPx(capstone.y) + fpToPx(capstone.h) / 2 }
    : { x: w / 2, y: h / 2 };
}
