import type { AudioCue } from './types';

// Shared procedural SFX synthesis (design/11 placeholder audio), factored out of
// WebAudio.ts so WeChatAudio.ts can drive the IDENTICAL cues through
// `wx.createWebAudioContext()` — WeChat's own doc describes it as implementing the
// same Web Audio API surface as the browser's `AudioContext` (design/11 "gives
// lower-latency mixing for SFX... verify availability on the lowest base library").
// Both backends are therefore this one voice table + these two primitives; only
// how the `AudioContext` itself is obtained (and the pool/fallback around it)
// differs per platform.
//
// Zero asset files, zero licensing (design/11's own "placeholder audio" recommendation
// — jsfxr/Kenney-style procedural generation) — this exists to prove the event→sound
// pipeline end-to-end everywhere, not as the final authored SFX pass.

/** A pitched blip; optional linear glide to `slideTo` over its life. */
export function tone(
  ctx: AudioContext,
  bus: GainNode,
  freq: number,
  type: OscillatorType,
  dur: number,
  gain: number,
  slideTo?: number,
): void {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo !== undefined) osc.frequency.linearRampToValueAtTime(slideTo, t + dur);
  // Fast attack, exponential-ish decay via a linear ramp to ~0.
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(g).connect(bus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A short filtered noise burst (impacts / crackle). */
export function noise(ctx: AudioContext, bus: GainNode, dur: number, gain: number, cutoff = 3000): void {
  const t = ctx.currentTime;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(lp).connect(g).connect(bus);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/** A tiny helper for multi-note cues — schedules a note without WebAudio timeline math
 * leaking into the voice table (each `tone()` already self-schedules from currentTime,
 * so stacking them plays a quick chord/arp; good enough for placeholders). */
function chordNote(ctx: AudioContext, bus: GainNode, freq: number, dur: number, gain: number): void {
  tone(ctx, bus, freq, 'triangle', dur, gain);
}

// One synth voice per cue. Kept intentionally small/quiet — combat emits a lot, and
// the caller already coalesces duplicates per frame (design/11). Element cues follow
// the colour law's mood (design/13): fire = crackle, ice = high sine, shock = buzz,
// poison = low wobble.
const VOICES: Record<AudioCue, (ctx: AudioContext, bus: GainNode) => void> = {
  muzzle: (c, b) => tone(c, b, 220, 'square', 0.06, 0.12, 120),
  impact: (c, b) => { noise(c, b, 0.07, 0.18, 2600); tone(c, b, 160, 'triangle', 0.06, 0.1, 90); },

  // The four voices added with the character-reaction cues (2026-09-02). Every one of them is
  // a SINGLE `tone()`, and that is a decision rather than a coincidence: a single tone's gain
  // envelope ramps 0 -> `gain` -> 0 over a unit-amplitude oscillator, so its peak IS its gain
  // argument, exactly — which is what lets `tools/audio-pipeline/process_reaction.py` derive
  // its peak-match reference from this table instead of from a re-rendered `synth.json` that
  // no longer exists in the repo. The four `ui.*` voices below rely on the same property.
  //
  // Direction of imitation is the UI table's, not the combat table's: the SAMPLE was picked
  // first and each voice was written to imitate its measured duration and centroid (swing
  // 126-155 ms / 1208-1572 Hz, hurt 107-118 ms / 1465-1818 Hz, death.player 780 ms / 1161 Hz,
  // spawn 400 ms / 467-631 Hz). "Closest match to the incumbent" is not why these files
  // sound the way they do — there was no incumbent.
  //
  // A downward sweep, under `muzzle`'s 0.12: a stroke through air, and the quieter half of
  // the two attack announcements.
  swing: (c, b) => tone(c, b, 1500, 'triangle', 0.14, 0.11, 620),
  // The local seat taking damage. Above the status stings and just under `impact`'s noise
  // burst (0.18) — it layers under that transient every time it plays, never over it.
  hurt: (c, b) => tone(c, b, 1400, 'triangle', 0.11, 0.16, 900),
  deflect: (c, b) => tone(c, b, 700, 'triangle', 0.14, 0.2, 1400), // signature parry ping (design/03/05)
  clash: (c, b) => { tone(c, b, 520, 'square', 0.05, 0.1); tone(c, b, 780, 'square', 0.05, 0.08); },
  'shield.break': (c, b) => { tone(c, b, 420, 'sawtooth', 0.16, 0.16, 180); chordNote(c, b, 620, 0.1, 0.1); },
  'status.burn': (c, b) => noise(c, b, 0.12, 0.09, 1800),
  'status.chill': (c, b) => tone(c, b, 1200, 'sine', 0.12, 0.09, 900),
  'status.shock': (c, b) => tone(c, b, 300, 'sawtooth', 0.08, 0.1, 600),
  'status.poison': (c, b) => tone(c, b, 180, 'sine', 0.16, 0.09, 140),
  'death.enemy': (c, b) => tone(c, b, 300, 'sawtooth', 0.22, 0.14, 70),
  // A long fall, and the loudest single voice in the table. It is the counterpart of `win`,
  // so it is allowed the room `win` gets — still under `win` itself, which stacks three tones.
  'death.player': (c, b) => tone(c, b, 520, 'triangle', 0.7, 0.2, 200),
  // A rise, level with `muzzle`: nine of these can arrive on one frame.
  spawn: (c, b) => tone(c, b, 300, 'sine', 0.38, 0.12, 900),
  'pickup.heal': (c, b) => tone(c, b, 660, 'sine', 0.12, 0.13, 990),
  'pickup.weapon': (c, b) => tone(c, b, 520, 'triangle', 0.14, 0.13, 780),
  'pickup.material': (c, b) => tone(c, b, 880, 'square', 0.08, 0.1, 1320),
  'pickup.buff': (c, b) => { tone(c, b, 587, 'triangle', 0.12, 0.12); chordNote(c, b, 880, 0.12, 0.1); },
  // The chest lid (2026-09-15), written the sample-first way the four above and the four UI
  // voices were: the file was picked on measurements and this imitates it. A falling sawtooth
  // groan, 600 ms against the shipped pair's 563/723, and 900 -> 500 Hz because a sawtooth's
  // harmonic stack puts the CENTROID of that glide at 3235 Hz — the pair measures 2993/3253.
  // (Rendered and measured offline rather than guessed; a triangle at the same centroid would
  // have to sit at 3.1 kHz, which is a whistle, not a creak.) Single `tone()`, so its peak is
  // exactly 0.14 and `process_reaction.py` can peak-match the samples to it with no re-render.
  'chest.open': (c, b) => tone(c, b, 900, 'sawtooth', 0.6, 0.14, 500),
  'wave-clear': (c, b) => { tone(c, b, 523, 'triangle', 0.12, 0.14); chordNote(c, b, 784, 0.12, 0.09); },
  win: (c, b) => { tone(c, b, 523, 'triangle', 0.16, 0.15); chordNote(c, b, 659, 0.16, 0.12); chordNote(c, b, 784, 0.2, 0.12); },

  // UI cues (design/11's screen-layer cues, fired by `audio/uiSound.ts`). Two properties are
  // deliberate and are what `tools/audio-pipeline/process_ui.py` peak-matched the shipped
  // files against:
  //   * each is a SINGLE `tone()`, so the voice's peak is exactly its `gain` argument. That
  //     is what let the UI pass skip the re-render-and-measure step the combat pass needed.
  //   * all four sit at 0.08-0.10, under every combat voice (impact 0.18, deflect 0.20,
  //     muzzle 0.12) and level with the status stings. A button has to be heard over a quiet
  //     menu, never startle over a loud fight.
  // Frequencies imitate the picked samples' measured centroids, in that order of authorship
  // (art/audio/README.md): sample first, voice written to match it — the reverse of the
  // combat table, which had no sample when it was written.
  'ui.tap': (c, b) => tone(c, b, 1500, 'square', 0.035, 0.09),
  // Down-glide, and the lowest of the four: leaving a screen reads under entering one.
  'ui.back': (c, b) => tone(c, b, 900, 'square', 0.06, 0.09, 620),
  'ui.toggle': (c, b) => tone(c, b, 2600, 'square', 0.05, 0.08),
  // A sustained saw buzz, not a click — length and density are what separate "refused" from
  // "pressed", since both are answers to the same press.
  'ui.denied': (c, b) => tone(c, b, 320, 'sawtooth', 0.18, 0.1, 260),
};

/** Play one cue through `ctx`/`bus` — the single entry point both WebAudio and
 * WeChatAudio call once they have a real (running) AudioContext-shaped context. */
export function playCue(cue: AudioCue, ctx: AudioContext, bus: GainNode): void {
  VOICES[cue](ctx, bus);
}
