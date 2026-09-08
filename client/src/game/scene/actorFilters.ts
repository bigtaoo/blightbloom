// Split out of Actor.ts (2026-08-25, 500-line convention). The four conditionally-active
// PER-ACTOR skin shaders and the composition rule that turns them into one `filters` list:
// shield shell, hit-flash outline, death dissolve, burn heat-haze.
//
// This is the extraction `client/scripts/file-length-baseline.json`'s own note on Actor.ts
// nominated — *"the filter cluster (`applySkinFilters`/`setShieldActive`/`hitFlash`/
// `startDissolve`/`isDissolved`, all touching the same four lazily-built filter fields) is the
// natural form-(2) composition candidate if this gets revisited"* — taken when the element-badge
// pass pushed the file past its recorded baseline. It is form (2) from CLAUDE.md, not form (3):
// the cross-boundary call list is exactly ONE method (`setSkinFilters`), which is why the host
// dependency is declared as a one-method interface rather than as the whole `Actor`.
//
// Everything here is presentation state with no engine meaning: `Actor` mirrors sim values into
// it (`setShield`, `setBurning`) and drives its clocks from the render frame (`tick`). Nothing in
// this file reads or writes `GameState` (design/08 "render only reads").
import type { Filter } from 'pixi.js';
import { EnergyShieldFilter, OutlineFilter, DissolveFilter, HeatHazeFilter } from '../fx/filters';
import { THEME } from '../theme';
import { activeQuality } from '../../render/quality';

/** Outline "you were just hit" flash duration. Exported so `Actor.test.ts` can drive the
 *  decay from the real number instead of a magic half-of-it — a retune is a look change,
 *  not a contract change, and a test named after this constant should read it. */
export const HIT_FLASH_MS = 160;
/** Death-dissolve shader duration. */
export const DISSOLVE_MS = 700;
/**
 * Shield-shell exit duration (2026-08-26). The shell no longer disappears between two frames
 * when the pool empties: `EnergyShieldFilter.shatter` runs 0→1 over this and the filter stays
 * ATTACHED for the whole of it — the same "keep the view alive past the state change" shape
 * `startDissolve` and `Scene`'s dying-view list already use, rather than a second mechanism.
 *
 * Short on purpose. It has to finish inside the window `EventReactor`'s own break reaction
 * occupies (a 50 ms hit-stop, a decaying shake, a 28 px burst and the shard particles), or the
 * shell is still visibly leaving after the moment it belongs to is over.
 */
export const SHATTER_MS = 200;

/**
 * What this needs from the object it decorates. One method, so it is declared as one method —
 * CLAUDE.md's "narrow that dependency to a small interface declaring just those methods rather
 * than depending on the whole concrete class". There is deliberately no call in the other
 * direction: `Actor` asks this for state (`isDissolved`), this never reaches back into `Actor`.
 */
export interface ActorFilterHost {
  /** Apply the composed filter list to the body's display object, or clear it when empty. */
  setSkinFilters(filters: Filter[] | null): void;
  /**
   * Body opacity, 0..1. Exists for the low quality tier (2026-08-25), which draws no per-actor
   * shaders and therefore has no `DissolveFilter` to play a death out with — without this the
   * corpse would stand there at full opacity for the whole `DISSOLVE_MS` and then vanish in one
   * frame, which reads as a dropped frame rather than as a cheaper effect. A plain alpha ramp is
   * not the dissolve, but it is the same 700ms and it costs nothing.
   *
   * This is the second method on what the file header calls a one-method interface. It is still
   * the narrow-dependency form from CLAUDE.md: two named things this object needs done to a view
   * it deliberately cannot reach, not a handle on `Actor`.
   */
  setSkinAlpha(alpha: number): void;
}

