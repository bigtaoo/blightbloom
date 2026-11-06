// The drawn half of `ui/nextRoomGuide.ts`: a chevron riding beside the local player, pointing at
// the nearest enemy while a room is fought and at the door to the next room once it is done.
//
// World-space on `layers.numbers`, like the pickup-refusal labels: never blurred, above every wall
// and health bar (a cue buried behind a pillar is no cue), and the layer meant for things that
// move every frame — `hud` is a render group precisely because it almost never changes.
import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { GuideClock, type GuideTarget } from '../ui/nextRoomGuide';

/** A point in world px. */
export interface GuidePoint {
  x: number;
  y: number;
}

/** The arrow's colour per target: the extraction glow toward a door, the enemy red toward a foe. */
export const GUIDE_TINT = { door: THEME.colors.extractGlow, foe: THEME.colors.enemy } as const;

export class NextRoomArrow {
  private readonly clock = new GuideClock();
  /** Built on the first frame the arrow shows: most scenes (the arena, PvP, a fight) never need
   *  one, and the shared layer stays exactly as the other cues left it. */
  private g: Graphics | null = null;

  constructor(private readonly parent: Container) {}

  /** Is the arrow up — read by tests and the console. */
  get visible(): boolean {
    return this.g?.visible ?? false;
  }

  /** One reconcile's verdict (`nextRoomGuide`). */
  setTarget(next: GuideTarget | null | undefined): void {
    this.clock.set(next);
  }

  /**
   * Advance on the render clock and pose the arrow at the player's DRAWN ground position, after
   * the camera has settled for the frame (2026-11-06, "the guide arrow shakes badly while moving").
   * It used to ride the view's `curX/curY`: the tick-rate target the view lerps toward, which steps
   * 30 times a second while the body and the camera glide, so on the screen the arrow jumped up to
   * a whole tick of travel back and forth around a smoothly moving player. `foeAt` gives an
   * enemy's drawn position for the same reason.
   */
  update(dt: number, player: GuidePoint | null, foeAt?: (id: number) => GuidePoint | null): void {
    const p = this.clock.pose(dt, player, foeAt);
    if (!p.visible) {
      if (this.g) this.g.visible = false;
      return;
    }
    const g = (this.g ??= this.build());
    g.visible = true;
    g.tint = GUIDE_TINT[this.clock.kind ?? 'door'];
    g.position.set(p.x, p.y);
    g.rotation = p.rotation;
    g.alpha = p.alpha;
  }

  clear(): void {
    this.clock.clear();
    if (this.g) this.g.visible = false;
  }

  /** A white chevron pointing +x, tinted per target, centred on its own origin so rotation
   *  pivots in place. */
  private build(): Graphics {
    const g = new Graphics()
      .poly([-7, -10, 7, 0, -7, 10, -3, 0])
      .fill({ color: 0xffffff })
      .stroke({ color: 0x0b0f17, width: 2, alpha: 0.8 });
    this.parent.addChild(g);
    return g;
  }
}
