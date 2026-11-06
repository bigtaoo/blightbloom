import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { GUIDE_TINT, NextRoomArrow } from './NextRoomArrow';
import { GUIDE_DELAY_MS, GUIDE_ORBIT_PX } from '../ui/nextRoomGuide';

describe('NextRoomArrow', () => {
  const player = { x: 100, y: 100 };
  const door = { kind: 'door', door: 0, x: 100, y: 500 } as const;

  it('adds nothing to its parent until the arrow first shows, then exactly one chevron', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.update(5000, player);
    a.clear();
    expect(parent.children.length).toBe(0);
    expect(a.visible).toBe(false);
    a.setTarget(door);
    a.update(5000, player);
    a.update(16, player);
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]).toBeInstanceOf(Graphics);
  });

  it('appears beside the drawn player after the delay, pointing at the door, in the door colour', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget(door);
    a.update(GUIDE_DELAY_MS - 1, player);
    expect(a.visible).toBe(false);
    a.update(1000, player);
    expect(a.visible).toBe(true);
    const g = parent.children[0] as Graphics;
    expect(g.rotation).toBeCloseTo(Math.PI / 2);
    expect(g.x).toBeCloseTo(100);
    expect(Math.abs(g.y - 100 - GUIDE_ORBIT_PX)).toBeLessThanOrEqual(5);
    expect(g.alpha).toBe(1);
    expect(g.tint).toBe(GUIDE_TINT.door);
  });

  it('rides exactly the position it is handed each frame — no lag behind a moving player', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget({ kind: 'door', door: 0, x: 5000, y: 100 });
    a.update(GUIDE_DELAY_MS + 1000, player);
    const g = parent.children[0]!;
    const offset = g.x - player.x;
    // Three frames of smooth travel: the arrow keeps the same offset from the body on every one.
    for (const x of [101.3, 102.6, 103.9]) {
      a.update(0, { x, y: 100 });
      expect(g.x - x).toBeCloseTo(offset, 0);
    }
  });

  it('aims at a foe’s drawn position, in the enemy colour', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget({ kind: 'foe', id: 4, x: 900, y: 100 }); // the sim says east...
    a.update(GUIDE_DELAY_MS + 1000, player, (id) => (id === 4 ? { x: 100, y: 900 } : null)); // ...drawn south
    const g = parent.children[0] as Graphics;
    expect(g.rotation).toBeCloseTo(Math.PI / 2);
    expect(g.tint).toBe(GUIDE_TINT.foe);
  });

  it('hides with no drawn player, on a lost target, and on clear()', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget(door);
    a.update(5000, null);
    expect(a.visible).toBe(false);
    a.update(0, player);
    expect(a.visible).toBe(true);
    a.clear();
    expect(a.visible).toBe(false);
    a.setTarget(door);
    a.update(5000, player);
    a.setTarget(null);
    a.update(16, player);
    expect(a.visible).toBe(false);
  });
});
