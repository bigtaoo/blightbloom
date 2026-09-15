// The cue catalogue (design/11 "Cue catalogue") — the data half of "what does a cue sound
// like", and the file design/11 named as the one thing blocking the then-46 shipped mp3s from
// ever being audible.
//
// WHY IT LIVES HERE, not in the design/12 asset manifest. `render/assetPacks.json` answers
// a different question ("which WeChat package does this path belong to") and it answers it
// for audio already, by prefix rule, with no entry needed. What it cannot hold is the mix:
// per-cue gain, the voice-cap priority, and how many variants exist. Those are content
// decisions in design/09's sense — data, never inline code — so they get a content-shaped
// table, and the loader (SampleBank) derives paths from it.
//
// WHY VARIANT COUNTS RATHER THAN FILE LISTS. The shipped set is named mechanically by
// `tools/audio-pipeline/` (`<stem>_NN.mp3`, stem = the cue id with '.' → '-'), so a literal
// list of 46 strings would be 46 chances to typo a name that fails silently as "no sample,
// use the synth". `variantPaths` generates them instead, and `cueCatalogue.test.ts` checks
// the generated set against BOTH the files on disk and `art/audio/credits.json` — so a
// renamed, added or dropped asset fails a test rather than going quiet.
//
// A cue with `variants: 0` is a deliberate synth keep, not an omission: `status.burn` has
// no sample because no fire crackle exists in any of the six CC0 packs (see
// `credits.json`'s `kept_on_synth`), and its synth voice is already the right shape.
import type { AudioCue } from '../platform/types';

/** Where the shipped SFX live, public-relative (design/12 stable-id convention: the cue id
 *  is the contract, this prefix + the id is only how the manifest happens to name it). */
export const SFX_DIR = '/audio';

export interface CueDef {
  /**
   * How many shipped sample variants this cue has. 0 = synth-only, on purpose.
   * A cue that fires many times per second needs several or it machine-guns; `win` fires
   * once per run and needs one (design/11 "variation-count").
   */
  variants: number;
  /**
   * Linear gain for one voice of this cue, applied UNDER the SFX bus volume (design/10
   * settings) and on top of whatever loudness the asset already has. The shipped files were
   * peak-matched to the synth voice each replaces (`art/audio/README.md`), so 1.0 means
   * "as loud as the placeholder was" — every value away from 1.0 below is a mix decision,
   * not a correction. It applies to the synth fallback too (CueMixer wraps it), so a cue
   * sounds the same weight whichever voice source is actually playing.
   */
  gain: number;
  /**
   * Voice-cap ranking, higher wins (design/11 "drop by a per-cue priority (player damage >
   * enemy death > distant bullet)"). When the concurrency cap is full, a new cue only
   * sounds if it outranks the weakest voice still playing, and that voice is stolen.
   * Rough ladder: run-defining stings > co-op/loot feedback > combat reactions > the cue
   * that fires on every single shot.
   */
  priority: number;
}

/**
 * Every cue the game can fire (`AudioCue`), with its audio decision. Declared as an
 * exhaustive `Record` on purpose: adding a cue to the union is a COMPILE error until it is
 * given a decision here, which is the same guarantee `audioAssets.test.ts` wanted from its
 * hand-maintained literal — one table instead of three copies of the union.
 */
