/**
 * `doorFx.ts` — one door's motion, assembled.
 *
 * The claim this file exists to pin is the DIRECTION one, because it is the whole design and it is
 * the one thing no other test can see. `doorFx`'s own doc says a locked door's motion is CONTAINED
 * (flame rises inside the leaf, the scan bar bounces between the jambs, the floor pulse travels
 * INWARD) and an open door's CROSSES the threshold (light streams down and out, motes drift onto
 * the floor, the pulse travels OUTWARD). Every one of those is a sign — of a scroll delta, of a
 * radius delta — and a sign is exactly what survives a refactor looking correct while being
 * backwards. Two of the three sign pairs here are literally one character apart in the source.
 *
 * The rest is the state machine around it: the crossfade, the one-shot burst, the refusal flash,
 * the proximity ramp, and the x-ray proxy that exists because `occlusion.fadeGroup` and this class
 * would otherwise both own the same `alpha`.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics, Sprite, TilingSprite } from 'pixi.js';
import { DoorFx, type DoorFxParts } from './doorFx';
import { doorFloorPlane, GLOW_POOL_SQUASH, type DoorFloorPlane } from './doorLights';
import { MOTE_COUNT, PERIODS_MS } from './doorMotion';
import { resetActiveQuality, setActiveQuality } from '../../render/quality';

const OPENING_W = 64;
const OPENING_H = 94;
const BAND = { x: 12, y: -76, w: 40, h: 58 };
const TRANSITION_MS = 350; // `doorFx.TRANSITION_MS`, restated so a wrong value there fails here

/** A door's fx with plain Containers standing in for the still layers `buildDoorBlock` hands over.
 *  `base`/`lit` are read off each node's alpha at construction, so these are set beforehand. */
function build(locked: boolean, index = 0, plane?: DoorFloorPlane): { fx: DoorFx; parts: Required<DoorFxParts> } {
  const layer = (alpha: number): Container => {
    const c = new Container();
    c.alpha = alpha;
    return c;
  };
  const parts = {
    leafGhost: new Sprite(),
    lockedBase: [layer(1)],
    lockedLit: [layer(0.8)],
    openBase: [layer(1), layer(0.9)],
    openLit: [layer(0.7), layer(0.6)],
  };
  return { fx: new DoorFx(OPENING_W, OPENING_H, BAND, parts, index, locked, plane), parts };
}

const tilesOf = (c: Container): TilingSprite[] => c.children.filter((k): k is TilingSprite => k instanceof TilingSprite);
const graphicsOf = (c: Container): Graphics[] => c.children.filter((k): k is Graphics => k instanceof Graphics);

/** Every point of every STROKED path in `g`, as `[x, y]`. The floor rings are stroked ellipse
 *  segments (`doorLights.strokeFloorArc`), not `ellipse` calls, so their radius has to be read back
 *  off the geometry — which is the better measurement anyway: it is the span actually drawn, not the
 *  argument that was passed.
 *
 *  Stroked ONLY, and that filter is load-bearing: Pixi emits a `moveTo(0, 0)` of its own ahead of
 *  every `circle` after the first, so an unfiltered read picks up one phantom point at the origin
 *  per mote. Those are what let the southern-half assertion below pass on a plane whose ring is
 *  nowhere near y = 0 — a test passing on points no ring drew. */
function pathPoints(g: Graphics): number[][] {
  type Ins = { action: string; data: { path?: { instructions: { action: string; data: number[] }[] } } };
  return (g.context.instructions as unknown as Ins[])
    .filter((ins) => ins.action === 'stroke')
    .flatMap((ins) =>
      (ins.data.path?.instructions ?? [])
        .filter((i) => i.action === 'moveTo' || i.action === 'lineTo')
        .map((i) => i.data),
    );
}

/** Half the horizontal span of `g`'s stroked path — the floor ring's own `rx`. NaN when nothing
 *  is drawn, so a test asking for a radius that is not there fails rather than reading a zero. */
