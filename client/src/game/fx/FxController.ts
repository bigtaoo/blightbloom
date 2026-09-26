import { BlurFilter, Container, Graphics, Rectangle } from 'pixi.js';
import type { Layers } from '../scene/layers';
import { fitTerrain } from '../scene/Terrain';
import { VignetteFilter, ChromaticAberrationFilter, SceneLightFilter, MAX_SCENE_LIGHTS } from './filters';
import { ParticleSystem } from './Particles';
import { LightRegistry, makeLightBuffer, type ActiveLight } from './lighting';
import { activeQuality } from '../../render/quality';
import { cullGroundLayer } from '../scene/groundCulling';
import { acquireSlashArc, releaseSlashArc, type SlashArc, type SlashArcPose } from './slashArc';
import { motionReduced } from '../../render/motion';
import { DamageNumbers } from './DamageNumbers';

const FX_LIFE_MS = 170; // flash/trail lifetime (the default for a `_life`-tagged fx child)
/** Muzzle-flare lifetime. Much shorter than a flash: a gun's flare is a single frame of real
 *  light, and at 170 ms a weapon firing every 200 ms would have one on screen essentially
 *  permanently, which reads as a glowing barrel rather than as shots. */
const MUZZLE_FLARE_MS = 85;
/** Muzzle-flare geometry, world px (an actor's own radius is ~16, so the cone reaches about a
 *  gun's length past the barrel). Drawn along +x and rotated onto the shot direction. */
const FLARE_R = 5;
const FLARE_LEN = 17;
const MAX_SHAKE_PX = 14; // camera-shake offset at full trauma (design/01 milestone 3)
// Cap on updateCamera's fill zoom — raised from 1.8 (design/10's original legibility
// fix) to 2.5 (user report, 2026-08-12): a floor whose combined room width is well
// under the viewport left a wide dark `Backdrop` void beside the room that read as "the
// game viewport doesn't fill the window" rather than an intentional letterbox (the void
// colour is deliberately very dark — theme.ts's `BiomePalette.void` — so it's visually
// indistinguishable from an unrendered black canvas). A higher cap shrinks that void by
// zooming a small floor in further before the degenerate-blockiness limit kicks in; it
// does NOT touch the zoom=1 floor for anything already viewport-sized+. Superseded for
// the VOID ITSELF by the cover-fit switch below (2026-08-12 follow-up) — this cap now
// only guards against a truly tiny/degenerate room forcing an absurd zoom, not against
// letterboxing (cover-fit has none).
// Raised again 2026-08-17 (2.5 -> 4.5) when the fit target became the current ROOM
// rather than the whole floor: level 1's authored rooms are ~470-560 px square, so
// cover-fitting one into a 1920x911 viewport wants ~3.4-4.1x and the old 2.5 cap bound
// in every single room — the room rendered ~1170 px wide inside a 1920 px viewport and
// the neighbours on either side stayed on screen, which is exactly what the fit change
// was for. At 4x the hero reads about a seventh of the screen height, in line with the
// genre. This remains a guard against a degenerate/tiny room, not a framing dial.
const MAX_ZOOM = 4.5;
// How much of the frame the camera looks ABOVE the follow target's ground point, as a
// fraction of the viewport height (user report, 2026-08-17: "镜头往下一些 … 给角色最好
// 的展示"). Every entity reports its GROUND position — the point at its feet, where its
// shadow and collision footprint sit (Entity.applyTransform) — so a camera centred on
// it puts the character's feet dead centre and its whole body in the upper half of the
// screen, with a band of empty floor below. Biasing the look-at point upward in world
// space slides the rendered world DOWN, which is what re-centres the character in the
// frame. 8% of the viewport, not a fixed pixel count, so it scales with the window and
// with the zoom the frame-fit picks.
const CAMERA_BODY_BIAS_R = 0.08;

/** Something that can report its interpolated ground position — the local player's
 *  Actor view, duck-typed so FxController never needs to import game/Actor.ts. */
