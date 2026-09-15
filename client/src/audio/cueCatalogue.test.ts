/**
 * The catalogue's own drift gate.
 *
 * `audioAssets.test.ts` already checks the shipped files against `credits.json` and the cue
 * union. What it cannot see is the third party that has to agree with both: the catalogue the
 * RUNTIME reads. A cue whose `variants` count is one too low ships a file nothing ever plays;
 * one too high asks for a path that 404s, and `SampleBank` swallows that by design (a failed
 * file falls back to the synth voice) — so the symptom of a wrong number here is not an error
 * anywhere, it is a variant quietly missing from the mix. Hence: generated paths are checked
 * against the directory listing in both directions.
 *
 * The mix values (gain/priority) are checked only for the properties design/11 actually
 * states. Whether 0.8 is the right gain for `muzzle` is a taste question no test can hold —
 * see `art/audio/README.md` on what measurement can and cannot say about this set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_CUES, CUE_CATALOGUE, cueStem, variantPaths, allSfxPaths, SFX_DIR } from './cueCatalogue';

const AUDIO_DIR = new URL('../../public/audio/', import.meta.url);
const CREDITS = new URL('../../../art/audio/credits.json', import.meta.url);

interface Credits {
  cues: { cue: string; variants: number }[];
  kept_on_synth: Record<string, string>;
}
const credits = JSON.parse(readFileSync(CREDITS, 'utf8')) as Credits;
const onDisk = readdirSync(fileURLToPath(AUDIO_DIR)).filter((f) => f.endsWith('.mp3')).sort();

describe('cue catalogue', () => {
  it('covers every cue the game can fire', () => {
    // Cheap, but it is the guarantee the whole module rests on: `CUE_CATALOGUE` is a
    // `Record<AudioCue, ...>`, so this passing means no cue can reach the mixer without a
    // decision. (`ALL_CUES` is derived from it, so the real assertion is the count.)
    // 21 engine cues + the 4 `ui.*` screen cues added 2026-08-30. The engine count went
    // 16 -> 20 on 2026-09-02 (`swing`, `hurt` and `spawn` are new, and `death` became the
    // pair `death.enemy`/`death.player`) and 20 -> 21 on 2026-09-15 with `chest.open`.
    expect(ALL_CUES).toHaveLength(25);
    expect(new Set(ALL_CUES).size).toBe(ALL_CUES.length);
    for (const cue of ALL_CUES) expect(CUE_CATALOGUE[cue]).toBeDefined();
  });

  it('generates a path for every shipped file and a file for every generated path', () => {
    const generated = allSfxPaths().map((p) => p.replace(`${SFX_DIR}/`, '')).sort();
    expect(generated).toEqual(onDisk);
  });

  it('names paths that actually exist on disk', () => {
    // The assertion above compares two lists; this one goes to the filesystem, so a naming
    // scheme that drifts (a stem rule change, a 3-digit index) fails as itself.
    for (const cue of ALL_CUES) {
      for (const path of variantPaths(cue)) {
        const rel = path.replace(`${SFX_DIR}/`, '');
        expect(existsSync(fileURLToPath(new URL(rel, AUDIO_DIR))), `${path} missing`).toBe(true);
      }
    }
  });

  it('agrees with credits.json on every variant count', () => {
    const recorded = new Map(credits.cues.map((c) => [c.cue, c.variants]));
    for (const cue of ALL_CUES) {
      expect(CUE_CATALOGUE[cue].variants, `${cue} variants`).toBe(recorded.get(cue) ?? 0);
    }
  });

  it('marks exactly the deliberate synth keeps as variant-less', () => {
    // A cue with no samples is a decision (`credits.json`'s kept_on_synth), and the two
    // records have to name the same cues or one of them is lying about what plays.
    const synthOnly = ALL_CUES.filter((cue) => CUE_CATALOGUE[cue].variants === 0);
    expect(synthOnly).toEqual(Object.keys(credits.kept_on_synth));
    for (const cue of synthOnly) expect(variantPaths(cue)).toEqual([]);
  });

  it('turns a dotted cue id into a hyphenated stem, uniquely', () => {
    expect(cueStem('shield.break')).toBe('shield-break');
    expect(cueStem('status.chill')).toBe('status-chill');
    expect(cueStem('wave-clear')).toBe('wave-clear'); // already hyphenated, untouched
    // Two cues sharing a stem would silently share files.
    const stems = ALL_CUES.map(cueStem);
    expect(new Set(stems).size).toBe(stems.length);
  });

  it('zero-pads the variant index', () => {
    expect(variantPaths('impact')[0]).toBe('/audio/impact_00.mp3');
    expect(variantPaths('impact')[4]).toBe('/audio/impact_04.mp3');
  });

  it('keeps every gain inside the headroom the shipped files were mastered for', () => {
    // The files were peak-matched to the synth voice each replaces (~-13 dBFS), so 1.0 is
    // "as loud as the placeholder". The ceiling here plus the coalesce cap (1.5x) is what
    // keeps a stacked frame short of clipping the bus.
    for (const cue of ALL_CUES) {
      const { gain } = CUE_CATALOGUE[cue];
      expect(gain, `${cue} gain`).toBeGreaterThan(0);
      expect(gain, `${cue} gain`).toBeLessThanOrEqual(1.2);
    }
  });

  it('ranks the priority ladder the way design/11 states it', () => {
    const p = (cue: keyof typeof CUE_CATALOGUE) => CUE_CATALOGUE[cue].priority;
    // "player damage > enemy death > distant bullet" — and the cue that fires on every shot
    // is the most expendable thing in the mix.
    expect(p('muzzle')).toBeLessThan(p('impact'));
    expect(p('impact')).toBeLessThan(p('death.enemy'));
    expect(p('death.enemy')).toBeLessThan(p('deflect')); // the signature parry outranks a kill
    // ...and, once `hurt` exists, that ladder is only half of design/11's sentence. "Player
    // damage" is the TOP of it: taking a hit has to outrank every cue that describes what is
    // happening to someone else, including the parry, or the cap can drop the one signal that
    // reports the state ending the run.
    expect(p('deflect')).toBeLessThan(p('hurt'));
    expect(p('death.enemy')).toBeLessThan(p('hurt'));
    // Your own death outranks even that, and is second only to the win jingle.
    expect(p('hurt')).toBeLessThan(p('death.player'));
    expect(p('death.player')).toBeLessThan(p('win'));
    // `swing` is the melee `muzzle` and sits with it at the expendable end: a stroke that is
    // dropped under load costs the player nothing they cannot see.
    expect(p('swing')).toBeLessThan(p('impact'));
    // `spawn` can arrive nine at a time and must never push a hit out of the budget.
    expect(p('spawn')).toBeLessThan(p('impact'));
    // A once-per-run stinger must never be stolen by anything.
    expect(p('win')).toBe(Math.max(...ALL_CUES.map((c) => CUE_CATALOGUE[c].priority)));
    for (const cue of ALL_CUES) expect(p(cue), `${cue} priority`).toBeGreaterThan(0);
  });
});