function arcRadius(g: Graphics): number {
  const xs = pathPoints(g).map((p) => p[0]!);
  return xs.length ? (Math.max(...xs) - Math.min(...xs)) / 2 : NaN;
}

/** Every `circle`, as `[cx, cy, r]` — the motes. */
function circles(g: Graphics): number[][] {
  type Ins = { data: { path?: { instructions: { action: string; data: number[] }[] } } };
  return (g.context.instructions as unknown as Ins[]).flatMap((ins) =>
    (ins.data.path?.instructions ?? []).filter((i) => i.action === 'circle').map((i) => i.data),
  );
}

describe('direction — the channel the whole cue rests on', () => {
  it('scrolls a locked door flame UP, contained inside the leaf', () => {
    const { fx } = build(true);
    const [flameA, flameB] = tilesOf(fx.over);
    fx.tick(200, 0);
    const a1 = flameA!.tilePosition.y;
    const b1 = flameB!.tilePosition.y;
    fx.tick(200, 0);
    // Screen y grows downward, so rising fire means a DECREASING tile offset. Both layers, because
    // one of them scrolling the wrong way is a shear, not a flame.
    expect(flameA!.tilePosition.y).toBeLessThan(a1);
    expect(flameB!.tilePosition.y).toBeLessThan(b1);
  });

  it('scrolls an open door light DOWN and OUT of the passage — the opposite sign', () => {
    const { fx } = build(false);
    const [streamA, streamB] = tilesOf(fx.behind);
    fx.tick(200, 0);
    const a1 = streamA!.tilePosition.y;
    const b1 = streamB!.tilePosition.y;
    fx.tick(200, 0);
    expect(streamA!.tilePosition.y).toBeGreaterThan(a1);
    expect(streamB!.tilePosition.y).toBeGreaterThan(b1);
  });

  it('gives the two flame layers different rates, so the pair never draws one shape twice', () => {
    const { fx } = build(true);
    const [flameA, flameB] = tilesOf(fx.over);
    fx.tick(500, 0);
    expect(Math.abs(flameA!.tilePosition.y)).not.toBeCloseTo(Math.abs(flameB!.tilePosition.y), 1);
    // ...and mirrors one of them, so even at a matching offset they are not the same field.
    expect(Math.sign(flameA!.tileScale.x)).toBe(-Math.sign(flameB!.tileScale.x));
  });

  it('stacks the second flame layer over the band own lower part — density at the base, pinned', () => {
    const { fx } = build(true);
    const [flameA, flameB] = tilesOf(fx.over);
    expect(flameA!.height).toBeCloseTo(BAND.h);
    expect(flameB!.height).toBeLessThan(BAND.h);
    // Bottom-anchored: both end at the band's floor, so the overlap is the low end.
    expect(flameA!.y + flameA!.height).toBeCloseTo(flameB!.y + flameB!.height);
    expect(flameB!.y).toBeGreaterThan(flameA!.y);
  });

  it('bounces the scan bar between the jambs instead of wrapping past one', () => {
    const { fx } = build(true);
    const scan = fx.over.children.find((c): c is Sprite => c instanceof Sprite)!;
    const xs: number[] = [];
    for (let i = 0; i <= PERIODS_MS.scan; i += PERIODS_MS.scan / 8) {
      fx.tick(PERIODS_MS.scan / 8, 0);
      xs.push(scan.x);
    }
    // Inside the band at every sample — a wrap or an unclamped sweep puts it past a jamb.
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(BAND.x - 0.01);
      expect(x + scan.width).toBeLessThanOrEqual(BAND.x + BAND.w + 0.01);
    }
    // And it comes back: the travel is not monotone over one period.
    const rising = xs.slice(1).filter((x, i) => x > xs[i]!).length;
    expect(rising).toBeGreaterThan(0);
    expect(rising).toBeLessThan(xs.length - 1);
  });

  it('travels an open door floor pulse OUTWARD and a locked one INWARD', () => {
    // One symbol, opposite signs. The pool shape is shared with `doorLights.GLOW_POOL` deliberately
    // (colour says which state); this ring's direction is the part that says "come through" vs
    // "pushed back", and it is a `s` where the other is a `1 - s`.
    // The pulse is the only Graphics drawing a stroked arc on a settled door (the burst is idle),
    // so "the one with a path" identifies it without depending on child order.
    const radiusAt = (fx: DoorFx, ms: number): number => {
      fx.tick(ms, 1);
      return Math.max(...graphicsOf(fx.over).map(arcRadius).filter((r) => !Number.isNaN(r)));
    };
    const open = build(false).fx;
    const openEarly = radiusAt(open, PERIODS_MS.pulse * 0.25);
    const openLate = radiusAt(open, PERIODS_MS.pulse * 0.35);
    expect(openLate).toBeGreaterThan(openEarly);

    const locked = build(true).fx;
    const lockedEarly = radiusAt(locked, PERIODS_MS.pulse * 0.25);
    const lockedLate = radiusAt(locked, PERIODS_MS.pulse * 0.35);
    expect(lockedLate).toBeLessThan(lockedEarly);
  });

  it('keeps both floor rings SOUTH of the threshold, never up the door own stone', () => {
    // A full ellipse centred on the threshold puts half its stroke over the hazard leaf and the
    // flanking wall. Caught on a live frame, where it read as a stray red line through the
    // masonry — `doorLights.GLOW_POOL` gets away with a full ellipse only because it is nine
    // fills at 0.035 alpha, and a stroke has nowhere to hide.
    const { fx } = build(true);
    fx.setLocked(false, true); // both rings live at once, mid-transition
    fx.tick(80, 1);
    const pts = graphicsOf(fx.over).flatMap(pathPoints);
    expect(pts.length).toBeGreaterThan(20);
    for (const [, y] of pts) expect(y!).toBeGreaterThanOrEqual(0);
  });

  it('puts both floor rings BESIDE the doorway for a door cut through a north-south wall', () => {
    // The other half of the same claim, and the bug that made the plane exist: south of THAT door's
    // threshold is the same wall continuing, so a southern half-ellipse is drawn onto stone that
    // Y-sorts in front of it — on a live frame, a ring with its middle bitten out. The plane moves
    // both rings onto the floor either side of the passage, where the player actually walks.
    // `doorFloorPlaneCoverage.test.ts` measures the shipped floors; this pins that the fixture's
    // own rings read the plane at all, which no assertion on `strokeFloorArc` can show.
    const plane = doorFloorPlane({ x: 0, y: 0, w: OPENING_W, h: 128 }, OPENING_H);
    const { fx } = build(true, 0, plane);
    fx.setLocked(false, true); // both rings live at once, mid-transition
    fx.tick(80, 1);
    const pts = graphicsOf(fx.over).flatMap(pathPoints);
    expect(pts.length).toBeGreaterThan(20);
    // Every point clear of the wall's own column — that column is the stone standing in front.
    for (const [x] of pts) expect(Math.abs(x! - plane.cx)).toBeGreaterThanOrEqual(plane.cx - 1e-9);
    // Both lobes present (a ring on ONE side would read as a door facing the wrong way), and all of
    // it around the DRAWN opening's own middle rather than hanging off the threshold — every lobe
    // is symmetric about `cy`, so the mean of the samples is exactly it. Half the PASSAGE's depth
    // (-64 here) is where the first version centred them, which reads as a ring floating above the
    // arch: `expect(cy)` is what fails against that code.
    expect(pts.some(([x]) => x! > plane.cx)).toBe(true);
    expect(pts.some(([x]) => x! < plane.cx)).toBe(true);
    expect(plane.cy).toBe(-OPENING_H / 2);
    expect(pts.reduce((sum, [, y]) => sum + y!, 0) / pts.length).toBeCloseTo(plane.cy, 6);
  });

  it('sizes both travelling rings off the plane span, not off the raw opening width', () => {
    // The 2026-09-04 reach, at the fixture rather than in the plane's own arithmetic. `drawPulse`
    // and `drawBurst` used to multiply `this.openingW` directly — proportional to the door and
    // still 2.6 and 3.3 door widths across, which is the report this pass exists for. The ceilings
    // below are what that arithmetic fails: on this fixture the pre-plane pulse reaches 83.2 px
    // against the plane's 45.8, and the burst 105.6 against 58.1. Measured off the drawn geometry
    // (max |x - cx| over the stroked points IS the ring's own rx), never off the argument.
    const plane = doorFloorPlane({ x: 0, y: 0, w: OPENING_W, h: 128 }, OPENING_H);
    const reach = (fx: DoorFx): number =>
      Math.max(0, ...graphicsOf(fx.over).flatMap(pathPoints).map(([x]) => Math.abs(x! - plane.cx)));

    const { fx } = build(false, 0, plane);
    let widest = 0;
    for (let i = 0; i < 24; i++) {
      fx.tick(PERIODS_MS.pulse / 24, 1); // one whole period, so the widest ring in the cycle is seen
      widest = Math.max(widest, reach(fx));
    }
    expect(widest).toBeGreaterThan(plane.cx); // it does come out of the wall at all
    expect(widest).toBeLessThanOrEqual(plane.span * 1.3 + 1e-6);
    expect(plane.span * 1.3).toBeLessThan(OPENING_W * 1.3); // ...and the old radius is outside that

    // The burst reaches further on purpose — an event, not a heartbeat — but off the same span.
    const burst = build(true, 0, plane).fx;
    burst.setLocked(false, true);
    let widestBurst = 0;
    for (let i = 0; i < 12; i++) {
      burst.tick(TRANSITION_MS / 12, 1);
      widestBurst = Math.max(widestBurst, reach(burst));
    }
    expect(widestBurst).toBeGreaterThan(plane.cx);
    expect(widestBurst).toBeLessThanOrEqual(plane.span * 1.65 + 1e-6);
  });

  it('runs a travelling ring along the door own long edge, on every Graphics that draws one', () => {
    // The 2026-09-11 report — *"这个椭圆的长边要和门的长边保持一致"* — at the FIXTURE, which is where
    // the reporter was looking: the two arcs flanking a doorway are this class's pulse and burst,
    // not the pool. `doorFloorPlaneCoverage` pins the shape `strokeFloorArc` draws; nothing pinned
    // that these rings carry the plane's aspect INTO it, and a mutation run proved the gap — with
    // `drawPulse` handed `{ ...this.plane, aspect: GLOW_POOL_SQUASH }`, all 1383 scene tests stayed
    // green while every travelling ring in the game went back to lying across its door.
    //
    // Measured off the drawn geometry, never off the argument. A ring's own `rx` is the widest
    // `|x - cx|` it strokes; its y-reach is then FIXED by the aspect — `ry * sin(acos(cx / rx))` on
    // a `sides` plane (the lobes are cut off before the ellipse's own extreme y, which is where the
    // wall stands) and `ry` itself on a `south` one (the southern half runs through it). Both
    // extremes are sampled exactly by `ARC_SEGS`, so this is an equality, not a bound.
    type Reach = { drawn: number; want: number; wantPreFix: number };
    const yReach = (g: Graphics, plane: DoorFloorPlane): Reach | null => {
      const pts = pathPoints(g);
      if (pts.length < 2) return null;
      const rx = Math.max(...pts.map(([x]) => Math.abs(x! - plane.cx)));
      const drawn = Math.max(...pts.map(([, y]) => Math.abs(y! - plane.cy)));
      const cut = plane.floor === 'sides' ? Math.sin(Math.acos(Math.min(1, plane.cx / rx))) : 1;
      return { drawn, want: rx * plane.aspect * cut, wantPreFix: rx * GLOW_POOL_SQUASH * cut };
    };
    const check = (fx: DoorFx, plane: DoorFloorPlane, expectRings: number): void => {
      const seen = graphicsOf(fx.over)
        .map((g) => yReach(g, plane))
        .filter((r): r is Reach => r !== null);
      expect(seen.length).toBeGreaterThanOrEqual(expectRings);
      for (const { drawn, want, wantPreFix } of seen) {
        expect(drawn).toBeCloseTo(want, 6);
        // ...and NOT what the pre-2026-09-11 foreshortening would have drawn — 3.2x shorter on this
        // door. Skipped for a `south` plane, whose aspect IS that constant: there the line above is
        // already the whole claim, and this one would contradict it.
        if (plane.floor === 'sides') expect(drawn).toBeGreaterThan(wantPreFix * 2);
      }
    };

    // A door cut through a north-south wall: taller than wide, so its rings are too.
    const sides = doorFloorPlane({ x: 0, y: 0, w: OPENING_W, h: 128 }, OPENING_H);
    expect(sides.aspect).toBeGreaterThan(1);
    const open = build(false, 0, sides).fx;
    open.tick(PERIODS_MS.pulse * 0.5, 1); // mid-flight: the pulse is well clear of the wall
    check(open, sides, 1);

    // ...and with the lock-change burst live as well, so the one-shot ring is covered too — it is a
    // second Graphics, and `check` asserts every one of them rather than the widest.
    const flipping = build(true, 0, sides).fx;
    flipping.setLocked(false, true);
    flipping.tick(TRANSITION_MS * 0.5, 1);
    check(flipping, sides, 2);

    // The control: the 11 east-west doors keep the floor foreshortening, and their rings stay
    // flatter than they are wide. Without this a "just stretch every ring" fix passes.
    const south = doorFloorPlane({ x: 0, y: 0, w: 128, h: 64 }, 104);
    expect(south.aspect).toBeLessThan(1);
    const southFx = build(false, 0, south).fx;
    southFx.tick(PERIODS_MS.pulse * 0.5, 1);
    check(southFx, south, 1);
  });

  it('carries motes out of the doorway toward the player, growing as they come', () => {
    const { fx } = build(false);
    fx.tick(16, 1);
    const motes = graphicsOf(fx.over).map(circles).find((c) => c.length > 0)!;
    expect(motes.length).toBeGreaterThan(1);
    // A mote deeper in the passage (more negative y) is smaller than one near the threshold.
    const sorted = [...motes].sort((a, b) => a[1]! - b[1]!);
    expect(sorted[0]![2]!).toBeLessThan(sorted[sorted.length - 1]![2]!);
    // All of them inside the arch hole, never over a jamb.
    for (const [cx] of motes) {
      expect(cx!).toBeGreaterThan(OPENING_W * 0.2);
      expect(cx!).toBeLessThan(OPENING_W * 0.8);
    }
  });

  it('thins the motes on the low tier, and never below one', () => {
    // The only per-frame REDRAW in the pass, so the only part with a cost worth a lever — and it
    // rides the `particleBudget` the quality profile already carries rather than a new tier field.
    // The floor of one matters: the open state's "things come OUT of here" is a legibility cue,
    // and a tier that turned it off entirely would take the cue away from the device tier alone.
    const count = (): number => {
      const { fx } = build(false);
      fx.tick(16, 1);
      return graphicsOf(fx.over).flatMap(circles).length;
    };
    expect(count()).toBe(MOTE_COUNT);
    setActiveQuality('low');
    try {
      const low = count();
      expect(low).toBeLessThan(MOTE_COUNT);
      expect(low).toBeGreaterThanOrEqual(1);
    } finally {
      resetActiveQuality();
    }
    expect(count()).toBe(MOTE_COUNT); // ...and back, so the tier is a lever and not a latch
  });

  it('draws no motes for a locked door', () => {
    const { fx } = build(true);
    fx.tick(16, 1);
    expect(graphicsOf(fx.over).flatMap(circles)).toHaveLength(0);
  });
});

