/**
 * `Minimap` itself had no dedicated test file before this pass (only the pure
 * `minimapLayout.ts` functions it wraps were tested) — "add tests for everything
 * mechanically testable" (daydayup memory), and this session changed its public
 * `update()` signature (zone → a generic `statusOf` resolver) and gave it PvE
 * wiring for the first time, so it's exactly the kind of newly-touched, previously-
 * untested file that shouldn't stay exempt just because nothing tested it before.
 *
 * `doors`/`rooms`/`dots` are private `Graphics` children — read via `view.children`
 * by fixed constructor order (`[bg, doors, rooms, dots]`), same "no public API,
 * index into children" convention `HudView.test.ts`'s `statsPanelOf` already uses.
 * Pixi v8's `Graphics` has no public "what did this draw" API and no renderer is
 * attached in plain vitest, so these tests read the internal `context.instructions`
 * log directly (verified against the actual runtime shape below, not just the type
 * declarations) — the same class of no-renderer workaround `getLocalBounds()`
 * already is elsewhere in this repo, just one level more precise (exact fill color/
 * shape instead of just aggregate bounds), which matters here because tinting IS
 * the widget's whole job.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { Minimap, type MinimapPlayer } from './Minimap';
import type { RoomStatus } from './minimapLayout';

const MAP: ArenaMap = {
  id: 'test',
  sizeGrid: { w: 20, h: 10 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
  ],
  doors: [{ roomA: 'A', roomB: 'B', passageGrid: { x: 9, y: 4, w: 2, h: 2 } }],
  spawns: [],
  eyeCandidates: [],
};

// Fixed constructor order: `view.addChild(this.bg, this.doors, this.rooms, this.dots)`.
function graphicsAt(m: Minimap, index: 0 | 1 | 2 | 3): Graphics {
  return m.view.children[index] as Graphics;
}

interface FillInstruction { color: number; alpha: number; shape: unknown }

/** Flattens `Graphics.context.instructions` into just the bits these tests need —
 * every instruction here is either a `fill` or a `stroke`, both carry a `style`
 * (color/alpha) and exactly one shape primitive (rect/circle/polygon). */
function drawnShapes(g: Graphics): FillInstruction[] {
  const ctx = g.context as unknown as { instructions: { data: { style?: { color: number; alpha: number }; path?: { shapePath: { shapePrimitives: { shape: unknown }[] } } } }[] };
  return ctx.instructions.map((ins) => ({
    color: ins.data.style!.color,
    alpha: ins.data.style!.alpha,
    shape: ins.data.path!.shapePath.shapePrimitives[0]!.shape,
  }));
}

function noPlayers(): readonly MinimapPlayer[] {
  return [];
}

