import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { NextRoomArrow } from './NextRoomArrow';
import { GUIDE_DELAY_MS, GUIDE_ORBIT_PX } from '../ui/nextRoomGuide';

describe('NextRoomArrow', () => {
  const player = { curX: 100, curY: 100 };

  it('adds nothing to its parent until the arrow first shows, then exactly one chevron', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.update(5000, player);
    a.clear();
    expect(parent.children.length).toBe(0);
    expect(a.visible).toBe(false);
    a.setTarget({ door: 0, x: 100, y: 500 });
    a.update(5000, player);
    a.update(16, player);
    expect(parent.children.length).toBe(1);
    expect(parent.children[0]).toBeInstanceOf(Graphics);
  });

  it('appears beside the drawn player after the delay, pointing at the door', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget({ door: 0, x: 100, y: 500 });
    a.update(GUIDE_DELAY_MS - 1, player);
    expect(a.visible).toBe(false);
    a.update(1000, player);
    expect(a.visible).toBe(true);
    const g = parent.children[0]!;
    expect(g.rotation).toBeCloseTo(Math.PI / 2);
    expect(g.x).toBeCloseTo(100);
    expect(Math.abs(g.y - 100 - GUIDE_ORBIT_PX)).toBeLessThanOrEqual(5);
    expect(g.alpha).toBe(1);
  });

  it('hides with no drawn player, on a lost target, and on clear()', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget({ door: 0, x: 100, y: 500 });
    a.update(5000, null);
    expect(a.visible).toBe(false);
    a.update(0, player);
    expect(a.visible).toBe(true);
    a.clear();
    expect(a.visible).toBe(false);
    a.setTarget({ door: 0, x: 100, y: 500 });
    a.update(5000, player);
    a.setTarget(null);
    a.update(16, player);
    expect(a.visible).toBe(false);
  });
});
