// The run-boundary transition gate — the one place a screen switch becomes a visible wait.
//
// Was `ArtGate.ts` until 2026-09-22 (design/12, "the gate, and why it is invisible almost
// always"), and the rename is the change: it now holds a screen for TWO different reasons,
// and only one of them is art.
//
//  1. **The art boundary.** Since 2026-09-01 the main package is code only and the art
//     arrives in two phases: the `lobby` pack is awaited at boot, everything a RUN draws is
//     downloaded in the background from the lobby (`render/preloadArt.ts`'s
//     `beginDeferredArt`). This turns "the run art is not in yet" into a wait instead of a
//     room full of placeholder rectangles. Invisible almost always, by design.
//  2. **The run boundary itself.** Asked for directly: a loading screen on the in-game
//     switches — into a map, back out to the lobby — held for at least `MIN_TRANSITION_MS`,
//     so a transition reads as one thing ending and another beginning rather than as a jump
//     cut. This one is deliberately VISIBLE, and it is why the two waits had to end up in the
//     same class: they land on the same transitions, and two independent holders of the same
//     screen would show it twice in a row.
//
// The floor is emphatically NOT on the boot splash, which is where a first pass put it on
// 2026-09-21: the front door is the one screen nobody has a reason to look at, and
// `bootSplash.ts`'s header records the removal.
//
// Three properties keep the change to each caller down to one line:
//
//  1. **Synchronous when there is nothing to wait for.** `defer()` asks `isRunArtReady()`
//     first and answers `false`, leaving the caller's transition exactly as synchronous as it
//     was before this class existed. `deferRunBoundary()` cannot answer that in a real
//     session — a floor is a wait by definition — which is why it is a separate method rather
//     than an argument to the same one.
//  2. **Inert unless a host armed the art phases.** `isRunArtReady()` answers `true` and
//     `isDeferredArtArmed()` answers `false` until `beginDeferredArt()` has been called,
//     which only the three real entry points do — so every unit test that drives `Game` sees
//     the pre-phases behaviour, and neither wait can silently swallow a transition in a test
//     that never opted into it.
//  3. **Nested gating passes straight through.** While a released transition is running its
//     `retry`, `defer`/`deferRunBoundary` answer `false` rather than opening a second wait.
//     The run entry points nest (`beginQuickRun` → `beginRun` → `beginArenaDemoRun`), and
//     without this the player would pay the floor once per layer.
//
// The gated art-only transitions and the reason for each: `showForge` (weapon art — the forge
// is where a player CHOOSES with it), `showPvpPreview` (character art), `showMatchmaking` (the
// run on the other side of it). The run-boundary ones are the entry points in `RunLifecycle`
// and the one exit. Everything else a player can reach — main menu, mode select, account,
// squad, settings, store — draws from the `lobby` pack alone and is never gated at all.
import type { Container, Ticker } from 'pixi.js';
import { ensureRunArt, isDeferredArtArmed, isRunArtReady, runArtUnitCount } from '../../render/preloadArt';
import { t } from '../../i18n';
import { LoadingScreen } from '../ui/loadingScreen';

/**
 * How long a RUN-BOUNDARY transition screen stays up at the very least.
 *
 * Three seconds, asked for by name. It is a floor and not a duration: a transition that has
 * real work behind it (run art still downloading) takes as long as that work takes, and this
 * only decides how short the fast case is allowed to be.
 */
export const MIN_TRANSITION_MS = 3000;

/** Which side of a run the player is crossing to. It picks the caption, and nothing else. */
export type RunBoundary = 'run' | 'hub';

export interface TransitionGateDeps {
  /** `Layers.overlay` — above every screen, unscaled. See layers.ts for why it is its own
   *  sub-layer rather than a child of `menu`. */
  overlay: Container;
  ticker: Ticker;
  /** The live viewport, read on every tick so a resize mid-wait re-lays-out. */
  screenSize(): { w: number; h: number };
  /** Injected so a test does not sit through a real three seconds. */
  sleep?(ms: number): Promise<void>;
}