export interface CameraTarget {
  interpGroundX(alpha: number): number;
  interpGroundY(alpha: number): number;
}

/** A world-px rect for the camera to fill — the room the local player is standing in
 *  (`GameLoop.updateCamera` resolves it), falling back to the whole floor. */
export interface CameraFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Post-processing / game-feel (design/01 fidelity roadmap milestone 3), extracted out
 * of Game.ts 2026-07-28 (that file had accreted 6+ unrelated jobs — this is the "world
 * glow, driven by events" slice: flashes/trails, ambient particles, camera shake/hit-
 * stop/chromatic pulse, and the camera-follow math those feed into). Render-only,
 * reads no engine state directly — Game hands it whatever this frame's derived values
 * are (dust bounds, viewport size, player position) so this stays decoupled from
 * Scene/GameState.
 */
export class FxController {
  readonly particles = new ParticleSystem();
  /** Floating damage numbers (design/10), on `layers.numbers` — see `DamageNumbers`. */
  readonly numbers = new DamageNumbers();
  readonly vignette = new VignetteFilter();
  readonly chromatic = new ChromaticAberrationFilter(0);
  /** Dynamic point lights (design/01 milestone 2) — the local-player glow (registered
   *  by Game.ts each frame) plus transient bursts registered by `flash()` below. */
  readonly lights = new LightRegistry();
  /** The one lighting pass (design/01 milestone 2) — replaced a per-actor filter 2026-08-24,
   *  see fx/filters/litFx.ts. Mounted on `layers.lit` by `attach`. */
  readonly sceneLight = new SceneLightFilter();
  /** Bloom-lite blur over the additive fx layer. A field rather than a `new` inside `attach()`
   *  (as it was until 2026-08-25) so `applyQuality` can mount and unmount it without building a
   *  fresh filter — and its GL program — every time the tier changes. */
  private readonly bloom = new BlurFilter({ strength: 3, quality: 2 });
  /** `layers.lit`'s filter region, in WORLD px. Pinned to exactly the visible world rect and
   *  mutated in place each frame (never reassigned) so the filter's own `uRegion` and Pixi's
   *  computed bounds describe the same rectangle — the shader's world-space mapping, and so
   *  every light's position on screen, depends on those two agreeing. */
  private readonly litArea = new Rectangle(0, 0, 1, 1);
  /** Reused scratch for `LightRegistry.snapshot` — one slot per shader light slot. */
  private readonly lightBuffer: ActiveLight[] = makeLightBuffer(MAX_SCENE_LIGHTS);
  /** Melee sector arcs currently sweeping (`slashArc`). Tracked in a list of its own rather than
   *  through `_life` because each one animates its geometry, not just its alpha — `updateFx`. */
  private readonly slashes: SlashArc[] = [];
  private shakeTrauma = 0;
  private hitStopMs = 0;
  /** Current world→screen zoom applied in updateCamera — CommandBuilder needs this
   *  to convert a screen-space mouse point back to world space (Game.ts reads it
   *  into `cam.zoom`). 1 until the first updateCamera call (no zoom applied yet). */
  zoom = 1;
  /** How many pieces of `layers.ground` the last `updateCamera` left on screen — the ground cull's
   *  own readout (`groundCulling.ts`). 0 before the first camera update, and 0 while there is no
   *  ground built. Read by tests and by the perf console handle; nothing in the render path uses it. */
  visibleGroundPieces = 0;

  constructor(private readonly layers: Layers) {}

  /** Wire post-processing filters + mount the particle view — call once from Game.start(). */
  attach(): void {
    this.layers.fx.addChild(this.particles.view);
    this.layers.numbers.addChild(this.numbers.view);
    // One lighting pass over ground+shadow+entities (see Layers.lit for what is deliberately
    // left out of it). `filterArea` is mandatory here, not an optimisation: this filter opts
    // out of Pixi's viewport clip, so without an area the region would be the whole dungeon
    // floor's bounds. The first `updateCamera` replaces these placeholder numbers; until then
    // there are no point lights registered, and the key-light term does not read the region.
    // Set unconditionally, even on the low tier where the filter itself is not mounted: it is
    // a property of the layer, not of the pass, and leaving it correct means re-mounting on a
    // tier change needs no second call.
    this.layers.lit.filterArea = this.litArea;
    this.applyQuality();
  }

