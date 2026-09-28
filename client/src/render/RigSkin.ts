import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { Rig } from './Rig';
import type { RigSkinBundle } from './taoBundle';
import type { ResolvedBoneTransform, WorldPositions } from './types';
import { canonicalAimRad, facingFromAngle } from './facing';
import { getWeaponAnchor, getWeaponRotationOffset, getWeaponScale, getWeaponTexture, type WeaponVisualKind } from './weaponSkins';
import { MODULE_BEHIND_SCALE, MODULE_BEHIND_SHADE, SHADE_MIN_BODY_R, drawSphereShading, paintModuleContacts, placeSphereShade, shadeHex } from './rigShading';
import { drawTethers, hasTetheredBone } from './rigTethers';
import { EYE_BONE_ID, FRONT_ONLY_BONES, trackEye } from './rigFacingArt';
import {
  AIM_TRACKING_BONES, ACTIVE_WEAPON_SOCKET, IDLE_WEAPON_SOCKET, MODULE_Z_BEHIND,
  activeModuleMount, barrelReach, idleModuleMount, moduleMuzzleLocal, orbitActiveSocketToAim,
  resolveWeaponMount,
  type ModuleMount, type WeaponMountMode,
} from './rigWeaponMount';
import {
  AttackMotion, type AttackKind, type ShotShape, type SwingShape,
} from './rigAttackMotion';
import { ClipLayers } from './rigClipLayer';

// `barrelReach` moved to ./rigWeaponMount with the rest of the mount geometry; re-exported
// here so the original import path stays valid for callers and tests (500-line convention:
// "keep that path alive as a thin re-export shell").
export { barrelReach };