export class ActorFilters {
  // All four are lazily built: most actors never carry a shield pool, never get hit while on
  // screen, never burn, and are destroyed rather than dissolved. A freshly spawned actor
  // therefore has no filter at all and costs no render-target pass — which is the property the
  // 2026-08-24 lighting pass existed to establish (every actor used to carry an always-on
  // `NormalLitFilter`, measured as the dominant cost of the frame; see `src/perf/README.md`).
  private shieldFilter: EnergyShieldFilter | null = null;
  // Two independent facts about the shell, deliberately not one tri-state: `shieldActive` is
  // "the POOL is up", `shatterMs >= 0` is "the exit is playing". The filter is on screen while
  // either holds (`shellVisible`), which is what lets `setShield` clear `shieldActive` the
  // instant the pool empties — the way it always did — while the view outlives it.
  private shieldActive = false;
  private shieldRatio = -1; // last-applied shield fraction (skip redundant work if unchanged)
  private shatterMs = -1; // -1 = not shattering; counts up from 0 once the pool empties
  private outlineFilter: OutlineFilter | null = null;
  private outlineMs = 0; // remaining ms of the current hit flash, 0 = inactive
  private dissolveFilter: DissolveFilter | null = null;
  private dissolveMs = -1; // -1 = not dissolving; counts up from 0 once startDissolve fires
  private heatHazeFilter: HeatHazeFilter | null = null;
  private heatHazeActive = false;

  constructor(private readonly host: ActorFilterHost) {}

  /**
   * Mirror the engine actor's two-pool shield (design/02/05/07) as a translucent shell
   * (design/01 fidelity roadmap milestone 5, `EnergyShieldFilter`). `maxShield <= 0` is the
   * common case (most enemies, the 0-shield starter) and stays a cheap no-op — the filter is
   * only ever built for an actor that actually carries a shield pool. Ratio 0 (broken, but still
   * has a maxShield) starts the shell's ~200 ms EXIT (`startShatter`) rather than removing it —
   * until 2026-08-26 it detached here and the shell vanished between two frames.
   */
  setShield(shield: number, maxShield: number): void {
    if (maxShield <= 0) {
      this.shieldRatio = -1;
      this.endShatter();
      this.setShieldActive(false);
      return;
    }
    const ratio = Math.max(0, Math.min(1, shield / maxShield));
    if (ratio === this.shieldRatio) return;
    this.shieldRatio = ratio;
    if (ratio <= 0) {
      // Order matters: `startShatter` decides whether there was a shell to see off by reading
      // `shieldActive`, so it has to run before that is cleared.
      this.startShatter();
      this.setShieldActive(false);
      return;
    }
    // Regen landing mid-exit puts the shell straight back up. Cancelled rather than allowed to
    // finish underneath the restored shell: the two are the same filter, so a running exit would
    // otherwise keep expanding and thinning a shield that is live again.
    this.endShatter();
    if (!this.shieldFilter) this.shieldFilter = new EnergyShieldFilter(THEME.colors.shield);
    this.shieldFilter.intensity = ratio;
    this.setShieldActive(true);
  }

  /**
   * Begin the shell's exit. The one guard is `shieldActive` — a shell that is not currently on
   * screen has nothing to see off — and it covers BOTH cases that look like a break from the
   * outside but are not one:
   *
   * - **No shell was ever up.** An actor that arrives with an already-empty pool (a mid-match
   *   join, a skin whose shield has not regenerated yet) reaches ratio 0 from the initial
   *   `shieldRatio = -1` without ever having been shielded, and one whose whole pool was taken
   *   away (`maxShield <= 0`) has already been detached. Starting an exit there would put a
   *   bursting bubble, and a render-target pass, around a character that never had one.
   * - **The exit is already running.** `setShield` clears `shieldActive` the moment it starts
   *   one, so a second `shield_break` inside the 200 ms — a DoT tick on the same frame, the same
   *   event delivered twice — finds this false and cannot snap the shell back to full size.
   *
   * `shatter` is deliberately NOT zeroed here: the only two ways out of an exit
   * (`advanceShatter`'s completion and `endShatter`'s cancel) both reset it, so a third reset
   * would be a line no test could reach.
   */
  private startShatter(): void {
    if (!this.shieldActive || !this.shieldFilter) return;
    this.shatterMs = 0;
    // Flared to full, not left at whatever sliver of pool it died with: a shield that broke from
    // 12% would otherwise play its whole exit at 12% brightness. See the shader's `energy`.
    this.shieldFilter.intensity = 1;
  }

  /** Abandon a running exit and put the shell back in its intact state. */
  private endShatter(): void {
    if (this.shatterMs < 0) return;
    this.shatterMs = -1;
    if (this.shieldFilter) this.shieldFilter.shatter = 0;
    this.apply(); // the exit was what held the filter on screen — recompose without it
  }