describe('the lock-state change is an event, not a boolean', () => {
  it('crossfades the outgoing leaf out over the transition and then unmounts the ghost', () => {
    const { fx, parts } = build(true);
    expect(parts.leafGhost.visible).toBe(false); // nothing to come from on a fresh build
    fx.setLocked(false, true);
    fx.tick(16, 0);
    expect(parts.leafGhost.visible).toBe(true);
    const early = parts.leafGhost.alpha;
    fx.tick(TRANSITION_MS / 2, 0);
    expect(parts.leafGhost.alpha).toBeLessThan(early);
    fx.tick(TRANSITION_MS, 0);
    expect(parts.leafGhost.visible).toBe(false);
  });

  it('clears the OUTGOING state early, so the eye lands on the state that is arriving', () => {
    // `outW` is squared and `inW` is not. A linear pair passes every other assertion here (the
    // ghost still fades, both groups are still mounted, it still settles) and reads as a dissolve
    // between two equal things, which a door swapping states is not. Found by the 2026-09-03b
    // mutation battery, which is also where "the ghost fades" turned out to be the only thing the
    // suite could see about the crossfade's SHAPE.
    const { fx, parts } = build(true);
    fx.setLocked(false, true);
    fx.tick(TRANSITION_MS / 2, 0);
    const outgoing = parts.lockedLit[0]!.alpha / 0.8; // undo the layer's own base intensity
    const incoming = parts.openLit[0]!.alpha / 0.7;
    expect(outgoing).toBeLessThan(incoming * 0.75);
  });

  it('mounts BOTH states for the transition and exactly one once settled', () => {
    const { fx, parts } = build(true);
    const mounted = (): [boolean, boolean] => [
      parts.lockedLit[0]!.visible,
      parts.openLit[0]!.visible,
    ];
    expect(mounted()).toEqual([true, false]);
    fx.setLocked(false, true);
    fx.tick(16, 0);
    expect(mounted()).toEqual([true, true]);
    fx.tick(TRANSITION_MS, 0);
    expect(mounted()).toEqual([false, true]);
  });

  it('throws off one ring, and it expands on unlock and contracts on lock', () => {
    // The burst is the LAST Graphics in `over` — the ambient pulse also draws exactly one ellipse
    // and, during a transition, in the same colour on the locking side, so neither width nor tint
    // can tell them apart. Coupled to the child order deliberately, and the degenerate-band case
    // below is what keeps that order asserted from the other end.
    const ringAt = (fx: DoorFx, ms: number): number => {
      fx.tick(ms, 0);
      return arcRadius(graphicsOf(fx.over).at(-1)!);
    };
    const unlocking = build(true).fx;
    unlocking.setLocked(false, true);
    const u1 = ringAt(unlocking, 40);
    const u2 = ringAt(unlocking, 120);
    expect(u2).toBeGreaterThan(u1);

    const locking = build(false).fx;
    locking.setLocked(true, true);
    const l1 = ringAt(locking, 40);
    const l2 = ringAt(locking, 120);
    expect(l2).toBeLessThan(l1);
  });

  it('snaps with no ghost and no ring when told not to animate', () => {
    const { fx, parts } = build(true);
    fx.setLocked(false, false);
    fx.tick(16, 0);
    expect(parts.leafGhost.visible).toBe(false);
    expect(parts.lockedLit[0]!.visible).toBe(false); // settled immediately
    expect(parts.openLit[0]!.visible).toBe(true);
  });

  it('ignores a setLocked to the state it is already settled in', () => {
    const { fx, parts } = build(true);
    fx.tick(16, 0);
    fx.setLocked(true, true);
    fx.tick(16, 0);
    expect(parts.leafGhost.visible).toBe(false);
    expect(parts.openLit[0]!.visible).toBe(false);
  });
});

