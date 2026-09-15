// Scene — the read-only view mirror of the engine's authoritative state. Each sim
// tick, reconcile() diffs the engine's entity arrays against the live views by
// stable id: new ids spawn a view (snapped in place), surviving ids get a fresh
// position pushed (for interpolation), and ids that vanished (compacted out, dead)
// have their views removed. Nothing here decides gameplay — it only draws what the
// engine already computed (design/08 "render/server only read").
import type { GameEvent, GameState } from '@dd/engine';
import type { Layers } from './layers';
import { Entity } from './Entity';
import { Actor } from './Actor';
import { Enemy } from './Enemy';
import { Bullet } from './Bullet';
import { Pickup, BOB_REST_Z } from './Pickup';
import { PickupFlightLayer, type FlightPoint } from './pickupFlight';
import { ChestLayer } from './ChestLayer';
import { ShopLayer } from './ShopLayer';
import { fpToPx, bradToRad } from '../coords';
import { turnToward, BODY_TURN_PER_TICK } from '../../render/facing';

/** Where a flown drop aims on the collector, as a fraction of that actor's DRAWN body height
 *  (`Actor.bodySilhouette`) above its ground point — a fraction rather than a pixel count for
 *  the reason the death burst's own lift is one: the same number that reads as "chest" on a
 *  15 px mob is an ankle on a 30 px boss. */
const TARGET_BODY_R = 0.5;

export class Scene {
  private views = new Map<number, Entity>();
  private playerView: Actor | null = null;
  // Actors whose id just dropped out of the engine's alive list, still playing their
  // death-dissolve shader (design/01 milestone 5) — kept out of `views` so a same-id
  // respawn (shouldn't happen for players/enemies today, but not this file's contract to
  // assume) can never collide with one still fading out.
  private dying: Actor[] = [];
  // Reused every reconcile() instead of a fresh Set per tick — cleared and refilled
  // each call, never read across ticks.
  private readonly seenScratch = new Set<number>();
  // Same pattern for `enemies` below: it runs at RENDER rate (GameLoop.updateFx, every
  // frame, not just once a sim tick), so a fresh array every call is needless churn in
  // a room with any real number of mobs. Cleared and refilled each call, never read
  // across calls, and never returned by reference to anything that outlives the call.
  private readonly enemiesScratch: Actor[] = [];
  // Same pattern again, for `pickups` below.
  private readonly pickupsScratch: Pickup[] = [];

  /**
   * Chests (design/05 "Chest rooms", ENGINE_VERSION 63). Owned HERE rather than plumbed
   * through `GameLoop` like `PickupDebugOverlay` is, because this class is already the one
   * thing whose job is "mirror `GameState` into the display list" — and because a chest draws
   * into two layers at once (`entities` for the Y-sorted body, `ground` for its mechanism
   * plates), which is the one thing `views`/`spawn` cannot express. It is reconciled below and
   * torn down by `clear()`, so it inherits this class's whole lifecycle for free.
   */
  private readonly chests = new ChestLayer(this.layers.entities, this.layers.ground);
  private readonly shops = new ShopLayer(this.layers.entities, this.layers.ground);

  /** Drops currently flying to whoever collected them (`scene/pickupFlight.ts`). Owned here for
   *  the same reason `chests`/`shops` are: this class is the one thing whose job is the display
   *  list's lifecycle, and a flight is exactly a view that outlives the entity it mirrored. */
  private readonly flights = new PickupFlightLayer(this.layers.entities, this.layers.shadow);

  /**
   * How many Actor views the last `reconcile()` built — the `spawn` cue's whole trigger
   * (design/11, 2026-09-02). It is reported as a NUMBER rather than played here for two
   * reasons: this file holds no audio dependency and should not start (it draws what the
   * engine computed, design/08), and the count is what the mixer needs anyway — a room's
   * wave materialising nine actors on one frame has to coalesce into one voice at higher
   * gain, not nine voices. `GameLoop` hands it to `EventReactor.consume` beside that frame's
   * events, which is where every other cue is already coalesced.
   *
   * Reset at the top of each `reconcile()`, so it describes that call and never accumulates.
   * Bullets and pickups are excluded because only an `Actor` has a `spawn` clip to match.
   */
  spawnedActors = 0;

  constructor(private readonly layers: Layers) {}

  /** The LOCAL player's view, for the camera to follow (null before spawn / after death). */
  get player(): Actor | null {
    return this.playerView;
  }

