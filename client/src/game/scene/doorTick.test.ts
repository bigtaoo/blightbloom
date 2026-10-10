/**
 * `doorTick.ts` — which doors get a frame of motion, how near the player is to each, and whether
 * a locked one is currently refusing them.
 *
 * Three of these rules are the kind that go wrong silently. The CULL decides whether a per-frame
 * `Graphics` rebuild runs for 24 doors or for the 2 on screen, and a cull that lets everything
 * through looks identical in play. The PROXIMITY ramp measures to a door's footprint, not its
 * centre, which only shows up on the 128 px kerb doors — half the shipped ones. And the REFUSAL
 * has three conditions of which any two will fire on a player merely walking past a doorway, so
 * each one is asserted to be independently necessary rather than just asserting the happy path.
 */
import { describe, it, expect, vi } from 'vitest';
import { DoorFxDriver, isRefused, nearness, overlapsView, tickDoors, type CameraRect } from './doorTick';
import type { RectPx } from './wallGeometry';
import type { TorchLightSink } from './torches';

const DOOR: RectPx = { x: 200, y: 300, w: 64, h: 20 };
const VIEW = { x: 0, y: 0, w: 800, h: 600 };
/** `doorTick.TICK_MARGIN_PX` — the slack for the one-frame-stale camera rect. Restated here rather
 *  than exported: a test that read the constant could not catch it being set to something absurd. */
const MARGIN = 96;

const fake = () => ({ tick: vi.fn((_dt: number, _near: number): void => undefined) });

describe('overlapsView — the cull', () => {
  it('lets a door inside the rect through and keeps one far outside it out', () => {
    expect(overlapsView(DOOR, VIEW)).toBe(true);
    expect(overlapsView({ ...DOOR, x: 5000 }, VIEW)).toBe(false);
    expect(overlapsView({ ...DOOR, y: -5000 }, VIEW)).toBe(false);
  });

  it('grows the rect by the margin on every one of the four sides', () => {
    // Just inside the margin on each side, then just outside it — a margin applied on only two
    // sides (an easy way to write this wrong) passes the first half of each pair.
    for (const near of [
      { ...DOOR, x: VIEW.x - DOOR.w - MARGIN + 2 },
      { ...DOOR, x: VIEW.x + VIEW.w + MARGIN - 2 },
      { ...DOOR, y: VIEW.y - DOOR.h - MARGIN + 2 },
      { ...DOOR, y: VIEW.y + VIEW.h + MARGIN - 2 },
    ]) {
      expect(overlapsView(near, VIEW)).toBe(true);
    }
    for (const far of [
      { ...DOOR, x: VIEW.x - DOOR.w - MARGIN - 2 },
      { ...DOOR, x: VIEW.x + VIEW.w + MARGIN + 2 },
      { ...DOOR, y: VIEW.y - DOOR.h - MARGIN - 2 },
      { ...DOOR, y: VIEW.y + VIEW.h + MARGIN + 2 },
    ]) {
      expect(overlapsView(far, VIEW)).toBe(false);
    }
  });
});

