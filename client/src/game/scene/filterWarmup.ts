// Compiles the actor filters' shader programs while the world is covered, instead of the first time
// each is needed in play (2026-09-28). Its own module (CLAUDE.md form 2): one small class, used by
// `RoomBuilder`, which owns every covered moment a build happens under.
//
// Pixi links a filter's WebGL program on the first frame something draws through it, and the link
// is synchronous: measured on a 1080p desktop, `DissolveFilter` first linked on the run's first
// enemy death and `OutlineFilter` ~0.75 s after the loading screen came down — the death frame spent
// 13 ms of its 36 ms waiting on `GetProgramiv`. Every filter here builds its program through
// `GlProgram.from`, which caches by source, so drawing ONE instance of each through the pipeline
// once links the program every later instance will use.
//
// Only the actor filters: the full-screen passes (scene light, vignette, chromatic aberration) are
// mounted from the first frame of a run and are therefore already linked behind the loading screen.
import { Container, DOMAdapter, Sprite, Texture, type Filter } from 'pixi.js';
import { DissolveFilter, HeatHazeFilter, OutlineFilter } from '../fx/filters/skinFx';
import { EnergyShieldFilter } from '../fx/filters/shieldFx';

/** Frames the probes stay mounted. Two, not one: a filter mounted in the frame's own update pass
 *  is drawn by that frame's render, but a second frame costs nothing and survives an ordering
 *  where the probe is added after the render has already started. */
export const WARM_FRAMES = 2;

/** Side of each probe sprite, px. Big enough that no filter bounds calculation rounds it to
 *  nothing; small enough to be free. */
const PROBE_PX = 4;

export class FilterWarmup {
  private probes: Container | null = null;
  private framesLeft = 0;
  private done = false;

  /** `parent` is the screen-space UI layer: the probes go UNDER everything in it, so whatever is
   *  covering the world covers them too, and they sit at the screen's own origin — inside the
   *  viewport, which matters, because Pixi intersects a filter's bounds with the viewport and skips
   *  one that falls outside it entirely (probes at the WORLD origin were measured linking nothing:
   *  the camera was elsewhere). `make` builds one instance of each filter to warm — injectable so a
   *  test can count what gets mounted. */
  constructor(
    private readonly parent: Container,
    private readonly make: () => Filter[] = defaultWarmFilters,
  ) {}

  /** Mount the probes, once per session: a program, once linked, stays linked. Call it at a moment
   *  the world is covered — a run's first build, or a descend's. */
  arm(): void {
    if (this.done || this.probes) return;
    const filters = this.make();
    if (filters.length === 0) {
      this.done = true;
      return;
    }
    const probes = new Container();
    probes.label = 'filter-warmup';
    for (const [i, filter] of filters.entries()) {
      const s = new Sprite(Texture.WHITE);
      s.width = PROBE_PX;
      s.height = PROBE_PX;
      s.position.set(i * PROBE_PX * 2, 0);
      s.filters = [filter];
      probes.addChild(s);
    }
    this.parent.addChildAt(probes, 0);
    this.probes = probes;
    this.framesLeft = WARM_FRAMES;
  }

  /** One render frame: remove the probes once they have been drawn `WARM_FRAMES` times. */
  tick(): void {
    if (!this.probes || --this.framesLeft > 0) return;
    this.teardown();
    this.done = true;
  }

  /** Drop the probes without counting the warm-up as done (a restart mid-warm). */
  cancel(): void {
    this.teardown();
  }

  private teardown(): void {
    const probes = this.probes;
    this.probes = null;
    // A run's reset sweeps `layers.fx` wholesale (`RunLifecycle.resetRenderState`) before it asks
    // the room builder to clear, so the probes may already be gone by the time this runs.
    if (!probes || probes.destroyed) return;
    for (const s of probes.children) for (const f of (s as Sprite).filters ?? []) f.destroy();
    probes.destroy({ children: true });
  }
}

/** One of each actor filter, at settings that make it actually DRAW (a filter at zero strength may
 *  still be applied, but there is no reason to find out). None at all where Pixi cannot make a
 *  canvas: `GlProgram` needs a GL context to size its precision, so an environment without one (the
 *  unit suite) has no program to link and could not construct these filters anyway. Probed through
 *  the same `DOMAdapter` Pixi uses, so the WeChat build's own adapter answers for itself. */
function defaultWarmFilters(): Filter[] {
  try {
    DOMAdapter.get().createCanvas(1, 1);
  } catch {
    return [];
  }
  return [new OutlineFilter(0xffffff, 1.5, 1), new DissolveFilter(0xffb347, 0.5), new HeatHazeFilter(1), new EnergyShieldFilter(0x66e0ff, 1)];
}