describe('Minimap — room tinting (design/05 "fully-realized branching" follow-up, 2026-08-05: statusOf resolver, not a hardcoded zone read)', () => {
  it('fills one rect per room, colored by whatever statusOf returns — the caller decides, not this widget', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'danger', noPlayers());
    const rooms = drawnShapes(graphicsAt(m, 2));
    expect(rooms).toHaveLength(2);
    for (const r of rooms) expect(r.color).toBe(0x9b2c2c); // STATUS_COLOR.danger
  });

  it('can render every RoomStatus value, including the PvE-only "unvisited" bucket', () => {
    const STATUS_COLOR: Record<RoomStatus, number> = { safe: 0x2a3140, closing: 0xf6ad55, danger: 0x9b2c2c, unvisited: 0x384258 };
    for (const status of Object.keys(STATUS_COLOR) as RoomStatus[]) {
      const m = new Minimap({ w: 100, h: 100 });
      m.update(MAP, () => status, noPlayers());
      const rooms = drawnShapes(graphicsAt(m, 2));
      expect(rooms.every((r) => r.color === STATUS_COLOR[status])).toBe(true);
    }
  });

  it('dims danger and unvisited rooms (fill alpha), keeps safe/closing at full alpha', () => {
    const alphaFor = (status: RoomStatus) => {
      const m = new Minimap({ w: 100, h: 100 });
      m.update(MAP, () => status, noPlayers());
      return drawnShapes(graphicsAt(m, 2))[0]!.alpha;
    };
    expect(alphaFor('danger')).toBe(0.5);
    expect(alphaFor('unvisited')).toBe(0.4);
    expect(alphaFor('safe')).toBe(0.9);
    expect(alphaFor('closing')).toBe(0.9);
  });

  it('resolves each room\'s status independently — a fork\'s untaken sibling can read differently from its cleared hub', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, (id) => (id === 'A' ? 'safe' : 'unvisited'), noPlayers());
    const rooms = drawnShapes(graphicsAt(m, 2));
    const shapeX = (r: FillInstruction) => (r.shape as { x: number }).x;
    const a = rooms.find((r) => shapeX(r) === 0)!; // room A's rect starts at x=0
    const b = rooms.find((r) => shapeX(r) !== 0)!; // room B's rect starts at x>0
    expect(a.color).toBe(0x2a3140); // safe
    expect(b.color).toBe(0x384258); // unvisited
  });

  it('clears and redraws on every update — a second call with fewer rooms doesn\'t leave stale fills behind', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', noPlayers());
    expect(drawnShapes(graphicsAt(m, 2))).toHaveLength(2);

    const oneRoomMap: ArenaMap = { ...MAP, rooms: [MAP.rooms[0]!], doors: [] };
    m.update(oneRoomMap, () => 'safe', noPlayers());
    expect(drawnShapes(graphicsAt(m, 2))).toHaveLength(1);
  });
});

describe('Minimap — door lines', () => {
  it('strokes one line per door, connecting the two rooms\' centres', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', noPlayers());
    const doors = drawnShapes(graphicsAt(m, 1));
    expect(doors).toHaveLength(1);
    expect(doors[0]!.color).toBe(0x4c566a);
  });

  it('draws nothing when the map has no doors', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update({ ...MAP, doors: [] }, () => 'safe', noPlayers());
    expect(drawnShapes(graphicsAt(m, 1))).toHaveLength(0);
  });
});

describe('Minimap — player dots (shared by both modes; PvE gained this 2026-08-05, previously local-only)', () => {
  it('draws one dot per player with a resolved roomId, skipping players not yet placed', () => {
    const players: MinimapPlayer[] = [
      { roomId: 'A', alive: true, isLocal: true },
      { roomId: undefined, alive: true, isLocal: false }, // not yet resolved to any room
    ];
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', players);
    expect(drawnShapes(graphicsAt(m, 3))).toHaveLength(1); // only the resolved player
  });

  it('skips a player whose roomId doesn\'t match any room in the map (malformed, not thrown)', () => {
    const players: MinimapPlayer[] = [{ roomId: 'ghost', alive: true, isLocal: true }];
    const m = new Minimap({ w: 100, h: 100 });
    expect(() => m.update(MAP, () => 'safe', players)).not.toThrow();
    expect(drawnShapes(graphicsAt(m, 3))).toHaveLength(0);
  });

  it('colors the local player green, a remote alive player light, a remote downed player dark', () => {
    const players: MinimapPlayer[] = [
      { roomId: 'A', alive: true, isLocal: true },
      { roomId: 'B', alive: true, isLocal: false },
    ];
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', players);
    const dots = drawnShapes(graphicsAt(m, 3));
    expect(dots).toHaveLength(2);
    expect(dots[0]!.color).toBe(0x68d391); // local
    expect(dots[1]!.color).toBe(0xe2e8f0); // remote, alive

    const m2 = new Minimap({ w: 100, h: 100 });
    m2.update(MAP, () => 'safe', [{ roomId: 'B', alive: false, isLocal: false }]);
    expect(drawnShapes(graphicsAt(m2, 3))[0]!.color).toBe(0x718096); // remote, downed
  });

  it('draws the local player\'s dot larger than a remote one — the one non-color visual distinction', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', [{ roomId: 'A', alive: true, isLocal: true }]);
    const localRadius = (drawnShapes(graphicsAt(m, 3))[0]!.shape as { radius: number }).radius;

    const m2 = new Minimap({ w: 100, h: 100 });
    m2.update(MAP, () => 'safe', [{ roomId: 'A', alive: true, isLocal: false }]);
    const remoteRadius = (drawnShapes(graphicsAt(m2, 3))[0]!.shape as { radius: number }).radius;

    expect(localRadius).toBeGreaterThan(remoteRadius);
  });
});