// The game-side .tao runtime renderer (design/12): bone FK + sprite binding +
// animation playback, ported from tools/animator/src/rendering/Renderer.ts's
// `updateSprites` (rewritten for Pixi v8's API — the editor is still on v7).
//
// Placement model (fixed 2026-08-17 — the port originally drew every sprite at its
// bone's PIVOT, unrotated-by-nothing, which visibly disassembled the character):
//   - A bone's art is centred on its TIP (`pose.ex/ey`), not its pivot — the tip is
//     where the rig itself puts that bone's `bodyR` body circle (the editor's own
//     skeleton view draws it there), so it's the point the art was sized against. It
//     matters because every rig here hangs its body off a pivot at the actor's feet
//     via one upward body bone (`shell`/`body`/`core`, `len` = hover height): drawing
//     at the pivot put the body a full body-length BELOW its own children, so
//     orb-core's eye/belly/both weapon sockets piled up in one spot above the shell's
//     head instead of sitting on the shell.
//   - Rotation is the bone's angle RELATIVE TO ITS REST ANGLE (`pose.wa - rwa`), so
//     art authored the way it reads on screen (shell upright, belly upright) stays
//     upright, and only animation/aim actually turns it. Drawing at the raw world
//     angle instead rotated every one of these rigs by its body bone's rest angle
//     (-90°, since it points up) — the hero's crystal spikes pointed left, and every
//     critter/boss body was 90° off too.
//
// Facing model (design/12 "Facing model (twin-stick 360° aim)"), extended with an
// upper/lower body split: a 2D bone rig gives L/R flip + part rotation, not a true
// 3D turn.
//   - L/R mirror + front/back hemisphere are driven by the BODY facing (movement
//     direction for a player, same as its aim for anything stationary like an
//     enemy) via `setBodyFacing` — the whole rig flips by that direction's
//     horizontal sign (`view.scale.x`), and aiming toward the top of the screen
//     (dy < 0, away from the camera) swaps in each slot's 'back' variant where one
//     exists (today: only `eye` has one — the concept turnaround's eye/vent swap).
//   - Aim-tracking socket rotation: the ACTIVE socket's WORLD rotation is overridden
//     every frame to the live AIM angle (`setAim`, design/03/12/13 "following that
//     socket's aim rotation every frame") instead of playing only its authored
//     clip — independently of the body flip above, so the gun can point at the
//     shot direction while the legs face movement. The rig is authored assuming it
//     faces right (rest pose `wa`/binding.rotation are canonical, unflipped); when
//     `view.scale.x` mirrors the whole rig, a socket's LOCAL rotation must be the
//     mirror image of the true aim angle so the flip renders it pointing at the
//     real reticle — see `canonicalSocketAngleRad` below.
export class RigSkin {
  readonly view = new Container();
  private readonly sprites = new Map<string, Sprite>();
  /** One child Graphics per tethered bone (`rigTethers.drawTethers`). */
  private readonly tethers: Container | null;
  // Sphere shading over the body bone (see rigShading.ts), plus which bone it tracks. Null
  // for a rig whose body is too small to shade, or one with no bound body art at all.
  private readonly sphereShade: Graphics | null;
  /** Contact shade where each orbiting module meets the core (`rigShading.drawModuleContacts`,
   *  2026-08-19). Allocated only for a rig that HAS orbiting modules, i.e. the same tethered
   *  bones the tether Graphics is drawn from, and only when that rig's body is big enough to
   *  shade at all — an enemy with one body bone gets neither. */
  private readonly moduleAO: Container | null;
  private readonly shadeBoneId: string | null;
  /** Which mount path this body plan uses (`rigWeaponMount.resolveWeaponMount`) — resolved
   *  once at construction, since it is a property of the rig def, not of this frame. */
  private readonly weaponMount: WeaponMountMode;
  private tetherGeometry = ''; // last-drawn endpoint signature (skip the rebuild if unchanged)
  private tetherTint = 0xffffff; // multiply-tint over the tether hue; white = as authored
  private showBack = false;
  private flipX: 1 | -1 = 1;
  private aimRad = 0;
  private weaponKind: WeaponVisualKind | null = null;
  private weaponName: string | undefined = undefined;
  /** The two halves of one attack, both driven by `attack()` below: the authored `attack` clip
   *  layered ADDITIVELY over idle/move (`rigClipLayer.ts`), and the aim-relative recoil/swing a
   *  clip cannot express (`rigAttackMotion.ts`). See either file for the split. */
  private readonly layers: ClipLayers;
  private readonly motion = new AttackMotion();
  private weaponSprite: Sprite | null = null; // the ACTIVE socket's module (aim-tracking)
  /** Last frame's active `ModuleMount.pivotY` — see `muzzleLocal`'s `heightPx`. */
  private activePivotY = 0;
  private idleModuleSprite: Sprite | null = null; // the other arm's decorative module
  private weaponTint = 0xffffff;

