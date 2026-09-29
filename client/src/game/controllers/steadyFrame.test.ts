/**
 * The steady frame, end to end: what a real run's render frames cost Pixi in render-group rebuilds.
 *
 * The 2026-09-28 steady-load pass took a 4x-throttled CPU from 36–54 fps to a flat 59–60, and
 * nearly all of it was rebuilds that bought nothing: every mover writing its Y-sort key through
 * Pixi's `zIndex` setter, a door pulse redrawn each frame that Pixi's own rule called "rebuild",
 * particles in the same group as the walls. Each fix has a unit test of its own (`ySort.test.ts`,
 * `graphicsPipeFix.test.ts`, `layers.test.ts`, `groundCulling.test.ts`), and none of those can see
 * the NEXT one: a new fixture that sets `zIndex` per frame, or a new per-frame `Graphics` left
 * batchable, would put the cost straight back with every one of them still green. This file is the
 * one that turns red.
 *
 * ## What runs
 *
 * The real `GameLoop` over a real engine on level 1 (`EMBER_DUNGEON` / `EMBER_L1_ROOMS`), driving
 * the real `Scene`, `RoomBuilder` and `FxController` — sim ticks, interpolation, dust, lights,
 * occlusion, door fixtures, camera and culling are all the shipped code. Only the HUD, prompts and
 * event reactions are faked (screen space or audio, not the world), and the filter classes are
 * stubbed because they compile GL programs.
 *
 * After each frame `settle` does Pixi's per-frame render-group upkeep minus the GPU, with Pixi's
 * own pieces: `runOnRender` (which is where `settleYSort` runs), `validateRenderables` against the
 * real `GraphicsPipe.validateRenderable` and a real `GraphicsContextSystem`, then
 * `updateRenderGroupTransforms`. What it records is which groups Pixi would have rebuilt, whether a
 * Graphics change is what asked, and whether the group's structure really changed.
 *
 * This file deliberately does NOT import `render/graphicsPipeFix`: that module patches the pipe on
 * import, so importing it here would install the fix on behalf of a scene that had stopped doing so
 * itself — which is exactly the regression the quiet-room tests are meant to catch.
 *
 * ## Mutation battery — what these tests are measured to catch
 *
 * Recorded 2026-09-28. Each mutation applied to the SOURCE, this file run alone, then reverted.
 *
 *   KILLED  Entity.applyTransform writes `this.zIndex = y` (the setter) again ........ 2 tests
 *   KILLED  staticGraphics.ts stops importing graphicsPipeFix ........................ 3
 *   KILLED  doorFx's pulse is a plain (batchable) `new Graphics()` ................... 3
 *   KILLED  layers: no render group on entities / fx / numbers ....................... 4
 *   KILLED  layers: no render group on entities alone ................................ 2
 *   KILLED  layers: no render group on fx alone ...................................... 3
 *   KILLED  settleYSort flags every frame ............................................ 5
 *   KILLED  settleYSort never flags (a crossing is drawn in the old order) ........... 2
 *
 * Not covered, by design: dropping the entity-layer cull (`FxController.syncCamera`) costs draw
 * calls, not rebuilds, and nothing here draws.
 *
 * ## Limit
 *
 * Only the `graphics` pipe's rule is modelled. A sprite asks for a rebuild when its new texture
 * does not fit its batch's texture slots, which needs the GPU batcher; that cost, and any GPU
 * cost at all, is what the live measurement (`client/scripts/perf/`, see its README) is for.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Container,
  Graphics,
  GraphicsContextSystem,
  GraphicsPipe,
  updateRenderGroupTransforms,
  validateRenderables,
  type RenderGroup,
} from 'pixi.js';
import { createGameEngine, EMBER_DUNGEON, EMBER_L1_ROOMS, type GameEngine } from '@dd/engine';
import { GameLoop, type GameLoopDeps, type GameLoopHost } from './GameLoop';
import { CommandBuilder } from './CommandBuilder';
import { AllyController } from './AllyController';
import { Layers } from '../scene/layers';
import { Scene } from '../scene/Scene';
import { RoomBuilder } from '../scene/RoomBuilder';
import { Backdrop } from '../scene/Backdrop';
import { FxController } from '../fx/FxController';
import type { InputSource, InputState, TouchVisual } from '../../platform/types';

// Pixi's BlurFilter and AlphaFilter and every class in fx/filters compile a GL program at construction. Only the
// classes are replaced; the module's plain values (`SHELL_ASPECT`, `MAX_SCENE_LIGHTS`, ...) stay
// real, the convention Scene.test.ts records the reason for.
vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pixi.js')>()),
  BlurFilter: class { strength = 0; quality = 0; enabled = true; },
  AlphaFilter: class { alpha = 1; enabled = true; },
}));

vi.mock('../fx/filters', async () => {
  const actual = await vi.importActual<typeof import('../fx/filters')>('../fx/filters');
  class Stub {
    enabled = true; intensity = 0; amount = 0; radius = 0; alpha = 0; progress = 0; shatter = 0; antialias = 'off';
    hit() {} tick() {} setRegion() {} setLights() {}
  }
  return {
    ...actual,
    VignetteFilter: Stub, ChromaticAberrationFilter: Stub, SceneLightFilter: Stub,
    OutlineFilter: Stub, DissolveFilter: Stub, HeatHazeFilter: Stub, EnergyShieldFilter: Stub,
  };
});

const FRAME_MS = 1000 / 60;

// ---- Pixi's per-frame render-group upkeep, without a GPU ----

const UID = 1;
const graphicsPipeThis = {
  renderer: {
    uid: UID,
    graphicsContext: new GraphicsContextSystem({ uid: UID, limits: { maxBatchableTextures: 16 }, gc: { addResourceHash: () => undefined, now: 0 } } as never),
  },
};

interface GroupFrame {
  name: string;
  rebuilt: boolean;
  /** The rebuild was asked for by a changed Graphics (`validateRenderables`), not by the tree. */
  byGraphics: boolean;
  /** The group's structure really differs from last frame — see `structureOf`. */
  structural: boolean;
}