describe('reaction — the channel a still door could not have', () => {
  it('brightens the LIT layers as the player approaches and leaves the base layers alone', () => {
    const { fx, parts } = build(false);
    fx.tick(16, 0);
    const litFar = parts.openLit[0]!.alpha;
    const baseFar = parts.openBase[0]!.alpha;
    // Same clock instant on both samples, so the breath cannot be what moved.
    const { fx: near, parts: nearParts } = build(false);
    near.tick(16, 1);
    expect(nearParts.openLit[0]!.alpha).toBeGreaterThan(litFar);
    expect(nearParts.openBase[0]!.alpha).toBeCloseTo(baseFar, 6);
  });

  it('flashes a locked door that refused the player, and decays the flash', () => {
    const { fx } = build(true);
    fx.tick(16, 0);
    const flash = graphicsOf(fx.over).find((g) => g.alpha === 0)!;
    expect(flash).toBeDefined();
    fx.reject();
    fx.tick(16, 0);
    const hot = flash.alpha;
    expect(hot).toBeGreaterThan(0.1);
    fx.tick(150, 0);
    expect(flash.alpha).toBeLessThan(hot);
    fx.tick(300, 0);
    expect(flash.alpha).toBe(0);
  });

  it('refuses nobody when open', () => {
    const { fx } = build(false);
    fx.reject();
    fx.tick(16, 0);
    for (const g of graphicsOf(fx.over)) expect(g.alpha).toBeLessThanOrEqual(1);
    // The flash layer only exists on the locked side; assert it never lights while open.
    fx.setLocked(true, false);
    fx.tick(16, 0);
    const flash = graphicsOf(fx.over).find((g) => g.alpha === 0);
    expect(flash).toBeDefined(); // still idle — the reject() above did not latch
  });
});