export class TransitionGate {
  private screen: LoadingScreen | null = null;
  /** True while a released transition is running its `retry` — see property 3 in the header. */
  private releasing = false;

  constructor(private readonly deps: TransitionGateDeps) {}

  /**
   * Ask permission to make a transition that needs run art, with no floor under it.
   *
   * Returns `true` when the transition was DEFERRED — the caller must return immediately and
   * do nothing else, because `retry` will re-run it once the art has landed. Returns `false`
   * when the art is already in, which is the overwhelmingly common case: the background load
   * starts the moment the lobby paints and has the whole login/menu/mode-select sequence to
   * finish.
   *
   * `retry` is normally the caller re-invoking itself (`() => this.showForge()`), which routes
   * back through this same method and sails past it the second time.
   */
  defer(retry: () => void): boolean {
    return this.open(retry, t('loading.art'), 0);
  }

  /**
   * Ask permission to cross a RUN boundary — into a map, or back out to the hub.
   *
   * Same contract as `defer`, and the same `retry` shape, but it holds the screen for
   * `MIN_TRANSITION_MS` on top of whatever the art costs, so it answers `true` on every call
   * in a real session. In a session that never armed the art phases it answers exactly what
   * `defer` would, which is what keeps the unit suite synchronous (property 2 above).
   */
  deferRunBoundary(into: RunBoundary, retry: () => void): boolean {
    const label = t(into === 'run' ? 'loading.enteringRun' : 'loading.returningToHub');
    return this.open(retry, label, isDeferredArtArmed() ? MIN_TRANSITION_MS : 0);
  }

  /** Whether a wait is currently on screen. Test/diagnostic surface. */
  get waiting(): boolean {
    return this.screen !== null;
  }

  private open(retry: () => void, label: string, minMs: number): boolean {
    // Already inside a released transition: the outer gate has been paid and this caller is
    // part of what it released. Gating again would charge the floor a second time.
    if (this.releasing) return false;
    const artPending = !isRunArtReady();
    if (!artPending && minMs <= 0) return false;
    // A wait is already on screen. Swallow this transition rather than stacking a second
    // screen or queueing a second `retry`: the overlay does not stop the KEYBOARD, so the
    // Enter that opened the forge can arrive again while the spinner is up (`Game.confirm` is
    // reachable in the phase the player is still standing in). The first retry is the one
    // that runs.
    if (this.screen) return true;

    const screen = new LoadingScreen({
      label,
      ticker: this.deps.ticker,
      sizeOf: () => this.deps.screenSize(),
    });
    const { w, h } = this.deps.screenSize();
    screen.layout(w, h);
    this.screen = screen;
    this.deps.overlay.addChild(screen.view);

    const waits: Promise<unknown>[] = [];
    if (artPending) {
      // Sized before the first tick arrives: `ensureRunArt` may already be most of the way
      // done, and a bar that appears at 0 and jumps is worse than one that appears where it
      // is. Only when the art is what we are waiting for — a bar over a pure floor would be a
      // progress report about a timer.
      screen.setProgress(0, runArtUnitCount());
      waits.push(
        ensureRunArt((done, total) => screen.setProgress(done, total))
          // Caught here, so the gate opens on EVERY outcome. Every loader inside
          // `ensureRunArt` is already best-effort per item, but a throw from anywhere else in
          // that chain would otherwise leave this spinner up for the rest of the session — a
          // permanently stuck wait is the worst possible reading of "gameplay is never
          // blocked on art" (design/02/12). The player gets the transition, with whatever art
          // arrived.
          .catch((err) => {
            console.warn('run art failed to load; entering with placeholder art', err);
          }),
      );
    }
    if (minMs > 0) waits.push((this.deps.sleep ?? defaultSleep)(minMs));

    void Promise.all(waits).then(() => {
      // Torn down BEFORE the retry, so the re-entrant call sees no screen — and `releasing`
      // is what stops it opening a fresh one in that gap.
      this.hide();
      this.releasing = true;
      try {
        retry();
      } finally {
        this.releasing = false;
      }
    });
    return true;
  }

  private hide(): void {
    this.screen?.destroy();
    this.screen = null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
