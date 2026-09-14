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
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import type { Chest, GameState } from '@dd/engine';
import { ChestLayer, drawBody, drawPlate } from './ChestLayer';
import { fpToPx } from '../coords';

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
  it('redraws the body when the chest opens', () => {
    const c = chest();
    const { entities, layer, state } = harness([c]);
    layer.update(state);
    const closed = entities.children[0]!.children[0];
    c.opened = true;
    layer.update(state);
    expect(entities.children[0]!.children[0]).not.toBe(closed);
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
});
