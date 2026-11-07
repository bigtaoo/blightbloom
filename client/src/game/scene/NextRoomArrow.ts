// The drawn half of `ui/nextRoomGuide.ts`: a chevron riding beside the local player, pointing at
// the nearest enemy while a room is fought and at the door to the next room once it is done.
//
// World-space on `layers.numbers`, like the pickup-refusal labels: never blurred, above every wall
// and health bar (a cue buried behind a pillar is no cue), and the layer meant for things that
// move every frame — `hud` is a render group precisely because it almost never changes.
//
// Under the player, unrotated, a line of words saying what the arrow means (2026-11-06, "a bare
// arrow, and the player has no idea what to do — clicking only shoots"): an arrow is only a
// direction, and a player who does not know the keys that walk cannot follow one. So the label
// names the goal, and adds the move keys until the player has walked `MOVE_LEARNED_PX` this run.
import { Container, Graphics, Text } from 'pixi.js';
import { THEME } from '../theme';
import { t } from '../../i18n';
import { GuideClock, type GuideTarget } from '../ui/nextRoomGuide';

/** A point in world px. */
export interface GuidePoint {
  x: number;
  y: number;
}

/** The arrow's colour per target: the extraction glow toward a door or the portal (the portal's
 *  own colour, `Portal.ts`), the enemy red toward a foe. */
export const GUIDE_TINT = { door: THEME.colors.extractGlow, foe: THEME.colors.enemy, portal: THEME.colors.extractGlow } as const;

/** The label's first line per target. */
const GUIDE_WORDS = { door: 'tutorial.guideDoor', foe: 'tutorial.guideFoe', portal: 'tutorial.guidePortal' } as const;

/** How far below the player's ground point the label's top sits, world px: clear of the feet and
 *  of the arrow when it points straight down (orbit 44 + pulse 5 + the dart's 15 px tip). */
export const GUIDE_LABEL_DROP_PX = 66;
/** Walked this far (drawn px, summed frame to frame) in a run, the player knows the move keys and
 *  the label stops naming them: 8 grid, a few steps past the first lesson's 1.5. */
export const MOVE_LEARNED_PX = 256;
/** A frame's step longer than this is a teleport (a descend, a respawn), not walking. */
const MAX_STEP_PX = 48;

export class NextRoomArrow {
  private readonly clock = new GuideClock();
  /** Built on the first frame the arrow shows: most scenes (the arena, PvP, a fight) never need
   *  one, and the shared layer stays exactly as the other cues left it. */
  private g: Graphics | null = null;
  private label: Text | null = null;
  /** How far the player has walked this run, drawn px. */
  private walked = 0;
  private last: GuidePoint | null = null;

  constructor(private readonly parent: Container) {}

  /** Is the arrow up — read by tests and the console. */
  get visible(): boolean {
    return this.g?.visible ?? false;
  }

  /** The label's words while it is up, else null — read by tests and the console. */
  get words(): string | null {
    return this.label?.visible ? this.label.text : null;
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
   * enemy's drawn position for the same reason. `touch` picks the label's move wording;
   * `moveTaught` (the tutorial's move-lesson panel is up) drops it, since that panel already
   * says it, larger (2026-11-07, the first-run report's two copies of one instruction).
   */
  update(
    dt: number,
    player: GuidePoint | null,
    foeAt?: (id: number) => GuidePoint | null,
    touch = false,
    moveTaught = false,
  ): void {
    this.track(player);
    const p = this.clock.pose(dt, player, foeAt);
    if (!p.visible || !player) {
      if (this.g) this.g.visible = false;
      if (this.label) this.label.visible = false;
      return;
    }
    const kind = this.clock.kind ?? 'door';
    const g = (this.g ??= this.build());
    g.visible = true;
    g.tint = GUIDE_TINT[kind];
    g.position.set(p.x, p.y);
    g.rotation = p.rotation;
    g.alpha = p.alpha;

    const label = (this.label ??= this.buildLabel());
    let words = t(GUIDE_WORDS[kind]);
    if (this.walked < MOVE_LEARNED_PX && !moveTaught) words += `
${t(touch ? 'tutorial.guideMoveTouch' : 'tutorial.guideMoveKeys')}`;
    if (label.text !== words) label.text = words;
    label.visible = true;
    label.style.fill = GUIDE_TINT[kind];
    label.position.set(player.x, player.y + GUIDE_LABEL_DROP_PX);
    label.alpha = p.alpha;
  }

  clear(): void {
    this.clock.clear();
    this.walked = 0;
    this.last = null;
    if (this.g) this.g.visible = false;
    if (this.label) this.label.visible = false;
  }

  /** Sum the player's drawn travel, skipping a jump no one walks in a frame. */
  private track(player: GuidePoint | null): void {
    if (player && this.last) {
      const step = Math.hypot(player.x - this.last.x, player.y - this.last.y);
      if (step <= MAX_STEP_PX) this.walked += step;
    }
    this.last = player ? { x: player.x, y: player.y } : null;
  }

  /** A white dart pointing +x, tinted per target, pivoting on its own origin. Longer than it is
   *  wide (22 x 18) with a notched tail, so the tip is the one corner that reads as the point: the
   *  first chevron was 14 long and 20 wide, and turned to a bearing one of its wings read as the
   *  tip — a door down-left of the player looked like an arrow pointing right. */
  private build(): Graphics {
    const g = new Graphics()
      .poly([15, 0, -7, -9, -2, 0, -7, 9])
      .fill({ color: 0xffffff })
      .stroke({ color: 0x0b0f17, width: 2, alpha: 0.8 });
    this.parent.addChild(g);
    return g;
  }

  private buildLabel(): Text {
    const text = new Text({
      text: '',
      style: {
        fill: GUIDE_TINT.door,
        fontSize: 12,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        align: 'center',
        stroke: { color: 0x0b0f17, width: 3 },
        padding: 4,
      },
    });
    text.anchor.set(0.5, 0);
    this.parent.addChild(text);
    return text;
  }
}