describe('nearness — the proximity ramp', () => {
  it('is 1 standing in the doorway and 0 across the room', () => {
    expect(nearness(DOOR, { x: DOOR.x + DOOR.w / 2, y: DOOR.y })).toBe(1);
    expect(nearness(DOOR, { x: DOOR.x - 4000, y: DOOR.y })).toBe(0);
  });

  it('falls monotonically, with no kink at either end', () => {
    let prev = 2;
    for (let d = 0; d < 260; d += 4) {
      const v = nearness(DOOR, { x: DOOR.x + DOOR.w / 2, y: DOOR.y + DOOR.h + d });
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it('measures to the FOOTPRINT, so a wide kerb door is not far from its own far jamb', () => {
    // The defect a distance-to-centre rule has, on the half of the shipped doors that are 128 px
    // wide: a player standing at the west jamb is 64 px from the centre and would read as much
    // further away than the same player at the middle of a 64 px perimeter door.
    const kerb: RectPx = { x: 0, y: 0, w: 128, h: 22 };
    const atWestJamb = { x: 2, y: kerb.h + 6 };
    const atCentre = { x: 64, y: kerb.h + 6 };
    expect(nearness(kerb, atWestJamb)).toBe(nearness(kerb, atCentre));
    expect(nearness(kerb, atWestJamb)).toBe(1);
  });

  it('is 1 for a point INSIDE the footprint — a player in the passage is not at distance', () => {
    expect(nearness(DOOR, { x: DOOR.x + 1, y: DOOR.y + 1 })).toBe(1);
  });
});

describe('tickDoors', () => {
  it('steps only the doors that meet the view, and hands each its own nearness', () => {
    const onScreen = fake();
    const offScreen = fake();
    const rects: RectPx[] = [DOOR, { ...DOOR, x: 9000 }];
    tickDoors(16, [onScreen, offScreen], rects, VIEW, { x: DOOR.x, y: DOOR.y });
    expect(onScreen.tick).toHaveBeenCalledTimes(1);
    expect(onScreen.tick).toHaveBeenCalledWith(16, 1);
    // Not "ticked with a zero" — not ticked AT ALL. A door's motion costs a Graphics rebuild, and
    // a floor is co-resident: all of level 1's 24 doors are built into one world.
    expect(offScreen.tick).not.toHaveBeenCalled();
  });

  it('ticks everything when there is no camera rect yet', () => {
    const a = fake();
    const b = fake();
    tickDoors(16, [a, b], [DOOR, { ...DOOR, x: 9000 }], null, null);
    expect(a.tick).toHaveBeenCalledTimes(1);
    expect(b.tick).toHaveBeenCalledTimes(1);
  });

  it('ticks at nearness 0 with no player, rather than skipping — a door keeps breathing', () => {
    const d = fake();
    tickDoors(16, [d], [DOOR], VIEW, null);
    expect(d.tick).toHaveBeenCalledWith(16, 0);
  });

  it('skips a fixture with no recorded footprint instead of throwing', () => {
    const d = fake();
    tickDoors(16, [d], [], VIEW, { x: 0, y: 0 });
    expect(d.tick).not.toHaveBeenCalled();
  });
});

describe('isRefused — the client-derived "you cannot get through that"', () => {
  /** Pressed against the door's south face, stopped dead. */
  const stuck = { x: DOOR.x + DOOR.w / 2, y: DOOR.y + DOOR.h + 8, dx: 0, dy: 0 };
  /** Pushing NORTH, i.e. into the passage (screen y grows southward). */
  const intoDoor = { rad: -Math.PI / 2, mag: 200 };

  it('fires when all three conditions hold', () => {
    expect(isRefused(DOOR, true, stuck, intoDoor)).toBe(true);
  });

  it('needs the door to be locked', () => {
    expect(isRefused(DOOR, false, stuck, intoDoor)).toBe(false);
  });

  it('needs the player to be pressing, not just standing there', () => {
    expect(isRefused(DOOR, true, stuck, { rad: intoDoor.rad, mag: 0 })).toBe(false);
    expect(isRefused(DOOR, true, stuck, { rad: intoDoor.rad, mag: 30 })).toBe(false);
  });

  it('needs the push to point INTO the door, not along or away from it', () => {
    // Away (south) and sideways (east) both have to fail, or the flash fires on anyone who walks
    // past a doorway with their back to it.
    expect(isRefused(DOOR, true, stuck, { rad: Math.PI / 2, mag: 200 })).toBe(false);
    expect(isRefused(DOOR, true, stuck, { rad: 0, mag: 200 })).toBe(false);
  });

  it('needs the player to be STOPPED — this is what tells being blocked from walking past', () => {
    // The sim has already resolved the collision, so a blocked player's position stops changing.
    // That is the entire signal, and without it every player crossing a doorway gets a flash.
    expect(isRefused(DOOR, true, { ...stuck, dx: 2 }, intoDoor)).toBe(false);
    expect(isRefused(DOOR, true, { ...stuck, dy: -1.5 }, intoDoor)).toBe(false);
    expect(isRefused(DOOR, true, { ...stuck, dx: 0.2 }, intoDoor)).toBe(true); // sub-pixel jitter still counts as stopped
  });

  it('needs the player to be within reach of the footprint', () => {
    expect(isRefused(DOOR, true, { ...stuck, y: DOOR.y + DOOR.h + 60 }, intoDoor)).toBe(false);
  });
});

describe('DoorFxDriver', () => {
  const cam = () => ({
    worldView: { x: 0, y: 0, width: 800, height: 600 },
    addShake: vi.fn((_amount: number): void => undefined),
  });
  const target = () => ({
    tickFixtures: vi.fn(
      (
        _dt: number,
        _view: CameraRect | null,
        _playerPx: { x: number; y: number } | null,
        _lights?: TorchLightSink,
      ): void => undefined,
    ),
    doorFootprint: vi.fn((_i: number): RectPx | null => DOOR),
    rejectDoor: vi.fn((_i: number): void => undefined),
  });
  const player = { curX: DOOR.x + DOOR.w / 2, curY: DOOR.y + DOOR.h + 8, prevX: DOOR.x + DOOR.w / 2, prevY: DOOR.y + DOOR.h + 8 };
  const push = { rad: -Math.PI / 2, mag: 200 };

  it('converts the camera rect it is given into the fixture pass own shape', () => {
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    d.frame(16, [], t, c, null, { rad: 0, mag: 0 });
    expect(t.tickFixtures).toHaveBeenCalledWith(16, { x: 0, y: 0, w: 800, h: 600 }, null, undefined);
  });

  it("hands the fixture pass the camera's light registry, when it has one", () => {
    const d = new DoorFxDriver();
    const t = target();
    const lights = { addPersistent: vi.fn(), removePersistent: vi.fn() };
    d.frame(16, [], t, { ...cam(), lights }, null, { rad: 0, mag: 0 });
    expect(t.tickFixtures).toHaveBeenCalledWith(16, { x: 0, y: 0, w: 800, h: 600 }, null, lights);
  });

  it('flashes the refused door and shakes the camera, exactly once', () => {
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    d.frame(16, [{ locked: true }], t, c, player, push);
    expect(t.rejectDoor).toHaveBeenCalledWith(0);
    expect(c.addShake).toHaveBeenCalledTimes(1);
  });

  it('debounces, so holding a direction into a door shoves rather than strobes', () => {
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    for (let i = 0; i < 12; i++) d.frame(16, [{ locked: true }], t, c, player, push);
    // 12 frames of 16 ms is 192 ms — well inside the 450 ms cooldown, so exactly one shove.
    expect(t.rejectDoor).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) d.frame(16, [{ locked: true }], t, c, player, push);
    expect(t.rejectDoor).toHaveBeenCalledTimes(2); // ...and a second one once the clock ran out
  });

  it('still steps the fixtures when there is no player, and shakes nothing', () => {
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    d.frame(16, [{ locked: true }], t, c, null, push);
    expect(t.tickFixtures).toHaveBeenCalledTimes(1);
    expect(t.rejectDoor).not.toHaveBeenCalled();
    expect(c.addShake).not.toHaveBeenCalled();
  });

  it('is a no-op on an arena, whose doors live in arenaMap and build no fixtures', () => {
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    d.frame(16, [], t, c, player, push);
    expect(t.rejectDoor).not.toHaveBeenCalled();
    expect(t.tickFixtures).toHaveBeenCalledTimes(1); // the fixture pass still runs
  });

  it('shakes once for a frame in which two doors both refuse', () => {
    // Two doors of one room lock as a unit (design/05), so a player wedged in a corner between
    // them is a real case — and two shakes for one shove would read as a hit.
    const d = new DoorFxDriver();
    const t = target();
    const c = cam();
    d.frame(16, [{ locked: true }, { locked: true }], t, c, player, push);
    expect(t.rejectDoor).toHaveBeenCalledTimes(2);
    expect(c.addShake).toHaveBeenCalledTimes(1);
  });
});