function groupsUnder(rg: RenderGroup, out: RenderGroup[] = []): RenderGroup[] {
  out.push(rg);
  for (const c of rg.renderGroupChildren) groupsUnder(c, out);
  return out;
}

/** Children in the order Pixi draws them: by `zIndex`, stably, when the container sorts. */
function drawOrder(c: Container): Container[] {
  return c.sortableChildren ? [...c.children].sort((a, b) => a.zIndex - b.zIndex) : c.children;
}

/**
 * Everything in a group's subtree whose change legitimately rebuilds it: which nodes are there, in
 * draw order, and each one's visible / culled / renderable flags and effect count. A nested group's
 * root is a leaf here — its insides are its own group's business.
 */
function structureOf(root: Container): string {
  const parts: string[] = [];
  const walk = (c: Container): void => {
    for (const k of drawOrder(c)) {
      parts.push(`${k.uid}:${+k.visible}${+k.culled}${+k.renderable}:${k.effects?.length ?? 0}`);
      if (!k.renderGroup) walk(k);
    }
  };
  walk(root);
  return parts.join(' ');
}

/** What a rebuild does to the tree it collects: sorts it, and marks every view as uploaded — Pixi's
 *  `updateRenderable` clears `didViewUpdate`, and a view that still has it set never reports its
 *  next change (`ViewContainer.onViewUpdate` returns early). A new Graphics starts with it set. */
function rebuildSubtree(c: Container): void {
  if (c.sortableChildren) c.sortChildren();
  for (const k of c.children) {
    (k as Container & { didViewUpdate?: boolean }).didViewUpdate = false;
    if (!k.renderGroup) rebuildSubtree(k);
  }
}

const pipes = new Proxy({} as Record<string, unknown>, {
  get: (_t, id: string) => ({
    validateRenderable: (r: Graphics) =>
      id === 'graphics' ? GraphicsPipe.prototype.validateRenderable.call(graphicsPipeThis as never, r) : false,
    updateRenderable: () => undefined,
  }),
});

class Probe {
  private readonly last = new Map<RenderGroup, string>();

  constructor(private readonly root: Container) {}

  /** Run one frame's upkeep over every group; report each. */
  settle(): GroupFrame[] {
    const out: GroupFrame[] = [];
    for (const rg of groupsUnder(this.root.renderGroup!)) {
      rg.runOnRender({} as never);
      rg.instructionSet.renderPipes = pipes as never;
      const flagged = rg.structureDidChange;
      if (!flagged) validateRenderables(rg, pipes as never);
      updateRenderGroupTransforms(rg);
      const rebuilt = rg.structureDidChange;
      if (rebuilt) rebuildSubtree(rg.root);
      rg.structureDidChange = false;
      const { list, index } = rg.childrenRenderablesToUpdate;
      for (let i = 0; i < index; i++) (list[i] as Container & { didViewUpdate: boolean }).didViewUpdate = false;
      rg.childrenRenderablesToUpdate.index = 0;
      const shape = structureOf(rg.root);
      out.push({ name: rg.root.label, rebuilt, byGraphics: rebuilt && !flagged, structural: shape !== this.last.get(rg) });
      this.last.set(rg, shape);
    }
    return out;
  }
}

// ---- A real run ----