  /**
   * Heat-haze distortion while burning (design/01 milestone 5, `HeatHazeFilter`) — the
   * silhouette itself shimmers, on top of whatever ring the status aura draws.
   *
   * Edge-detected in here rather than by the caller: a chill or poison toggle arriving alongside
   * an ongoing burn must not rebuild this filter, and putting that condition next to the state
   * it guards is what keeps the two from drifting apart.
   */
  setBurning(burning: boolean): void {
    if (burning === this.heatHazeActive) return;
    if (burning && !this.heatHazeFilter) this.heatHazeFilter = new HeatHazeFilter();
    this.heatHazeActive = burning;
    this.apply();
  }

  /**
   * Brief "you were just hit" silhouette flash (design/01 milestone 5, `OutlineFilter`) — real
   * alpha-edge detection, unlike the shield's UV-distance approximation, so it reads correctly
   * against any body shape. Fired from EventReactor's 'hit' case for BOTH factions (whichever
   * actor the event names as `target`), independent of the position-anchored `fx.flash()` burst
   * — that one reads as "impact happened here", this one as "THIS actor took it".
   *
   * `dx`/`dy` are the screen-space delta from the actor's centre to where the hit landed (y
   * down), and drive the shield shell's elastic dent.
   */
  hitFlash(dx = 0, dy = 0): void {
    if (!this.outlineFilter) this.outlineFilter = new OutlineFilter(0xffffff);
    this.outlineFilter.alpha = 1;
    this.outlineMs = HIT_FLASH_MS;
    // The shell dents where the hit landed (2026-08-26, `EnergyShieldFilter.hit`). Only
    // meaningful while a shield is actually up: an unshielded actor has no filter to dent, and
    // building one here just to animate it would put a shell around an actor with no pool.
    // `dx`/`dy` default to 0, which `hit()` reads as "keep the previous axis" — a caller that
    // has no impact position still gets a dent, just not a directed one.
    // A shell already playing its exit does NOT dent: it is coming apart, and an elastic
    // rebound would read as it healing. That falls out of `shieldActive` — which means "the pool
    // is up", and the pool is what just ran out — rather than needing its own condition.
    if (this.shieldActive && this.shieldFilter) this.shieldFilter.hit(dx, dy);
    this.apply();
  }

  /**
   * Kick off the death-dissolve shader (design/01 milestone 5, `DissolveFilter`) — called once by
   * `Actor.onDeath` when this actor's id drops out of the engine's alive list, instead of
   * destroying the view that same tick. Hiding the actor's other furniture (weapon, aura, health
   * bar) stays with `Actor`: those are its children, not this object's business.
   */
  startDissolve(): void {
    if (this.dissolveMs >= 0) return; // already dissolving — defensive, shouldn't double-fire
    this.dissolveFilter = new DissolveFilter();
    this.dissolveMs = 0;
    this.apply();
  }

  /** True once the death-dissolve has fully played out — `Scene` destroys the view then. */
  get isDissolved(): boolean {
    return this.dissolveMs >= DISSOLVE_MS;
  }

  /** Advance every active shader's own clock. Call once per render frame (dt in ms). */
  tick(frameDt: number): void {
    if (this.shellVisible && this.shieldFilter) this.shieldFilter.tick(frameDt);
    if (this.shatterMs >= 0) this.advanceShatter(frameDt);
    if (this.heatHazeActive && this.heatHazeFilter) this.heatHazeFilter.tick(frameDt);
    if (this.outlineMs > 0) {
      this.outlineMs = Math.max(0, this.outlineMs - frameDt);
      this.outlineFilter!.alpha = this.outlineMs / HIT_FLASH_MS;
      if (this.outlineMs === 0) this.apply(); // expired — drop it back off the list
    }
    if (this.dissolveMs >= 0 && this.dissolveMs < DISSOLVE_MS) {
      this.dissolveMs = Math.min(DISSOLVE_MS, this.dissolveMs + frameDt);
      if (this.dissolveFilter) this.dissolveFilter.progress = this.dissolveMs / DISSOLVE_MS;
      // The shader-free equivalent for every tier that does not run `actorShaders`, driven from
      // the same clock so all of them agree on WHEN the actor is gone even though they disagree
      // on how it looks going.
      if (!activeQuality().actorShaders) this.host.setSkinAlpha(this.lowTierAlpha());
    }
  }

