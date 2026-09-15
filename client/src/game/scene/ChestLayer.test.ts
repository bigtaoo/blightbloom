/**
 * Chest rendering (design/05 "Chest rooms", ENGINE_VERSION 63).
 *
 * What is worth testing here is not "does it draw a box" — it is the four properties that
 * would fail silently in a live frame and that nothing else in the repo would notice:
 *
 *  - a chest body Y-sorts on its GROUND coordinate, like every other world object;
 *  - a plate lands where the SIM put it, not where a redraw last left it;
 *  - an OPENED chest's plates keep tracking occupancy (`ChestSystem` refreshes them on
 *    purpose so a plate cannot stay lit after everyone walks away, and a renderer that
 *    stopped reading them would hand that bug straight back);
 *  - a chest that leaves `state.chests` takes BOTH of its containers with it, since the
 *    layers they live in are not swept by the run reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import type { Chest, GameState } from '@dd/engine';
import { Sprite, Texture } from 'pixi.js';
import { ChestLayer, buildChestBody, chestFootprintWidth, drawBody, drawPlate } from './ChestLayer';
import { getChestTexture } from '../../render/environmentSprites';
import { fpToPx } from '../coords';

// `getChestTexture` is the one thing this module reads that a headless test has no way to
// satisfy for real (`preloadEnvironmentSprites` needs a GPU and a network). Mocked rather than
// worked around, so BOTH branches of `buildChestBody` are reachable here — the fallback is the
// default, and the art is opted into per case.
vi.mock('../../render/environmentSprites', () => ({ getChestTexture: vi.fn(() => undefined) }));
const mockedTexture = vi.mocked(getChestTexture);

/** A texture of a stated pixel size — the only two fields `buildChestBody` reads. */
const texture = (w: number, h: number) => ({ width: w, height: h }) as Texture;

beforeEach(() => mockedTexture.mockReturnValue(undefined));

type Fp = Chest['gx'];
const fp = (grid: number) => (grid * 1000) as Fp;

function chest(over: Partial<Chest> = {}): Chest {
  return {
    id: 1,
    roomId: 'r1',
    kind: 'small',
    gx: fp(10),
    gy: fp(12),
    mechanisms: [],
    opened: false,
    ...over,
  };
}

/** The two layers `ChestLayer` draws into, plus a state carrying just `chests` — every other
 *  field is untouched by this module, so a full GameState would only hide what it reads. */
function harness(chests: Chest[]) {
  const entities = new Container();
  const ground = new Container();
  const layer = new ChestLayer(entities, ground);
  const state = { chests } as unknown as GameState;
  return { entities, ground, layer, state };
}

describe('ChestLayer — placement', () => {
  it('puts a body in the entity layer and Y-sorts it on the ground coordinate', () => {
    const c = chest();
    const { entities, layer, state } = harness([c]);
    layer.update(state);
    expect(entities.children).toHaveLength(1);
    const body = entities.children[0]!;
    expect(body.position.x).toBe(fpToPx(c.gx));
    expect(body.position.y).toBe(fpToPx(c.gy));
    // Not the lid's drawn height, not zero: the sort key is where the chest STANDS, the same
    // rule `Entity.pushState` follows for every actor it sorts against.
    expect(body.zIndex).toBe(fpToPx(c.gy));
  });

  it('puts one plate per mechanism in the ground layer, at the sim positions', () => {
    const c = chest({
      kind: 'big',
      mechanisms: [
        { gx: fp(13), gy: fp(12), occupied: false },
        { gx: fp(7), gy: fp(12), occupied: false },
      ],
    });
    const { ground, layer, state } = harness([c]);
    layer.update(state);
    const plates = ground.children[0]!;
    expect(plates.children).toHaveLength(2);
    expect(plates.children[0]!.position.x).toBe(fpToPx(fp(13)));
    expect(plates.children[1]!.position.x).toBe(fpToPx(fp(7)));
  });

  it('gives a small chest no plates at all', () => {
    const { ground, layer, state } = harness([chest()]);
    layer.update(state);
    expect(ground.children[0]!.children).toHaveLength(0);
  });

  it('gives the chest a ground shadow, under its body', () => {
    const { entities, layer, state } = harness([chest()]);
    layer.update(state);
    const body = entities.children[0] as Container;
    // Child 0, so it draws UNDER the body — the same order (and the same ellipse) the counter
    // next door uses, because both are furniture standing on the same floor.
    expect(body.children).toHaveLength(2);
    expect((body.children[0] as Graphics).bounds.height).toBeLessThan((body.children[0] as Graphics).bounds.width);
  });

  it('reuses the same body across frames instead of rebuilding it', () => {
    const c = chest();
    const { entities, layer, state } = harness([c]);
    layer.update(state);
    const first = entities.children[0];
    layer.update(state);
    layer.update(state);
    expect(entities.children).toHaveLength(1);
    expect(entities.children[0]).toBe(first);
  });
});