  /**
   * Mount exactly the full-viewport passes the active quality tier calls for
   * (`render/quality.ts`). Idempotent, and safe to call at any time — `Game` calls it once from
   * `attach()` and again whenever the setting or the frame watchdog changes the tier.
   *
   * Each of the three lists below is one render-target pass over the whole viewport, and on a
   * phone each of those pays the renderer's resolution multiplier again. Turning them off is
   * the largest lever this class has, which is why it is a lever and not a constant (2026-08-25;
   * before that these three assignments ran unconditionally, and a device that could not afford
   * them had nothing to turn off).
   *
   * `filters = []` rather than `null`: Pixi treats both as "no filter", and an empty array keeps
   * the property's type stable across tier flips.
   */
  applyQuality(): void {
    const q = activeQuality();
    this.layers.world.filters = q.screenFx ? [this.vignette, this.chromatic] : [];
    // Bloom-lite: a modest blur directly on the ADDITIVE-blended fx layer (muzzle
    // flashes/trails/particles) gives a cheap glow halo without a real multi-pass
    // bright-pass bloom (first-pass approximation, design/01's own "milestone" framing).
    this.layers.fx.filters = q.bloom ? [this.bloom] : [];
    this.layers.lit.filters = q.sceneLight ? [this.sceneLight] : [];
    this.particles.setBudget(q.particleBudget);
  }

