/**
 * `updateCheckpointOverlays` — the one pass that decides when a finished floor's
 * overlays appear (design/05/10, ENGINE_VERSION 58).
 *
 * A pure module (`pureLayerBoundary.test.ts` lists it), so this runs with no browser and
 * no renderer: the views are fakes, and what is asserted is the DECISION — which is the
 * part that could drift. The portal, its popup, the floor-card offer and the fire
 * suppression all read one condition, and the whole reason they share it is that four
 * copies of "is this floor done" is four chances to disagree.
 */
import { describe, it, expect, vi } from 'vitest';
import type { GameState } from '@dd/engine';
import { updateCheckpointOverlays, PORTAL_PROMPT_RADIUS_PX } from './checkpointOverlays';
import { pxToFp } from '@dd/engine';

function fakeDeps(portalPx: { x: number; y: number } | null = { x: 0, y: 0 }) {
  const portalPrompt = { update: vi.fn(), isOpen: false };
  const floorCardPrompt = { update: vi.fn() };
  const roomBuilder = { setPortalOpen: vi.fn(), portalPx };
  const suppressFire = vi.fn();
  return {
    portalPrompt,
    floorCardPrompt,
    roomBuilder,
    suppressFire,
    deps: { portalPrompt, floorCardPrompt, roomBuilder, suppressFire } as never,
  };
}

/**
 * A dungeon-shaped state whose capstone room is cleared (or not), with the local player
 * standing `distPx` from the portal. Only the fields the pass reads are populated —
 * `checkpointReached`/`totalFloorCount` walk the same room arrays the engine builds.
 */
function state(o: {
  cleared?: boolean;
  distPx?: number;
  floorIndex?: number;
  floorCount?: number;
  zone?: boolean;
  phase?: string;
}): GameState {
  const cleared = o.cleared ?? true;
  const rooms = [{ id: 'r1' }, { id: 'cap' }];
  return {
    zoneEnabled: o.zone ?? false,
    phase: o.phase ?? 'playing',
    floorIndex: o.floorIndex ?? 0,
    dungeonEnabled: true,
    dungeonConfig: { floorCount: o.floorCount ?? 3 },
    dungeonRooms: rooms,
    dungeonRoomRuntime: [
      { activated: true, hasLiveEnemy: false },
      { activated: cleared, hasLiveEnemy: !cleared },
    ],
    extraFloors: [],
    floorsEnabled: true,
    players: [{ gx: pxToFp(o.distPx ?? 0), gy: pxToFp(0) }],
  } as unknown as GameState;
}

/** The `show` argument each panel was last given. */
const shown = (t: ReturnType<typeof fakeDeps>) => ({
  portal: t.portalPrompt.update.mock.calls.at(-1)![1],
  cards: t.floorCardPrompt.update.mock.calls.at(-1)![1],
});