describe('the x-ray proxy — one writer per alpha', () => {
  it('scales every layer it owns by the fade the occlusion group writes to the proxy', () => {
    const { fx, parts } = build(false);
    fx.tick(16, 1);
    const before = [parts.openLit[0]!.alpha, parts.openBase[0]!.alpha];
    // Exactly what `occlusion.fadeGroup` does to its members.
    fx.xrayLayer.alpha = 0.25;
    fx.tick(0, 1);
    expect(parts.openLit[0]!.alpha).toBeCloseTo(before[0]! * 0.25, 5);
    expect(parts.openBase[0]!.alpha).toBeCloseTo(before[1]! * 0.25, 5);
  });

  it('carries the deep-fade label, so the fixture own group picks it up', () => {
    expect(build(true).fx.xrayLayer.label).toBe('xray-deep');
  });
});

describe('phase', () => {
  it('starts two doors of one room at different phases, so they do not breathe in unison', () => {
    // design/01: "Give co-located instances different start phases" — the rule `Pickup` had to
    // learn when a whole floor of loot rose and fell as one flash.
    const a = build(true, 0);
    const b = build(true, 1);
    a.fx.tick(16, 0);
    b.fx.tick(16, 0);
    expect(a.parts.lockedLit[0]!.alpha).not.toBeCloseTo(b.parts.lockedLit[0]!.alpha, 4);
  });

  it('is deterministic in the index — two clients draw the same room identically', () => {
    const a = build(true, 3);
    const b = build(true, 3);
    a.fx.tick(123, 0.5);
    b.fx.tick(123, 0.5);
    expect(a.parts.lockedLit[0]!.alpha).toBe(b.parts.lockedLit[0]!.alpha);
  });
});

describe('a degenerate band builds no flame layers at all', () => {
  it('skips the flame pair, the scan bar and the flash when the fire is cropped away', () => {
    const layer = (): Container => new Container();
    const parts = {
      leafGhost: new Sprite(),
      lockedBase: [layer()],
      lockedLit: [layer()],
      openBase: [layer()],
      openLit: [layer()],
    };
    const fx = new DoorFx(OPENING_W, OPENING_H, { x: 0, y: 0, w: 40, h: 0 }, parts, 0, true);
    fx.tick(16, 1);
    expect(tilesOf(fx.over)).toHaveLength(0);
    expect(fx.over.children.filter((c) => c instanceof Sprite)).toHaveLength(0);
    // ...and the open state's streams are unaffected: they do not depend on the leaf art at all.
    expect(tilesOf(fx.behind)).toHaveLength(2);
  });
});