describe('ChestLayer — state it has to keep following', () => {
  it('redraws the body when the chest opens, and keeps the shadow it stands on', () => {
    const c = chest();
    const { entities, layer, state } = harness([c]);
    layer.update(state);
    const body = entities.children[0] as Container;
    const shadow = body.children[0];
    const closed = body.children[1];
    c.opened = true;
    layer.update(state);
    expect(body.children[1]).not.toBe(closed);
    // The shadow belongs to the FOOTPRINT, which a thrown-back lid does not change — a rebuild
    // that swept it would leave the chest floating for the rest of the floor.
    expect(body.children[0]).toBe(shadow);
    expect(body.children).toHaveLength(2);
  });

  it('keeps following a plate’s occupancy AFTER the chest has opened', () => {
    // The regression this file exists for. `ChestSystem.markMechanisms` deliberately runs for
    // an opened chest; if this layer skipped an opened chest wholesale, a plate would stay lit
    // for the rest of the run.
    const c = chest({ kind: 'big', opened: true, mechanisms: [{ gx: fp(13), gy: fp(12), occupied: true }] });
    const { ground, layer, state } = harness([c]);
    layer.update(state);
    const g = ground.children[0]!.children[0] as Graphics;
    const lit = g.bounds.width;
    c.mechanisms[0]!.occupied = false;
    layer.update(state);
    // The idle ring is drawn with a thinner stroke, so its bounds are strictly smaller — a
    // measured difference rather than "some draw call happened".
    expect(g.bounds.width).toBeLessThan(lit);
  });

  it('follows a plate that moves', () => {
    const c = chest({ kind: 'big', mechanisms: [{ gx: fp(13), gy: fp(12), occupied: false }] });
    const { ground, layer, state } = harness([c]);
    layer.update(state);
    c.mechanisms[0]!.gx = fp(15);
    layer.update(state);
    expect(ground.children[0]!.children[0]!.position.x).toBe(fpToPx(fp(15)));
  });
});

describe('ChestLayer — teardown', () => {
  it('removes both containers when a chest leaves the state', () => {
    const c = chest();
    const { entities, ground, layer, state } = harness([c]);
    layer.update(state);
    (state.chests as Chest[]).length = 0;
    layer.update(state);
    expect(entities.children).toHaveLength(0);
    expect(ground.children).toHaveLength(0);
  });

  it('clear() drops everything — the run reset does not sweep these two layers', () => {
    const { entities, ground, layer, state } = harness([chest(), chest({ id: 2, kind: 'big' })]);
    layer.update(state);
    expect(entities.children).toHaveLength(2);
    layer.clear();
    expect(entities.children).toHaveLength(0);
    expect(ground.children).toHaveLength(0);
  });

  it('rebuilds after a clear rather than resurrecting destroyed views', () => {
    const { entities, layer, state } = harness([chest()]);
    layer.update(state);
    layer.clear();
    layer.update(state);
    expect(entities.children).toHaveLength(1);
    expect(entities.children[0]!.destroyed).toBe(false);
  });

  it('survives the GROUND layer being swept out from under it', () => {
    // `RoomBuilder.build` destroys every child of `layers.ground` on its first line, and a
    // door unlocking triggers one — so the plates container is destroyed underneath this map
    // routinely. Until 2026-09-14 that was SILENT: a destroyed Container reports an empty
    // `children`, so the per-mechanism loop found nothing and skipped, and a big chest simply
    // lost its plates for the rest of the floor. Only a big chest has plates and the shipped
    // level has one per floor, which is why nobody saw it.
    //
    // Asserted on a plate being drawn AGAIN afterwards, not merely on "no throw": the bug was
    // never a crash, and a guard that swallowed the destroyed view without rebuilding would
    // pass a crash test while reproducing the defect exactly.
    const big = chest({ kind: 'big', mechanisms: [{ gx: fp(11), gy: fp(12), occupied: false }] });
    const { ground, layer, state } = harness([big]);
    layer.update(state);
    expect(ground.children).toHaveLength(1);

    for (const c of [...ground.children]) c.destroy(); // what RoomBuilder.build does
    layer.update(state);

    expect(ground.children).toHaveLength(1);
    expect(ground.children[0]!.destroyed).toBe(false);
    expect((ground.children[0] as Container).children).toHaveLength(1);
  });
});

/**
 * The sprite path (2026-09-15). Four files landed — two kinds x closed/open — and the thing
 * that had to be pinned is not that a Sprite appears, but that it appears *where the fallback
 * was*: both paths are fitted to the same width and anchored at the same feet, because a chest
 * that jumped, grew or sank the frame its texture arrived would be a bug nobody could
 * reproduce (it only happens on a cold load).
 */
