import { Graphics } from 'pixi.js';
import type { GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { biomePalette, biomeElementOf, type BiomeElement, type BiomePalette } from '../theme';
import { fpToPx } from '../coords';
import { getFloorTexture, getWallTexture, getWallFaceTexture } from '../../render/biomeTiles';
import { getDoorCurtainTexture, getDoorTexture } from '../../render/environmentSprites';
import { wallHeight, DOOR_H, DOOR_TIER, type RectPx } from './wallGeometry';
import { buildWallBlock, drawWallShadow } from './wallRender';
import { tagStandingPiece } from './groundCulling';
import { staticGraphics } from '../../render/staticGraphics';
import { buildPillarEntities, buildPropEntities, destroyDressing } from './roomDressing';
import {
  deepXrayLayers,
  fadeableBlock,
  updateOcclusion,
  xrayLayers,
  type FadeableOccluder,
  type OcclusionFocus,
} from './occlusion';
import { blockCapTop, doorCapless, effectiveWallHeight, wallJoins, type WallRun } from './wallRuns';
import { buildDoorBlock, type DoorFixture, type DoorSkin } from './doorRender';
import { tickDoors, type CameraRect } from './doorTick';
import { groundSteps } from './groundLayer';
import { planRoomWalls, type RoomWallPlan } from './roomWallPlan';
import { StagedBuild, solo, type BuildStep } from './stagedBuild';
import { DescendCover } from './descendCover';
import { FilterWarmup } from './filterWarmup';
import { faceCrownFraction } from './wallTone';
import type { Backdrop } from './Backdrop';
import { Terrain } from './Terrain';
import { Portal } from './Portal';
import { portalCenterPx } from './portalPlacement';
import { floorKeyOf, isSameFloor, type FloorKey } from './floorKey';

// Standing walls used to optionally take a per-segment `NormalLitFilter` on top of their
// hand-authored cap/face/side tints (2026-08-18 — one render-target pass per segment, up to 32
// per room, by far the most expensive thing in the wall pass), gated behind a `LIT_WALLS`
// switch that had been off since 2026-08-19: an A/B of the live frame with the filter stripped
// differed by a MEAN of 0.48 out of 765 (0.06%), max 5%, only 0.05% of pixels moving more than
// 5/255. The tuning that made it safe (`WALL_LIT_AMBIENT` above `1 - key`, a much gentler
// gradient gain than an actor's — both needed to stop a wall going darker than its own floor)
// is also what left it with no visible amplitude, and the relief walls actually have now comes
// free from `wallTone.ts` (cap wash, cap depth gradient, face ramp, fold line). Removed
// entirely 2026-08-20 rather than left as a permanently-off switch: a re-tune was never
// scheduled, "kept for the experiment" had become "dead code nobody revisits," and the switch
// was still costing a render target per wall the one time it was ever flipped on. The shader
// itself (`NormalLitFilter`) and its actor-facing tuning (`ACTOR_*`) are unaffected — this only
// removes the wall-specific `WALL_LIT_*` look and its call site.

/** Build time a staged build may spend per render frame. Its own frame also pays for triangulating
 *  whatever that slice added (on the render that first draws it), and a normal frame here is ~4 ms
 *  of work, so 4 ms keeps a building frame near half the 16.7 ms budget. */
const STAGED_BUILD_BUDGET_MS = 4;

/**
 * Render-side mirror of the engine's dungeon/arena room geometry (design/08 "render
 * only reads") — ground/grid, AABB walls, and the round Y-sortable pillars. Extracted
 * out of Game.ts 2026-07-28 alongside EventReactor: owns the pillar Entity list itself
 * so Game only calls `build()` (once per run), `enterRoom()` (on `room_enter`) and `clear()`
 * (on a fresh run).
 */
export class RoomBuilder {
  private readonly pillars: Entity[] = [];
  // Standing wall segments (design/01's front face) — Entities on the Y-sortable
  // `entities` layer, so they must be destroyed explicitly like `pillars`; the flat
  // walls they replace lived on `ground`, which `build()` clears wholesale.
  private readonly wallEntities: Entity[] = [];
  // One shared Graphics carrying EVERY wall's ground shadow for the current room
  // (`wallRender.drawWallShadow`), on `layers.shadow`. A room has up to a couple of dozen
  // segments and their shadows never move, so one static display object beats one per wall.
  private wallShadows: Graphics | null = null;
  // Every standing block in the current room — wall segments AND pillars — paired with the band
  // of floor its art covers, for the occlusion x-ray (`updateOcclusion`). Rebuilt with the room;
  // one flat list because the fade rule does not care which kind of block it is looking at.
  private occluders: FadeableOccluder[] = [];
  // Index-aligned with `state.dungeonDoors` (design/05 "Room & door model") — a real
  // fixture per door, never a bare gap / never folded into the generic wall fill.
  // `updateDoors()` swaps the leaf texture on these in place on door_locked/door_unlocked
  // (DoorSystem), so a lock-state flip doesn't need a full room rebuild. STANDING fixtures
  // since 2026-08-20 (`doorRender.ts`) and therefore on the Y-sorted `entities` layer, which
  // means they must be destroyed explicitly like `wallEntities` — `build()`'s wholesale sweep
  // of `layers.ground` no longer covers them.
  private readonly doorFixtures: DoorFixture[] = [];
  // The same doors' world-px footprints, index-aligned with `doorFixtures`. Kept because
  // `tickFixtures` has to answer two questions per frame that a fixture cannot answer about
  // itself: is this door on screen at all, and how close is the player to it. Rebuilt with the
  // room by `buildDoors`, cleared by `clearDoors`.
  private readonly doorFootprints: RectPx[] = [];
  // Decorative room dressing (`RoomPiece.props`, design/09 "decorative + Y-sortable"),
  // read straight off `s.dungeonRooms` — the same `PlacedRoom[]` SpawnSystem already
  // populates for walls/obstacles, so no new engine-side plumbing is needed to reach a
  // piece's authored props plus the offset it was placed at. Static one-shot Entities,
  // same lifecycle as `pillars`: rebuilt with the room, destroyed explicitly since they
  // live on the Y-sorted `entities` layer.
  private readonly props: Entity[] = [];
  private portal: Portal | null = null;
  // World-px position of the current room's portal (its center), or null before the
  // first room ever loads. Game reads this to gate the popup's proximity check.
  portalPx: { x: number; y: number } | null = null;
  /** The floor the last `build()` drew (`floorKey.ts`), so `enterRoom` can skip rebuilding it. */
  private builtFloor: FloorKey | null = null;

  /** The void's far side (Terrain.ts). Owned here rather than by `Game`, because its whole
   *  lifecycle is the room's — unlike `Backdrop`, nothing outside this class ever touches it
   *  (`FxController` fits the plane per frame through `layers.terrain`, not through this object).
   *  Assigned in the constructor body, not as a field initializer, so it cannot depend on
   *  parameter-property assignment order. */
  private readonly terrain: Terrain;
  /** The build in progress, if any: `build` drains it at once, `buildStaged` leaves it to
   *  `tickFixtures`, a few ms per frame. */
  private readonly staged = new StagedBuild();
  private readonly cover: DescendCover;
  private readonly warmup: FilterWarmup;
  private warmPending = false;

  constructor(
    private readonly layers: Layers,
    private readonly backdrop: Backdrop,
  ) {
    this.terrain = new Terrain(layers);
    this.cover = new DescendCover(layers.ui);
    this.warmup = new FilterWarmup(layers.ui);
  }

  /** `room_enter`: rebuild only when the floor itself changed — see `floorKey.ts` for why a room
   *  of the floor already drawn needs nothing here (door locks arrive through `updateDoors`).
   *
   *  A NEW dungeon floor after one was already drawn is a descend, and that one is built over
   *  several frames behind `DescendCover` (`stagedBuild.ts` has the measurement). Anything else —
   *  nothing built yet, a restart, a flat or arena state — builds at once, as it always has. */
  enterRoom(s: GameState): void {
    if (isSameFloor(this.builtFloor, s)) return;
    if (this.builtFloor !== null && s.dungeonRooms.length > 0) this.buildStaged(s);
    else this.build(s);
  }

  /** Rebuild the ground, AABB walls, and pillars for the CURRENTLY LOADED room, now. */
  build(s: GameState): void {
    this.staged.start(this.buildSteps(s));
    this.staged.runAll();
  }

  /** The same build, spread over the next render frames (`tickFixtures` runs it) with the world
   *  covered until it is done. */
  buildStaged(s: GameState): void {
    this.staged.start(this.buildSteps(s));
    this.cover.show();
  }

  /** Whether a staged build is still running. */
  get building(): boolean {
    return this.staged.busy;
  }

  /** One build as ordered steps: the first clears the old floor and plans the new one, then
   *  expands into a step per wall run, per ground piece, and the doors, dressing and portal. */
  private buildSteps(s: GameState): BuildStep[] {
    return [solo(() => this.beginBuild(s))];
  }

  private beginBuild(s: GameState): BuildStep[] {
    this.builtFloor = floorKeyOf(s);
    // Every build happens with the world covered (a run's behind the loading screen, a descend's
    // behind `cover`), so the next frame is where the actor filters get linked — `filterWarmup.ts`.
    // Armed from `tickFixtures`, not here, because only a rendering frame has anything to link.
    this.warmPending = true;
    const w = fpToPx(s.worldW);
    const h = fpToPx(s.worldH);

    for (const c of [...this.layers.ground.children]) c.destroy();
    this.clearWalls();
    // Dropped here rather than inside `clearWalls`, because pillars contribute to this list too
    // and the dressing step refills it further down this same build.
    this.occluders.length = 0;

    // design/13 "per-biome background palette" — derived from the run's dungeon
    // biomeId (undefined outside dungeon mode, e.g. flat EngineConfig.floors/PvP
    // arena, which fall back to today's neutral palette unchanged).
    const palette = biomePalette(s.dungeonConfig?.biomeId);
    const element = biomeElementOf(s.dungeonConfig?.biomeId);
    this.backdrop.setPalette(palette);
    // The far-side ground under the whole world (Terrain.ts). Recoloured with the backdrop
    // because the fog over it IS `palette.void` — the two have to move together or the plane
    // stops resolving into the backdrop at the view's edge.
    this.terrain.setPalette(palette);
    // Everything else the old floor stood up goes now too, not only when its own step comes round:
    // a staged build is covered, but the doors' ticks and `updateDoors` still see these lists.
    this.clearDoors();
    destroyDressing(this.props);
    destroyDressing(this.pillars);
    this.portal?.destroy();
    this.portal = null;
    this.portalPx = null;

    // Planned in its own solo step: teardown + plan together were a 23 ms frame at 4x throttle.
    return [solo(() => this.planSteps(s, w, h, palette, element))];
  }

  private planSteps(s: GameState, w: number, h: number, palette: BiomePalette, element: BiomeElement): BuildStep[] {
    const floorTex = getFloorTexture(element);
    const wallTex = getWallTexture(element);
    const plan = planRoomWalls(s, w, h, element);
    // Every wall now stands (2026-08-18 — see `wallGeometry.wallTier` for why the old
    // "east-west runs only" rule was what made a room read flat), at one of three heights.
    // Shadows all land on one shared Graphics, added to `layers.shadow` before the blocks so
    // it paints under both them and the actors. `staticGraphics` because it is by far the largest
    // single piece of geometry in the frame (~24k floats for a room's 27 runs, four graduated
    // hull passes plus five hug strokes each) and `layers.shadow` has its own render group, so it
    // joins the sprite batch for one build-time pack instead of a draw call per frame.
    const shadows = staticGraphics();
    const faceTex = getWallFaceTexture(element);
    // Owned from here though mounted with the doors, so a cancelled build's is still destroyed.
    this.wallShadows = shadows;
    const skin = { palette, cap: wallTex, face: faceTex };
    const steps: BuildStep[] = plan.merged.map((run, i) => () => this.buildWallRun(run, i, plan, skin, shadows));
    steps.push(
      ...groundSteps(this.layers.ground, {
        rooms: plan.roomsPx,
        floorRegions: plan.floorsPx,
        wallRects: plan.merged.map((run) => run.rect),
        doorRects: plan.passageRectsPx,
        palette,
        floorTex,
      }),
    );
    // Doors before the shadow Graphics is mounted, because a door is a piece of the wall it is
    // cut into and throws its own cast shadow onto the same shared Graphics.
    steps.push(solo(() => {
      this.buildDoors(
        s,
        plan.merged,
        plan.doorRectsPx,
        { palette, cap: wallTex, face: faceTex, floor: floorTex, curtain: getDoorCurtainTexture() },
        shadows,
        element,
      );
      this.layers.shadow.addChild(shadows);
    }));
    steps.push(solo(() => this.buildDressing(s, palette, element)));
    steps.push(() => this.buildPortal(s, w, h));
    return steps;
  }

  /** One merged wall run: its ground shadow, its standing block, and its occluder. */
  private buildWallRun(
    run: WallRun,
    i: number,
    plan: RoomWallPlan,
    skin: Pick<DoorSkin, 'palette' | 'cap' | 'face'>,
    shadows: Graphics,
  ): void {
    const { joins, voids } = plan;
    // `doorClip`ped run whose OWN footprint is shallower than its tier: shrink the height
    // itself, not just the cap — see `effectiveWallHeight` for why a cap-only clip still let
    // the FACE spill onto the door (measured: 72 px of pure face, on a 32 px-deep stub). A
    // no-op for every other run, tier height unchanged.
    const height = effectiveWallHeight(run.rect, wallHeight(run.tier), joins[i]!);
    drawWallShadow(shadows, run.rect, height);
    const seg = buildWallBlock(run.rect, height, skin, joins[i], voids[i]);
    this.layers.entities.addChild(seg);
    tagStandingPiece(seg);
    this.wallEntities.push(seg);
    // The block sorts on its south edge and paints upward from there, so the floor it covers
    // runs from its cap's north edge down to its own footprint — see `occlusion.Occluder`.
    const sortY = run.rect.y + run.rect.h;
    this.occluders.push(
      fadeableBlock(
        {
          left: run.rect.x,
          right: run.rect.x + run.rect.w,
          top: sortY + blockCapTop(run.rect, height, joins[i]),
          sortY,
          foldY: sortY - height, // the cap/face joint: below it, only a deep fade reaches
        },
        xrayLayers(seg.children),
        deepXrayLayers(seg.children),
      ),
    );
  }

  /**
   * The occlusion x-ray, one render frame (design/01 "Limits of fake 3D", live report
   * *"角色跑到墙下面去了"*): any standing block that is currently drawing over the character
   * fades toward `XRAY_FADE` and back once it isn't.
   *
   * Called from `GameLoop.updateFx` at render rate. `foci` is the local player plus every live
   * enemy (an empty list whenever there is no local view at all — menus, between spawns), which
   * fades every block back to solid rather than freezing one mid-x-ray.
   */
  updateOcclusion(foci: readonly OcclusionFocus[], dtMs: number): void {
    updateOcclusion(this.occluders, foci, dtMs);
  }

  /** Destroy the standing wall segments (they live on the Y-sorted `entities` layer, which
   *  `build()`/`clear()` never sweep wholesale — actors live there too), plus the shared
   *  Graphics holding their ground shadows (`layers.shadow`, likewise never swept). */
  private clearWalls(): void {
    for (const e of this.wallEntities) e.destroy();
    this.wallEntities.length = 0;
    this.wallShadows?.destroy();
    this.wallShadows = null;
  }

  /**
   * One STANDING fixture per dungeon door (design/05: "always-present physical fixtures with
   * exactly two visual states, locked/open — never a bare gap"), on its own `passageAabb`.
   *
   * Standing since 2026-08-20 (`doorRender.ts`): the two door swatches are front ELEVATIONS and
   * were being stretched flat over the passage rect on `layers.ground`, so the one fixture the
   * player has to read at a glance was the only thing in the room still painted on the floor.
   * A door builds as a wall block whose face is an opening, at `wallGeometry.DOOR_H` — the SAME
   * height for every door in the game since 2026-09-03, where it used to inherit the shortest
   * wall abutting its passage — and registers with the occlusion x-ray like any other standing
   * block: the passage floor is entirely inside the fixture's own art, so a character walking
   * through a doorway is behind it by construction. `runs` is still the MERGED wall list (a
   * boundary authored as two parallel rects is one mass), because the doors' own `wallJoins` pass
   * below has to see the stone each doorway is cut into, even though its HEIGHT no longer does.
   *
   * Rebuilt fresh each `build()`; `updateDoors()` is the cheap in-place path for a lock-state
   * flip alone. `doorRects` is index-aligned with `s.dungeonDoors` (built by the caller for
   * `bordersDoorNorth`), reused here rather than converted a second time.
   */
  private buildDoors(
    s: GameState,
    runs: readonly WallRun[],
    doorRects: readonly RectPx[],
    // Everything a door is drawn from except the leaf, which is per-door (`getDoorTexture`) and
    // is added at the `buildDoorBlock` call below.
    skin: Omit<DoorSkin, 'leaf'>,
    shadows: Graphics,
    element: string,
  ): void {
    this.clearDoors();
    // A door stands at `DOOR_H` — ONE height for every door, whatever wall it is cut into and
    // however thick (see `wallGeometry.DOOR_H` for the report that replaced `doorFlankTier`'s
    // shortest-flank rule, and what it spends). `DOOR_TIER` is only for `wallJoins` below, which
    // reasons in tiers — a stale one there silently clips the cap off every kerb doorway.
    const doorRuns: WallRun[] = doorRects.map((rect) => ({ rect, tier: DOOR_TIER }));
    // The doors' own joins, computed against the walls AND each other. Deliberately a SECOND
    // `wallJoins` pass rather than one combined list: a door has to know that its cap runs into
    // the flanking runs' caps (else it draws a lit coping and a dark silhouette straight across
    // one continuous stone top, which is the artifact `wallJoins` exists for), but feeding doors
    // back into the WALLS' joins would re-tier cues on every run beside a doorway — including
    // making a deep run `tuckNorth` under a door — and every one of those numbers was measured
    // without doors in that list. Doors see walls; walls see only walls and their own `doorClip`.
    const doorJoins = wallJoins([...runs, ...doorRuns], faceCrownFraction(element)).slice(runs.length);

    for (const [i, dr] of s.dungeonDoors.entries()) {
      const rect = doorRects[i]!;
      const height = DOOR_H;
      // `capless` is folded in by hand for the same reason `doorClip` is on the walls' joins:
      // `wallJoins` cannot compute it. Why a door that out-tops its flanks draws no cap at all
      // is `wallRuns.doorCapless`.
      const joins = doorCapless(rect, runs, height) ? { ...doorJoins[i]!, capless: true } : doorJoins[i]!;
      // `i` is the door's phase offset (`doorFx.ts`: two doors in one room must not breathe in
      // unison), so it has to be the index within the FLOOR's door list — stable across rebuilds
      // and identical on every client — not a per-room counter.
      const fixture = buildDoorBlock(rect, height, { ...skin, leaf: getDoorTexture(dr.locked) }, dr.locked, joins, i);
      drawWallShadow(shadows, rect, height);
      this.layers.entities.addChild(fixture.view);
      tagStandingPiece(fixture.view);
      this.doorFixtures.push(fixture);
      this.doorFootprints.push(rect);
      const sortY = rect.y + rect.h;
      this.occluders.push(
        fadeableBlock(
          {
            left: rect.x,
            right: rect.x + rect.w,
            top: sortY + blockCapTop(rect, height, joins),
            sortY,
            foldY: sortY - height,
          },
          fixture.capLayers,
          fixture.deepLayers,
        ),
      );
    }
  }

  /**
   * One render frame of every animated fixture in the current room.
   *
   * **Why this exists at all.** Nothing in this project could animate a scene FIXTURE before
   * 2026-09-03: `Scene.interpolate` walks `Scene.views` (actors/bullets/pickups), and a door or a
   * portal is added straight to `layers.entities` by this class and is in no such list. So every
   * door was a still image (live report: *"目前的形式太死板了"*) — and `Portal.interpolate`, four
   * animated layers written 2026-08-12, had no caller at all and had been drawing a frozen vortex
   * ever since. Both are driven from here; the doors' own cull-and-proximity rule is
   * `doorTick.tickDoors`.
   */
  tickFixtures(dt: number, view: CameraRect | null, playerPx: { x: number; y: number } | null): void {
    // A staged build (a descend) advances here because this is called once per render frame on
    // every render path — and first, so the doors ticked below are this frame's doors.
    if (this.staged.busy) this.staged.runFor(STAGED_BUILD_BUDGET_MS);
    this.cover.update(dt, this.staged.busy);
    if (this.warmPending) this.warmup.arm(); // drawn by this frame's render, and the next one's
    else this.warmup.tick();
    this.warmPending = false;
    tickDoors(dt, this.doorFixtures, this.doorFootprints, view, playerPx);
    // The portal animates only while it is open — it is `visible = false` otherwise, and a hidden
    // vortex advancing its own clock is pure cost. `alpha` is 1 because a portal never
    // interpolates a POSITION: it is placed once per room, and only its own layers move.
    if (this.portal?.visible) this.portal.interpolate(1, dt);
  }

  /** Flash the door at `index` as having refused the player (`DoorFixture.reject`) — `GameLoop`
   *  derives that on the client. No-op for an index with no fixture: an arena has doors in its map
   *  and builds none. `doorFootprint` is the same index's drawn rect, which that derivation needs
   *  because `state.dungeonDoors[index]` carries only the sim's Fp passage AABB. */
  rejectDoor(index: number): void {
    this.doorFixtures[index]?.reject();
  }

  doorFootprint(index: number): RectPx | null {
    return this.doorFootprints[index] ?? null;
  }

  /** Cheap reaction to `door_locked`/`door_unlocked` (DoorSystem) — swap each door's leaf
   *  texture and its hazard bloom in place, no destroy/rebuild of the room. No-op if called
   *  before any `build()` has run for this floor (index mismatch). */
  updateDoors(s: GameState): void {
    if (this.doorFixtures.length !== s.dungeonDoors.length) return;
    for (let i = 0; i < s.dungeonDoors.length; i++) {
      const locked = s.dungeonDoors[i]!.locked;
      this.doorFixtures[i]!.setLocked(locked, getDoorTexture(locked));
    }
  }

  /** Destroy the standing door fixtures — like `wallEntities`, they live on the Y-sorted
   *  `entities` layer, which `build()`/`clear()` never sweep wholesale. */
  private clearDoors(): void {
    for (const d of this.doorFixtures) d.view.destroy();
    this.doorFixtures.length = 0;
    this.doorFootprints.length = 0;
  }

  /** Hidden until `setPortalOpen(true)` (Game, gated on the same checkpoint condition
   *  PortalPrompt uses). Rebuilt (not just repositioned) per room so a stale reference
   *  never survives a room swap. WHERE it stands is `portalPlacement.ts`. */
  private buildPortal(s: GameState, w: number, h: number): void {
    this.portal?.destroy();
    const portal = new Portal();
    this.layers.entities.addChild(portal);
    this.layers.shadow.addChild(portal.shadow!);

    const px = portalCenterPx(s, w, h);
    portal.place(px.x, px.y);
    this.portal = portal;
    this.portalPx = px;
  }

  /** Toggle the current room's portal visibility — open once the checkpoint condition
   *  is met (design/05 "the portal opens" — generalized to every checkpoint room). */
  setPortalOpen(open: boolean): void {
    this.portal?.setOpen(open);
  }

  /** Round pillars for the current room, from the engine's obstacle solids. Tall
   *  Y-sortable objects (occlusion + collision). Rebuilt per room; the drawn body is a
   *  little wider than the collision footprint so the player can stand against it. */
  /** The pillars and the props are `roomDressing.ts` (split out 2026-08-27, 500-line
   *  convention). Both lists stay here because this class owns their lifetimes — they live on
   *  the Y-sorted `entities` layer, which `build()`/`clear()` never sweep wholesale — and the
   *  pillars' occluders join the wall segments' in the one flat `occluders` list the x-ray
   *  walks, appended after them so the list stays in the order `build()` produced it. */
  private buildDressing(s: GameState, palette: BiomePalette, element: BiomeElement): void {
    destroyDressing(this.pillars);
    const built = buildPillarEntities(this.layers, s, palette, element);
    this.pillars.push(...built.pillars);
    this.occluders.push(...built.occluders);

    destroyDressing(this.props);
    this.props.push(...buildPropEntities(this.layers, s, palette));
  }

  /** Tear down the current room's ground + pillars (beginRun) so a restart doesn't
   *  leak the previous run's geometry. */
  clear(): void {
    this.builtFloor = null;
    this.staged.cancel();
    this.cover.hide();
    this.warmup.cancel();
    this.warmPending = false;
    for (const c of [...this.layers.ground.children]) c.destroy();
    this.clearDoors();
    this.clearWalls();
    destroyDressing(this.props);
    destroyDressing(this.pillars);
    this.occluders.length = 0;
    // `Entity.destroy` unparents and destroys the shadow itself, so the explicit
    // `portal.shadow?.destroy()` that used to precede this (at both portal sites) was the same
    // redundancy `destroyDressing` removed from the pillar and prop lists on 2026-08-27.
    this.portal?.destroy();
    this.portal = null;
    this.portalPx = null;
  }
}