  /** The live Actor/Enemy view for an engine entity id, for a render reaction that needs
   *  to target a SPECIFIC actor rather than just a world position (e.g. EventReactor's
   *  hit-flash outline). Undefined for a bullet/pickup id, or one that already died. */
  actorAt(id: number): Actor | undefined {
    const v = this.views.get(id);
    return v instanceof Actor ? v : undefined;
  }

  /** Every currently live enemy view, for a render pass that must consider every mob rather
   *  than just the local player — the occlusion x-ray (`GameLoop.updateFx`) is the reason this
   *  exists: a wall block used to fade only against `player`, so a monster standing in the same
   *  hidden band got no x-ray at all. A dying (dissolving) enemy is excluded, same as `views`
   *  itself — it's already fading out, not something the x-ray needs to keep legible. Order is
   *  whatever the underlying Map iterates in, not meaningful. */
  get enemies(): readonly Actor[] {
    this.enemiesScratch.length = 0;
    for (const v of this.views.values()) if (v instanceof Enemy) this.enemiesScratch.push(v);
    return this.enemiesScratch;
  }

  /** Every currently live pickup view, for the same occlusion x-ray `enemies` feeds — live
   *  report *"被墙挡住的物品，只有角色走到墙下的时候才显示"*: a drop never moves once it lands, so
   *  unlike a player/enemy focus it isn't standing IN the hidden band on its own account, it's
   *  simply placed there by the room/drop table. Feeding it in as a focus anyway (`GameLoop.
   *  updateFx`) makes the wall over it fade permanently rather than only while a character
   *  happens to be close enough to trigger the same fade for themselves. Order is whatever the
   *  underlying Map iterates in, not meaningful. */
  get pickups(): readonly Pickup[] {
    this.pickupsScratch.length = 0;
    for (const v of this.views.values()) if (v instanceof Pickup) this.pickupsScratch.push(v);
    return this.pickupsScratch;
  }

  /**
   * Recompose every live actor's skin filters against the current quality tier
   * (`render/quality.ts`, 2026-08-25). `Game` calls this when the tier changes, because an
   * actor's filter list is otherwise only rebuilt when that actor's own status changes — a
   * player standing still with a shield up, or an enemy mid-burn, would keep whichever list the
   * previous tier produced until something happened to it.
   *
   * Includes the `dying` list: a tier flip during a death animation has to reach the actor
   * playing it, which is exactly the case where the tiers differ most (shader dissolve vs
   * alpha ramp).
   */
  refreshQuality(): void {
    for (const v of this.views.values()) if (v instanceof Actor) v.refreshQuality();
    for (const v of this.dying) v.refreshQuality();
  }

  /** Drop every view — called on a fresh run before a new engine is created. */
  clear(): void {
    this.chests.clear();
    this.shops.clear();
    this.flights.clear();
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    for (const v of this.dying) v.destroy();
    this.dying = [];
    this.playerView = null;
  }

