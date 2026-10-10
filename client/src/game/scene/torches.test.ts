/**
 * TorchSet — the wall torches' fixtures and their scene lights (design/13 "Environment: warm stone,
 * dark edges, light pools", 2026-10-10). WHERE they hang is `torchPlacement.test.ts`; this file pins
 * what a spot turns into, which torches get one of the scene pass's scarce light slots, and that a
 * rebuild or a clear never leaves a light registered over empty floor.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import type { Layers } from './layers';
import type { LightSource } from '../fx/lighting';
import type { TorchSpot } from './torchPlacement';

const mocks = vi.hoisted(() => ({ torchTexture: undefined as unknown }));
vi.mock('../../render/environmentSprites', () => ({
  getTorchTexture: () => mocks.torchTexture,
}));

import {
  MAX_LIT_TORCHES,
  TORCH_DRAW_H,
  TORCH_LIGHT_INTENSITY,
  TORCH_LIGHT_RADIUS,
  TORCH_ELEMENTS,
  TORCH_MOUNT_Z,
  TorchSet,
  type TorchLightSink,
} from './torches';
import { WARM_STONE_ELEMENTS } from '../theme';

/** 88x200, the shipped sconce's proportions: drawn 48 tall it is 21.12 wide. */
const TEX = new Texture({ source: new TextureSource({ width: 88, height: 200 }) });
const HALF_W = (TORCH_DRAW_H * 88) / 200 / 2;

function layers(): Layers & { entities: Container } {
  return { entities: new Container() } as unknown as Layers & { entities: Container };
}

class Recorder implements TorchLightSink {
  readonly lights = new Map<string, LightSource>();
  readonly removed: string[] = [];
  addPersistent(id: string, light: LightSource): void {
    this.lights.set(id, light);
  }
  removePersistent(id: string): void {
    this.removed.push(id);
    this.lights.delete(id);
  }
}

const north = (x: number, y = 64): TorchSpot => ({ x, y, sortY: y, side: 'north' });
const VIEW = { x: 0, y: 0, w: 800, h: 600 };

describe('TorchSet.build — what a spot turns into', () => {
  it('stands a sconce sprite and an additive halo on the wall, sorted just south of it', () => {
    const l = layers();
    const set = new TorchSet(l);
    set.build([{ x: 100, y: 264, sortY: 480, side: 'west' }], TEX);
    expect(set.count).toBe(1);
    const entity = l.entities.children[0] as Container;
    expect(entity.position.x).toBe(100);
    expect(entity._zIndex).toBe(480.5); // the wall's own sort line, plus the tie-break
    const [sprite, halo] = entity.children as [Sprite, Graphics];
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.height).toBeCloseTo(TORCH_DRAW_H);
    expect(sprite.position.y).toBe(-TORCH_MOUNT_Z);
    expect(halo).toBeInstanceOf(Graphics);
    expect(halo.blendMode).toBe('add');
  });

  it('pushes a side sconce into the room by half its width, and its light twice that', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build(
      [
        { x: 32, y: 264, sortY: 480, side: 'west' },
        { x: 608, y: 264, sortY: 480, side: 'east' },
      ],
      TEX,
    );
    set.tick(16, VIEW, sink);
    expect(sink.lights.get('torch:0')!.x).toBeCloseTo(32 + 2 * HALF_W);
    expect(sink.lights.get('torch:1')!.x).toBeCloseTo(608 - 2 * HALF_W);
    // A side light sits at the mount height; it lights the floor in front of the wall.
    expect(sink.lights.get('torch:0')!.y).toBe(264 - TORCH_MOUNT_Z);
  });

  it('centres a north torch on its spot and lifts its light just above the floor line', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(300)], TEX);
    set.tick(0, VIEW, sink);
    const light = sink.lights.get('torch:0')!;
    expect(light.x).toBe(300);
    expect(light.y).toBeLessThan(64);
    expect(light.y).toBeGreaterThan(64 - TORCH_MOUNT_Z);
    expect(light.radius).toBe(TORCH_LIGHT_RADIUS);
  });

  it('still lights the room with no sconce art loaded — the halo alone stands on the wall', () => {
    const l = layers();
    const set = new TorchSet(l);
    const sink = new Recorder();
    set.build([{ x: 32, y: 264, sortY: 480, side: 'west' }], undefined);
    expect((l.entities.children[0] as Container).children).toHaveLength(1);
    set.tick(0, VIEW, sink);
    expect(sink.lights.get('torch:0')!.x).toBe(32); // no width to push it in by
  });
});