  /** `bodyFill` is how much of the body bone's declared `bodyR` this bundle's art actually
   *  paints (`skinRegistry.BODY_FILL`, measured from the shipped PNGs). Everything drawn ON the
   *  body rather than as part of it — the sphere shading, the module contact shades — must be
   *  sized against that, not against `bodyR`: nothing here is masked, so a mark sized to a
   *  radius the art does not reach paints straight onto the transparent background. Defaults to
   *  1 (assume the art fills its radius) so a fake bundle in a test behaves as before. */
  constructor(
    private readonly rig: Rig,
    private readonly bundle: RigSkinBundle,
    private readonly bodyFill = 1,
  ) {
    this.weaponMount = resolveWeaponMount(rig);
    this.layers = new ClipLayers(bundle.clips);
    // Tethers paint behind every bone sprite: they run from the core's centre out to a
    // module, so the half nearest the core belongs UNDER the body, not across it.
    this.tethers = hasTetheredBone(rig.boneDefs) ? new Container() : null;
    if (this.tethers) {
      this.tethers.zIndex = -1;
      this.view.addChild(this.tethers);
    }

    for (const boneId of rig.drawOrder) {
      const binding = bundle.bindings.get(boneId);
      const texture = bundle.textures.get(boneId);
      if (!binding || !texture) continue;

      const sprite = new Sprite(texture);
      sprite.anchor.set(binding.anchorX, binding.anchorY);
      sprite.zIndex = binding.zOrder;
      this.sprites.set(boneId, sprite);
      this.view.addChild(sprite);
    }

    // Sphere shading goes on the rig's BODY bone — the first bone in draw order with a
    // bodyR big enough to be worth shading, which is `shell` (orb-core), `body`
    // (critter-core and the brute/floater that share its rig) and `core` (boss-core).
    // Placed at that bone's own zOrder + 0.5, i.e. immediately over its art and under
    // everything drawn later (an orb-core's belly/eye/modules keep their own reads).
    this.shadeBoneId =
      rig.drawOrder.find(id => {
        const r = rig.boneMap.get(id)?.bodyR ?? 0;
        return r >= SHADE_MIN_BODY_R && bundle.bindings.has(id) && bundle.textures.has(id);
      }) ?? null;
    if (this.shadeBoneId) {
      this.sphereShade = drawSphereShading(this.drawnBodyR());
      this.sphereShade.zIndex = (bundle.bindings.get(this.shadeBoneId)?.zOrder ?? 0) + 0.5;
      this.view.addChild(this.sphereShade);
    } else {
      this.sphereShade = null;
    }

    // Just above the sphere shade and still below every decorative bone (orb-core: belly 1,
    // eye 2, sockets 3/4), so a module's own art always draws over its contact shade.
    this.moduleAO = this.shadeBoneId && this.tethers ? new Container() : null;
    if (this.moduleAO) {
      this.moduleAO.zIndex = (bundle.bindings.get(this.shadeBoneId!)?.zOrder ?? 0) + 0.6;
      this.view.addChild(this.moduleAO);
    }

    this.view.sortableChildren = true;
  }

  /** Select which GROUND clip plays (idle/move) and at what local time (ms — converted to the
   *  seconds clip.duration/keyframe.time are authored in, tools/animator's AnimationController).
   *  The one-shot overlays ride on top of it (`attack`/`hurt`) and the lifecycle clips outrank it
   *  (`spawn`/`die`), so this stays the caller's plain "what is the body doing on the ground"
   *  question — `Actor` asks for idle/move whether or not the actor is spawning or dying. */
  playClip(name: string, tMs: number): void {
    this.layers.playBase(name, tMs);
  }

  /** An attack just left this rig — one entry point for both kinds, which is the whole point:
   *  a shot and a swing start the same authored `attack` clip and the same envelope, and only
   *  the envelope's SHAPE differs by kind. The shape is the WEAPON that attacked (its sector,
   *  hit window, recovery and knockback for a swing; its cadence and per-pull damage for a
   *  shot); omitted, the envelope falls back to that kind's starter weapon. */
  attack(kind: 'ranged', shot?: ShotShape): void;
  attack(kind: 'melee', swing?: SwingShape): void;
  attack(kind: AttackKind, shape?: ShotShape | SwingShape): void {
    // The overloads above are the pairing check; this body has already lost it, so the two
    // `kick` overloads are re-selected by the same discriminant rather than by a cast.
    if (kind === 'melee') this.motion.kick(kind, shape as SwingShape | undefined);
    else this.motion.kick(kind, shape as ShotShape | undefined);
    this.layers.attack();
  }

  /** The other three signals the engine's event/entity stream carries, each one clip and nothing
   *  else — no procedural half, unlike `attack`, because none of them points along the aim ray.
   *  Which LAYER each lands on is `rigClipLayer`'s call and is forced by the shipped keyframes;
   *  see its header table. `hurt` rides over whatever the body is doing (a flinch must not stop
   *  a walk), `spawn`/`die` take over the base layer for their duration. */
  hurt(): void { this.layers.hurt(); }
  spawn(): void { this.layers.spawn(); }
  die(): void { this.layers.die(); }

  /** Advance every clip clock + the attack envelope by one render frame. Call before `update()`. */
  advanceClips(dtMs: number): void {
    this.motion.advance(dtMs);
    this.layers.advance(dtMs);
  }

