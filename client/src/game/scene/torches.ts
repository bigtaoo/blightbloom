// A room's wall torches (2026-10-10, design/13 "Environment: warm stone, dark edges, light pools"):
// the fixture on the wall, a small additive halo at its flame, and — the part that matters — a real
// point light in the scene pass (`fx/filters/litFx.ts`), so the stone, the walls and every actor
// near a torch are lit by it rather than a glow being painted on top of them. WHERE the torches hang
// is `torchPlacement.ts`; this file owns their lifetime and their per-frame light.
//
// Light budget. The scene pass has a fixed number of slots (`MAX_SCENE_LIGHTS`) shared with the
// player's glow and every muzzle flash and impact, and `LightRegistry.snapshot` keeps the strongest
// when there are more lights than slots. A torch is stronger than a muzzle flash, so registering
// every torch on the floor would starve the fight's own lights. Only the torches whose light can
// reach the visible rect are registered, nearest the view centre first, capped at `MAX_LIT_TORCHES`.
import { Graphics, Sprite, type Texture } from 'pixi.js';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { tagStandingPiece } from './groundCulling';
import { writeSortKey } from './ySort';
import { planTorches, type TorchSpot } from './torchPlacement';
import type { RectPx } from './wallGeometry';
import type { WallRun } from './wallRuns';
import type { LightSource } from '../fx/lighting';
import type { BiomeElement } from '../theme';
import { getTorchTexture } from '../../render/environmentSprites';

/** Chapters whose rooms are torch-lit. Ember first — the pilot chapter of the warm-stone direction;
 *  each other chapter joins when its own stone art does, so a cold room never gets a warm torch. */
export const TORCH_ELEMENTS: ReadonlySet<BiomeElement> = new Set<BiomeElement>(['fire']);

/** What `TorchSet` needs from `LightRegistry` — two methods, so a test can hand it a recorder. */
export interface TorchLightSink {
  addPersistent(id: string, light: LightSource): void;
  removePersistent(id: string): void;
}

/** The visible world rect — `doorTick.CameraRect`, the shape `RoomBuilder.tickFixtures` gets. */
export interface TorchView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The fixture's drawn height, and the height its foot hangs at above the floor line, world px.
 *  A perimeter face is 104 px (`wallGeometry.WALL_H_PERIMETER`); this puts the sconce in its upper
 *  middle, where the key frame hangs them, clear of the base an actor stands in front of. */
export const TORCH_DRAW_H = 48;
export const TORCH_MOUNT_Z = 24;
/** Where the flame sits inside the sprite, as a fraction of its height from the top. */
const FLAME_FROM_TOP = 0.42;

/** The light. Warm and wide: about three and a half hero-widths of radius, so neighbouring torches'
 *  pools (`TORCH_SPACING` apart) overlap into one lit band along the wall. */
export const TORCH_LIGHT_COLOR = 0xffa654;
export const TORCH_LIGHT_RADIUS = 140;
export const TORCH_LIGHT_INTENSITY = 1.2;
/** How far above a north torch's ground point its light is centred, world px. Between the floor
 *  line and the flame, on purpose: the pass lights in screen space, so a light at the flame spends
 *  half its disc on the wall face above it and a light on the floor line leaves the wall around the
 *  sconce unlit — the key frame lights both, the wall in a glow and the floor in a pool. */
const LIGHT_LIFT = 8;
/** The additive halo at the flame: concentric rings, so the glow on the wall around a sconce falls
 *  off rather than ending in an edge. */
const HALO_RINGS = 6;
const HALO_RADIUS = 34;
const HALO_RING_ALPHA = 0.045;
/** Torches registered at once. Leaves the rest of `MAX_SCENE_LIGHTS` to the player and the fight. */
export const MAX_LIT_TORCHES = 6;

/** Flicker: two incommensurate sines, each torch at its own phase, so a row of torches never
 *  pulses in step. Small on purpose: this is a whole-room light, and a room whose brightness
 *  visibly pumps is whole-screen motion, which this project treats as a bug. */
const FLICKER_A = 0.07;
const FLICKER_B = 0.04;

interface Torch {
  readonly id: string;
  readonly spot: TorchSpot;
  readonly entity: Entity;
  readonly halo: Graphics;
  readonly light: LightSource;
  readonly phase: number;
}

export class TorchSet {
  private torches: Torch[] = [];
  private readonly lit = new Set<string>();
  /** The registry the lit set was registered with, kept so a rebuild or a clear can withdraw them —
   *  a rebuild that left `torch:7` registered on a floor of five torches would light empty floor. */
  private sink: TorchLightSink | undefined;
  private clockMs = 0;
  /** Reused per frame: the candidates for this frame's light slots. */
  private readonly candidates: { torch: Torch; d2: number }[] = [];

