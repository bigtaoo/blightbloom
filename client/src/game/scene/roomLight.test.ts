/**
 * `roomLight` — the static per-room light pool painted on the floor (2026-08-19 volume pass).
 *
 * It exists because a measured full-floor extract put every room's floor at luma 39-53, corner
 * and centre alike: there was no room-scale lighting at all, so a floor of five rooms read as
 * one flat sheet, and a black cast shadow on a near-black floor had nothing brighter to be dark
 * against. The properties worth pinning are that the falloff really is a falloff (monotonic, in
 * from the edge, reaching zero), that it scales with the room rather than being a fixed border,
 * and that it stays inside its own room — a band that overshot would darken the neighbour.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { DEFAULT_ROOM_LIGHT, drawRoomLight, insetByWalls, WARM_STONE_ROOM_LIGHT } from './roomLight';
import { drawWallShadow } from './wallRender';
import type { RectPx } from './wallGeometry';

const ROOM: RectPx = { x: 200, y: 300, w: 480, h: 480 };

interface Instr {
  action: string;
  data: {
    style?: { color: number; alpha: number; width: number };
    path?: { instructions: Array<{ action: string; data: unknown[] }> };
  };
}

/** The stroked bands drawn into `g`, as `{ alpha, width, rect }` in draw order. */
function bands(g: Graphics): Array<{ alpha: number; width: number; rect: number[] }> {
  const out: Array<{ alpha: number; width: number; rect: number[] }> = [];
  for (const i of g.context.instructions as Instr[]) {
    if (i.action !== 'stroke') continue;
    for (const pi of i.data.path?.instructions ?? []) {
      if (pi.action === 'rect') out.push({ alpha: i.data.style!.alpha, width: i.data.style!.width, rect: pi.data as number[] });
    }
  }
  return out;
}