export const CUE_CATALOGUE: Record<AudioCue, CueDef> = {
  // --- combat: fires constantly, must stay under the mix rather than fill it ---
  muzzle: { variants: 5, gain: 0.8, priority: 20 },
  // The melee `muzzle`, and it inherits `muzzle`'s treatment for the same reason: it fires on
  // every stroke. Four variants rather than five only because that is how many clean swings
  // the source take yields (see `process_reaction.py`); gain stays 1.0 because the level
  // decision is already made in the voice table, which put `swing` under `muzzle` — the shot
  // is the louder of the two announcements.
  swing: { variants: 4, gain: 1.0, priority: 22 },
  impact: { variants: 5, gain: 1.0, priority: 60 },
  // Fires for the LOCAL seat only, on top of the `impact` that fires for the same hit. Its
  // priority is above every combat cue and below the UI: a voice cap that dropped "you are
  // being damaged" would be dropping the one cue that reports the state ending the run,
  // whereas a dropped `muzzle` reads as nothing at all. design/11's ladder puts player damage
  // at the top and this is what that means once the cue exists.
  hurt: { variants: 3, gain: 1.0, priority: 105 },
  // The parry is the pivot mechanic (design/03/05) and design/11 asks for it to "read
  // clearly over the mix" — the only cue deliberately louder than its placeholder.
  deflect: { variants: 5, gain: 1.15, priority: 95 },
  clash: { variants: 3, gain: 0.85, priority: 30 },
  'shield.break': { variants: 5, gain: 1.0, priority: 90 },

  // --- status stings: design/11 keeps these low so combat cues pop ---
  'status.burn': { variants: 0, gain: 0.75, priority: 40 },
  'status.chill': { variants: 4, gain: 0.75, priority: 40 },
  'status.shock': { variants: 4, gain: 0.75, priority: 40 },
  'status.poison': { variants: 2, gain: 0.75, priority: 40 },

  // --- feedback: rarer, longer, and the player is meant to notice every one ---
  'death.enemy': { variants: 3, gain: 0.9, priority: 70 },
  // The counterpart of `win`, and ranked directly under it: your own death is the second
  // thing in the game that ends a run, and nothing but the win jingle may steal it. One
  // variant for the same reason `win` has one — it happens once.
  'death.player': { variants: 1, gain: 1.0, priority: 118 },
  // Below `impact` on purpose. A wave materialising is context, not a demand on the player's
  // attention, and it can arrive nine at a time — it must never be what pushes a hit or a
  // parry out of the voice budget.
  spawn: { variants: 3, gain: 1.0, priority: 50 },
  'pickup.heal': { variants: 2, gain: 1.0, priority: 80 },
  'pickup.weapon': { variants: 2, gain: 1.0, priority: 80 },
  'pickup.material': { variants: 2, gain: 0.9, priority: 75 },
  'pickup.buff': { variants: 2, gain: 1.0, priority: 80 },
  // Two variants for ~5 openings a run (a small chest on four of five floors, the big one on
  // the third): enough that the second one in a run is not the same take, not so many that a
  // cue nobody hears twice in a minute carries five files. Priority above every `pickup.*`
  // (75-80) and under `shield.break` (90): a chest is the rarer event and the one a player
  // walked into a dead-end room for, but it must never steal the cue that says your shell
  // just failed. Gain 1.0 — the level decision is in the voice table (0.14, level with
  // `wave-clear`), which the shipped files were peak-matched to.
  'chest.open': { variants: 2, gain: 1.0, priority: 85 },
  'wave-clear': { variants: 1, gain: 0.95, priority: 100 },
  // Once per run. Nothing may steal it.
  win: { variants: 1, gain: 1.0, priority: 120 },

  // --- UI: not engine events at all (see `AudioCue`), fired by audio/uiSound.ts ---
  //
  // ONE variant each, against the "a cue that fires often needs several" rule above — on
  // purpose. That rule exists because repetition fatigue is audible across a set; a UI cue is
  // the opposite case, a direct answer to the player's own finger that has to read as the
  // SAME affordance every press. Two buttons that sound different are a bug, not variety.
  // CueMixer's +/-3% pitch jitter is all the variation these get.
  //
  // Gain 1.0 across the board: the UI mix decision is already made in the voice table's
  // amplitudes (~-21 dBFS, below every combat cue), and the shipped files were peak-matched
  // to those, so a second knob here would only obscure where the level comes from.
  //
  // Priority 110 — above every combat cue, below `win`. A cue the player caused by pressing
  // a button must not be the one the voice cap drops: a silent press reads as a missed input
  // (design/10's HUD legibility argument, in audio), where a dropped `muzzle` reads as
  // nothing at all. They are rare enough that outranking combat costs the mix nothing.
  'ui.tap': { variants: 1, gain: 1.0, priority: 110 },
  'ui.back': { variants: 1, gain: 1.0, priority: 110 },
  'ui.toggle': { variants: 1, gain: 1.0, priority: 110 },
  'ui.denied': { variants: 1, gain: 1.0, priority: 110 },
};

/** Every cue, at runtime. Derived from the catalogue so it cannot drift from the union the
 *  way a hand-written list can (the `Record` above is what the compiler holds exhaustive). */
export const ALL_CUES: readonly AudioCue[] = Object.keys(CUE_CATALOGUE) as AudioCue[];

/** The file stem the audio pipeline gives this cue's variants: the cue id with '.' → '-'
 *  ('shield.break' → 'shield-break'). Kept as one function because it is the single point
 *  where the id contract and the on-disk naming meet. */
export function cueStem(cue: AudioCue): string {
  return cue.replace(/\./g, '-');
}

/** Public-relative paths for every shipped variant of `cue`, in variant order. Empty for a
 *  synth-only cue — callers read that as "there is nothing to load", not as an error. */
export function variantPaths(cue: AudioCue): readonly string[] {
  const { variants } = CUE_CATALOGUE[cue];
  const stem = cueStem(cue);
  return Array.from(
    { length: variants },
    (_, i) => `${SFX_DIR}/${stem}_${String(i).padStart(2, '0')}.mp3`,
  );
}

/** Every shipped SFX path, in cue order — what the boot preload fetches (design/11
 *  "preload the core SFX set at boot"). */
export function allSfxPaths(): readonly string[] {
  return ALL_CUES.flatMap((cue) => variantPaths(cue));
}