  // `localPlayerId` is the id of the seat this client controls (co-op, ROADMAP 3.1); the
  // camera follows ITS view, not "whichever player is last in the array". Default -1 (the
  // single-player caller passes the sole player's id, or omits it → the first player wins,
  // matching the old behaviour exactly).
  //
  // `events` is this frame's engine→render batch, and this class reads exactly ONE kind out of
  // it: `pickup`, whose `by` names the collector a flown drop has to curve toward. That is a
  // view-LIFECYCLE fact, not a reaction — "this id left `GameState` because someone took it"
  // is the one thing the state diff below cannot tell apart from "this id left because its
  // floor did", and getting it wrong sends a whole floor's uncollected loot flying at the
  // player on a descend. `EventReactor` still owns every REACTION to the same event (fx, cue,
  // toast, score); this is the diff it has no view of. Defaulted, so every existing caller —
  // and every test that reconciles a hand-built state — is untouched.
  reconcile(state: GameState, localPlayerId = -1, events: readonly GameEvent[] = []): void {
    const seen = this.seenScratch;
    seen.clear();
    this.spawnedActors = 0;

    for (const p of state.players) {
      if (!p.alive) continue;
      let v = this.views.get(p.id) as Actor | undefined;
      const aimRad = bradToRad(p.facing);
      // The body turns to face the AIM, rate-limited (render/facing.ts — see its header
      // for why this is the aim and not the movement vector: the orb-core is an eye, and
      // an eye looks at what it is shooting). A fresh spawn has no previous angle to turn
      // from, so it starts already facing its aim.
      const bodyFacingRad = v ? turnToward(v.bodyFacingRad, aimRad, BODY_TURN_PER_TICK) : aimRad;
      if (!v) {
        v = new Actor('player', fpToPx(p.radius), undefined, false, p.atlasKey);
        this.spawn(p.id, v, fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), aimRad, bodyFacingRad);
      } else {
        v.pushState(fpToPx(p.gx), fpToPx(p.gy), fpToPx(p.z), aimRad, bodyFacingRad);
      }
      // The camera-follow target: the local seat if named, else the first player (the
      // single-player default — playerView is only unset, so the first alive player wins;
      // `this.playerView === v` keeps that choice sticky across later reconciles, which
      // is what the original `playerView === null` test did implicitly).
      const isLocal =
        p.id === localPlayerId ||
        (localPlayerId === -1 && (this.playerView === null || this.playerView === v));
      if (isLocal) this.playerView = v;
      // "Which one is me" cue (design/10 legibility, 2026-08-02) — a teal ground ring +
      // teal health-bar outline on the local seat only. See Actor.setLocal.
      v.setLocal(isLocal);
      v.setWeaponKind(p.weapon?.spec.kind ?? null, p.weapon?.spec.damageType, p.weapon?.spec.name);
      v.setStatus(p.status);
      v.setHealth(p.hp, p.maxHp);
      v.setShield(p.shield, p.maxShield);
      seen.add(p.id);
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      let v = this.views.get(e.id) as Enemy | undefined;
      if (!v) {
        v = new Enemy(fpToPx(e.radius), e.tint, e.boss, e.bodyRig, e.element);
        this.spawn(e.id, v, fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      } else {
        v.pushState(fpToPx(e.gx), fpToPx(e.gy), fpToPx(e.z), bradToRad(e.facing));
      }
      v.setWeaponKind(e.weapon?.spec.kind ?? null, e.weapon?.spec.damageType, e.weapon?.spec.name);
      v.setStatus(e.status);
      v.setHealth(e.hp, e.maxHp);
      v.setShield(e.shield, e.maxShield);
      seen.add(e.id);
    }

    for (const b of state.projectiles) {
      if (!b.alive) continue;
      let v = this.views.get(b.id) as Bullet | undefined;
      if (!v) {
        v = new Bullet(fpToPx(b.radius));
        const bx = fpToPx(b.gx);
        const by = fpToPx(b.gy);
        const bz = fpToPx(b.z);
        this.spawn(b.id, v, bx, by, bz, 0);
        // Draw the shot leaving the shooter's actual barrel tip: the engine's spawn
        // point (`RangedSimSpec.muzzleOffset` along the aim ray on the ground plane,
        // lifted by `bulletZ`) is not where the rig draws the gun, so bullets read as
        // coming out of the body rather than the muzzle (user report, 2026-08-17: "子弹
        // 要从枪口打出"). `Bullet.setMuzzleOrigin` eases the difference out over its first
        // few ticks — see there for the geometry and for why this is corrected on the
        // view instead of by moving the sim's own muzzle (which stays authoritative for
        // hit detection, and which a player standing flush against a wall could
        // otherwise push through to the far side).
        //
        // `muzzlePos()` is null for anything with no rig-mounted module — a rig whose
        // `weaponMount` is 'none' (the boss), a skin still on the Graphics placeholder, and
        // the frames before a weapon texture finishes preloading. Those leave the bullet
        // exactly where the engine put it, as before. Enemies used to be in that list too,
        // for the wrong reason (they never mounted a module at all, see `Skin.weaponMount`);
        // since 2026-08-21 they mount one, so a mob's shots get the same barrel-tip spawn
        // correction the hero's have had since 2026-08-17.
        //
        // The offset is measured against the round's OWN drawn height, not against `bulletZ`
        // (2026-09-02): the gun is drawn where the rig hangs it and the sim's `z` is a
        // gameplay band, so pinning the round to `bulletZ` left a gap straight up the screen —
        // perpendicular to a horizontal shot, i.e. an arc out of the barrel. `setDrawnHeight`
        // puts the round at the gun's height instead, which leaves `setMuzzleOrigin` a pure
        // along-the-shot distance. Order matters: the height has to be set before the offset
        // is measured against it.
        const muzzle = b.ownerId === undefined ? null : this.actorAt(b.ownerId)?.muzzlePos();
        if (muzzle) {
          v.setDrawnHeight(muzzle.heightPx);
          // The shot direction, straight off the round's own velocity — the sim's aim ray by
          // construction (`WeaponFireSystem.spawnBullet` sets both from the same `dir`), and
          // available here where the firing angle is not. A projectile with no velocity at all
          // has no direction to project onto, so it keeps the whole offset.
          const vx = fpToPx(b.vx);
          const vy = fpToPx(b.vy);
          const speed = Math.hypot(vx, vy);
          const ux = speed > 0 ? vx / speed : 1;
          const uy = speed > 0 ? vy / speed : 0;
          v.setMuzzleOrigin(muzzle.x - bx, muzzle.y - (by - muzzle.heightPx), ux, uy);
        }
      } else {
        v.pushState(fpToPx(b.gx), fpToPx(b.gy), fpToPx(b.z), 0);
      }
      v.setFaction(b.faction);
      v.setElement(b.damageType);
      seen.add(b.id);
    }

    for (const it of state.pickups) {
      if (!it.alive) continue;
      let v = this.views.get(it.id) as Pickup | undefined;
      // A crate's kind changes in place once PickupSystem resolves it (design/15) —
      // same id, so the default "reuse by id" path below would otherwise leave it
      // drawn as an unresolved crate forever. Rebuild the view when kind flips.
      if (v && v.kind !== it.kind) {
        v.destroy();
        this.views.delete(it.id);
        v = undefined;
      }
      if (!v) {
        v = new Pickup(it.kind, it.weaponId, it.id);
        this.spawn(it.id, v, fpToPx(it.gx), fpToPx(it.gy), 0, 0);
      } else {
        v.pushState(fpToPx(it.gx), fpToPx(it.gy), 0, 0);
      }
      seen.add(it.id);
    }

    this.chests.update(state);
    this.shops.update(state);

    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.views.delete(id);
      if (v === this.playerView) this.playerView = null;
      // A dead player/enemy plays its death animation instead of vanishing outright — the rig's
      // authored `death` clip plus the dissolve shader (design/01 milestone 5; `Actor.onDeath`
      // for which owns what). Bullets/pickups have neither and destroy same as ever.
      // `interpolate()` below keeps stepping the dissolve until it finishes.
      if (v instanceof Actor) {
        v.onDeath();
        this.dying.push(v);
      } else {
        v.destroy();
      }
    }

