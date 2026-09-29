// How a cue becomes sound (design/11): the shipped sample if one is loaded, the synth voice
// if not, under the catalogue's mix and the voice cap.
//
// Both platform backends compose this, so the decision ladder exists ONCE:
//
//   1. `SampleBank` has a decoded variant → play it, at the catalogue's gain, with a small
//      render-side pitch jitter, counted against `VoiceBudget`.
//   2. It does not (a synth-only cue, still loading at boot, or every file failed) →
//      `audioSynth.playCue`, exactly what shipped before the asset pass.
//
// Step 2 is not a temporary shim. `status.burn` has no sample by decision, and a cue's first
// firings on a cold boot land before the preload resolves — an audible-but-different voice
// beats silence, and both paths pass through the same gain so the swap does not change the
// weight of the mix.
//
// DETERMINISM (design/06/11). Everything here runs on the render clock and reads nothing but
// the cue id. The variant choice and pitch jitter draw from an injected `random` that
// defaults to `Math.random` — NEVER the sim's `Prng`, whose stream a sound must not perturb.
import type { AudioCue } from '../platform/types';
import { playCue } from '../platform/audioSynth';
import { CUE_CATALOGUE } from './cueCatalogue';
import { VoiceBudget } from './VoiceBudget';
import type { SampleBank } from './SampleBank';

/** Simultaneous sample voices. What real play ASKS FOR is measured (`sim/voiceDemand.sim.ts`,
 *  which gates it): 16 is the smallest cap at which no cue from `impact` up loses a voice in
 *  any mode played. It was 12 from volume 113 (2026-09-29) until volume 115 the same day, when
 *  it turned out 113's PvP matches had every seat stacked on one spawn point and firing past
 *  each other; real PvP fights ask for 12-14 voices at p99 and 17 at worst (8 seats), and at
 *  12 the 8-seat rows lost 0.9% of their voices, 55 of them `impact`. 14 and 15 still lost
 *  `impact`. What a phone can AFFORD is still open (design/11).
 *  First sized against what a frame can actually ask for: the
 *  caller coalesces duplicates, so a bounded number of distinct cues arrive per frame, and the
 *  long tails (`death.player`, 780 ms; `death.enemy`, 600 ms) are the only ones that overlap
 *  for any length of time. That bound was 16 when this number was chosen and is 20 since the
 *  character-reaction cues landed (2026-09-02) — the cap was deliberately NOT raised with it,
 *  because it is a device budget, not a headroom-over-the-cue-count budget, and what the extra
 *  cues cost is measured in `audioPipeline.test.ts`: the overflow is cut from the bottom of the
 *  priority ladder, which is exactly what the ladder is for.
 *
 *  Exported for that test, which derives how many voices a saturated frame must sacrifice
 *  rather than writing the number down — it had been written down, and it went stale. */
export const DEFAULT_CAP = 16;

/** Pitch spread per voice, plus and minus. Small enough to read as the same sound, large
 *  enough to blunt the repetition a 2-variant cue would otherwise have. */
const PITCH_JITTER = 0.03;

/** How much louder a coalesced cue gets, and its ceiling. Ten hits in one frame become one
 *  impact "at higher gain, not ten" (design/11) — log-shaped, because doubling the number of
 *  events is nothing like doubling the loudness of the moment. */
const COALESCE_PER_DOUBLING = 0.15;
const COALESCE_MAX = 1.5;

/** Fade applied when a voice is stolen, so the cut reads as a duck rather than a click. */
const STEAL_FADE = 0.012;

export interface CueMixerDeps {
  ctx: AudioContext;
  /** The SFX bus gain node — settings volume lives there (design/10), never per voice. */
  bus: GainNode;
  bank: SampleBank;
  cap?: number;
  random?: () => number;
}

/** The gain multiplier for `count` events that coalesced into one cue this frame. */
export function coalesceBoost(count: number): number {
  if (count <= 1) return 1;
  return Math.min(1 + COALESCE_PER_DOUBLING * Math.log2(count), COALESCE_MAX);
}

export class CueMixer {
  private readonly budget: VoiceBudget;
  private readonly random: () => number;
  /** Last variant index played per cue, so the next one differs — repetition fatigue is
   *  audible across a set long before any single sample sounds wrong. */
  private readonly lastVariant = new Map<AudioCue, number>();

  constructor(private readonly deps: CueMixerDeps) {
    this.budget = new VoiceBudget(deps.cap ?? DEFAULT_CAP);
    this.random = deps.random ?? Math.random;
  }

  /**
   * Play one cue. `count` is how many events coalesced into it this frame (design/11) — it
   * raises the gain, it never plays the cue twice.
   */
  play(cue: AudioCue, count = 1): void {
    const def = CUE_CATALOGUE[cue];
    const scale = def.gain * coalesceBoost(count);
    const variants = this.deps.bank.variantsOf(cue);
    if (!variants || variants.length === 0) {
      this.playSynth(cue, scale);
      return;
    }

    const buffer = this.pickVariant(cue, variants);
    const rate = 1 + (this.random() * 2 - 1) * PITCH_JITTER;
    const { ctx, bus } = this.deps;
    const now = ctx.currentTime;

    // Claimed BEFORE any node is built, so a dropped cue costs nothing. `voice` is filled in
    // below and only read by the stealer, which can only run from a LATER claim — never
    // before this call returns.
    let voice: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
    const claimed = this.budget.claim(def.priority, now, now + buffer.duration / rate, () => {
      if (voice) this.steal(voice.src, voice.gain);
    });
    if (!claimed) return;

    const gain = ctx.createGain();
    gain.gain.value = scale;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Guarded: `playbackRate` is standard WebAudio, but this same code runs on WeChat's
    // WebAudioContext, whose node surface is documented rather than verified here — a missing
    // param must cost the jitter, not the sound.
    if (src.playbackRate) src.playbackRate.value = rate;
    src.connect(gain).connect(bus);
    voice = { src, gain };
    src.start(now);
  }

  private playSynth(cue: AudioCue, scale: number): void {
    const { ctx, bus } = this.deps;
    // At exactly 1.0 the trim node would be a provable no-op, so the synth voice connects
    // straight to the bus as it always did.
    if (scale === 1) {
      playCue(cue, ctx, bus);
      return;
    }
    const trim = ctx.createGain();
    trim.gain.value = scale;
    trim.connect(bus);
    playCue(cue, ctx, trim);
  }

  /** A variant index that is never the one this cue played last. */
  private pickVariant(cue: AudioCue, variants: readonly AudioBuffer[]): AudioBuffer {
    const n = variants.length;
    const last = this.lastVariant.get(cue);
    let i: number;
    if (n === 1 || last === undefined) {
      i = Math.min(n - 1, Math.floor(this.random() * n));
    } else {
      // Draw from the n-1 OTHER variants, then step over the excluded slot.
      const k = Math.min(n - 2, Math.floor(this.random() * (n - 1)));
      i = k < last ? k : k + 1;
    }
    this.lastVariant.set(cue, i);
    return variants[i]!;
  }

  private steal(src: AudioBufferSourceNode, gain: GainNode): void {
    const t = this.deps.ctx.currentTime;
    try {
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + STEAL_FADE);
      src.stop(t + STEAL_FADE);
    } catch {
      // Already ended on its own between the purge and here — nothing to cut short.
    }
  }
}