function fakeInput(): InputSource & { state: InputState } {
  const state: InputState = { moveX: 0, moveY: 0, firing: false, interacting: false };
  const touchVisual: TouchVisual = {
    active: false, stickRadius: 40, move: null,
    fire: { cx: 0, cy: 0, r: 0, pressed: false },
    weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
    interact: { cx: 0, cy: 0, r: 0, pressed: false },
  };
  return { state, onSwitchWeapon: null, attach: vi.fn(), read: () => state, getTouchVisual: () => touchVisual } as never;
}

interface Run {
  layers: Layers;
  scene: Scene;
  engine: GameEngine;
  input: InputState;
  probe: Probe;
  /** Render `n` frames; every group's report for each. */
  frames(n: number, each?: () => void): GroupFrame[][];
}

/** Level 1's first room, built, primed and past its build frames. `clear` kills the room's enemies
 *  first, so nothing spawns, dies or crosses unless the test makes it. */
function startRun({ clear }: { clear: boolean }): Run {
  const layers = new Layers();
  layers.root.enableRenderGroup(); // what `renderer.render(stage)` does to the stage
  const named: [Container, string][] = [
    [layers.root, 'root'], [layers.backdrop, 'backdrop'], [layers.ground, 'ground'], [layers.shadow, 'shadow'],
    [layers.entities, 'entities'], [layers.fx, 'fx'], [layers.hud, 'hud'], [layers.numbers, 'numbers'], [layers.ui, 'ui'],
  ];
  for (const [c, n] of named) c.label = n;
  const scene = new Scene(layers);
  const roomBuilder = new RoomBuilder(layers, new Backdrop(layers));
  const fx = new FxController(layers);
  fx.attach();
  const input = fakeInput();
  const engine = createGameEngine({
    seed: 7, worldW: 4000, worldH: 4000, waves: [], skinId: 'vanguard', loadout: [],
    dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
  });
  const deps = {
    scene, roomBuilder, fx,
    hud: { update: vi.fn(), weaponPickupPrompt: { isOpen: false } },
    touchControlsView: { update: vi.fn() },
    portalPrompt: { update: vi.fn(), isOpen: false },
    floorCardPrompt: { update: vi.fn(), isOpen: false },
    lobbyScreens: [], menuScreens: [],
    world: layers.world, ticker: { maxFPS: 0 },
    builder: new CommandBuilder(input), ally: new AllyController(), input,
    events: { consume: vi.fn() }, runOutcome: { handle: vi.fn() }, tutorialHints: { consume: vi.fn(), reset: vi.fn() },
    pickupDebugOverlay: null,
  } as unknown as GameLoopDeps;
  const host: GameLoopHost = {
    getPhase: () => 'playing', isOnline: () => false, isCoop: () => false, isArenaDemo: () => false, isTeaching: () => false,
    replayStopTick: () => null, localOwner: 0, getEngine: () => engine, getSession: () => null,
    activeState: () => engine.state, currentScore: () => 0, selectedSkinId: () => 'vanguard', allySkinId: () => 'x',
    screenSize: () => ({ w: 1280, h: 720 }), markTutorialSeen: vi.fn(), confirm: vi.fn(),
  };
  const loop = new GameLoop(deps, host);
  const probe = new Probe(layers.root);
  const frames = (n: number, each?: () => void): GroupFrame[][] => {
    const out: GroupFrame[][] = [];
    for (let i = 0; i < n; i++) {
      loop.update(FRAME_MS);
      each?.();
      out.push(probe.settle());
    }
    return out;
  };

  loop.update(40); // tick 1: the room's enemies are placed
  roomBuilder.build(engine.state);
  if (clear) {
    for (let i = 0; i < 5; i++) {
      for (const e of engine.state.enemies) { e.alive = false; e.hp = 0; }
      loop.update(40);
    }
  }
  frames(180); // first builds, door unlock, drops settling, camera easing in
  return { layers, scene, engine, input: input.state, probe, frames };
}

function rebuildsOf(frames: GroupFrame[][], name: string): number {
  return frames.filter((f) => f.some((g) => g.name === name && g.rebuilt)).length;
}

/** A rebuild neither the tree nor a batchable Graphics asked for — pure waste. */
function unexplained(frames: GroupFrame[][]): string[] {
  const out: string[] = [];
  frames.forEach((f, i) => {
    for (const g of f) if (g.rebuilt && !g.structural && !g.byGraphics) out.push(`frame ${i}: ${g.name}`);
  });
  return out;
}

/** A real structure change Pixi was never told about — the scene draws stale (a crossing never
 *  re-sorted draws an enemy in front of the wall it walked behind). */
function missed(frames: GroupFrame[][]): string[] {
  const out: string[] = [];
  frames.forEach((f, i) => {
    for (const g of f) if (g.structural && !g.rebuilt) out.push(`frame ${i}: ${g.name}`);
  });
  return out;
}