  /**
   * Advance the shell's exit and, at the end of it, finally let go of the filter. The clock runs
   * on the low quality tier too even though `buildFilterList` draws nothing there: it is what
   * decides WHEN the shell is gone, and that has to agree across tiers the same way
   * `lowTierAlpha` makes the dissolve agree.
   */
  private advanceShatter(frameDt: number): void {
    this.shatterMs += frameDt;
    if (this.shatterMs >= SHATTER_MS) {
      this.shatterMs = -1;
      if (this.shieldFilter) {
        // Reset rather than left at 1, because this instance is REUSED — a regenerated shield
        // re-attaches the same filter (`setShield`), and one still holding a finished exit would
        // come back as an expanded, thinned, invisible shell.
        this.shieldFilter.shatter = 0;
        this.shieldFilter.intensity = 0;
      }
      this.apply(); // and NOW the filter comes off the list
      return;
    }
    // Written only on a frame that did not finish the exit, which is why no clamp is needed
    // here: `shatterMs` is strictly less than `SHATTER_MS` on every path that reaches this line,
    // however long the frame was. A clamp would be a line nothing could reach.
    if (this.shieldFilter) this.shieldFilter.shatter = this.shatterMs / SHATTER_MS;
  }

  /** The shell is on screen while its pool is up OR while it is playing its exit. The whole
   *  point of the 2026-08-26 exit is that those two stopped being the same statement. */
  private get shellVisible(): boolean {
    return this.shieldActive || this.shatterMs >= 0;
  }

  private setShieldActive(active: boolean): void {
    if (active === this.shieldActive) return;
    this.shieldActive = active;
    this.apply();
  }

  /**
   * Recompose the filter list from whichever of the four are currently live — most of the time
   * that is none, and the actor draws unfiltered, batched with its neighbours.
   *
   * Order is warp-then-glow-then-highlight-then-dissolve: the UV wobble should distort what the
   * shell/outline draw (not the other way around), a hit flash should still read on top of an
   * active shield, and a dying actor's dissolve should be the last word regardless of what else
   * was active the instant it died. Lighting is deliberately NOT in this list (2026-08-24): it is
   * one pass over the whole scene layer, running AFTER these composite rather than underneath
   * them — see `fx/filters/litFx.ts`.
   */
  private apply(): void {
    // Low tier draws the actor unfiltered (`render/quality.ts`, 2026-08-25). Each of the four
    // below is a render-target pass for ONE actor, so a room where eight enemies are burning
    // costs eight of them — the per-actor cost profile the 2026-08-24 lighting pass was built
    // to get rid of, still reachable through the status shaders.
    //
    // Gated HERE, at the single composition funnel, rather than at each setter: the setters
    // also maintain the state that says WHICH effects are live, and that state has to stay
    // truthful across a tier flip so `refreshQuality()` can recompose the real list when the
    // player switches back to high mid-run. The filters themselves stay lazily built, so a
    // session that never leaves the low tier never constructs one.
    const shaders = activeQuality().actorShaders;
    const list: Filter[] = shaders ? this.buildFilterList() : [];
    this.host.setSkinFilters(list.length ? list : null);
    // On the high tier the body is always fully opaque and the dissolve shader does the fading.
    // Setting it back to 1 unconditionally here is what makes a mid-dissolve tier flip safe: a
    // half-faded body handed to the shader would dim twice.
    this.host.setSkinAlpha(shaders ? 1 : this.lowTierAlpha());
  }

  /** The low tier's stand-in for whatever a shader would have been doing to the body. Today that
   *  is only the death fade — the other three effects have visible companions that are not
   *  shaders at all (the status aura ring, the hit flash's own positional burst), so dropping
   *  them costs detail rather than information. */
  private lowTierAlpha(): number {
    if (this.dissolveMs < 0) return 1;
    return 1 - Math.min(1, this.dissolveMs / DISSOLVE_MS);
  }

  /** Re-run the composition against the current tier — `Scene` calls this on every live actor
   *  when the quality setting changes, since a filter list is otherwise only recomposed when
   *  the actor's own status changes (an actor standing still and burning would keep whichever
   *  list the previous tier produced). */
  refreshQuality(): void {
    this.apply();
  }

  private buildFilterList(): Filter[] {
    const list: Filter[] = [];
    if (this.heatHazeActive && this.heatHazeFilter) list.push(this.heatHazeFilter);
    if (this.shellVisible && this.shieldFilter) list.push(this.shieldFilter);
    if (this.outlineMs > 0 && this.outlineFilter) list.push(this.outlineFilter);
    if (this.dissolveMs >= 0 && this.dissolveFilter) list.push(this.dissolveFilter);
    return list;
  }
}