  /** Body/legs facing (radians, standard math convention, y-down screen space) —
   *  drives the whole-rig L/R flip + front/back hemisphere. Independent of `setAim`
   *  below: this is movement direction for a player, not the aim/shot direction. */
  setBodyFacing(rad: number): void {
    const { flipX, showBack } = facingFromAngle(rad);
    this.view.scale.x = flipX;
    this.showBack = showBack;
    this.flipX = flipX;
    // The key light is fixed in SCREEN space, so the shading must not mirror with the body:
    // counter-flipping cancels `view.scale.x` exactly, leaving the highlight on the
    // upper-left and the terminator on the lower-right whichever way the character faces.
    // (Every other child here is body-space art and SHOULD mirror.) The counter-flip itself is
    // WRITTEN in `update()`, together with the body's own clip squash it now has to share that
    // scale with — one line owning one property, rather than two that overwrite each other.
  }

  /** Aim/shot direction (radians) — drives ONLY the weapon-socket aim-tracking
   *  rotation, independently of the body flip set by `setBodyFacing`. */
  setAim(rad: number): void {
    this.aimRad = rad;
  }

  /** Multiply-tint every bone sprite (design/13: a neutral-grey body re-tinted per
   *  elemental variant at runtime, e.g. critter-core — never called for a character
   *  skin, which already carries its own real colours). The weapon sprite (mounted
   *  separately, not a bone) is deliberately left untinted. */
  setTint(color: number): void {
    this.sprites.forEach(sprite => {
      sprite.tint = color;
    });
    // The tether is part of the body, so it takes the variant tint too (a corrupted
    // boss core's shard-ring tethers read in its own hue, not the hero's cyan).
    this.tetherTint = color;
    if (this.tethers) this.tethers.tint = color;
  }

  /** Which weapon module (if any) the active socket (`ACTIVE_WEAPON_SOCKET`) mounts —
   *  null hides it (unarmed / no rig / texture not preloaded yet). design/13's
   *  universal mount: one neutral sprite per KIND, not per weapon frame. */
  setWeaponKind(kind: WeaponVisualKind | null, name?: string): void {
    this.weaponKind = kind;
    this.weaponName = name;
  }

  /** Re-tint the mounted weapon sprite (design/03/13 "element = colour" — a fire/ice/
   *  lightning/poison weapon reads in its element hue, physical stays neutral). Applied
   *  immediately if the sprite already exists; otherwise picked up the next time
   *  `updateWeaponSprite` (re)creates it. */
  setWeaponTint(color: number): void {
    this.weaponTint = color;
    if (this.weaponSprite) this.weaponSprite.tint = color;
    if (this.idleModuleSprite) this.idleModuleSprite.tint = color;
  }

  /** Where the AIM points, canonically (`facing.canonicalAimRad`) — the eye tracks its target
   *  along this, and the recoil pushes along it, during a swing as well as outside one. */
  private canonicalSocketAngleRad(): number {
    return canonicalAimRad(this.aimRad, this.flipX);
  }

  /** Where the WEAPON points: the aim plus whatever the attack envelope adds to it — a melee
   *  swing's arc, or a shot's muzzle climb. Separate from the aim above on purpose: the eye
   *  follows the target, not the blade, and it does not ride the recoil either. */
  private canonicalWeaponAngleRad(): number {
    return this.canonicalSocketAngleRad() + (this.motion.weaponDeg * Math.PI) / 180;
  }