function graphicsRebuilds(frames: GroupFrame[][]): string[] {
  const out: string[] = [];
  frames.forEach((f, i) => {
    for (const g of f) if (g.byGraphics) out.push(`frame ${i}: ${g.name}`);
  });
  return out;
}

// ---- The invariants ----

describe('the steady frame — a quiet room', () => {
  it('an idle second rebuilds nothing but the dust layer', () => {
    const run = startRun({ clear: true });
    const second = run.frames(60);
    for (const name of ['root', 'backdrop', 'ground', 'shadow', 'entities', 'hud', 'numbers', 'ui']) {
      expect(rebuildsOf(second, name), name).toBe(0);
    }
    // Dust drifts in and out of `fx` for as long as a run plays; that is why it has a group.
    expect(rebuildsOf(second, 'fx')).toBeGreaterThan(0);
  });

  it('walking rebuilds the entity layer only where something really changed, and never the root', () => {
    const run = startRun({ clear: true });
    const { curX: x0, curY: y0 } = run.scene.player!;
    // Diagonally, so the player's sort key changes every frame: a straight east walk never writes a
    // new key at all, and would pass with the old per-frame `zIndex` write put back.
    run.input.moveX = 1;
    run.input.moveY = 0.5;
    const walk = run.frames(120);
    expect(run.scene.player!.curX - x0).toBeGreaterThan(100); // it really walked
    expect(run.scene.player!.curY - y0).toBeGreaterThan(30);
    expect(unexplained(walk)).toEqual([]);
    expect(missed(walk)).toEqual([]);
    expect(graphicsRebuilds(walk)).toEqual([]);
    expect(rebuildsOf(walk, 'root')).toBe(0);
    // Before `ySort.ts` the mover's key write rebuilt this group on every one of these frames. What
    // is left is the player crossing a wall or pillar, a piece culled or uncovered at the view's
    // edge, and a door fixture shown or hidden.
    expect(rebuildsOf(walk, 'entities')).toBeLessThan(walk.length / 4);
  });
});

describe('the steady frame — a fight', () => {
  it('every rebuild in a real fight has a cause: a spawn, a death, a crossing, a cull, a flag, a batch', () => {
    const run = startRun({ clear: false });
    expect(run.engine.state.enemies.some((e) => e.alive)).toBe(true);
    const fight = run.frames(240, () => {
      // Strafe up and down through the room so the player's key crosses the enemies' and the walls'.
      run.input.moveY = Math.sin(run.engine.state.tick / 20) > 0 ? 1 : -1;
    });
    expect(rebuildsOf(fight, 'entities')).toBeGreaterThan(0); // it really fought
    expect(unexplained(fight)).toEqual([]);
    expect(missed(fight)).toEqual([]);
    expect(rebuildsOf(fight, 'root')).toBe(0);
  });
});

// ---- The controls: each file's detector, shown to fire on the regression it exists for ----

describe('the steady frame — controls', () => {
  it('a mover writing its key through the zIndex setter again is caught as waste', () => {
    const run = startRun({ clear: true });
    run.input.moveX = 1;
    const walk = run.frames(60, () => {
      const p = run.scene.player!;
      p.zIndex = p.zIndex + 1e-6; // what `Entity.applyTransform` did before `writeSortKey`
    });
    expect(unexplained(walk).length).toBeGreaterThan(50);
  });

  it("Pixi's own Graphics rule is caught rebuilding on the door fixtures' redraws", () => {
    const run = startRun({ clear: true });
    const proto = GraphicsPipe.prototype as unknown as { validateRenderable: (g: Graphics) => boolean };
    const fixed = proto.validateRenderable;
    // Pixi 8.19's rule, restated: `graphicsPipeFix.test.ts` pins that the real one answers exactly
    // this, and this file cannot import that module to borrow it (see the header).
    proto.validateRenderable = function (this: typeof graphicsPipeThis, g: Graphics) {
      const gpu = this.renderer.graphicsContext.updateGpuContext(g.context);
      const wasBatched = !!(g._gpuData as unknown); // always true: the bug
      return gpu.isBatchable || wasBatched !== gpu.isBatchable;
    };
    try {
      expect(graphicsRebuilds(run.frames(60)).length).toBeGreaterThan(50);
    } finally {
      proto.validateRenderable = fixed;
    }
    expect(graphicsRebuilds(run.frames(60))).toEqual([]);
  });

  it('a per-frame Graphics left batchable is caught', () => {
    const run = startRun({ clear: true });
    const g = new Graphics();
    run.layers.entities.addChild(g);
    run.frames(1);
    const idle = run.frames(30, () => {
      g.clear().circle(0, 0, 4 + Math.random()).fill(0xffffff);
    });
    expect(graphicsRebuilds(idle).length).toBe(30);
  });
});