describe('TorchSet.buildFor — which chapters are torch-lit', () => {
  const plan = {
    roomsPx: [{ x: 0, y: 0, w: 640, h: 480 }],
    merged: [{ rect: { x: 0, y: 0, w: 640, h: 64 }, tier: 'perimeter' as const }],
    passageRectsPx: [],
  };

  it('hangs the ember chapter, with the loaded sconce art', () => {
    mocks.torchTexture = TEX;
    const l = layers();
    const set = new TorchSet(l);
    set.buildFor(plan, 'fire');
    expect(set.count).toBe(2);
    expect((l.entities.children[0] as Container).children[0]).toBeInstanceOf(Sprite);
    mocks.torchTexture = undefined;
  });

  it.each(['ice', 'lightning', 'poison'] as const)('hangs the %s chapter too, now that its stone is warm-stone', (element) => {
    const set = new TorchSet(layers());
    set.buildFor(plan, element);
    expect(set.count).toBe(2);
  });

  it('lights exactly the warm-stone chapters — the torch is part of that look, not of every room', () => {
    expect([...TORCH_ELEMENTS].sort()).toEqual([...WARM_STONE_ELEMENTS].sort());
  });

  it('hangs nothing on first-generation stone (a PvP arena), and clears the last floor', () => {
    const l = layers();
    const set = new TorchSet(l);
    set.buildFor(plan, 'fire');
    set.buildFor(plan, 'neutral');
    expect(set.count).toBe(0);
    expect(l.entities.children).toHaveLength(0);
  });
});

describe('TorchSet.tick — the light budget', () => {
  it('registers only the torches whose light can reach the view', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    // In view; just off its right edge but within one radius; past one radius.
    set.build([north(400), north(800 + TORCH_LIGHT_RADIUS - 1), north(800 + TORCH_LIGHT_RADIUS + 1)], TEX);
    set.tick(0, VIEW, sink);
    expect([...sink.lights.keys()].sort()).toEqual(['torch:0', 'torch:1']);
  });

  it('culls vertically too', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(400, 600 + TORCH_LIGHT_RADIUS + 50), north(400, -TORCH_LIGHT_RADIUS - 50)], TEX);
    set.tick(0, VIEW, sink);
    expect(sink.lights.size).toBe(0);
  });

  it('keeps the nearest MAX_LIT_TORCHES to the view centre when more are visible', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    // Eleven torches across the view, listed far-to-near so list order cannot fake the sort.
    const xs = [0, 800, 40, 760, 80, 730, 120, 680, 400, 360, 440];
    set.build(xs.map((x) => north(x, 300)), TEX);
    set.tick(0, VIEW, sink);
    expect(sink.lights.size).toBe(MAX_LIT_TORCHES);
    const kept = [...sink.lights.values()].map((l) => l.x).sort((a, b) => a - b);
    expect(kept).toEqual([80, 120, 360, 400, 440, 680]); // 730 is 10 px further out than 80
  });

  it('withdraws a torch that leaves the view, and only that one', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(100), north(700)], TEX);
    set.tick(0, VIEW, sink);
    set.tick(0, { ...VIEW, x: 600 }, sink); // the view slides right: torch 0 is now 500+ px out
    expect(sink.removed).toEqual(['torch:0']);
    expect([...sink.lights.keys()]).toEqual(['torch:1']);
  });

  it('flickers each torch at its own phase, by a few per cent at most', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(300), north(500)], TEX);
    const seen: number[][] = [];
    for (let f = 0; f < 120; f++) {
      set.tick(16, VIEW, sink);
      seen.push([sink.lights.get('torch:0')!.intensity, sink.lights.get('torch:1')!.intensity]);
    }
    const all = seen.flat();
    expect(Math.min(...all)).toBeGreaterThan(TORCH_LIGHT_INTENSITY * 0.88);
    expect(Math.max(...all)).toBeLessThan(TORCH_LIGHT_INTENSITY * 1.12);
    expect(new Set(all.map((v) => v.toFixed(4))).size).toBeGreaterThan(100); // it does move
    expect(seen.some(([a, b]) => Math.abs(a! - b!) > 0.02)).toBe(true); // not in step
  });

  it('registers nothing without a view, nor without a sink', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(300)], TEX);
    set.tick(16, null, sink);
    expect(sink.lights.size).toBe(0);
    set.tick(16, VIEW, undefined);
    expect(sink.lights.size).toBe(0);
    set.tick(16, VIEW, sink);
    expect(sink.lights.size).toBe(1); // the control: the same torch, with both, is lit
  });
});

describe('TorchSet.clear — nothing left behind', () => {
  it('destroys every fixture and withdraws every light it registered', () => {
    const l = layers();
    const set = new TorchSet(l);
    const sink = new Recorder();
    set.build([north(300), north(500)], TEX);
    set.tick(0, VIEW, sink);
    set.clear();
    expect(l.entities.children).toHaveLength(0);
    expect(sink.lights.size).toBe(0);
    expect(set.count).toBe(0);
  });

  it('withdraws the old floor when a new one is built — a stale id would light empty floor', () => {
    const set = new TorchSet(layers());
    const sink = new Recorder();
    set.build([north(100), north(300), north(500)], TEX);
    set.tick(0, VIEW, sink);
    set.build([north(300)], TEX);
    expect(sink.lights.size).toBe(0);
    set.tick(0, VIEW, sink);
    expect([...sink.lights.keys()]).toEqual(['torch:0']);
  });

  it('is safe before any sink was ever seen', () => {
    const set = new TorchSet(layers());
    set.build([north(300)], TEX);
    expect(() => set.clear()).not.toThrow();
  });
});
