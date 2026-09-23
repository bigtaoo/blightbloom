/**
 * The checkpoint overlay pass, split out of `GameLoop.updateHud` (CLAUDE.md 500-line
 * convention, form (1) — an independent function module): everything that appears when
 * a floor is finished, driven from one shared condition.
 *
 * That sharing is the reason it is one function rather than three calls sitting next to
 * each other. Four things read "this floor is done": the portal's own open/closed
 * visual, the portal popup's proximity gate, the floor-card offer, and the fire
 * suppression that keeps a tap on either panel from also firing a shot. Computing the
 * condition once, here, is what makes it impossible for them to disagree — a card offer
 * over an unfinished floor, or a portal with no card to pick at it.
 */
import type { GameState } from '@dd/engine';
import { fpToPx } from '../coords';
import { checkpointReached, totalFloorCount } from '../match/floorCount';
import type { RoomBuilder } from '../scene/RoomBuilder';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';

/** How close (world px) the player must stand to the portal for the popup to open
 *  (design/10 legibility fix, 2026-08-02) — wide enough to reach comfortably before the
 *  portal's own footprint, narrow enough that it does not show while still crossing the
 *  room. */
export const PORTAL_PROMPT_RADIUS_PX = 90;

export interface CheckpointOverlayDeps {
  roomBuilder: RoomBuilder;
  portalPrompt: PortalPrompt;
  floorCardPrompt: FloorCardPrompt;
  /** Fire is suppressed while the PORTAL popup is open — its buttons are a run-level
   *  choice made in a cleared room, so gating the whole button on it costs nothing. The
   *  weapon-pickup panel is deliberately NOT OR'd in (2026-09-02 live report: it opens
   *  mid-fight from `SIM.lootRevealRadius` away every time anything drops a weapon, so
   *  gating fire on it disarmed the player standing in their own loot). That panel — and
   *  the card panel — swallow their own presses instead, via `onPressStart` ->
   *  `CommandBuilder.suppressFireUntilRelease`. */
  suppressFire: (active: boolean) => void;
}

/**
 * The last floor is included, not excluded: it used to be skipped entirely, because
 * `ExtractionSystem` auto-resolved EXTRACT the instant its capstone cleared, with no
 * portal at all — dropped 2026-08-12 after a live report that the boss's own death drops
 * never had a chance to be collected, since the run ended before the player could walk
 * to them. It now opens the same portal as any other checkpoint; `PortalPrompt` hides
 * its Descend button, and no card offer is rolled (there is nowhere to spend one).
 */
export function updateCheckpointOverlays(s: GameState, localOwner: number, d: CheckpointOverlayDeps): void {
  const isLastFloor = s.floorIndex + 1 >= totalFloorCount(s);
  const eligible = !s.zoneEnabled && s.phase !== 'gameover' && checkpointReached(s);
  d.roomBuilder.setPortalOpen(eligible);

  const p = s.players[localOwner];
  const portalPx = d.roomBuilder.portalPx;
  const nearPortal =
    !!p && !!portalPx && Math.hypot(fpToPx(p.gx) - portalPx.x, fpToPx(p.gy) - portalPx.y) <= PORTAL_PROMPT_RADIUS_PX;

  d.portalPrompt.update(s, eligible && nearPortal, localOwner, isLastFloor);
  d.floorCardPrompt.update(s, eligible && nearPortal, localOwner);
  d.suppressFire(d.portalPrompt.isOpen);
}