    // The collected drop's view has just been destroyed by the sweep above — replace it with a
    // flight. LAST in this method, not first, because the arc is aimed at the collector's view
    // and this same call is what mirrors it: a drop collected on the first frame a seat exists
    // would otherwise find no body to fly to. A flight is a fresh view rather than the one that
    // was on the floor, because under online catch-up (`GameLoop.advanceOnline`) a drop can
    // spawn and be collected inside one drained batch, so the view it replaces may never have
    // existed — while the event always arrives.
    for (const e of events) if (e.type === 'pickup') this.launchPickupFlight(e);
  }

  /**
   * A drop was just collected — send a copy of it curving into the collector's body over
   * `FLIGHT_MS` (`scene/pickupFlight.ts` owns the curve and the reasoning).
   *
   * No collector view, no flight: the drop simply disappears the way it always did. That is a
   * real case rather than a defensive one — a bot seat in `?arenaDemo=1`, or a remote player
   * whose actor has not been mirrored yet — and an arc with nothing on the end of it would say
   * something false about where the loot went.
   */
  private launchPickupFlight(e: Extract<GameEvent, { type: 'pickup' }>): void {
    if (!this.actorAt(e.by)) return;
    const from: FlightPoint = { x: fpToPx(e.gx), y: fpToPx(e.gy), z: BOB_REST_Z };
    // Which side the arc bows to, alternating by the drop's own position. The engine id would
    // be the natural key (it is what `Pickup`'s hover-phase spread uses) but a `pickup` event
    // deliberately carries no item id — it carries where the item WAS, which separates two
    // drops just as well and costs the engine nothing. Deterministic either way: this render
    // layer draws no random numbers.
    const sign = (Math.round(from.x + from.y) & 1) === 0 ? 1 : -1;
    this.flights.launch(new Pickup(e.kind, e.weaponId), from, () => {
      // Re-resolved every frame, not captured: the collector is still running, and the view
      // may be gone by the time the drop gets there (see `FlightTarget`).
      const a = this.actorAt(e.by);
      if (!a) return null;
      // `a.x/a.y` is the container's SCREEN position, so the ground point it sorts by is the
      // drawn lift added back on (`Entity.applyTransform`) — and the drop aims at the middle of
      // the drawn body rather than at that ground point, because loot flying into a character's
      // feet reads as dropping in front of them.
      return { x: a.x, y: a.y + a.drawnLift, z: a.drawnLift + a.bodySilhouette.bodyH * TARGET_BODY_R };
    }, sign);
  }

  interpolate(alpha: number, frameDt: number): void {
    for (const v of this.views.values()) v.interpolate(alpha, frameDt);
    // Flights run on the RENDER clock, like the death dissolve below — they are already
    // detached from any engine entity, so there is nothing left to interpolate them against.
    this.flights.update(frameDt);
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      v.interpolate(alpha, frameDt);
      if (v.isDissolved) {
        v.destroy();
        this.dying.splice(i, 1);
      }
    }
  }

  /**
   * Override the LOCAL player's view with a predicted pose (ROADMAP 3.3 follow-up, online
   * prediction). Call AFTER reconcile() and BEFORE interpolate(): it snaps the local view
   * onto the predicted (px, radians) position so the sprite — and the camera that follows
   * it — show the render-ahead prediction, while every remote view keeps its confirmed
   * reconcile+interpolate. No-op before the local view exists. Never touches the sim.
   *
   * `moving` is `LocalPredictor.pose.moving` — the snap just below collapses prev onto
   * cur, so `Actor.interpolate`'s own curX/prevX-delta heuristic can't tell idle from
   * moving here the way it does for every confirmed (non-predicted) entity; this is the
   * explicit substitute (`Entity.movingOverride`), fixing what was otherwise a local
   * player whose walk animation never played under prediction.
   */
  positionLocal(x: number, y: number, z: number, facingRad: number, moving = false): void {
    if (!this.playerView) return;
    // Body facing is deliberately NOT taken from the caller (it used to be
    // `LocalPredictor.pose.bodyFacing`, the predicted movement direction): since
    // 2026-08-18 the body turns toward the AIM, and `reconcile` above already advanced it
    // one rate-limited step this tick. Re-deriving it here — at render rate, from movement
    // — would both double the turn speed and reintroduce the movement-driven facing this
    // change removed. Carry the value the view already holds.
    this.playerView.pushState(x, y, z, facingRad, this.playerView.bodyFacingRad);
    this.playerView.snap(); // prev == cur → no lerp; interpolate() draws it exactly here
    this.playerView.movingOverride = moving;
  }

  private spawn(id: number, v: Entity, x: number, y: number, z: number, facingRad: number, bodyFacingRad: number = facingRad): void {
    this.views.set(id, v);
    this.layers.entities.addChild(v);
    if (v.shadow) this.layers.shadow.addChild(v.shadow);
    // An Actor's health bar owns itself but isn't a child (Actor.ts's constructor doc) — it
    // rides `layers.hud`, always in front of every wall/pillar/door regardless of Y-sort or
    // the occlusion x-ray's fade state (design/01, live report *"血条被墙挡住了"*).
    if (v instanceof Actor && v.healthBar) this.layers.hud.addChild(v.healthBar);
    v.pushState(x, y, z, facingRad, bodyFacingRad);
    v.snap(); // appear at spawn, don't lerp in from (0,0)
    // A new engine id IS the spawn signal — there is no `spawn` event, and there does not need to
    // be one: this method runs exactly once per id, on the tick the entity first appears in
    // `GameState`. What DOES matter about the timing is that it is after CONSTRUCTION: `Actor`
    // measures its filter area and its drawn silhouette once, off a rest-posed rig, and the spawn
    // clip opens the body at 20% scale — so starting it any earlier would size the shield shell,
    // the hit outline and the occlusion x-ray's denominator against a body that has not arrived,
    // for the whole run rather than for the clip's 350 ms. Its position within this method is not
    // load-bearing (a clip trigger reads no coordinates); the call being here rather than in the
    // constructor is.
    if (v instanceof Actor) {
      v.onSpawn();
      this.spawnedActors++;
    }
  }
}