describe('ChestLayer — real art', () => {
  it('draws a bottom-anchored sprite scaled to the kind width, aspect from the art', () => {
    mockedTexture.mockReturnValue(texture(144, 104));
    const body = buildChestBody('small', false, texture(144, 104));
    const sprite = body.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.anchor.y).toBe(1); // feet, not centre
    expect(sprite.width).toBe(chestFootprintWidth('small'));
    // Height is the ART's to decide: 144x104 at 18 px wide is 13 px tall. A number stated in
    // the renderer would silently re-proportion a replacement file.
    expect(sprite.height).toBeCloseTo(chestFootprintWidth('small') * (104 / 144), 5);
  });

  it('lets an OPEN sprite stand taller than it is wide without widening the chest', () => {
    // `chest_small_open.png` is 144x153 — the lid is thrown back, so the art is taller than the
    // closed file. Scaling by WIDTH is what keeps the box the same size in both states.
    const closed = buildChestBody('small', false, texture(144, 104)).children[0] as Sprite;
    const open = buildChestBody('small', true, texture(144, 153)).children[0] as Sprite;
    expect(open.width).toBe(closed.width);
    expect(open.height).toBeGreaterThan(closed.height);
  });

  it('falls back to the Graphics form when the texture has not loaded', () => {
    const body = buildChestBody('big', false, undefined);
    expect(body.children[0]).toBeInstanceOf(Graphics);
  });

  it('picks the art up when it loads LATE, under a body already built', () => {
    // The real sequence on a cold boot: `RoomBuilder` runs while `preloadEnvironmentSprites()`
    // is still in flight, so the first frames draw the fallback. Without the re-ask the chest
    // would keep it for the rest of the run.
    const { entities, layer, state } = harness([chest()]);
    layer.update(state);
    expect((entities.children[0] as Container).children[1]!.children[0]).toBeInstanceOf(Graphics);
    mockedTexture.mockReturnValue(texture(144, 104));
    layer.update(state);
    expect((entities.children[0] as Container).children[1]!.children[0]).toBeInstanceOf(Sprite);
  });

  it('does NOT rebuild the body every frame once the art is in', () => {
    mockedTexture.mockReturnValue(texture(144, 104));
    const { entities, layer, state } = harness([chest()]);
    layer.update(state);
    const drawn = (entities.children[0] as Container).children[1];
    layer.update(state);
    layer.update(state);
    expect((entities.children[0] as Container).children[1]).toBe(drawn);
  });

  it('asks for the sprite of the state it is drawing, not just of the kind', () => {
    const { layer, state } = harness([chest({ opened: true })]);
    layer.update(state);
    expect(mockedTexture).toHaveBeenCalledWith('small', true);
  });
});

describe('the drawn forms', () => {
  it('makes a big chest visibly bigger than a small one — form, not only hue', () => {
    // design/13's dual-channel rule: the two kinds must be distinguishable without colour.
    expect(drawBody('big', false).bounds.width).toBeGreaterThan(drawBody('small', false).bounds.width);
  });

  it('draws an opened chest differently from a closed one of the same kind', () => {
    const closed = drawBody('small', false);
    const open = drawBody('small', true);
    expect(open.bounds.height).not.toBe(closed.bounds.height);
  });

  it('draws an occupied plate heavier than an idle one', () => {
    const idle = drawPlate(new Graphics(), false);
    const live = drawPlate(new Graphics(), true);
    expect(live.bounds.width).toBeGreaterThan(idle.bounds.width);
  });

  it('draws a plate flatter than it is wide — it lies in the floor, not on it', () => {
    const g = drawPlate(new Graphics(), true);
    expect(g.bounds.height).toBeLessThan(g.bounds.width);
  });

  it('stands the fallback ON the ground point, where the sprite stands', () => {
    // Both paths are anchored at the feet (2026-09-15). If the fallback kept straddling the
    // point the way it did before the art landed, the chest would jump half its own height the
    // frame its texture arrived — on a cold load only, which is the worst kind of bug to get a
    // report about.
    for (const kind of ['small', 'big'] as const) {
      for (const opened of [false, true]) {
        const b = drawBody(kind, opened).bounds;
        // The 1 px silhouette stroke straddles the base edge, so half of it is legitimately
        // below the ground point — anything more would be the body itself sunk into the floor.
        expect(b.maxY, `${kind}/${opened}: sits below the floor`).toBeLessThanOrEqual(0.5);
        expect(b.minY, `${kind}/${opened}: reaches above the ground point`).toBeLessThan(0);
        expect(b.width, `${kind}/${opened}: drawn to the kind width`).toBeCloseTo(chestFootprintWidth(kind) + 1, 0);
      }
    }
  });
});
