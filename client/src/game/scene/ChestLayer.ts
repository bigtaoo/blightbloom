// Chest rendering (design/05 "Chest rooms", ENGINE_VERSION 63) — the drawn half of
// `GameState.chests`.
//
// Shaped like `PickupDebugOverlay` rather than like `Pickup`: one controller, told which
// containers to draw into, diffing its own map against the sim's array each frame. A chest is
// NOT an `Entity` in `Scene`'s `views` map for one concrete reason — it draws into TWO layers
// at once. The body is a Y-sorted object among the actors (`layers.entities`), and its
// mechanisms are flat ground decals that every actor must draw over (`layers.ground`), and a
// single `Entity` has exactly one position and one layer.
//
// ## No art yet, deliberately
//
// Every object in this room shipped a Graphics form first and grew a sprite later — walls,
// pillars, doors, drops, props (see `propRender.ts`'s own note). A chest is the newest object
// in the game and has no art at all, so the shapes below are the drawn form for now, not a
// fallback waiting on a file. They follow design/13's dual-channel rule — the two kinds differ
// in SIZE and FORM, not only in hue, so they stay apart for a colourblind player — and they are
// sized against `Pickup`'s own 18 px so a chest reads as furniture rather than as loot.
//
// ## What the plates have to communicate, and what they must not
//
// A mechanism is the only thing in the game whose state is "somebody else is standing here", so
// an occupied plate is drawn as filled-and-ringed and an empty one as a thin outline. The rule
// the drawing has to respect is that an OPENED chest's plates keep updating: `ChestSystem`
// refreshes `occupied` for an opened chest too, precisely so a plate does not stay lit forever
// after the party walks away, and a renderer that stopped reading them would put that bug back.
import { Container, Graphics } from 'pixi.js';
import type { Chest, GameState } from '@dd/engine';
import { fpToPx } from '../coords';
import { THEME } from '../theme';
import { SHADOW_SQUASH } from './Entity';

/** Half-width of a chest body, world px. A big chest is the one with the ring around it, so it
 *  is also the one that has to read from further away. */
const BODY_HALF = { small: 9, big: 14 } as const;
/** How tall the drawn box is relative to its half-width — a chest is wider than it is tall in
 *  this tilted view, the same foreshortening every ground-plane object here gets. */
const BODY_ASPECT = 0.8;
/** Mechanism plate radius, world px. Drawn to the SIM's own `CHEST_MECHANISM_RADIUS_GRID` so
 *  "am I standing on it" is answered by the picture rather than guessed — the same reasoning
 *  `PickupDebugOverlay` was built on, applied to a shipped mechanic instead of a debug flag. */
const PLATE_RADIUS_PX = 1 * 32;

const CLOSED_FILL = 0x8a5a2b; // warm timber, clearly not a floor tone
const CLOSED_BAND = 0xd8b26a; // the strap/lock line
const OPEN_FILL = 0x3a2a1c; // the emptied interior, read as a hole rather than as a box
const PLATE_IDLE = 0x6b7280;
const PLATE_LIVE = THEME.colors.pickupWeapon;

/** One chest's two drawn halves, kept together so a removed chest tears down both. */
interface ChestView {
  body: Container;
  plates: Container;
  /** What the body was last drawn as. A chest's body only ever changes once (closed → open),
   *  so redrawing it every frame would be pure churn; this is the edge that avoids it. */
  drawnOpen: boolean;
  /** Per-plate occupancy as last drawn, index-aligned with `Chest.mechanisms`. Same reason.
   *  `null` means "never drawn", and it has to be a third value rather than a `false` default:
   *  seeding it with a boolean makes the first frame a no-op for every plate that happens to
   *  start in that state, which leaves a live plate undrawn until somebody steps off it. */
  drawnOccupied: (boolean | null)[];
}

export class ChestLayer {
  private readonly views = new Map<number, ChestView>();

  /**
   * @param entities the Y-sorted actor layer (`Layers.entities`) — bodies go here, each with
   *        its own `zIndex`, so a chest occludes and is occluded exactly like an actor.
   * @param ground the flat decal layer (`Layers.ground`) — plates go here, so an actor
   *        standing on one is always drawn over it.
   */
  constructor(
    private readonly entities: Container,
    private readonly ground: Container,
  ) {}

  update(state: GameState): void {
    const seen = new Set<number>();
    for (const chest of state.chests) {
      seen.add(chest.id);
      let v = this.views.get(chest.id);
      if (!v) {
        v = this.create(chest);
        this.views.set(chest.id, v);
      }
      this.sync(chest, v);
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      v.body.destroy({ children: true });
      v.plates.destroy({ children: true });
      this.views.delete(id);
    }
  }