  constructor(private readonly layers: Layers) {}

  /** Replace the floor's torches. `texture` undefined still registers the lights. */
  build(spots: readonly TorchSpot[], texture: Texture | undefined): void {
    this.clear();
    spots.forEach((spot, i) => {
      const entity = new Entity();
      const flameY = -TORCH_MOUNT_Z - TORCH_DRAW_H * (1 - FLAME_FROM_TOP);
      // A side wall shows no face in this projection, only its cap, so a sconce centred on the edge
      // reads as standing ON the wall. Pushed into the room by half its width, its back is on the
      // wall's edge and it reads as hung from it.
      const inward = texture ? (TORCH_DRAW_H * texture.width) / texture.height / 2 : 0;
      const dx = spot.side === 'west' ? inward : spot.side === 'east' ? -inward : 0;
      const halo = new Graphics();
      for (let k = HALO_RINGS; k >= 1; k--) {
        halo.circle(dx, flameY, (HALO_RADIUS * k) / HALO_RINGS).fill({ color: TORCH_LIGHT_COLOR, alpha: HALO_RING_ALPHA });
      }
      halo.blendMode = 'add';
      if (texture) {
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5, 1);
        sprite.scale.set(TORCH_DRAW_H / texture.height);
        sprite.position.set(dx, -TORCH_MOUNT_Z);
        entity.addChild(sprite);
      }
      entity.addChild(halo);
      // Half a pixel south of the wall's sort line: a tie would let the wall draw over its own torch.
      entity.place(spot.x, spot.y);
      writeSortKey(entity, spot.sortY + 0.5);
      this.layers.entities.addChild(entity);
      tagStandingPiece(entity);
      const light: LightSource = {
        // Further into the room than the sconce for a side torch: the light is for the floor in front.
        x: spot.x + dx * 2,
        y: spot.y + (spot.side === 'north' ? -LIGHT_LIFT : -TORCH_MOUNT_Z),
        color: TORCH_LIGHT_COLOR,
        radius: TORCH_LIGHT_RADIUS,
        intensity: TORCH_LIGHT_INTENSITY,
      };
      this.torches.push({ id: `torch:${i}`, spot, entity, halo, light, phase: i * 2.399 });
    });
  }

  /** The floor's torches from its wall plan (`roomWallPlan.planRoomWalls`) — none for a chapter
   *  not in `TORCH_ELEMENTS`, which still clears whatever the previous floor hung. */
  buildFor(
    plan: { roomsPx: readonly RectPx[]; merged: readonly WallRun[]; passageRectsPx: readonly RectPx[] },
    element: BiomeElement,
  ): void {
    const spots = TORCH_ELEMENTS.has(element) ? planTorches(plan.roomsPx, plan.merged, plan.passageRectsPx) : [];
    this.build(spots, getTorchTexture());
  }

  get count(): number {
    return this.torches.length;
  }

  /** Flicker the visible torches and hand the scene pass the ones whose light reaches `view`. */
  tick(dtMs: number, view: TorchView | null, sink: TorchLightSink | undefined): void {
    this.clockMs += dtMs;
    if (sink) this.sink = sink;
    if (!view) return;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const reach = TORCH_LIGHT_RADIUS;
    this.candidates.length = 0;
    for (const torch of this.torches) {
      const { x, y } = torch.light;
      const flicker = this.flicker(torch.phase);
      torch.halo.alpha = flicker;
      torch.light.intensity = TORCH_LIGHT_INTENSITY * flicker;
      if (x < view.x - reach || x > view.x + view.w + reach) continue;
      if (y < view.y - reach || y > view.y + view.h + reach) continue;
      this.candidates.push({ torch, d2: (x - cx) ** 2 + (y - cy) ** 2 });
    }
    if (!sink) return;
    this.candidates.sort((a, b) => a.d2 - b.d2);
    const keep = new Set<string>();
    for (let i = 0; i < Math.min(MAX_LIT_TORCHES, this.candidates.length); i++) {
      const t = this.candidates[i]!.torch;
      keep.add(t.id);
      sink.addPersistent(t.id, t.light);
    }
    for (const id of this.lit) if (!keep.has(id)) sink.removePersistent(id);
    this.lit.clear();
    for (const id of keep) this.lit.add(id);
  }

  /** Destroy every fixture and withdraw every light this set registered. */
  clear(): void {
    for (const t of this.torches) t.entity.destroy();
    this.torches = [];
    if (this.sink) for (const id of this.lit) this.sink.removePersistent(id);
    this.lit.clear();
  }

  private flicker(phase: number): number {
    const t = this.clockMs;
    return 1 + FLICKER_A * Math.sin(t * 0.0113 + phase) + FLICKER_B * Math.sin(t * 0.0291 + phase * 1.7);
  }
}