describe('drawRoomLight — a room has a centre and it has corners', () => {
  it('darkens most at the room\'s edge and fades to nothing inward', () => {
    const b = bands(newLight(ROOM));
    expect(b.length).toBeGreaterThan(6);
    for (let i = 1; i < b.length; i++) expect(b[i]!.alpha).toBeLessThan(b[i - 1]!.alpha);
    expect(b[0]!.alpha).toBeGreaterThan(0.1); // the edge is a real darkening
    expect(b[b.length - 1]!.alpha).toBeLessThan(0.01); // ...and the inner end is nothing
  });

  it('steps inward monotonically, so the bands never overlap or leave a hole', () => {
    // Non-overlapping strokes are what let each band's alpha BE its ramp value; two overlapping
    // bands composite instead, and the ramp stops being the curve it was written as.
    const b = bands(newLight(ROOM));
    for (let i = 1; i < b.length; i++) {
      const prev = b[i - 1]!;
      const cur = b[i]!;
      expect(cur.rect[0]!).toBeCloseTo(prev.rect[0]! + prev.width, 6); // exactly one width in
      expect(cur.width).toBeCloseTo(prev.width, 6);
    }
  });

  it('stays strictly inside its own room, so it cannot darken the neighbour', () => {
    const g = newLight(ROOM);
    expect(g.bounds.minX).toBeGreaterThanOrEqual(ROOM.x);
    expect(g.bounds.minY).toBeGreaterThanOrEqual(ROOM.y);
    expect(g.bounds.maxX).toBeLessThanOrEqual(ROOM.x + ROOM.w);
    expect(g.bounds.maxY).toBeLessThanOrEqual(ROOM.y + ROOM.h);
  });

  it('scales its reach with the room, up to a cap', () => {
    // A gradient that is a fixed pixel border reads as a frame; one proportional to the room
    // reads as light. But a whole arena should not get an enormous one either, hence the cap.
    const small = reach(newLight({ x: 0, y: 0, w: 200, h: 200 }));
    const medium = reach(newLight({ x: 0, y: 0, w: 480, h: 480 }));
    const huge = reach(newLight({ x: 0, y: 0, w: 4000, h: 4000 }));
    expect(medium).toBeGreaterThan(small);
    expect(huge).toBeLessThan(medium * 3);
  });

  it('takes its reach from the SHORTER side, so a corridor is not swallowed', () => {
    // A 480x64 corridor with a 96 px falloff per side would be entirely gradient.
    const corridor = reach(newLight({ x: 0, y: 0, w: 480, h: 64 }));
    expect(corridor * 2).toBeLessThan(64);
  });

  it('stays fainter than the wall darkening it stacks with, so a corner is ambience and not a hole', () => {
    // `EDGE_ALPHA`'s own doc says why it is moderate: "a wall's base hug and its cast shadow both
    // land in this same region, and three dark things stacked in one corner reads as a hole rather
    // than as ambience". Nothing read that. A 2026-08-27 mutation battery pushed it from 0.26 to
    // 0.9 and all 3,310 client tests still passed: the band COUNT is geometry and every test above
    // pins it, the alpha is a look decision, and a geometry-shaped suite structurally cannot see
    // one. This is the reader.
    //
    // Both bounds come out of the REAL `drawWallShadow` rather than being transcribed, so
    // re-tuning the wall's shadow moves this gate with it instead of leaving it stale.
    const pool = bands(newLight(ROOM))[0]!.alpha;
    const wall = new Graphics();
    drawWallShadow(wall, { x: 0, y: 0, w: 100, h: 100 }, 40);
    const { cast, hug } = wallDarkening(wall);

    // 1. The pool is the faintest of the three. It is ambience; the crease at the wall's foot is
    //    the contact cue, and a pool that outshouts it plants the mass nowhere.
    expect(pool).toBeLessThan(hug); // today 0.24 against 0.34

    // 2. And all three composited still leave floor to see. At EDGE_ALPHA 0.9 this reads 0.93 --
    //    a black corner. The margin today is 0.71 against the 0.8 bound; if a wall re-tune eats
    //    that margin, this is the test that says so rather than a screenshot six weeks later.
    const stacked = 1 - (1 - pool) * (1 - hug) * (1 - cast);
    expect(stacked).toBeLessThan(0.8);
  });

  it('draws nothing at all for a degenerate rect rather than throwing', () => {
    expect(bands(newLight({ x: 0, y: 0, w: 0, h: 0 }))).toHaveLength(0);
  });

  it('accumulates every room onto one shared Graphics', () => {
    // RoomBuilder paints the whole floor's pools into a single ground-layer display object.
    const g = new Graphics();
    drawRoomLight(g, { x: 0, y: 0, w: 400, h: 400 });
    drawRoomLight(g, { x: 900, y: 0, w: 400, h: 400 });
    expect(g.bounds.minX).toBeLessThan(400);
    expect(g.bounds.maxX).toBeGreaterThan(900);
  });
});

describe('drawRoomLight — the warm-stone style (design/13, 2026-10-10)', () => {
  const NORTH: RectPx = { x: 200, y: 300, w: 480, h: 64 };
  const WEST: RectPx = { x: 200, y: 300, w: 32, h: 480 };

  it('is the default when no style is passed', () => {
    const g = new Graphics();
    drawRoomLight(g, ROOM, DEFAULT_ROOM_LIGHT);
    expect(bands(g)).toEqual(bands(newLight(ROOM)));
  });

  it('falls off harder and further than the default — a light floor needs a darker edge to read', () => {
    const g = new Graphics();
    drawRoomLight(g, ROOM, { ...WARM_STONE_ROOM_LIGHT, wallInset: false });
    expect(bands(g)[0]!.alpha).toBeGreaterThan(bands(newLight(ROOM))[0]!.alpha * 1.5);
    expect(reach(g)).toBeGreaterThan(reach(newLight(ROOM)));
  });

  it('starts the ramp at the foot of the walls, not under them', () => {
    const g = new Graphics();
    drawRoomLight(g, ROOM, WARM_STONE_ROOM_LIGHT, [NORTH, WEST]);
    const outer = bands(g)[0]!;
    // The outermost band's stroke straddles its own rect: its outer edge is the wall's foot.
    expect(outer.rect[0]! - outer.width / 2).toBeCloseTo(WEST.x + WEST.w, 6);
    expect(outer.rect[1]! - outer.width / 2).toBeCloseTo(NORTH.y + NORTH.h, 6);
  });

  it('ignores the walls when the style does not ask for the inset', () => {
    const g = new Graphics();
    drawRoomLight(g, ROOM, DEFAULT_ROOM_LIGHT, [NORTH, WEST]);
    expect(bands(g)).toEqual(bands(newLight(ROOM)));
  });

  it("still leaves floor to see where it stacks with a wall's crease and cast shadow", () => {
    // The default's first rule (the pool fainter than the crease) is deliberately given up here:
    // the key frame's corners ARE dark. Its second is not — a black corner is a hole in any style.
    const g = new Graphics();
    drawRoomLight(g, ROOM, WARM_STONE_ROOM_LIGHT);
    const pool = bands(g)[0]!.alpha;
    const wall = new Graphics();
    drawWallShadow(wall, { x: 0, y: 0, w: 100, h: 100 }, 40);
    const { cast, hug } = wallDarkening(wall);
    expect(1 - (1 - pool) * (1 - hug) * (1 - cast)).toBeLessThan(0.8);
  });
});

