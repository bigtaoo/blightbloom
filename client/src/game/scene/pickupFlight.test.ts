/**
 * The collected-drop flight (`pickupFlight.ts`) — the curve and the layer that drives it.
 *
 * What these tests are built to catch is the failure mode a "does it animate?" test cannot see:
 * a flight that runs, ends in the right place, and has quietly become a STRAIGHT LINE. Every
 * constant in that file (the bow, the pop, the hop, the shrink) can be zeroed one at a time
 * without moving either endpoint, so each one is asserted as a SHAPE — the path leaves the
 * straight line by a real number of px, the drop is further from its collector after 50 ms than
 * it was at rest, the arc peaks in its first half — rather than by restating the constant.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { Entity } from './Entity';
import { PickupFlightLayer, flightPose, FLIGHT_MS, type FlightPoint } from './pickupFlight';

const FROM: FlightPoint = { x: 100, y: 200, z: 9 };
const TO: FlightPoint = { x: 220, y: 200, z: 24 };

/** Screen position of a pose: the renderer shears (x, y, z) -> (x, y - z)
 *  (`Entity.applyTransform`), so THIS is where a curve either exists or does not. Measuring the
 *  bow in the ground plane instead is how the first cut of this file shipped a "curve" that a
 *  live 28 px pickup drew as a straight line 0.5 px off true: the ground bow and the hop are the
 *  same screen axis pointing opposite ways, and they cancelled. */
function screen(p: { x: number; y: number; z: number }): { x: number; y: number } {
  return { x: p.x, y: p.y - p.z };
}

/** Signed distance of the DRAWN pose at `t` from the straight screen line between the flight's
 *  own drawn endpoints — the one number that tells a curve from a tween. */