describe('one condition, four consumers', () => {
  it('opens everything on a cleared floor with the player at the portal', () => {
    const t = fakeDeps();
    updateCheckpointOverlays(state({ distPx: 0 }), 0, t.deps);
    expect(t.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
    expect(shown(t)).toEqual({ portal: true, cards: true });
  });

  it('opens the PORTAL but neither panel while the player is still crossing the room', () => {
    // The portal's own visual is the "you can leave" signal from across the room; the
    // popup and the cards are a thing you walk up to.
    const t = fakeDeps();
    updateCheckpointOverlays(state({ distPx: PORTAL_PROMPT_RADIUS_PX + 40 }), 0, t.deps);
    expect(t.roomBuilder.setPortalOpen).toHaveBeenCalledWith(true);
    expect(shown(t)).toEqual({ portal: false, cards: false });
  });

  it('keeps the card offer and the popup in lockstep across every case', () => {
    // The invariant the shared condition exists for. Asserted over the whole matrix
    // rather than one case, since a divergence would most likely appear in exactly the
    // combination nobody wrote a test for.
    for (const cleared of [true, false]) {
      for (const distPx of [0, PORTAL_PROMPT_RADIUS_PX + 1]) {
        for (const zone of [true, false]) {
          for (const phase of ['playing', 'gameover']) {
            const t = fakeDeps();
            updateCheckpointOverlays(state({ cleared, distPx, zone, phase }), 0, t.deps);
            const s = shown(t);
            expect(s.cards, `cleared=${cleared} dist=${distPx} zone=${zone} phase=${phase}`).toBe(s.portal);
          }
        }
      }
    }
  });

  it('shows nothing on an uncleared floor', () => {
    const t = fakeDeps();
    updateCheckpointOverlays(state({ cleared: false }), 0, t.deps);
    expect(t.roomBuilder.setPortalOpen).toHaveBeenCalledWith(false);
    expect(shown(t)).toEqual({ portal: false, cards: false });
  });

  it('shows nothing in a PvP arena — the checkpoint is a PvE concept', () => {
    const t = fakeDeps();
    updateCheckpointOverlays(state({ zone: true }), 0, t.deps);
    expect(t.roomBuilder.setPortalOpen).toHaveBeenCalledWith(false);
  });

  it('shows nothing once the run is over', () => {
    const t = fakeDeps();
    updateCheckpointOverlays(state({ phase: 'gameover' }), 0, t.deps);
    expect(t.roomBuilder.setPortalOpen).toHaveBeenCalledWith(false);
  });

  it('survives a floor with no portal placed yet', () => {
    const t = fakeDeps(null);
    updateCheckpointOverlays(state({}), 0, t.deps);
    expect(shown(t)).toEqual({ portal: false, cards: false });
  });
});

describe('what each consumer is told', () => {
  it('tells the popup when it is the LAST floor, so it can hide Descend', () => {
    const t = fakeDeps();
    updateCheckpointOverlays(state({ floorIndex: 2, floorCount: 3 }), 0, t.deps);
    expect(t.portalPrompt.update.mock.calls.at(-1)![3]).toBe(true);
    const mid = fakeDeps();
    updateCheckpointOverlays(state({ floorIndex: 0, floorCount: 3 }), 0, mid.deps);
    expect(mid.portalPrompt.update.mock.calls.at(-1)![3]).toBe(false);
  });

  it('tells the card panel which seat is LOCAL, so it highlights the right vote', () => {
    const t = fakeDeps();
    const s = state({});
    (s.players as unknown as unknown[]).push({ gx: pxToFp(0), gy: pxToFp(0) });
    updateCheckpointOverlays(s, 1, t.deps);
    expect(t.floorCardPrompt.update.mock.calls.at(-1)![2]).toBe(1);
  });

  it('measures the portal distance from the LOCAL seat, not from seat 0', () => {
    // Seat 0 is far away, seat 1 (local) is standing on the portal. Reading seat 0 would
    // leave a teammate unable to open the popup they are standing in front of.
    const t = fakeDeps();
    const s = state({ distPx: 400 });
    (s.players as unknown as unknown[]).push({ gx: pxToFp(0), gy: pxToFp(0) });
    updateCheckpointOverlays(s, 1, t.deps);
    expect(shown(t)).toEqual({ portal: true, cards: true });
  });
});

describe('fire suppression', () => {
  it('suppresses fire while the portal popup is open', () => {
    const t = fakeDeps();
    t.portalPrompt.isOpen = true;
    updateCheckpointOverlays(state({}), 0, t.deps);
    expect(t.suppressFire).toHaveBeenLastCalledWith(true);
  });

  it('leaves fire alone otherwise — it is gated on the POPUP, nothing else', () => {
    // 2026-09-02 live report: the weapon-pickup panel used to be OR'd in here, which
    // disarmed a player standing anywhere near their own loot. Both that panel and the
    // card panel swallow their own presses instead.
    const t = fakeDeps();
    t.portalPrompt.isOpen = false;
    updateCheckpointOverlays(state({}), 0, t.deps);
    expect(t.suppressFire).toHaveBeenLastCalledWith(false);
  });
});