describe('insetByWalls — the floor a player can see', () => {
  const R: RectPx = { x: 0, y: 0, w: 640, h: 480 };

  it('takes each edge in to the foot of the deepest wall along it', () => {
    const walls: RectPx[] = [
      { x: 0, y: 0, w: 640, h: 64 }, // north
      { x: 0, y: 0, w: 320, h: 80 }, // a deeper stretch of north wall: it wins
      { x: 0, y: 448, w: 640, h: 32 }, // south kerb
      { x: 0, y: 0, w: 32, h: 480 }, // west
      { x: 608, y: 0, w: 32, h: 480 }, // east
    ];
    expect(insetByWalls(R, walls)).toEqual({ x: 32, y: 80, w: 576, h: 368 });
  });

  it('leaves an edge with no wall where it is — a room open onto the next', () => {
    expect(insetByWalls(R, [])).toEqual(R);
    expect(insetByWalls(R, [{ x: 0, y: 0, w: 640, h: 64 }])).toEqual({ x: 0, y: 64, w: 640, h: 416 });
  });

  it('accepts a wall a few px off the edge, and not one further in', () => {
    expect(insetByWalls(R, [{ x: 0, y: 4, w: 640, h: 60 }]).y).toBe(64);
    expect(insetByWalls(R, [{ x: 0, y: 5, w: 640, h: 60 }]).y).toBe(0);
  });

  it("ignores a wall that misses the room, and one standing across an edge rather than along it", () => {
    const outside: RectPx = { x: 700, y: 0, w: 640, h: 64 };
    const below: RectPx = { x: 0, y: 500, w: 640, h: 64 };
    // Taller than wide and touching the north edge: a side wall's end, not a north wall.
    const stub: RectPx = { x: 300, y: 0, w: 32, h: 200 };
    expect(insetByWalls(R, [outside, below, stub])).toEqual(R);
  });

  it('never returns a negative size, whatever the walls', () => {
    const r = insetByWalls(R, [
      { x: 0, y: 0, w: 640, h: 400 },
      { x: 0, y: 100, w: 640, h: 380 },
      { x: 0, y: 0, w: 400, h: 400 },
    ]);
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.h).toBe(0);
  });
});

function newLight(room: RectPx): Graphics {
  const g = new Graphics();
  drawRoomLight(g, room);
  return g;
}

/** The two darkenings `drawWallShadow` lays on the floor in the same band as a room's light pool:
 *  the cast shadow's four graduated passes composited, and the strongest base-hug crease stroke. */
function wallDarkening(g: Graphics): { cast: number; hug: number } {
  let clear = 1;
  let hug = 0;
  for (const i of g.context.instructions as Instr[]) {
    const alpha = i.data.style?.alpha ?? 0;
    if (i.action === 'fill') clear *= 1 - alpha;
    if (i.action === 'stroke') hug = Math.max(hug, alpha);
  }
  return { cast: 1 - clear, hug };
}

/** Total inward reach of the falloff = band count x band width. */
function reach(g: Graphics): number {
  const b = bands(g);
  return b.length * (b[0]?.width ?? 0);
}
