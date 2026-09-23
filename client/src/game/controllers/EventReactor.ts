import {
  WEAPON_SIM_BY_ID, BLUEPRINT_CATALOG, MATERIAL_DEFS, RUN_BUFFS,
  type GameEvent, type GameState, type MeleeSimSpec, type WeaponSimSpec,
} from '@dd/engine';
import { THEME, rarityColor, ELEMENT_COLORS } from '../theme';
import { SCORE } from '../score';
import { fpToPx, bradToRad } from '../coords';
import { facingFromAngle } from '../../render/facing';
import { swingSchedule, type AttackTrigger } from '../../render/rigAttackMotion';
import { byId, specOf, shotShapeOf, swingShapeOf } from './attackShapes';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { AudioBus, AudioCue } from '../../platform/types';
import { t, tName } from '../../i18n';
import { localSeatWon } from './localOutcome';

/** How far above a dying actor's ground anchor its death burst is centred, in multiples of
 *  that actor's own drawn body radius — see the `death` case for why this reactor eyeballs
 *  the body centre rather than reading the view's real one. 0.8 is what the flat 12 px this
 *  replaced worked out to on the 15 px mob it was chosen against. */
const DEATH_BURST_LIFT_R = 0.8;

/** The bits of Game an EventReactor reaction needs to reach back into — score/meta/
 *  room-rebuild are Game-owned state, so this stays a callback interface rather than
 *  EventReactor importing MetaState/Screens/etc. directly (same decoupling FxController
 *  itself relies on: this file never imports Game.ts). */
export interface EventReactorHost {
  readonly localOwner: number;
  activeState(): GameState | null;
  addScore(delta: number): void;
  /** A `room_enter` event landed — rebuild the render-side room geometry. */
  onRoomEnter(s: GameState): void;
  /** A `door_locked`/`door_unlocked` event landed (DoorSystem) — restyle the
   *  affected door fixture(s) in place, no full room rebuild. */
  onDoorStateChange(s: GameState): void;
  /** The LOCAL player was just force-regrouped (DoorSystem, design/05) — an instant
   *  position snap, not organic movement, so the camera must cut to it rather than
   *  interpolate/pan across the floor. */
  onForceRegroup(): void;
  /** A catalogued weapon was picked up — unlock its forge blueprint if not already. */
  onWeaponPickup(weaponId: string): void;
  /** The specific actor view an event's id names — a `hit`'s `target`, or a `bullet_fired`'s
   *  `ownerId` — for a reaction that must land on ONE actor rather than just at a world
   *  position the way `fx.flash()` does. Undefined for a bullet/pickup id, or an actor that's
   *  already gone. Duck-typed (not `Actor`) so this file still never imports scene/ — same
   *  decoupling as the rest of this interface.
   *
   *  The narrow view this reactor needs: where the actor is on screen (world px, so an event's
   *  own position can be turned into a delta from its centre), the hit reaction, the attack
   *  reaction, and where its DRAWN barrel tip is — the muzzle fx has to be anchored there, and
   *  `muzzlePos()` is null for a skin that mounts no weapon module (`Skin.muzzleAnchor`).
   *
   *  The two lifecycle reactions (`onSpawn`/`onDeath`) are deliberately NOT here: an id
   *  appearing in or vanishing from `GameState` is the signal for those, so `Scene` drives them
   *  off its own diff. This reactor only carries what an EVENT announces. */
  actorAt(id: number): {
    onHurt(dx?: number, dy?: number): void;
    onAttack: AttackTrigger;
    muzzlePos(): { x: number; y: number } | null;
    x: number;
    y: number;
  } | undefined;
}

/**
 * Events are the only engine→render channel (design/08): fx feedback + score + audio.
 * Extracted out of Game.ts 2026-07-28 (that file had accreted too many unrelated jobs) —
 * this is purely the "one big switch over GameEvent" slice, sharing FxController/HudView/
 * AudioBus with the rest of the shell and reaching back into Game only through `host` for
 * the handful of reactions that are genuinely Game-owned state (score/meta/room rebuild).
 */
export class EventReactor {
  constructor(
    private readonly fx: FxController,
    private readonly hud: HudView,
    private readonly audio: AudioBus,
    private readonly host: EventReactorHost,
  ) {}

