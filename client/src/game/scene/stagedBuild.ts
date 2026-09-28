// A build spread over render frames: an ordered queue of steps, run a few milliseconds' worth per
// frame. Split out as its own module (CLAUDE.md form 1) because it knows nothing about rooms —
// `RoomBuilder` hands it the steps of a floor build, and this only decides how many run now.
//
// Why a floor build is spread at all (2026-09-28). Descending builds the whole new floor in the frame
// the new floor's `room_enter` lands: measured on a 1080p desktop, 24 ms of `RoomBuilder.build` plus
// 20 ms of render (12 ms of it triangulating the freshly drawn Graphics) — a 48 ms frame, three
// vsyncs, every descend. Run as steps, each frame pays for its own slice AND the triangulation of
// what that slice added, since new geometry is triangulated on the render that first draws it.

/** One unit of a staged build. May return further steps, which run next, before the rest of the
 *  queue — so a step that has to compute something first can expand into the work that needs it. */
export type BuildStep = (() => BuildStep[] | void) & { solo?: true };

/**
 * Mark a step as one that gets a frame to itself: it runs only as the first step of a frame, and
 * nothing runs after it that frame. For the steps measured at 2-5 ms of their own, because what a
 * step costs is only half of what it adds to its frame — the other half is triangulating what it
 * drew, on the render that first draws it, which the budget cannot see. Returns the same function.
 */
export function solo(step: () => BuildStep[] | void): BuildStep {
  return Object.assign(step, { solo: true as const });
}

export class StagedBuild {
  private queue: BuildStep[] = [];

  /** Whether any step is still waiting. */
  get busy(): boolean {
    return this.queue.length > 0;
  }

  /** Replace whatever was queued with `steps`. Nothing runs until `runFor` / `runAll`. */
  start(steps: readonly BuildStep[]): void {
    this.queue = [...steps];
  }

  /** Drop every queued step (a restart, or a synchronous build superseding this one). */
  cancel(): void {
    this.queue.length = 0;
  }

  /**
   * Run steps until the queue is empty or `budgetMs` has been spent. Always runs at least one, so a
   * step longer than the budget still makes progress rather than stalling the build; a `solo` step
   * ends the frame, and one that is not first waits for the next. Returns whether steps remain.
   */
  runFor(budgetMs: number, now: () => number = () => performance.now()): boolean {
    const start = now();
    for (let ran = 0; this.queue.length > 0; ran++) {
      const next = this.queue[0]!;
      if (ran > 0 && (next.solo || now() - start >= budgetMs)) break;
      this.runOne();
      if (next.solo) break;
    }
    return this.busy;
  }

  /** Run every step now, in order. */
  runAll(): void {
    while (this.queue.length > 0) this.runOne();
  }

  private runOne(): void {
    const step = this.queue.shift();
    const more = step?.();
    if (more && more.length > 0) this.queue.unshift(...more);
  }
}