  /** Recompute FK from the current clip sample and push it onto the sprites. Call once per render frame. */
  update(): void {
    const transforms: Map<string, ResolvedBoneTransform> = this.layers.sample();
    // The active socket ORBITS the core to the aim, applied to the BONE before FK so the ring,
    // its tether, its contact shade and the weapon module all travel as one assembly.
    //
    // The WEAPON angle, not the bare aim: a melee swing adds its arc here, so the whole assembly
    // sweeps around the core instead of the blade pivoting inside its own housing. Identical to
    // the aim for a gun, since `swingDeg` is 0 for anything but a swing.
    if (this.weaponMount === 'socket')
      orbitActiveSocketToAim(this.rig, transforms, this.canonicalWeaponAngleRad());
    const worldPose = this.rig.computeFK(0, 0, transforms);
    const canonicalWeaponDeg = (this.canonicalWeaponAngleRad() * 180) / Math.PI;

    // The body moves along the SCREEN aim, not the canonical one: this is the container's own
    // position, which `view.scale.x` does not mirror. `bodyPx` is SIGNED — positive shoves back
    // off a shot, negative lunges into a swing — so one formula covers both.
    const shove = this.motion.bodyPx;
    this.view.x = -Math.cos(this.aimRad) * shove;
    this.view.y = -Math.sin(this.aimRad) * shove;

    this.sprites.forEach((sprite, boneId) => {
      const pose = worldPose.get(boneId);
      const binding = this.bundle.bindings.get(boneId)!;
      if (!pose) return;

      const backTexture = this.showBack ? this.bundle.textures.get(`${boneId}__back`) : undefined;
      sprite.texture = backTexture ?? this.bundle.textures.get(boneId)!;
      // A FRONT_ONLY bone with no back art of its own is hidden from behind rather than
      // drawn as though the character were still facing the camera. Closes design/12's one
      // remaining facing-model gap ("a character facing away still shows its belly"), which
      // that doc offers two fixes for: ship `belly__back`, or hide it. This is the second,
      // and it is written so the first supersedes it for free — the moment a `belly__back`
      // texture exists the lookup above finds it, `backTexture` is defined, and the bone
      // draws again with no code change.
      sprite.visible = !(this.showBack && !backTexture && FRONT_ONLY_BONES.has(boneId));

      const transform = transforms.get(boneId);
      sprite.x = pose.ex + (transform?.translateX ?? 0);
      sprite.y = pose.ey + (transform?.translateY ?? 0);
      // `pose.wa` already carries the clip's own rotation for this bone (Rig.computeFK
      // folds it in), so it is NOT added a second time here.
      const restAngleDeg = this.rig.boneMap.get(boneId)?.rwa ?? 0;
      const aimTracking = AIM_TRACKING_BONES.has(boneId);
      // The ring the module is mounted on kicks back WITH it, or the gun would slide out of
      // its own housing. Canonical space, like every other offset in this loop, so the
      // whole-rig flip lands it on the correct side.
      if (aimTracking && this.motion.modulePx !== 0) {
        const a = this.canonicalSocketAngleRad();
        sprite.x -= Math.cos(a) * this.motion.modulePx;
        sprite.y -= Math.sin(a) * this.motion.modulePx;
      }
      const angleDeg = aimTracking ? canonicalWeaponDeg : pose.wa - restAngleDeg;
      sprite.rotation = ((angleDeg + binding.rotation) * Math.PI) / 180;
      const scaleMul = boneId === EYE_BONE_ID
        ? trackEye(sprite, this.canonicalSocketAngleRad(), this.aimRad)
        : 1;
      sprite.scale.set(
        (binding.flipX ? -1 : 1) * (transform?.scaleX ?? 1) * binding.scaleX * scaleMul,
        (transform?.scaleY ?? 1) * binding.scaleY * scaleMul,
      );
      sprite.alpha = transform?.alpha ?? 1;
    });

    // Sphere shading rides the body bone it shades — its drawn position, its clip alpha and its
    // clip squash, all off that one bone. See `rigShading.placeSphereShade` for each and for the
    // one property that deliberately does NOT come from the body (the screen-space flip).
    if (this.sphereShade && this.shadeBoneId) {
      placeSphereShade(
        this.sphereShade, worldPose.get(this.shadeBoneId), transforms.get(this.shadeBoneId), this.flipX,
      );
    }

    if (this.tethers) {
      this.tetherGeometry = drawTethers(
        this.tethers, this.rig.boneDefs, worldPose, transforms, this.tetherGeometry, this.tetherTint,
      );
    }
    if (this.moduleAO && this.shadeBoneId) {
      paintModuleContacts(
        this.moduleAO, this.shadeBoneId, this.rig.boneDefs, worldPose, transforms, this.drawnBodyR(),
      );
    }
    this.updateWeaponSprites(worldPose, transforms);
  }

