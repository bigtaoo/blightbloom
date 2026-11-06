import { describe, it, expect } from 'vitest';
import { Container, Graphics, Text } from 'pixi.js';
import { GUIDE_LABEL_DROP_PX, GUIDE_TINT, MOVE_LEARNED_PX, NextRoomArrow } from './NextRoomArrow';
import { en } from '../../i18n/locales/en';
import { GUIDE_DELAY_MS, GUIDE_ORBIT_PX } from '../ui/nextRoomGuide';

describe('NextRoomArrow', () => {
  const player = { x: 100, y: 100 };
  const door = { kind: 'door', door: 0, x: 100, y: 500 } as const;

  it('adds nothing to its parent until the arrow first shows, then exactly one dart and one label', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.update(5000, player);
    a.clear();
    expect(parent.children.length).toBe(0);
    expect(a.visible).toBe(false);
    a.setTarget(door);
    a.update(5000, player);
    a.update(16, player);
    expect(parent.children.length).toBe(2);
    expect(parent.children[0]).toBeInstanceOf(Graphics);
    expect(parent.children[1]).toBeInstanceOf(Text);
  });

  it('draws a dart whose tip is unmistakably its forward end: longer than wide, reaching furthest along +x', () => {
    const parent = new Container();
    const a = new NextRoomArrow(parent);
    a.setTarget(door);
    a.update(5000, player);
    const g = parent.children[0] as Graphics;
    g.rotation = 0;
    const b = g.getLocalBounds();
    // The old chevron (14 long, 20 wide) read wing-first once rotated; the dart must not.
    expect(b.maxX - b.minX).toBeGreaterThan(b.maxY - b.minY);
    expect(b.maxX).toBeGreaterThan(-b.minX * 1.5);
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

  describe('the label under the player', () => {
    const tut = en.tutorial;
    const shown = (a: NextRoomArrow, p = player) => {
      a.setTarget(door);
      a.update(GUIDE_DELAY_MS + 1000, p);
    };

    it('names the goal and the move keys, centred under the drawn player, in the arrow colour', () => {
      const parent = new Container();
      const a = new NextRoomArrow(parent);
      shown(a);
      expect(a.words).toBe(`${tut.guideDoor}
${tut.guideMoveKeys}`);
      const label = parent.children[1] as Text;
      expect(label.x).toBe(player.x);
      expect(label.y).toBe(player.y + GUIDE_LABEL_DROP_PX);
      expect(label.rotation).toBe(0);
      expect(label.style.fill).toBe(GUIDE_TINT.door);
      expect(label.alpha).toBe(1);
    });

    it('says the fight goal toward a foe, and touch wording on a touch session', () => {
      const parent = new Container();
      const a = new NextRoomArrow(parent);
      a.setTarget({ kind: 'foe', id: 4, x: 100, y: 900 });
      a.update(GUIDE_DELAY_MS + 1000, player, undefined, true);
      expect(a.words).toBe(`${tut.guideFoe}
${tut.guideMoveTouch}`);
      expect((parent.children[1] as Text).style.fill).toBe(GUIDE_TINT.foe);
    });

    it('drops the move keys once the player has walked MOVE_LEARNED_PX, and not before', () => {
      const a = new NextRoomArrow(new Container());
      shown(a);
      let x = player.x;
      for (let walked = 0; walked + 10 < MOVE_LEARNED_PX; walked += 10) a.update(16, { x: (x += 10), y: 100 });
      expect(a.words).toContain(tut.guideMoveKeys);
      a.update(16, { x: (x += 10), y: 100 });
      a.update(16, { x: (x += 10), y: 100 });
      expect(a.words).toBe(tut.guideDoor);
    });

    it('counts walking even while the arrow is hidden, but never a teleport', () => {
      const a = new NextRoomArrow(new Container());
      a.update(16, player); // no target: hidden, still tracking
      a.update(16, { x: player.x + 5000, y: 100 }); // a descend/respawn jump
      a.update(16, { x: player.x + 5000, y: 100 + 40 });
      shown(a, { x: player.x + 5000, y: 140 });
      expect(a.words).toContain(tut.guideMoveKeys);
      const b = new NextRoomArrow(new Container());
      for (let i = 1; i <= 30; i++) b.update(16, { x: player.x + i * 10, y: 100 });
      shown(b, { x: player.x + 300, y: 100 });
      expect(b.words).toBe(tut.guideDoor);
    });

    it('hides with the arrow, and clear() forgets the walking for the next run', () => {
      const a = new NextRoomArrow(new Container());
      for (let i = 1; i <= 30; i++) a.update(16, { x: player.x + i * 10, y: 100 });
      shown(a, { x: 400, y: 100 });
      expect(a.words).toBe(tut.guideDoor);
      a.setTarget(null);
      a.update(16, { x: 400, y: 100 });
      expect(a.words).toBeNull();
      a.clear();
      expect(a.words).toBeNull();
      shown(a);
      expect(a.words).toContain(tut.guideMoveKeys);
    });

    it('follows the arrow’s fade', () => {
      const parent = new Container();
      const a = new NextRoomArrow(parent);
      a.setTarget(door);
      a.update(GUIDE_DELAY_MS + 150, player);
      expect((parent.children[1] as Text).alpha).toBeCloseTo((parent.children[0] as Graphics).alpha);
      expect((parent.children[1] as Text).alpha).toBeLessThan(1);
    });
  });
});
