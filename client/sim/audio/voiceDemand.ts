/**
 * How many sample voices real play asks for (design/11 "Voice-count budget"). Two halves:
 *
 *   1. `CueLog` records, tick by tick, the cues the REAL `EventReactor` plays for a headless
 *      match. The reactor's render-side collaborators (fx, hud, actor views) are no-op
 *      proxies; its audio bus is the recorder. Coalescing is the reactor's own, so a tick of
 *      ten hits is one `impact` here exactly as it is in the game.
 *   2. `replayBudget` plays that log through the REAL `VoiceBudget` at a given cap, with each
 *      voice lasting as long as the shipped variant it would have drawn, and counts what the
 *      cap cost: cues refused outright, and voices stolen (cut short to make room).
 *
 * The cap is a device budget, and a device cannot be measured from here. What this measures
 * is the other half of the question, the one `CueMixer.DEFAULT_CAP`'s comment reasoned about
 * instead: how many voices a frame of real play actually wants, and which cues pay when it
 * wants more than the cap.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GameEvent, GameState } from '@dd/engine';
import { EventReactor, type EventReactorHost } from '../../src/game/controllers/EventReactor';
import type { FxController } from '../../src/game/fx/FxController';
import type { HudView } from '../../src/game/ui/HudView';
import type { AudioBus, AudioCue } from '../../src/platform/types';
import { ALL_CUES, CUE_CATALOGUE, variantPaths } from '../../src/audio/cueCatalogue';
import { parseMp3 } from '../../src/audio/mp3Frames';
import { VoiceBudget } from '../../src/audio/VoiceBudget';

/** The engine runs at 30 Hz; a tick's events are consumed on the render frame that sees it. */
const TICK_SECONDS = 1 / 30;

/** Every method call, at any depth, is a no-op that returns another no-op. */
function noop(): unknown {
  const fn = (): unknown => proxy;
  const proxy: unknown = new Proxy(fn, { get: () => proxy, apply: () => proxy });
  return proxy;
}

export interface CueEvent {
  tick: number;
  cue: AudioCue;
  count: number;
}

/** Records what the real `EventReactor` plays, tick by tick, for one match. */
export class CueLog {
  readonly events: CueEvent[] = [];
  private readonly reactor: EventReactor;
  private readonly seen = new Set<number>();
  private tick = 0;
  private state: GameState | null = null;

  constructor(localOwner = 0) {
    const bus = { play: (cue: AudioCue, count = 1) => this.events.push({ tick: this.tick, cue, count }) };
    const host = new Proxy({} as EventReactorHost, {
      get: (_t, key) => {
        if (key === 'localOwner') return localOwner;
        if (key === 'activeState') return () => this.state;
        if (key === 'actorAt') return () => undefined;
        return noop();
      },
    });
    this.reactor = new EventReactor(noop() as FxController, noop() as HudView, bus as unknown as AudioBus, host);
  }

  /** Feed one tick. `Scene.spawnedActors` (the `spawn` cue) is approximated by the ids of
   *  living players and enemies this log has not seen before — the actors `Scene` builds a
   *  view for. */
  observe(state: GameState): void {
    this.state = state;
    this.tick = state.tick;
    let spawned = 0;
    for (const a of [...state.players, ...state.enemies]) {
      if (!a.alive || this.seen.has(a.id)) continue;
      this.seen.add(a.id);
      spawned++;
    }
    this.reactor.consume(state.events as readonly GameEvent[], spawned);
  }
}

/** Seconds of audible length for each shipped variant, by cue, read off the shipped files. */
export function shippedDurations(): Map<AudioCue, number[]> {
  const pub = fileURLToPath(new URL('../../public', import.meta.url));
  const out = new Map<AudioCue, number[]>();
  for (const cue of ALL_CUES) {
    out.set(cue, variantPaths(cue).map((p) => parseMp3(readFileSync(pub + p)).durationMs / 1000));
  }
  return out;
}

export interface CueCost {
  played: number;
  refused: number;
  stolen: number;
  /** Seconds of audio lost by the stolen voices. */
  cutSeconds: number;
}

export interface BudgetReport {
  cap: number;
  /** Voices held just after each admitted claim — the concurrency the mix actually reached. */
  heldPeak: number;
  heldP99: number;
  byCue: Map<AudioCue, CueCost>;
}

/**
 * Replay a log through a real `VoiceBudget` at `cap`. A synth-only cue never reaches the
 * budget in the game (`CueMixer.playSynth`) and is skipped here too. Variants are drawn in
 * round-robin order: `CueMixer` never repeats the previous variant, and for a duration count
 * that is what matters. Pitch jitter (±3%) is ignored.
 */
export function replayBudget(logs: readonly CueEvent[][], durations: Map<AudioCue, number[]>, cap: number): BudgetReport {
  const byCue = new Map<AudioCue, CueCost>();
  const cost = (c: AudioCue): CueCost => {
    let v = byCue.get(c);
    if (!v) byCue.set(c, (v = { played: 0, refused: 0, stolen: 0, cutSeconds: 0 }));
    return v;
  };
  const held: number[] = [];
  // The time of the claim in progress: a stolen voice loses what it had left AT that moment.
  let clock = 0;
  for (const log of logs) {
    const budget = new VoiceBudget(cap);
    const next = new Map<AudioCue, number>();
    for (const e of log) {
      const lengths = durations.get(e.cue) ?? [];
      if (lengths.length === 0) continue;
      const i = next.get(e.cue) ?? 0;
      next.set(e.cue, (i + 1) % lengths.length);
      const now = (clock = e.tick * TICK_SECONDS);
      const until = now + lengths[i]!;
      const c = cost(e.cue);
      const ok = budget.claim(CUE_CATALOGUE[e.cue].priority, now, until, () => {
        c.stolen++;
        c.cutSeconds += until - clock;
      });
      if (ok) {
        c.played++;
        held.push(budget.held);
      } else {
        c.refused++;
      }
    }
  }
  held.sort((a, b) => a - b);
  return {
    cap,
    heldPeak: held.at(-1) ?? 0,
    heldP99: held[Math.floor(held.length * 0.99)] ?? 0,
    byCue,
  };
}