  /** The body art's real drawn radius in authoring px — the shade bone's declared `bodyR` times
   *  this bundle's measured `bodyFill`. Only valid once `shadeBoneId` has resolved. */
  private drawnBodyR(): number {
    return this.rig.boneMap.get(this.shadeBoneId!)!.bodyR! * this.bodyFill;
  }

  /** The body bone a 'held' module hangs off, or null for a rig that mounts on a socket (or
   *  mounts nothing). It is the same bone the sphere shading tracks — the rig's actual body —
   *  and the radius is the ART's, not the bone's declared `bodyR`; see `HELD_MOUNT_R`.
   *
   *  The `weaponMount !== 'held'` half of the guard is deliberately unobservable: the socket
   *  path ignores this argument and the 'none' path returns null whatever it is handed, so
   *  dropping it changes no output (it is the one surviving mutant of the 59-mutant battery run
   *  for this pass, and survives as a true equivalent). Kept because it states the intent and
   *  skips the work, not because anything downstream depends on it. */
  private heldMountBody(): { boneId: string; drawnR: number } | null {
    if (this.weaponMount !== 'held' || !this.shadeBoneId) return null;
    return { boneId: this.shadeBoneId, drawnR: this.drawnBodyR() };
  }

  /** Mount/move/hide this rig's weapon modules (design/03 universal mount — render-only,
   *  never touches the sim). Which modules exist, and where they sit, is `rigWeaponMount`'s
   *  call: the hero's orb-core gets an ACTIVE module orbiting the core toward the aim plus a
   *  decorative IDLE one on the other arm; an enemy body gets a single module held out along
   *  the aim at its own drawn edge; the boss gets none. */
  private updateWeaponSprites(worldPose: WorldPositions, transforms: Map<string, ResolvedBoneTransform>): void {
    const texture = this.weaponKind ? getWeaponTexture(this.weaponName, this.weaponKind) : undefined;
    const canonical = this.canonicalWeaponAngleRad();
    const activeMount = texture
      ? activeModuleMount(
          this.weaponMount, worldPose, transforms, canonical, this.heldMountBody(), this.motion.modulePx,
        )
      : null;
    const idleMount = texture ? idleModuleMount(this.weaponMount, worldPose, transforms) : null;
    // The height half of the active mount (see `muzzleLocal`'s `heightPx`) — the last point
    // where the rig can still tell "how high off the floor" from "how far north".
    this.activePivotY = activeMount?.pivotY ?? 0;
    if (!texture) {
      if (this.weaponSprite) this.weaponSprite.visible = false;
      if (this.idleModuleSprite) this.idleModuleSprite.visible = false;
      return;
    }

    const rotationOffset = getWeaponRotationOffset(this.weaponName, this.weaponKind!);
    // The ACTIVE module orbits to the aim, so its OWN hemisphere decides whether it is on the
    // far side of the core (design/01 "per-weapon local z-order"). Keyed off `showBack` it
    // would be drawn across the core's face for the length of the rate-limited body turn,
    // during which the gun has swung behind it and the body has not. The idle one does not
    // orbit, so it stays on the body's answer.
    this.weaponSprite = this.mountModule(
      this.weaponSprite, ACTIVE_WEAPON_SOCKET, activeMount, texture, rotationOffset,
      Math.sin(canonical) < 0,
    );
    this.idleModuleSprite = this.mountModule(
      this.idleModuleSprite, IDLE_WEAPON_SOCKET, idleMount, texture, rotationOffset, this.showBack,
    );
  }