  /** Drop every view. Called when a match ends — the containers belong to layers this class
   *  does not own, so leaving children behind would leak a floor's chests into the next run. */
  clear(): void {
    for (const v of this.views.values()) {
      v.body.destroy({ children: true });
      v.plates.destroy({ children: true });
    }
    this.views.clear();
  }

  private create(chest: Chest): ChestView {
    const body = new Container();
    this.entities.addChild(body);
    const plates = new Container();
    this.ground.addChild(plates);
    for (let i = 0; i < chest.mechanisms.length; i++) plates.addChild(new Graphics());
    // Both sentinels are deliberately values the real state can never equal, so the first
    // `sync` always draws: `drawnOpen` inverted, `drawnOccupied` null.
    return { body, plates, drawnOpen: !chest.opened, drawnOccupied: chest.mechanisms.map(() => null) };
  }

  private sync(chest: Chest, v: ChestView): void {
    const x = fpToPx(chest.gx);
    const y = fpToPx(chest.gy);
    v.body.position.set(x, y);
    // The GROUND coordinate, exactly as `Entity` does it — a chest sits on the floor, so its
    // sort key is where it stands, never where its lid is drawn.
    v.body.zIndex = y;
    if (v.drawnOpen !== chest.opened) {
      v.body.removeChildren().forEach((c) => c.destroy());
      v.body.addChild(drawBody(chest.kind, chest.opened));
      v.drawnOpen = chest.opened;
    }
    for (let i = 0; i < chest.mechanisms.length; i++) {
      const m = chest.mechanisms[i]!;
      const g = v.plates.children[i] as Graphics | undefined;
      if (!g) continue;
      g.position.set(fpToPx(m.gx), fpToPx(m.gy));
      if (v.drawnOccupied[i] === m.occupied) continue;
      drawPlate(g, m.occupied);
      v.drawnOccupied[i] = m.occupied;
    }
  }
}

/** The chest body itself. Exported for `ChestLayer.test.ts`, which measures the drawn extents
 *  rather than trusting the constants above — the same rule `propRender.test.ts` follows. */
export function drawBody(kind: 'small' | 'big', opened: boolean): Graphics {
  const g = new Graphics();
  const half = BODY_HALF[kind];
  const h = half * BODY_ASPECT;
  if (opened) {
    // An emptied chest: the box is still there (it is a landmark — a player crossing the room
    // again should be able to see they have already been here) but the lid is thrown back and
    // the inside is a hole rather than a surface.
    g.roundRect(-half, -h * 0.2, half * 2, h * 1.2, 3).fill({ color: OPEN_FILL });
    g.roundRect(-half, -h * 1.3, half * 2, h * 0.5, 2).fill({ color: CLOSED_FILL, alpha: 0.75 });
    g.roundRect(-half, -h * 0.2, half * 2, h * 1.2, 3).stroke({ color: CLOSED_BAND, width: 1, alpha: 0.5 });
    return g;
  }
  g.roundRect(-half, -h, half * 2, h * 2, 3).fill({ color: CLOSED_FILL });
  // The strap across the lid line, and the lock under it: two marks, because one horizontal
  // band alone reads as a crate (which this room already has three of).
  g.rect(-half, -h * 0.15, half * 2, h * 0.3).fill({ color: CLOSED_BAND });
  g.rect(-2, -h * 0.35, 4, h * 0.7).fill({ color: CLOSED_BAND });
  g.roundRect(-half, -h, half * 2, h * 2, 3).stroke({ color: 0x000000, width: 1, alpha: 0.35 });
  return g;
}

/** One mechanism plate. Exported for the same reason `drawBody` is. */
export function drawPlate(g: Graphics, occupied: boolean): Graphics {
  g.clear();
  const r = PLATE_RADIUS_PX;
  // Foreshortened by the same constant every ground-plane disc in this renderer uses, so a
  // plate lies in the floor instead of standing up out of it.
  const ry = r * SHADOW_SQUASH;
  const color = occupied ? PLATE_LIVE : PLATE_IDLE;
  g.ellipse(0, 0, r, ry).fill({ color, alpha: occupied ? 0.26 : 0.08 });
  g.ellipse(0, 0, r, ry).stroke({ color, width: occupied ? 3 : 2, alpha: occupied ? 0.9 : 0.45 });
  // An inner pip, present in both states: it marks the CENTRE the sim actually measures from,
  // which is the one thing a ring alone does not say.
  g.ellipse(0, 0, r * 0.18, ry * 0.18).fill({ color, alpha: occupied ? 0.95 : 0.35 });
  return g;
}
