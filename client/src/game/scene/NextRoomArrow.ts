// The drawn half of `ui/nextRoomGuide.ts`: a chevron riding beside the local player, pointing at
// the door to the next room once the current one is done.
//
// World-space on `layers.numbers`, like the pickup-refusal labels: never blurred, above every wall
// and health bar (a cue buried behind a pillar is no cue), and the layer meant for things that
// move every frame — `hud` is a render group precisely because it almost never changes.
import { Container, Graphics } from 'pixi.js';
import { THEME } from '../theme';
import { GuideClock, type GuideTarget } from '../ui/nextRoomGuide';

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

  /** Advance on the render clock and follow the player's DRAWN position. */
  update(dt: number, player: { curX: number; curY: number } | null): void {
    const p = this.clock.pose(dt, player ? { x: player.curX, y: player.curY } : null);
    if (!p.visible) {
      if (this.g) this.g.visible = false;
      return;
    }
    const g = (this.g ??= this.build());
    g.visible = true;
    g.position.set(p.x, p.y);
    g.rotation = p.rotation;
    g.alpha = p.alpha;
  }

  clear(): void {
    this.clock.clear();
    if (this.g) this.g.visible = false;
  }

  /** A chevron pointing +x, centred on its own origin so rotation pivots in place. */
  private build(): Graphics {
    const g = new Graphics()
      .poly([-7, -10, 7, 0, -7, 10, -3, 0])
      .fill({ color: THEME.colors.extractGlow })
      .stroke({ color: 0x0b0f17, width: 2, alpha: 0.8 });
    this.parent.addChild(g);
    return g;
  }
}
