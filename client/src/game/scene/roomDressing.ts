// Split out of RoomBuilder 2026-08-27 (500-line convention, CLAUDE.md form ① — a set of
// independent functions with no shared private state, the same form `groundLayer.ts` took out of
// the same file in 2026-08-20): the two kinds of free-standing thing a room is DRESSED with, as
// opposed to the geometry it is BUILT from.
//
// The distinction is not cosmetic. Walls and doors are the room's shape — they come out of
// merged runs, they carve each other, they share one shadow Graphics, and a door's fixture has to
// know which wall run it was cut into. A pillar or a prop is placed at a point, on its own, from
// one engine record, and nothing else in the room depends on where it landed. That is why these
// two moved and the wall/door pass did not: each is a loop over engine records that reads
// `layers` and returns what it made, so RoomBuilder keeps only the lists (it owns their
// lifetimes — both kinds live on the Y-sorted `entities` layer, which `build()`/`clear()` never
// sweep wholesale) and calls two functions.
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity, SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
import { tagStandingPiece } from './groundCulling';
import type { BiomeElement, BiomePalette } from '../theme';
import { fpToPx, PX_PER_GRID } from '../coords';
import { getPillarTexture } from '../../render/biomeTiles';
import { getPropTexture } from '../../render/environmentSprites';
import { WALL_HEIGHT } from './wallGeometry';
import { buildPillarBody, buildPillarSprite, pillarArtExtent } from './pillarRender';
import { buildPropBody, propShadowRadius, resolvePropKind } from './propRender';
import { fadeableBlock, type FadeableOccluder } from './occlusion';

/** Destroy every Entity in `list` and empty the list in place.
 *
 *  The shadow is NOT destroyed here, and that is the correction rather than an omission: all three
 *  copies of this loop that RoomBuilder used to carry called `e.shadow?.destroy()` before
 *  `e.destroy()`, and `Entity.destroy` already un-parents and destroys its own shadow — the wall
 *  path has always relied on exactly that and never had the extra line. A 2026-08-27 battery
 *  proved it: deleting the manual destroy left all 3,365 client tests green INCLUDING
 *  `RoomBuilder.test.ts`'s "clear() removes every pillar and its shadow", which asserts
 *  `layers.shadow.children.length === 0`. That test is the oracle, not an argument — so the line
 *  was two guards for one case, and this doc comment used to claim a leak that cannot happen. */
export function destroyDressing(list: Entity[]): void {
  for (const e of list) e.destroy();
  list.length = 0;
}

/** The round Y-sortable pillars for every co-resident room, one per `state.obstacles` circle,
 *  plus the occluders they contribute to the x-ray. Mounts them on `layers`; the caller keeps
 *  the returned lists (see this module's header for why). */
export function buildPillarEntities(
  layers: Layers,
  s: GameState,
  palette: BiomePalette,
  element: BiomeElement,
): { pillars: Entity[]; occluders: FadeableOccluder[] } {
  const pillars: Entity[] = [];
  const occluders: FadeableOccluder[] = [];
  const pillarTex = getPillarTexture(element);
  for (const o of s.obstacles) {
    const rad = fpToPx(o.radius);
    const bodyW = rad * 2 + 16; // visual body a touch wider than the footprint
    const height = WALL_HEIGHT; // one height for every standing thing in a room
    const p = new Entity();
    // Real pillar art where it exists (`biome/pillar_neutral.png`, 2026-08-20), else the
    // hand-toned cylinder that stood in for it — see `pillarRender.buildPillarBody`'s doc
    // for the four attempts behind that choice, including why sampling the WALL swatches
    // at pillar scale was tried and was worse.
    p.addChild(
      pillarTex
        ? buildPillarSprite(bodyW, height, palette, pillarTex)
        : buildPillarBody(bodyW, height, palette),
    );
    // A pillar's shadow has to be displaced by hand (2026-08-18): the height that throws
    // it is the DRAWN body's, and a pillar is drawn upward from a grounded origin rather
    // than lifted by the transform, so `Entity`'s own height-driven offset sees z = 0.
    // Same slant constants as an actor's hover shadow and a wall's cast shadow, so all
    // three agree on where the key light is.
    p.makeShadow(rad + 12);
    p.shadowOffsetX = height * SHADOW_SLANT_X;
    p.shadowOffsetY = height * SHADOW_SLANT_Y;
    layers.entities.addChild(p);
    layers.shadow.addChild(p.shadow!);
    pillars.push(p);
    const gx = fpToPx(o.gx);
    const gy = fpToPx(o.gy);
    p.place(gx, gy);
    tagStandingPiece(p);
    // A pillar hides the character exactly the way a wall block does — it is drawn upward from
    // its ground point over the same `height` of walkable floor to its north, and it is a
    // NARROWER target, so the player brushes past its blind side more often, not less. Same
    // x-ray. (design/01 used to call being hidden behind a pillar intended; a body that
    // vanishes completely is not, whatever shape the thing hiding it is.)
    const art = pillarArtExtent(bodyW, height, pillarTex);
    occluders.push(
      fadeableBlock(
        // `foldY: gy` — a pillar's whole body is one Graphics and fades together, so it has no
        // opaque remainder for a deep fade to reach and never asks for one.
        { left: gx - art.halfW, right: gx + art.halfW, top: gy + art.top, sortY: gy, foldY: gy },
        p.children,
      ),
    );
  }
  return { pillars, occluders };
}

/**
 * Decorative room dressing (`RoomPiece.props`) for the current floor's co-resident
 * rooms — every room stands at once (same "co-resident" model as walls/pillars, design/05),
 * so this iterates `s.dungeonRooms` rather than a single piece. Grid → px is a plain
 * `* PX_PER_GRID` (1 grid = 32 px exactly, `coords.ts`), not the engine's `toFpGrid`/`fpToPx`
 * round trip — that pair exists to cross the sim's fixed-point boundary, and a prop is never
 * simulated (no `state.obstacles`/`state.walls` entry, ever — this function only reads
 * `piece.props`, nothing it does can affect collision).
 *
 * No occlusion x-ray registration (unlike walls/pillars/doors) and no collision: see
 * `propRender.ts`'s module doc for why a prop's short art doesn't need the x-ray treatment,
 * and `content/rooms.ts`'s own doc comment for why the sim never reads this field at all.
 */
export function buildPropEntities(layers: Layers, s: GameState, palette: BiomePalette): Entity[] {
  const props: Entity[] = [];
  for (const room of s.dungeonRooms) {
    for (const prop of room.piece.props ?? []) {
      const kind = resolvePropKind(prop.id);
      const e = new Entity();
      e.addChild(buildPropBody(kind, palette, getPropTexture(kind)));
      e.makeShadow(propShadowRadius(kind));
      layers.entities.addChild(e);
      layers.shadow.addChild(e.shadow!);
      props.push(e);
      e.place((prop.x + room.offsetXGrid) * PX_PER_GRID, (prop.y + room.offsetYGrid) * PX_PER_GRID);
      tagStandingPiece(e);
    }
  }
  return props;
}