function offLine(t: number, sign = 1, from = FROM, to = TO): number {
  const a = screen(from);
  const b = screen(to);
  const p = screen(flightPose(t, from, to, sign));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return ((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}

/** The peak absolute deviation over the body of the flight. */
function bow(from: FlightPoint, to: FlightPoint, sign = 1): number {
  return Math.max(...[0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((t) => Math.abs(offLine(t, sign, from, to))));
}

function distanceToTarget(t: number): number {
  const p = flightPose(t, FROM, TO, 1);
  return Math.hypot(TO.x - p.x, TO.y - p.y);
}

describe('flightPose — the endpoints are exact', () => {
  it('starts exactly on the drop, at rest: no scale, no fade, no tilt', () => {
    const p = flightPose(0, FROM, TO, 1);
    expect(p.x).toBeCloseTo(FROM.x, 6);
    expect(p.y).toBeCloseTo(FROM.y, 6);
    expect(p.z).toBeCloseTo(FROM.z, 6); // the hop is 0 at both ends, so this is the hover height
    expect(p.scale).toBeCloseTo(1, 6);
    expect(p.alpha).toBe(1);
    expect(p.rotation).toBeCloseTo(0, 6);
  });

  it('ends exactly on the collector, shrunk and fully faded out', () => {
    const p = flightPose(1, FROM, TO, 1);
    expect(p.x).toBeCloseTo(TO.x, 6);
    expect(p.y).toBeCloseTo(TO.y, 6);
    expect(p.z).toBeCloseTo(TO.z, 6);
    expect(p.scale).toBeLessThan(1); // it has entered the body, not landed on it
    expect(p.alpha).toBe(0);
    expect(p.rotation).toBeCloseTo(0, 6);
  });
});

describe('flightPose — the shape of the arc', () => {
  it('is a CURVE ON SCREEN, not a straight line — for an EAST-WEST flight, which bows by 0', () => {
    // Travelling along screen x, the ground perpendicular is pure ground Y, which this curve
    // deliberately does not bow in (it would cancel the hop — see `BULGE_R`). So every px of
    // deviation here is the thrown arc, and this is the test that fails if the hop is flattened
    // back into the ramp between the two heights.
    expect(bow(FROM, TO)).toBeGreaterThan(12);
  });

  it('is a CURVE ON SCREEN for a NORTH-SOUTH flight too, where the arc alone would draw a line', () => {
    // The mirror case, and the reason the sideways bow exists at all: travelling along screen y,
    // the hop moves the drop along the SAME axis as the travel, so height by itself produces a
    // straight vertical line at a varying speed. The bow in ground x is what curves it.
    const northSouth = { x: 100, y: 200 + 120, z: 24 };
    expect(bow(FROM, northSouth)).toBeGreaterThan(12);
  });

  it('still curves on the SHORT flight that auto-collection actually produces (~28 px)', () => {
    // The case the floors under `POP_BACK_MIN`/`BULGE_MIN` and the hop's own base exist for:
    // everything but a weapon is collected on overlap (`SIM.pickupRadius` + the player's body),
    // so `from` is about one body away from `to` and a purely proportional arc would be ~6 px
    // wide — 600 ms of which reads as a slide, not a flight.
    expect(bow(FROM, { x: 128, y: 200, z: 24 })).toBeGreaterThan(8);
    expect(bow(FROM, { x: 100, y: 228, z: 24 })).toBeGreaterThan(8);
  });

  it('bows to the OPPOSITE side for the other sign — two drops taken together do not overlap', () => {
    // Asserted on the north-south flight, the one the sideways bow actually shapes.
    const northSouth = { x: 100, y: 320, z: 24 };
    for (const t of [0.25, 0.5, 0.75]) {
      expect(offLine(t, -1, FROM, northSouth)).toBeCloseTo(-offLine(t, 1, FROM, northSouth), 6);
    }
    expect(bow(FROM, northSouth, -1)).toBeGreaterThan(12); // and it is a real bow on that side too
  });

  it('POPS AWAY first: the drop is further from its collector 50 ms in than it was at rest', () => {
    expect(distanceToTarget(50 / FLIGHT_MS)).toBeGreaterThan(distanceToTarget(0));
  });

  it('then closes in monotonically over the second half — no second hesitation near the body', () => {
    let last = Infinity;
    for (let t = 0.5; t <= 1.0001; t += 0.05) {
      const d = distanceToTarget(t);
      expect(d).toBeLessThan(last);
      last = d;
    }
    expect(last).toBeCloseTo(0, 6);
  });

  it('HOPS: it rises above both endpoints, tops out by mid-flight, and dives in from there', () => {
    const samples = Array.from({ length: 21 }, (_, i) => flightPose(i / 20, FROM, TO, 1).z);
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(Math.max(FROM.z, TO.z)); // an arc, not a ramp between two heights
    expect(samples.indexOf(peak) / 20).toBeLessThanOrEqual(0.5);
    // Falling through the whole last third, so the drop comes DOWN into the collector rather
    // than still climbing when it reaches them.
    for (let i = 14; i < 20; i++) expect(samples[i + 1]!).toBeLessThan(samples[i]!);
  });

  it('swells on the pop and is smallest on arrival — the drop enters the body, not lands on it', () => {
    expect(flightPose(0.25, FROM, TO, 1).scale).toBeGreaterThan(1);
    expect(flightPose(1, FROM, TO, 1).scale).toBeLessThan(flightPose(0.5, FROM, TO, 1).scale);
  });

  it('holds full opacity through the curve and fades only at the end', () => {
    expect(flightPose(0.5, FROM, TO, 1).alpha).toBe(1);
    expect(flightPose(0.7, FROM, TO, 1).alpha).toBe(1);
    expect(flightPose(0.9, FROM, TO, 1).alpha).toBeLessThan(1);
    expect(flightPose(0.9, FROM, TO, 1).alpha).toBeGreaterThan(0);
  });

  it('tilts away and back rather than tumbling — a weapon drop\'s badge stays the right way up', () => {
    expect(Math.abs(flightPose(0.5, FROM, TO, 1).rotation)).toBeGreaterThan(0);
    expect(Math.abs(flightPose(0.5, FROM, TO, 1).rotation)).toBeLessThan(Math.PI / 2);
    expect(flightPose(0.5, FROM, TO, -1).rotation).toBeCloseTo(-flightPose(0.5, FROM, TO, 1).rotation, 6);
  });

  it('a drop collected from exactly underfoot degenerates cleanly — no NaN, no division by zero', () => {
    const same = { x: 100, y: 200, z: 9 };
    for (const t of [0, 0.25, 0.5, 1]) {
      const p = flightPose(t, same, same, 1);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      expect(p.x).toBeCloseTo(same.x, 6);
      expect(p.y).toBeCloseTo(same.y, 6);
    }
    // The hop is the only motion left, and it still happens: the drop lifts and drops back in.
    expect(flightPose(0.3, same, same, 1).z).toBeGreaterThan(same.z);
  });
});

/** A view with a shadow, the same shape every real drop has (`Pickup` calls `makeShadow`). */
function makeView(): Entity {
  const v = new Entity();
  v.makeShadow(9);
  return v;
}

function makeLayer(): { layer: PickupFlightLayer; entities: Container; shadows: Container } {
  const entities = new Container();
  const shadows = new Container();
  return { layer: new PickupFlightLayer(entities, shadows), entities, shadows };
}

describe('PickupFlightLayer', () => {
  it('mounts the view and its shadow, and draws it at the drop before the first update', () => {
    const { layer, entities, shadows } = makeLayer();
    const view = makeView();
    layer.launch(view, FROM, () => TO, 1);
    expect(layer.count).toBe(1);
    expect(entities.children).toContain(view);
    expect(shadows.children).toContain(view.shadow);
    expect(view.x).toBe(FROM.x);
    expect(view.y).toBe(FROM.y - FROM.z); // screen y is the ground point minus the lift
  });

  it('arrives and destroys itself after exactly FLIGHT_MS — nothing is left mounted', () => {
    const { layer, entities, shadows } = makeLayer();
    const view = makeView();
    const shadow = view.shadow!;
    layer.launch(view, FROM, () => TO, 1);
    layer.update(FLIGHT_MS - 1);
    expect(layer.count).toBe(1);
    layer.update(1);
    expect(layer.count).toBe(0);
    expect(view.destroyed).toBe(true);
    expect(entities.children).not.toContain(view);
    expect(shadows.children).not.toContain(shadow);
  });

  it('CHASES a moving collector: the target is re-asked every frame, not captured at launch', () => {
    const { layer } = makeLayer();
    const view = makeView();
    const moving = { x: TO.x, y: TO.y, z: TO.z };
    layer.launch(view, FROM, () => moving, 1);
    layer.update(FLIGHT_MS * 0.3);
    moving.x += 300; // the collector ran off mid-flight
    layer.update(FLIGHT_MS * 0.69);
    // Within a few px of where they are NOW (t = 0.99), not of where they were at launch.
    expect(Math.abs(view.x - moving.x)).toBeLessThan(6);
    expect(Math.abs(view.x - TO.x)).toBeGreaterThan(200);
  });

  it('keeps flying at the last point it saw when the collector\'s view disappears mid-flight', () => {
    const { layer } = makeLayer();
    const view = makeView();
    let target: FlightPoint | null = { ...TO };
    layer.launch(view, FROM, () => target, 1);
    layer.update(FLIGHT_MS * 0.5);
    target = null; // the collector died / the floor was torn down
    layer.update(FLIGHT_MS * 0.49);
    expect(Number.isFinite(view.x)).toBe(true);
    expect(Math.abs(view.x - TO.x)).toBeLessThan(6); // not snapped back to the origin
  });

  it('survives a target that is already gone at launch — it flies its own arc and ends at the drop', () => {
    const { layer } = makeLayer();
    const view = makeView();
    layer.launch(view, FROM, () => null, 1);
    layer.update(FLIGHT_MS * 0.5);
    expect(Number.isFinite(view.x)).toBe(true);
    layer.update(FLIGHT_MS * 0.5);
    expect(layer.count).toBe(0);
  });

  it('flies a view with NO shadow — the layer is typed against Entity, not against a drop', () => {
    const { layer, entities, shadows } = makeLayer();
    const bare = new Entity(); // never called makeShadow
    layer.launch(bare, FROM, () => TO, 1);
    expect(shadows.children.length).toBe(0);
    layer.update(FLIGHT_MS * 0.5);
    expect(Number.isFinite(bare.x)).toBe(true);
    layer.update(FLIGHT_MS * 0.5);
    expect(entities.children.length).toBe(0);
  });

  it('fades the SHADOW with the drop — it must not slide out from under a vanished item', () => {
    const { layer } = makeLayer();
    const view = makeView();
    layer.launch(view, FROM, () => TO, 1);
    layer.update(FLIGHT_MS * 0.99);
    // Height alone would leave it around 0.5 here (`Entity`'s SHADOW_LIFT_FALLOFF over ~24 px);
    // the flight's own alpha is what takes it to nothing.
    expect(view.shadow!.alpha).toBeLessThan(0.05);
  });

  it('caps concurrent flights by finishing the OLDEST — a whole chest paying at once cannot pile up', () => {
    const { layer } = makeLayer();
    const first = makeView();
    layer.launch(first, FROM, () => TO, 1);
    for (let i = 0; i < 40; i++) layer.launch(makeView(), FROM, () => TO, 1);
    expect(layer.count).toBeLessThanOrEqual(32);
    expect(first.destroyed).toBe(true);
  });

  it('clear() drops every flight mid-air — a new run has nothing left to arrive at', () => {
    const { layer, entities } = makeLayer();
    const a = makeView();
    const b = makeView();
    layer.launch(a, FROM, () => TO, 1);
    layer.launch(b, FROM, () => TO, 1);
    layer.clear();
    expect(layer.count).toBe(0);
    expect(a.destroyed && b.destroyed).toBe(true);
    expect(entities.children.length).toBe(0);
  });
});