  /** Drop a fading dot at (x,y) — bullet trails (spawnBulletTrails). */
  trailDot(x: number, y: number, color: number, radius: number): void {
    const dot = new Graphics();
    dot.circle(0, 0, radius).fill({ color, alpha: 0.5 });
    dot.blendMode = 'add';
    dot.x = x;
    dot.y = y - 12;
    (dot as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(dot);
  }

  /** A radial glow burst at (x,y) — hit/pickup/status feedback (consumeEvents). Also
   *  registers a matching transient point light (design/01 milestone 2) so nearby
   *  actors visibly brighten for the same instant the burst is on screen — same
   *  lifetime, same colour, no separate call site needed. */
  flash(x: number, y: number, color: number, radius: number): void {
    const glow = new Graphics();
    const steps = 5;
    for (let i = steps; i >= 1; i--) {
      glow.circle(0, 0, radius * (i / steps)).fill({ color, alpha: 0.16 });
    }
    glow.blendMode = 'add';
    glow.x = x;
    glow.y = y - 12;
    (glow as unknown as { _life: number })._life = FX_LIFE_MS;
    this.layers.fx.addChild(glow);
    this.lights.addTransient({ x, y, color, radius: radius * 3, intensity: 0.7 }, FX_LIFE_MS);
  }

  /**
   * The shot leaving the barrel (2026-08-30, user report *"枪口也没有射击特效"*): a directional
   * flare drawn AT the drawn muzzle and pointed along the shot, plus its own transient light.
   *
   * Replaces the radial `flash()` this event used to call for three reasons, all of which made
   * the previous fx read as absent rather than as small. It was anchored at the SIM's muzzle
   * (`bullet_fired`'s `gx/gy` — a flat offset along the aim ray on the GROUND plane) lifted by
   * a hardcoded 12 px, which lands near the character's middle rather than at the gun the rig
   * actually draws; it was round, so it carried no direction at all; and it expanded over
   * 170 ms, i.e. it was still on screen when the next shot of a 200 ms-cooldown weapon went
   * out. This one is anchored on `Actor.muzzlePos()` — the same barrel tip the bullet already
   * spawns from — points along `angleRad`, and collapses in 85 ms.
   *
   * Shape: a forward cone (the blast), a shorter perpendicular cross-flash (what makes it read
   * as a flash and not a beam), and a near-white core so the flare has a value peak instead of
   * one flat hue. Additive, so `layers.fx`'s bloom pass picks it up.
   */
  muzzleFlare(x: number, y: number, angleRad: number, color: number): void {
    const g = new Graphics();
    g.moveTo(0, -FLARE_R * 0.75).lineTo(FLARE_LEN, 0).lineTo(0, FLARE_R * 0.75).closePath()
      .fill({ color, alpha: 0.5 });
    g.moveTo(0, -FLARE_R * 1.9).lineTo(FLARE_R * 0.75, 0).lineTo(0, FLARE_R * 1.9)
      .lineTo(-FLARE_R * 0.75, 0).closePath().fill({ color, alpha: 0.3 });
    g.circle(0, 0, FLARE_R).fill({ color, alpha: 0.55 });
    g.circle(0, 0, FLARE_R * 0.5).fill({ color: 0xffffff, alpha: 0.7 });
    g.blendMode = 'add';
    g.position.set(x, y);
    g.rotation = angleRad;
    Object.assign(g, { _life: MUZZLE_FLARE_MS, _lifeMax: MUZZLE_FLARE_MS, _grow: -0.35 });
    this.layers.fx.addChild(g);
    // The room lights up for exactly as long as the flare is on screen — the same pairing
    // `flash()` makes, kept here so dropping that call cost nothing.
    this.lights.addTransient({ x, y, color, radius: 46, intensity: 0.85 }, MUZZLE_FLARE_MS);
  }

  /**
   * The melee counterpart of `muzzleFlare`: the swing's own SECTOR, swept once at the weapon's
   * true arc and reach (2026-09-02, asked for: an fx that shows the attack's sector). See
   * `fx/slashArc.ts` for the geometry and for why this one fx is a Mesh.
   *
   * Kept off the `_life` machinery below on purpose. That loop fades alpha and SCALES a child by
   * `_grow`, and scaling an arc would grow it past the reach it exists to state — the sweep is
   * this fx's animation, and it owns its own clock (`SlashArc.advance`).
   */
  slashArc(pose: SlashArcPose): void {
    const arc = acquireSlashArc(pose);
    this.layers.fx.addChild(arc);
    this.slashes.push(arc);
    // The room lights up while the swing is out, the same pairing `flash`/`muzzleFlare` make.
    // It starts on the ANNOUNCE rather than on the strike (a transient light has no delay of its
    // own), so the wind-up gets the leading edge of the decay — which is the right way round: a
    // light that snapped on at the strike would flash after the blade had already moved.
    this.lights.addTransient(
      { x: pose.x, y: pose.y, color: pose.color, radius: pose.outerPx * 1.5, intensity: 0.6 },
      pose.delayMs + pose.sweepMs + pose.fadeMs,
    );
  }

  /** Fade/expire every `_life`-tagged fx child, step ambient dust, and decay the
   *  chromatic pulse + shake trauma. `dustBounds` is undefined outside a live room
   *  (dungeon mode resizes per room, ROADMAP 1.3); `dustRate` is particles/sec (0
   *  when not actually playing). */
  updateFx(dt: number, dustRate: number, dustBounds: { x: number; y: number; w: number; h: number } | undefined): void {
    for (const child of [...this.layers.fx.children] as Container[]) {
      const holder = child as unknown as { _life?: number; _lifeMax?: number; _grow?: number };
      if (typeof holder._life !== 'number') continue; // e.g. `particles.view` — not a _life-tagged glow
      holder._life -= dt;
      // `_lifeMax`/`_grow` default to the flash/trail values, so every existing call site is
      // untouched. A NEGATIVE `_grow` shrinks instead of expanding — a dissipating burst grows
      // as it fades, but a muzzle flare collapses back into the barrel, and drawing that as an
      // expanding ring is most of what made the old one read as a stray glow near the body.
      const max = holder._lifeMax ?? FX_LIFE_MS;
      child.alpha = Math.max(0, holder._life / max);
      child.scale.set(1 + (1 - child.alpha) * (holder._grow ?? 0.6));
      if (holder._life <= 0) {
        this.layers.fx.removeChild(child);
        child.destroy();
      }
    }

    // Melee sector arcs, each stepping its own sweep. Walked backwards so a finished one can be
    // spliced out mid-loop, and handed back to the pool rather than destroyed (`slashArc.ts`).
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      const arc = this.slashes[i]!;
      if (arc.advance(dt)) continue;
      this.slashes.splice(i, 1);
      this.layers.fx.removeChild(arc);
      releaseSlashArc(arc);
    }

    this.particles.update(dt, dustRate, dustBounds);
    this.numbers.update(dt, this.zoom);
    this.lights.update(dt);

    // Chromatic-aberration pulse decays back to 0 — a hit reaction, never a permanent look.
    this.chromatic.amount = Math.max(0, this.chromatic.amount - dt * 0.006);
    // Screen-shake trauma also decays here (updateCamera only gets `alpha`, not `dt`; it
    // just reads the current value to compute this frame's offset).
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 0.0025);
  }

  /** Follow `player`, pin the camera inside the world, then add screen-shake on top.
   *
   *  Cover-fit zoom (design/10, 2026-08-12 follow-up — replaced the original contain-
   *  fit): zoom by whichever axis needs the MOST zoom to fill the viewport, so both
   *  axes always cover it — no letterbox void on either axis, ever, capped at MAX_ZOOM
   *  so a tiny/degenerate room doesn't blow sprites up into blocks. The tradeoff (the
   *  fitted rect is now routinely bigger than the viewport on the axis that didn't need
   *  the zoom) is exactly what the clamp branch below was already built to handle — an
   *  edge or door can scroll off-screen while the player is elsewhere, back into view as
   *  they approach it, same as any camera-follow game.
   *
   *  What it fits, though, is `frame` — the ROOM the player is standing in — not the
   *  whole floor (user report, 2026-08-17: "尽量视口内只有当前房间"). A dungeon floor is
   *  co-resident: every room of it is stitched into one world (`world/dungeon`'s
   *  `buildFloorGeometry`), so fitting `worldSize` meant fitting the whole floor, which
   *  is far wider than any viewport — cover-fit therefore resolved to zoom 1 and the
   *  player saw several rooms at once, each one small. Fitting the current room instead
   *  puts that room (and essentially only it) on screen. `frame` is null in a mode with
   *  no room model, or in the tick before the player's room is resolved; the whole floor
   *  is then the fallback, i.e. exactly the previous behaviour.
   *
   *  Panning still clamps to the WORLD, never to `frame`: clamping to the room would
   *  hard-stop the camera at a doorway, cutting off the corridor the player is about to
   *  walk into. A room whose fitted zoom leaves it larger than the viewport keeps the
   *  pan; one smaller than the viewport just shows a little of its neighbours at the
   *  edges, which reads as depth rather than as a mistake.
   *
   *  No-op (leaves layers.world untouched) if there's no player yet. */
  updateCamera(
    alpha: number,
    viewport: { vw: number; vh: number },
    worldSize: { w: number; h: number } | null,
    player: CameraTarget | null,
    frame: CameraFrame | null = null,
  ): void {
    if (!player) {
      // Still re-sync: the camera is unchanged, but a light may have expired or moved, and
      // the pass is live whether or not there is anyone to follow.
      this.syncCamera(viewport);
      return;
    }
    const { vw, vh } = viewport;
    const worldW = worldSize ? worldSize.w : vw;
    const worldH = worldSize ? worldSize.h : vh;
    const fitW = frame ? frame.w : worldW;
    const fitH = frame ? frame.h : worldH;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, vw / fitW, vh / fitH));
    this.zoom = zoom;
    const effW = worldW * zoom;
    const effH = worldH * zoom;
    // Look slightly ABOVE the follow target's feet so the character sits in the middle
    // of the frame rather than in its top half — see CAMERA_BODY_BIAS_R.
    const targetY = player.interpGroundY(alpha) - (vh * CAMERA_BODY_BIAS_R) / zoom;
    // How far ABOVE world y=0 the camera may reveal (2026-08-19). `cy`'s upper bound used to
    // be a flat 0 — the world's own top edge — which silently cancelled the whole reason
    // `GameLoop.cameraFrame` extends its rect upward by MAX_WALL_HEIGHT: a standing wall on the
    // FLOOR's northern boundary draws its cap and the top of its face at NEGATIVE world y, so
    // the clamp pinned exactly that band off the top of the screen. Confirmed in a live frame
    // (`layers.world.y === 0`, the room's north wall showing face only, no cap, top of the face
    // cut) — the tallest wall in the room, and the player never saw where it ended. The frame is
    // the authority on how much overscan it asked for, so this reads it back off `frame.y`
    // rather than importing the wall height.
    const overscanTop = frame ? Math.max(0, -frame.y) * zoom : 0;
    const cx = effW <= vw ? (vw - effW) / 2 : clamp(vw / 2 - player.interpGroundX(alpha) * zoom, vw - effW, 0);
    const cy = effH <= vh
      ? (vh - effH) / 2
      : clamp(vh / 2 - targetY * zoom, vh - effH, overscanTop);

    // `motionReduced()` is read HERE rather than at `addShake`, so trauma keeps accumulating
    // and decaying exactly as it always did and the setting is a pure output filter: turning it
    // on or off mid-fight cannot leave the controller in a state it could not have reached on
    // its own. See `render/motion.ts` for what the setting covers and what it deliberately
    // does not.
    const shakeMag = motionReduced() ? 0 : this.shakeTrauma * this.shakeTrauma * MAX_SHAKE_PX;
    const shakeX = shakeMag > 0.05 ? (Math.random() * 2 - 1) * shakeMag : 0;
    const shakeY = shakeMag > 0.05 ? (Math.random() * 2 - 1) * shakeMag : 0;

    this.layers.world.scale.set(zoom);
    this.layers.world.x = cx + shakeX;
    this.layers.world.y = cy + shakeY;
    this.syncCamera(viewport);
  }

  /**
   * Everything that depends on WHERE the camera ended up this frame: what the floor has to submit,
   * and what the scene-lighting pass has to shade. Called at the END of updateCamera, after the
   * world transform is settled — the light shader maps each texel to a WORLD position, so a region
   * computed from last frame's camera would slide the whole lighting a camera-delta behind the
   * scene it is lighting, and a cull computed from it would be a frame stale at every room edge.
   *
   * The rect is the inverse of the camera transform applied to the viewport — safe as a plain
   * divide because this camera only ever scales and translates (no rotation, see updateCamera).
   * `layers.ground` sits under `world` with no transform of its own, so the same rect is directly
   * the ground layer's own space.
   *
   * Note the ORDER of the two things below: the region is computed unconditionally, because the
   * ground cull needs it on every quality tier, and only the light pass's uniforms are skipped when
   * that pass is unmounted. Before 2026-08-26 the whole method returned early on the low tier, which
   * was right when the region existed only to feed the filter.
   *
   * That order is now a TEST, not just a comment — `FxController.test.ts`'s "still culls the ground
   * on the low tier". A 2026-08-27 mutation battery moved the cull back below the guard and all
   * 3,309 client tests still passed, which is the worst possible place for that gap: the low tier is
   * the device tier, so the machine that most needs the cull was the only one that would not get it.
   */
  private syncCamera(viewport: { vw: number; vh: number }): void {
    const world = this.layers.world;
    const zoom = world.scale.x || 1;
    this.litArea.x = -world.x / zoom;
    this.litArea.y = -world.y / zoom;
    this.litArea.width = viewport.vw / zoom;
    this.litArea.height = viewport.vh / zoom;
    this.visibleGroundPieces = cullGroundLayer(this.layers.ground, {
      x: this.litArea.x,
      y: this.litArea.y,
      w: this.litArea.width,
      h: this.litArea.height,
    });
    // The void's far side, fitted to the same rect (Terrain.ts, 2026-08-28). ABOVE the tier guard
    // below, and for exactly the reason the ground cull is: the low tier is the DEVICE tier, and a
    // terrain plane left un-fitted there would be a 1x1 sprite in the corner — i.e. the void would
    // go back to being a hole on the only machines that ever read as one. Same shape as the
    // 2026-08-27 battery survivor this guard already has a test for.
    fitTerrain(this.layers.terrain, {
      x: this.litArea.x,
      y: this.litArea.y,
      w: this.litArea.width,
      h: this.litArea.height,
    });
    // Nothing reads these uniforms while the pass is unmounted (low tier).
    if (!activeQuality().sceneLight) return;
    this.sceneLight.setRegion(this.litArea.x, this.litArea.y, this.litArea.width, this.litArea.height);
    this.sceneLight.setLights(this.lightBuffer, this.lights.snapshot(this.lightBuffer));
  }

  /** This frame's visible world rect, in world px — the inverse of the camera transform applied
   *  to the viewport, computed by `syncCamera`. Read by callers that have to cull against what is
   *  on screen (`RoomBuilder.tickFixtures`, whose doors each cost a per-frame redraw). Live from
   *  the first `updateCamera`; a 1x1 placeholder before it, which culls nothing in because
   *  `doorTick` treats an unset view the same way it treats any other. Returned by reference and
   *  mutated in place every frame, so never hold onto it across frames. */
  get worldView(): Rectangle {
    return this.litArea;
  }

  /** Bump camera-shake trauma (clamped to 1) — call from consumeEvents on an impactful moment. */
  addShake(amount: number): void {
    this.shakeTrauma = Math.min(1, this.shakeTrauma + amount);
  }

  /** Freeze sim ticks for `ms` (offline-only — see Game.hitStopMs's original doc: a
   *  shared online/PvP match can't be frozen from one client). A bigger pause always
   *  wins over a smaller one still counting down, never additive. */
  addHitStop(ms: number): void {
    this.hitStopMs = Math.max(this.hitStopMs, ms);
  }

  /** Bump the chromatic-aberration pulse (clamped to a sane max) — decays in updateFx.
   *  Suppressed under "reduce motion" (`render/motion.ts`): it is a full-frame distortion on a
   *  hit, and the hit is already told by the flash, the knockback and the damage number.
   *  Refused at the BUMP and not at the uniform, unlike the shake above, because the pulse has
   *  no accumulating state worth preserving — it decays from whatever it was last set to, so
   *  never raising it is the whole of the behaviour. */
  pulseChromatic(amount: number): void {
    if (motionReduced()) return;
    this.chromatic.amount = Math.min(0.03, this.chromatic.amount + amount);
  }

  /** If hit-stop is active, consume `dt` from it and report true (caller should skip
   *  its sim step this frame); otherwise report false and do nothing. */
  consumeHitStop(dt: number): boolean {
    if (this.hitStopMs <= 0) return false;
    this.hitStopMs = Math.max(0, this.hitStopMs - dt);
    return true;
  }

  /** Reset transient game-feel state for a fresh run (beginRun) — NOT `particles.view`
   *  itself, which is a persistent child of layers.fx mounted once in attach(). */
  resetForNewRun(): void {
    this.particles.clear();
    this.numbers.clear();
    this.lights.clear();
    // A `_life` glow is small and gone in 170 ms, so those are left to expire across a run
    // boundary; a sector arc is the size of a weapon's whole reach and lasts longer, and one
    // hanging over the first frames of a new run reads as that run's own swing.
    for (const arc of this.slashes.splice(0)) {
      this.layers.fx.removeChild(arc);
      releaseSlashArc(arc);
    }
    this.shakeTrauma = 0;
    this.hitStopMs = 0;
    this.chromatic.amount = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