  /** Place one module sprite (creating it on first use) at the given mount; hides it when
   *  there is no mount this frame (an unposed bone, or a rig that has no such module at all).
   *  Returns the sprite so the caller can keep its lazily-created reference. */
  private mountModule(
    sprite: Sprite | null,
    socketId: string,
    mount: ModuleMount | null,
    texture: Texture,
    rotationOffset: number,
    behind: boolean,
  ): Sprite | null {
    if (!mount) {
      if (sprite) sprite.visible = false;
      return sprite;
    }
    if (!sprite) {
      sprite = new Sprite(texture);
      sprite.tint = this.weaponTint;
      this.view.addChild(sprite);
      this.view.sortableChildren = true;
    }
    // design/01's "Per-weapon local z-order" rule, implemented 2026-08-18 (it had been
    // documented, and pinned to in-front, since the rig renderer shipped): aiming away from
    // the camera puts the module on the far side of the core, so it has to draw BEHIND the
    // body — otherwise it reads as a gun stuck on the hero's back/chest. Re-evaluated every
    // frame, not just on creation, since `showBack` flips during play.
    // ...and, since 2026-08-18, two more depth cues on the same edge (MODULE_BEHIND_*): the
    // far-side module is drawn smaller and darker, so crossing the hemisphere reads as an
    // orbit around a sphere rather than a layer swap. Applied here, not in `setWeaponTint`,
    // because it has to be recomputed against the CURRENT `showBack` every frame — the tint
    // setter only knows the element colour.
    sprite.zIndex = behind ? MODULE_Z_BEHIND : (this.bundle.bindings.get(socketId)?.zOrder ?? 0) + 1;
    sprite.tint = behind ? shadeHex(this.weaponTint, MODULE_BEHIND_SHADE) : this.weaponTint;
    const anchor = getWeaponAnchor(this.weaponName, this.weaponKind!);
    sprite.texture = texture;
    sprite.anchor.set(anchor.x, anchor.y);
    sprite.scale.set(getWeaponScale(this.weaponName, this.weaponKind!) * (behind ? MODULE_BEHIND_SCALE : 1));
    sprite.visible = true;
    sprite.x = mount.x;
    sprite.y = mount.y;
    // A module is not a bone, so its mount carries its mount BONE's clip alpha — see
    // `ModuleMount.alpha` for the two clips that make the difference visible.
    sprite.alpha = mount.alpha;
    sprite.rotation = mount.angle + rotationOffset;
    return sprite;
  }

  /**
   * Where the mounted weapon's business end is this frame, or null when nothing is mounted (a
   * rig whose `weaponMount` is 'none' — `boss-core` — and the frames before the weapon texture
   * preloads; NOT null for enemies, which have mounted a real 'held' module since 2026-08-21).
   * The geometry is `rigWeaponMount.moduleMuzzleLocal` (split out 2026-08-30, 500-line
   * convention) — see there for why the barrel tip is not the sim's muzzle. Because the recoil
   * moves the MOUNT, this point recoils with the gun; `+ view.position` adds the recoil's
   * whole-body shove, which lives on the container rather than on any bone, since the result is
   * stated in the rig's PARENT space.
   *
   * `heightPx` is the HEIGHT half of this point, which `y` alone cannot express: that is two
   * world quantities added — how high off the floor the tip is, and how far north of its
   * carrier it stands — separable only because both mount paths carry the module along the aim
   * ray in the GROUND plane at a fixed height (see GROUND-PLANE ORBIT). `Scene` draws the round
   * at this height rather than at `bulletZ`, since the gap between those is straight up the
   * screen, i.e. PERPENDICULAR to a horizontal shot: an arc. Excludes `view.x/y` (added to the
   * point above) — the recoil's body shove runs along the aim ON THE GROUND, so it is position.
   */
  muzzleLocal(): { x: number; y: number; heightPx: number } | null {
    const sprite = this.weaponSprite;
    if (!sprite || !sprite.visible || !this.weaponKind) return null;
    const local = moduleMuzzleLocal(
      sprite,
      this.canonicalSocketAngleRad(),
      this.flipX,
      sprite.texture,
      getWeaponAnchor(this.weaponName, this.weaponKind),
      getWeaponRotationOffset(this.weaponName, this.weaponKind),
      getWeaponScale(this.weaponName, this.weaponKind),
    );
    return { x: local.x + this.view.x, y: local.y + this.view.y, heightPx: -this.activePivotY };
  }

}