// The HUD calls update() every frame, and PvE hands in a freshly CONVERTED map every frame
// (`dungeonToArenaMap`). A cleared Graphics is re-triangulated on its next render, so each layer
// redraws only when what it would draw changed (2026-09-28) — measured, the three layers were a
// real share of a run's per-frame garbage for a picture that changes a few times per room.
describe('Minimap — each layer redraws only when its own content changed', () => {
  const spies = (m: Minimap) => ({
    doors: vi.spyOn(graphicsAt(m, 1), 'clear'),
    rooms: vi.spyOn(graphicsAt(m, 2), 'clear'),
    dots: vi.spyOn(graphicsAt(m, 3), 'clear'),
  });
  const cloneMap = (): ArenaMap => JSON.parse(JSON.stringify(MAP)) as ArenaMap;
  const here: MinimapPlayer[] = [{ roomId: 'A', alive: true, isLocal: true }];

  it('an unchanged frame redraws nothing — even with a NEW map object of the same content', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', here);
    const s = spies(m);
    for (let i = 0; i < 5; i++) m.update(cloneMap(), () => 'safe', [{ ...here[0]! }]);
    expect(s.doors).not.toHaveBeenCalled();
    expect(s.rooms).not.toHaveBeenCalled();
    expect(s.dots).not.toHaveBeenCalled();
    // ...and what is on screen is still the full picture, not an emptied one.
    expect(drawnShapes(graphicsAt(m, 2))).toHaveLength(2);
    expect(drawnShapes(graphicsAt(m, 3))).toHaveLength(1);
  });

  it('a room changing status redraws the rooms and nothing else', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', here);
    const s = spies(m);
    m.update(MAP, (id) => (id === 'B' ? 'danger' : 'safe'), here);
    expect(s.rooms).toHaveBeenCalledTimes(1);
    expect(s.doors).not.toHaveBeenCalled();
    expect(s.dots).not.toHaveBeenCalled();
    expect(drawnShapes(graphicsAt(m, 2)).map((r) => r.color)).toEqual([0x2a3140, 0x9b2c2c]);
  });

  it('a player moving rooms, or changing role, redraws the dots and nothing else', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', here);
    const s = spies(m);
    m.update(MAP, () => 'safe', [{ roomId: 'B', alive: true, isLocal: true }]);
    expect(s.dots).toHaveBeenCalledTimes(1);
    m.update(MAP, () => 'safe', [{ roomId: 'B', alive: true, isLocal: false }]);
    expect(s.dots).toHaveBeenCalledTimes(2); // the local dot's size and colour are content too
    expect(s.rooms).not.toHaveBeenCalled();
    expect(s.doors).not.toHaveBeenCalled();
  });

  it('a different map redraws its doors and rooms', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', here);
    const s = spies(m);
    const moved = cloneMap();
    (moved.rooms[1]!.rectGrid as { w: number }).w = 5;
    moved.doors = [];
    m.update(moved, () => 'safe', here);
    expect(s.rooms).toHaveBeenCalledTimes(1);
    expect(s.doors).toHaveBeenCalledTimes(1);
    expect(graphicsAt(m, 1).context.instructions).toHaveLength(0);
  });

  it('a player dropping off the map empties the dots layer rather than leaving a stale dot', () => {
    const m = new Minimap({ w: 100, h: 100 });
    m.update(MAP, () => 'safe', here);
    m.update(MAP, () => 'safe', [{ roomId: undefined, alive: true, isLocal: true }]);
    expect(drawnShapes(graphicsAt(m, 3))).toHaveLength(0);
  });
});
