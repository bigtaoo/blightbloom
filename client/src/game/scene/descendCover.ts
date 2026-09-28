// The black the world drops to while a descend builds its new floor (`RoomBuilder.buildStaged`,
// 2026-09-28), then fades back out of. Its own module because it has one job and no geometry.
//
// Why a cover at all. A staged build puts the new floor up over several frames, and a floor that
// assembles itself wall by wall in front of the player is a worse defect than the frame it saves.
// Covered, the same frames are a cut to black and a fade in — which is also what a descend should
// read as: the old floor went away, and the player is somewhere else now.
import { Graphics, type Container } from 'pixi.js';

/** How long the fade back in takes once the build is done. Long enough to read as a transition
 *  rather than a flicker, short enough that the player is back in control before a fight could
 *  reach them in the new floor's first room. */
export const COVER_FADE_MS = 280;

/** Far past any screen in either direction: the cover sits in the unscaled `ui` layer, so this is
 *  screen px, and oversizing it is cheaper than keeping it fitted to a resizing viewport. */
const COVER_REACH = 20000;

export class DescendCover {
  private readonly view = new Graphics();
  private alpha = 0;

  /** `parent` is the screen-space UI layer; the cover goes UNDER everything already in it, so the
   *  HUD stays readable over the black. */
  constructor(parent: Container) {
    this.view.rect(-COVER_REACH, -COVER_REACH, COVER_REACH * 2, COVER_REACH * 2).fill({ color: 0x000000 });
    this.view.eventMode = 'none';
    this.view.visible = false;
    parent.addChildAt(this.view, 0);
  }

  /** Cover the world at once. */
  show(): void {
    this.alpha = 1;
    this.apply();
  }

  /** Remove the cover at once (a restart). */
  hide(): void {
    this.alpha = 0;
    this.apply();
  }

  /** One render frame: hold while `holding`, fade out after. */
  update(dtMs: number, holding: boolean): void {
    if (this.alpha <= 0) return;
    if (!holding) this.alpha = Math.max(0, this.alpha - dtMs / COVER_FADE_MS);
    this.apply();
  }

  /** How much of the world the cover hides, 0..1. */
  get opacity(): number {
    return this.alpha;
  }

  private apply(): void {
    this.view.alpha = this.alpha;
    this.view.visible = this.alpha > 0;
  }
}