  /**
   * @param spawnedActors how many actor VIEWS `Scene.reconcile` built this frame — the one
   * cue in the game with no engine event behind it (`spawn`). An id appearing in `GameState`
   * is a diff only `Scene` computes, which is why `Actor.onSpawn` is driven from there and
   * why `EventReactorHost` deliberately carries no lifecycle reaction. It arrives here as a
   * plain count rather than through the host for exactly that reason: nothing is being read
   * back out of a view, and the coalescing below is the whole job — a wave materialising nine
   * actors on one frame has to become one voice at higher gain, the same as nine `impact`s.
   */
  consume(events: readonly GameEvent[], spawnedActors = 0): void {
    // Coalesce audio cues within the frame: a bullet-hell frame can emit dozens of
    // identical events, so we collect the distinct cues here and play each ONCE after
    // the loop (design/11 "coalesce identical cues in the same frame"). fx/score still
    // react per-event below — only sound is deduped.
    //
    // The COUNT is kept, not just the fact: design/11 asks for ten hits in one frame to
    // become one impact "at higher gain, not ten", and the mixer needs the number to do it.
    const cues = new Map<AudioCue, number>();
    const cue = (id: AudioCue): void => {
      cues.set(id, (cues.get(id) ?? 0) + 1);
    };
    if (spawnedActors > 0) cues.set('spawn', spawnedActors);
    // "Is this entity the seat I am playing?" — the gate on `hurt` and `death.player`, the
    // only two cues that fire for ONE actor rather than for a world position. Both are
    // meaningless without it: `impact` already says a hit landed somewhere, so a `hurt` that
    // fired for every target would only double it, and in an 8-player PvP match a
    // `death.player` per elimination would announce seven runs that are not this one.
    //
    // Resolved at most ONCE per frame, and only if an event actually asks. Eager resolution
    // was the first cut and it was wrong twice over: it walks the state on every frame of a
    // menu whose queue holds nothing that needs it, and it makes this reactor — a consumer
    // that never used to touch `players` unless an event named one — able to throw on a
    // state it previously tolerated. A render-layer consumer failing where it used to draw
    // is the wrong trade for saving one property read.
    let localId: number | undefined;
    let localIdResolved = false;
    const isLocalSeat = (id: number): boolean => {
      if (!localIdResolved) {
        localId = this.host.activeState()?.players[this.host.localOwner]?.id;
        localIdResolved = true;
      }
      // Undefined before the first seat exists — "no local actor", never "actor 0".
      return localId !== undefined && id === localId;
    };
    for (const e of events) {
      switch (e.type) {
        case 'bullet_fired': {
          // Anchored on the SHOOTER, not on the event's own position (2026-08-30, user report
          // *"角色射击时，没有射击动画，枪口也没有射击特效"*). `gx/gy` is the sim's muzzle —
          // `muzzleOffset` along the aim ray on the GROUND plane — which is not where the rig
          // draws the gun, so every muzzle fx used to burst near the character's middle and read
          // as "no muzzle effect at all". `Actor.muzzlePos()` is the drawn barrel tip, i.e. the
          // exact point `Scene` already spawns the bullet view from, so shot, flare and sparks
          // now all leave the same place. It is null for a skin with no mounted module (the
          // boss, the Graphics placeholder, the frames before the weapon texture preloads) —
          // those keep the old sim position plus the same 12 px lift `flash()`/`trailDot()` use.
          const shooter = this.host.actorAt(e.ownerId);
          // clip + recoil — render-only, see Actor.onAttack. The SHOOTER's own weapon sizes and
          // paces the kick (`render/attack/shotShape.ts`); resolved from the state for the same
          // reason the swing below is, and over players AND enemies, since every enemy in the
          // roster shoots. A shooter that cannot be resolved falls back to the starter blaster.
          const gun = specOf(this.attacker(e.ownerId), 'ranged');
          shooter?.onAttack('ranged', gun && shotShapeOf(gun));
          const drawn = shooter?.muzzlePos() ?? null;
          const fx = drawn ? drawn.x : fpToPx(e.gx);
          const fy = drawn ? drawn.y : fpToPx(e.gy) - 12;
          const facingRad = bradToRad(e.facing);
          this.fx.muzzleFlare(fx, fy, facingRad, THEME.colors.muzzle);
          this.fx.particles.muzzleFlame(fx, fy, facingRad, THEME.colors.muzzle);
          this.fx.particles.shellCasing(fx, fy, facingRad);
          cue('muzzle');
          break;
        }
        case 'melee_swing': {
          // The melee half of the SAME reaction the ranged branch above opens with, and the
          // reason `melee_swing` exists at all (ENGINE_VERSION 52): a swing is announced whether
          // or not it connects, so the blade animates over empty air too. It gets a cue for the
          // same reason it gets a clip: a stroke through empty air is a real action the player
          // took, and until 2026-09-02 it was the only one they could not hear.
          //
          // Both fx below need the swinging WEAPON, which the event deliberately does not carry
          // (design/08 keeps events to what the sim announces, and every client already holds
          // the whole `GameState` — the netcode broadcasts inputs, not entities). Resolved from
          // there rather than added to the event, so no engine/protocol shape changes.
          const swinger = this.attacker(e.ownerId);
          const blade = specOf(swinger, 'melee');
          this.host.actorAt(e.ownerId)?.onAttack('melee', blade && swingShapeOf(blade));
          if (swinger && blade)
            this.slashSector(blade, swinger.radiusPx, bradToRad(e.facing), fpToPx(e.gx), fpToPx(e.gy));
          cue('swing');
          break;
        }
        case 'hit':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy),
            e.faction === 'enemy' ? THEME.colors.enemy : THEME.colors.swordGlow, 16);
          // The reaction on the SPECIFIC actor hit — a silhouette flash + shield dent
          // (design/01 milestone 5, `OutlineFilter`/`EnergyShieldFilter.hit`) and, since
          // 2026-09-02, the rig's own authored `hurt` flinch. All one call, the same way
          // `bullet_fired` above makes one `onAttack` call: it is one signal, and splitting it
          // into two host methods would let a future reaction reach only half the target.
          // Independent of the position-anchored burst above, which reads as "impact happened
          // here" rather than "this one took it". Handed the impact point as a delta from the
          // target's own centre, so the shell dents where the hit landed rather than in a fixed
          // direction; the event already carries that position, so nothing new had to reach the
          // client for either half.
          {
            const target = this.host.actorAt(e.target);
            target?.onHurt(fpToPx(e.gx) - target.x, fpToPx(e.gy) - target.y);
          }
          if (e.faction === 'enemy') {
            // The (any) player took the hit — a small punch of feedback.
            this.fx.addShake(0.18);
            this.fx.pulseChromatic(0.006);
          }
          cue('impact');
          // ...and, since 2026-09-02, the audio half of the shake above. Gated on the LOCAL
          // seat rather than on `faction === 'enemy'` like the shake is, because the two
          // answer different questions: the shake fires when a player took it (a PvP rival's
          // hit is `faction: 'player'` and shakes nobody's screen today), while this one has
          // to fire whenever THIS player took it, from any source that reaches this event —
          // an enemy, a PvP rival, or a hazard tile (`faction: 'environment'`). The shrinking
          // zone's own ticks are NOT one of them: those arrive as `zone_damage`, which this
          // reactor has never handled, and wiring that up is its own decision, not a
          // side-effect of this one. `hurt`'s file is light glass to `shield.break`'s heavy
          // glass, an octave above `impact`'s thud, so the pair layers into "a hit landed,
          // and it was on you".
          if (isLocalSeat(e.target)) cue('hurt');
          break;
        case 'shield_break':
          // A shattered shield — a bright cyan burst (design/07 two-pool break).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.shield, 28);
          // ...plus the shell's own fragments (2026-08-26). The event's position IS the target
          // actor's centre (`combat.ts` pushes `target.gx/gy`), which is what the ring has to be
          // thrown from — unlike `hit`, whose position is the impact point. The shell's surface
          // animates itself over the same 200 ms in `EnergyShieldFilter.shatter`, driven off the
          // pool reaching 0 rather than off this event, so the two need no handshake.
          this.fx.particles.shieldShards(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.shield);
          this.fx.addShake(0.4);
          this.fx.addHitStop(50);
          this.fx.pulseChromatic(0.014);
          cue('shield.break');
          break;
        case 'deflect':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.deflect, 20);
          this.fx.addShake(0.22);
          this.fx.pulseChromatic(0.008);
          cue('deflect');
          break;
        case 'status': {
          // Elemental fx — a coloured flash by effect (design/03/07).
          const c =
            e.effect === 'burn' ? THEME.colors.statusBurn
            : e.effect === 'chill' ? THEME.colors.statusChill
            : e.effect === 'shock' ? THEME.colors.statusShock
            : THEME.colors.statusPoison;
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 12);
          cue(`status.${e.effect}` as AudioCue);
          break;
        }
        case 'clash':
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.clash, 14);
          cue('clash');
          break;
        case 'enrage':
          // A boss crossed its enrage threshold (design/09 traits) — a hard red pulse,
          // distinct from a normal hit flash, so it reads as a real escalation moment.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.enemy, 40);
          this.fx.addShake(0.35);
          this.fx.pulseChromatic(0.012);
          cue('shield.break'); // reuse the existing sting; no dedicated cue authored yet
          break;
        case 'death':
          if (e.faction === 'enemy') {
            this.host.addScore(SCORE.kill);
            // Centred on the corpse's BODY, not on its ground anchor: `e.gx/gy` is where the
            // shadow and the collision footprint sit (`Actor`'s container origin), and a ring
            // sized off the body but centred at the feet hangs below it. The lift was a flat
            // 12 px until 2026-09-03 — 0.8 body radii for the 15 px mob it was eyeballed on,
            // and the same 12 px on a 30 px boss, where it is 0.4 — so it is now that same
            // fraction of whatever died. Deliberately an approximation and not `Actor`'s own
            // `bodyCenterY`: that one is per-SKIN (a rig stands its art off the ground point
            // in its body bone, a placeholder gets `BODY_LIFT_R`), and reading it would mean
            // resolving a view this reactor cannot see anyway — the dying actor has already
            // left `Scene.views` by the time this event is consumed.
            const bodyR = fpToPx(e.r);
            this.fx.particles.explosionDebris(
              fpToPx(e.gx), fpToPx(e.gy) - bodyR * DEATH_BURST_LIFT_R, THEME.colors.enemy, bodyR,
            );
            this.fx.addShake(0.15);
            cue('death.enemy');
          } else if (isLocalSeat(e.id)) {
            // The local seat bled out (ReviveSystem) — the run is over, and until 2026-09-02
            // this branch did not exist at all: the cue was named `death` but only ever played
            // for `faction === 'enemy'`, so the one moment that ends a run was the only
            // lifecycle event in the game with no sound. It is deliberately NOT the same cue
            // the `downed` case below plays: going down is recoverable in co-op and this is
            // not, so hearing the run-ending fall on a revive would be a lie.
            cue('death.player');
          }
          break;
        case 'pickup':
          switch (e.kind) {
            case 'heal':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupHeal, 20);
              cue('pickup.heal');
              this.hud.toast(t('toast.heal'), THEME.colors.pickupHeal);
              break;
            case 'weapon': {
              // Flash in the dropped weapon's rarity colour (design/14) — the tier
              // reads at a glance. Falls back to the generic amber if unresolved.
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              const c = spec ? rarityColor(spec) : THEME.colors.pickupWeapon;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
              cue('pickup.weapon');
              this.hud.toast(spec ? tName(spec.nameKey) : t('toast.newWeapon'), c);
              // A catalogued weapon found grants its blueprint too — permanent, or a
              // stacked schematic for the earnable pool (`Game.onWeaponPickup`, ENGINE_VERSION 68).
              if (e.weaponId && BLUEPRINT_CATALOG[e.weaponId]) this.host.onWeaponPickup(e.weaponId);
              break;
            }
            case 'buff':
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupBuff, 22);
              cue('pickup.buff');
              {
                const buff = e.buffId ? RUN_BUFFS[e.buffId] : undefined;
                // Falls back to the raw id only if `buffId` names something outside the
                // catalogue (shouldn't happen for a real drop) — same defensive shape as
                // the material/weapon lookups below.
                const label = buff ? tName(buff.nameKey) : e.buffId;
                this.hud.toast(label ? t('toast.buffNamed', { id: label }) : t('toast.buffGeneric'), THEME.colors.pickupBuff);
              }
              break;
            case 'schematic': { // a boss's one-time drop (ENGINE_VERSION 68) — cosmetic only
              const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupSchematic, 26);
              cue('pickup.buff'); // reuses buff's cue — no recorded asset for a new one
              this.hud.toast(t('toast.schematicFound', { weapon: spec ? tName(spec.nameKey) : (e.weaponId ?? '') }), THEME.colors.pickupSchematic);
              break;
            }
            default: { // material
              this.host.addScore(SCORE.material);
              this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupMaterial, 16);
              cue('pickup.material');
              const mat = e.materialId ? MATERIAL_DEFS[e.materialId] : undefined;
              // Translated fallback only triggers when `materialId` itself is absent —
              // an id present but uncatalogued falls back to the raw id, same shape as
              // the buff toast above.
              const materialName = mat ? tName(mat.nameKey) : e.materialId ?? t('toast.materialFallback');
              this.hud.toast(t('toast.materialQty', { qty: e.qty ?? 1, material: materialName }), THEME.colors.pickupMaterial);
            }
          }
          break;
        case 'wave_clear':
          this.host.addScore(SCORE.waveClear);
          cue('wave-clear');
          break;
        case 'chest_open':
          // The one feedback a chest had was visual and easy to miss: the box changes shape and
          // the weapons appear a tick later (design/05 — the payout lands on the NEXT tick, so
          // its own `pickup.weapon` cue cannot double as this one). Sound only, deliberately:
          // no toast, because the weapon panel that opens over the payout already says what
          // came out, and no flash, because `ChestLayer` redraws the body on the same frame.
          cue('chest.open');
          break;
        case 'room_enter': {
          // A new dungeon room went live (ROADMAP 1.3) — mirror its geometry: ground,
          // AABB walls, pillars, and the resized world bounds (design/08 render-only).
          const s = this.host.activeState();
          if (s) this.host.onRoomEnter(s);
          break;
        }
        case 'door_locked':
        case 'door_unlocked': {
          // A room's doors flipped lock state as a unit (design/05, DoorSystem) — the
          // engine already rewrote state.walls; just restyle the door fixture(s), no
          // full room rebuild.
          const s = this.host.activeState();
          if (s) this.host.onDoorStateChange(s);
          break;
        }
        case 'force_regroup': {
          // Every OTHER online, non-downed player was just teleported onto the
          // fighting room's entrance (design/05, DoorSystem) — react only if the
          // LOCAL player was one of them (playerIds are entity ids, not seats/owners,
          // same lookup the 'hit' case above uses for `actorAt`).
          const s = this.host.activeState();
          const p = s?.players[this.host.localOwner];
          if (p && e.playerIds.includes(p.id)) {
            this.host.onForceRegroup();
            this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), THEME.colors.extractGlow, 24);
          }
          break;
        }
        case 'descend': {
          // Banked the floor's materials and dropped deeper — a green pulse at the player.
          const p = this.host.activeState()?.players[this.host.localOwner];
          if (p) this.fx.flash(fpToPx(p.gx), fpToPx(p.gy), THEME.colors.extractGlow, 30);
          this.host.addScore(SCORE.waveClear);
          cue('wave-clear');
          break;
        }
        case 'downed':
          // A player was incapacitated (co-op downed/revive, ROADMAP 3.2) — a red pulse.
          // In the single-player demo this is the moment the run is lost.
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.clash, 28);
          this.fx.addShake(0.55);
          this.fx.addHitStop(80);
          this.fx.pulseChromatic(0.02);
          // Used to play the bare `death` cue — an enemy explosion crunch, for the local
          // player collapsing, which the 2026-09-02 split made impossible to keep writing
          // down. `hurt` instead: going down IS damage, it is already the highest-priority
          // combat cue, and it coalesces with the `hit` that caused it in this same frame
          // into ONE voice at higher gain, which is exactly what the moment should sound
          // like. Gated on the local seat for the same reason `hurt` itself is — the fx
          // above stays ungated, because a teammate going down is worth SEEING.
          if (isLocalSeat(e.id)) cue('hurt');
          break;
        case 'revived':
          // A teammate channelled the player back up — a green pulse (co-op only).
          this.fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.extractGlow, 28);
          cue('pickup.heal');
          break;
        case 'win': {
          // "Somebody won" is not "we won". The event announces the winner of the whole
          // match (`Winner` = a seat, `'enemies'`, or null), and in PvP / `?arenaDemo=1` that
          // is usually not this seat — so playing the jingle on any `win` meant a player who
          // had just bled out heard the victory sting over their own defeat screen. Observed
          // live 2026-09-02: `death.player:1` then `win:1` in ONE frame, `g.phase` already
          // `'defeat'`.
          //
          // The answer comes from `localSeatWon`, split out of `RunOutcome` (which computes
          // the same thing for the result screen) rather than re-derived here, so the sound
          // and the screen cannot disagree — including on the squad case, where comparing
          // seat identity instead of team membership once made most of a winning squad see
          // DEFEAT (fixed 2026-08-04).
          //
          // A defeat plays `death.player` rather than a cue of its own, because design/11
          // authored that file AS the counterpart of `win`: same instrument, a descending
          // scale against the jingle's own figure, ranked directly under it and stealable by
          // nothing else. Where the local seat's own `death` event lands in this same frame
          // the two coalesce into ONE voice at higher gain — the same call `downed` already
          // makes with the `hit` that caused it: your death and your defeat are one moment,
          // not two sounds. And where the run ends with the seat merely `downed` (a
          // single-player wipe, whose only cue is `hurt`), this is the first thing that says
          // the fall was final — which is exactly why `downed` itself must not play it: until
          // this event arrives, a co-op revive is still possible.
          //
          // With no active state — a menu frame draining a stale queue — NEITHER plays: the
          // same "no local seat, no answer" silence the `hurt` gate above takes, rather than
          // guessing a run we cannot see the outcome of.
          const s = this.host.activeState();
          if (s) cue(localSeatWon(s, this.host.localOwner, e.winner) ? 'win' : 'death.player');
          break;
        }
        // 'win' score bonus is handled by the outcome check (win()).
      }
    }
    for (const [id, count] of cues) this.audio.play(id, count);
  }

  /**
   * The weapon an actor just attacked with, plus its own body radius — the melee arc's inner
   * edge. Both attack branches above go through this: the shape they hand the rig is what sizes
   * and paces the motion, and neither event carries it (design/08 keeps events to what the sim
   * announces, and every client already holds the whole `GameState` — the netcode broadcasts
   * inputs, not entities). Resolved from there rather than added to the event, so no
   * engine/protocol shape change was needed for either kind.
   *
   * PLAYERS AND ENEMIES, unlike the players-only lookup this replaced. That one was written for
   * the melee branch, where it was sufficient — `HitResolveSystem.meleeArc` is called over
   * `state.players` and every enemy in the roster is built on the generic ranged AI
   * (`content/enemies.ts`: "no ranged/melee AI split exists yet"), so no enemy can swing. The
   * RANGED branch is the other way round: enemies are most of what fires, and a players-only
   * lookup would have given every mob in the game the fallback blaster kick. A miss is still not
   * an error — an actor already gone from the state on the frame its own event is drained — and
   * every caller treats it as "no spec, keep that kind's starter weapon".
   */
  private attacker(ownerId: number): { spec: WeaponSimSpec; radiusPx: number } | undefined {
    const s = this.host.activeState();
    const a = byId(s?.players, ownerId) ?? byId(s?.enemies, ownerId);
    const spec = a?.weapon?.spec;
    return a && spec ? { spec, radiusPx: fpToPx(a.radius) } : undefined;
  }

  /**
   * The swing's sector, swept once (`fx/slashArc.ts`). Anchored on the SIM's own swing origin
   * (the event's `gx/gy`, which is exactly what `meleeArc` measures `range` from) rather than on
   * the drawn body the way `muzzleFlare` is: this fx exists to state where the weapon reaches,
   * so it has to agree with the hit test, and the body is mid-lunge for the whole of the sweep.
   */
  private slashSector(
    spec: MeleeSimSpec,
    radiusPx: number,
    facingRad: number,
    x: number,
    y: number,
  ): void {
    const schedule = swingSchedule(swingShapeOf(spec));
    this.fx.slashArc({
      x,
      // Lifted off the ground point by the same 12 px `flash()` uses, so the arc reads as a
      // sweep at blade height rather than as a decal around the character's feet.
      y: y - 12,
      facingRad,
      arcHalfRad: bradToRad(spec.arcHalf),
      innerPx: radiusPx,
      outerPx: fpToPx(spec.range),
      // The element's own hue, with `swordGlow` for physical — `ELEMENT_COLORS` deliberately
      // omits that entry (a physical bullet takes the FACTION colour, see theme.ts), and the
      // faction colour is wrong here: the sector is the blade's light, not a team marker.
      color: ELEMENT_COLORS[spec.damageType] ?? THEME.colors.swordGlow,
      flipX: facingFromAngle(facingRad).flipX,
      delayMs: schedule.strikeStartMs,
      sweepMs: schedule.strikeEndMs - schedule.strikeStartMs,
      // The arc outlives the strike by the length of the strike itself: the blade has moved on
      // and what is left is the light going out, which is what makes a sector legible at all
      // (the sweep window alone is ~65 ms on the starter saber — three frames).
      fadeMs: (schedule.strikeEndMs - schedule.strikeStartMs) * 2,
    });
  }
}
