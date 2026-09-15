"""Produce the cues whose peak reference is a single `tone()`: swing, hurt, death.player,
spawn -- the four a CHARACTER makes about itself -- and, since 2026-09-15, `chest.open`.

The counterpart to `process_all.py` (the cues an engine EVENT makes at a world position) and
`process_ui.py` (the cues a SCREEN makes). The original four are the audio half of the rig's own
six authored clips -- `attack`, `hurt`, `death`, `spawn` all animate a body since 2026-09-02 and
none of them made a sound. `idle`/`move` are the two that never should.

**Why a chest cue lives in the character driver.** It is not a character, and the alternative
was a fifth driver that would have been this file with two rows changed. What actually decides
which driver a cue belongs to is where its peak-match reference comes from (point 1 below), and
`chest.open`'s voice is a single `tone()` like these four -- so it belongs here on the only axis
that has ever mattered. The docstring's first line was rewritten to say that rather than leaving
the file named after a category it had outgrown.

It imports `process_all`'s measurement and encoding helpers unchanged -- mono, trim, cap,
bandwidth-driven rate search, smallest-MP3 encode -- and differs in exactly two steps, which
is why it is a fourth driver rather than more rows in the first one:

**1. Where the peak-match reference comes from.** `process_all.py` reads `synth.json`, an
audit of RE-RENDERED synth voices, because those voices stack several primitives and their
delivered peak cannot be read off the table. That file is a scratch artefact and is not in
the repo, which makes that driver un-re-runnable as written. Every voice added for these four
cues is a SINGLE `tone()`, whose gain envelope ramps 0 -> `gain` -> 0 over a unit-amplitude
oscillator, so its peak IS its `gain` argument exactly -- the same closed form `process_ui.py`
relies on, chosen deliberately here rather than merely inherited. The reference moves only
when `platform/audioSynth.ts` moves, and nothing has to survive between sessions.

**2. A source can be a REGION of a longer take.** `swing` is the one cue in the game with no
material in the six Kenney packs -- there is no whoosh, swoosh or air family in any of their
323 files, so it comes from BigSoundBank (`fetch_bigsoundbank.py`). The finding that decided
this table: the useful sword whooshes are not the 1-second files, they are the ELEVEN discrete
swings inside `whoosh_s0572.ogg`, an 11 s mono take. Measured across all eleven, they are far
more homogeneous than any four separate files could be (centroid 1433-1806 Hz, -40 dB extent
124-153 ms), which is exactly what a variant SET wants: four takes of one action, not four
different actions. The regions below are written as measured times rather than found by an
onset detector, because a detector in a shipping driver is a second thing that can drift; the
source file's sha256 in `credits.json` is what makes the times stay meaningful.

**Direction of imitation, as in the UI pass: the SAMPLE was picked first.** None of these four
cues had a synth voice before this pass, so the file was chosen on `audit.py`'s gates plus the
measurements recorded per cue below, and the voice in `platform/audioSynth.ts` was then written
to imitate its duration and centroid. "Closest match to the incumbent" is not the rationale for
any of these files and should not be read into them.
"""
import json, os, shutil
import numpy as np
import soundfile as sf

from process_all import allowed_rates, cap, encode_smallest, rolloff95, trim

OUT = 'out-reaction'
SRC = 'src'

# cue -> list of (source file, region or None, duration cap in ms or None)
#
# A region is (start_s, end_s) into the source, generous at both ends -- `trim()` then cuts to
# the -40 dB extent, so the numbers only have to CONTAIN the swing, not frame it.
PICKS = {
    # Fires on every melee stroke, connected or not (`melee_swing`, ENGINE_VERSION 52), so it
    # is the melee `muzzle` and gets `muzzle`'s treatment: the most variants in the set and a
    # short cue. No cap is set because none is needed -- the extracted swings measure 124-153 ms
    # at -40 dB, already inside `muzzle`'s own 140 ms cap.
    'swing': ([('bigsoundbank/whoosh_s0572.ogg', (1.08, 1.42)),
               ('bigsoundbank/whoosh_s0572.ogg', (3.42, 3.78)),
               ('bigsoundbank/whoosh_s0572.ogg', (6.46, 6.80)),
               ('bigsoundbank/whoosh_s0572.ogg', (8.48, 8.82))], None,
              'Four of the eleven sword-through-air swings inside one 11 s mono take -- the only '
              'whoosh material reachable at all, since the six Kenney packs contain no air '
              'family. Chosen across the take rather than consecutively: centroid 1455/1656/'
              '1697/1806 Hz spans the set\'s own 1433-1806 range, so the four read as one action '
              'performed four times.'),

    # Fires only when the LOCAL player takes damage, and `impact` fires at the same instant --
    # see EventReactor. So the pick is entirely about what SEPARATES the two on a real speaker,
    # and it took two wrong answers to find the axis that matters.
    #
    # The first cut chose body impacts (impactPunch_heavy) on the reasoning that a punch is
    # what "you took it" sounds like, and picked among them by SPECTRAL CENTROID. Both were
    # wrong, and one measurement showed it: band-limit each shipped file to 500-4000 Hz -- what
    # a phone speaker can actually reproduce -- and take its RMS. The shipped `impact` set
    # delivers -38.7 to -39.7 dBFS there. The punches deliver **-48 to -57**, because 96-98% of
    # their energy sits below 300 Hz. On the WeChat target the game's single most important
    # feedback cue would have been inaudible while the cue it layers under was not. Centroid
    # had hidden it: a sparse high tail pulls the centroid to 594-873 Hz over a spectrum that
    # is essentially all sub-bass.
    #
    # These deliver -32.5/-32.9/-33.1 dBFS in that band -- about 6 dB LOUDER than `impact`
    # itself -- and they close a vocabulary rather than opening one: `shield.break` is already
    # impactGlass_HEAVY, so the shell now has two weights of the same material, a light tick
    # when it is hit and a heavy shatter when it fails. `deflect` stays metal, which is what
    # keeps the parry distinct from being hit.
    'hurt': ([('impact-sounds/impactGlass_light_002.ogg', None),
              ('impact-sounds/impactGlass_light_000.ogg', None),
              ('impact-sounds/impactGlass_light_004.ogg', None)], None,
             '500-4000 Hz RMS of -32.5/-32.9/-33.1 dBFS against the shipped `impact` set\'s '
             '-38.7..-39.7 -- audible over it on a phone, which is the property the first two '
             'candidate families failed. Centroid 1466-1835 Hz sits an octave above `impact` '
             '(793-927) and an octave below `deflect` (2465-3082). Light glass to '
             '`shield.break`\'s heavy glass: one material, two severities.'),

    # Once per run, and the counterpart of `win` -- so it comes from the same instrument.
    # `win` is jingles_PIZZI00; measuring the fundamental of all 17 pizzicato jingles in 120 ms
    # frames gives eight that fall and nine that rise, and this is the clearest fall: a six-note
    # descending scale, 417 -> 371 -> 331 -> 294 -> 263 -> 262 Hz over 923 ms. It cannot be
    # confused with `win` (494 ms, two notes) or with `death.enemy` (an explosion crunch).
    'death.player': ([('music-jingles/jingles_PIZZI14.ogg', None)], 780,
                     'The descending pizzicato scale, against `win`\'s rising-then-held figure '
                     'in the same instrument. Capped at 780 ms to sit inside the feedback gate '
                     'proper (800 ms); the peak lands 360 ms in, well before the cap.'),

    # Fires when an actor VIEW is built -- the render-side diff `Scene` already computes, not
    # an engine event. Bursts: a room's wave materialises up to nine actors on one frame, which
    # the mixer coalesces into one voice at higher gain.
    # The chest lid (design/05 "Chest rooms", 2026-09-15). A chest had no sound at all: the
    # only feedback for opening one was the box changing shape and the weapons appearing, which
    # is why the mechanic was reported as broken twice in one day.
    #
    # **What the cue is deliberately NOT.** Not a coin rattle and not a fanfare -- the REWARD
    # already has a sound (`pickup.weapon`, when the payout is collected a tick later), so a
    # second reward sting here would double it. This cue is the mechanical event: a wooden lid
    # swinging open.
    #
    # Two takes of one action, which is what a variant set wants. Of the fourteen candidates
    # measured out of this pack (creaks, latches, doors, coins, leather, book), `creak1`/`creak2`
    # are the pair that measure as the same sound twice: centroid 3230/3486 Hz and a 500-4000 Hz
    # RMS 17.1/17.3 dB under their own peak, against 12.9 for the shorter `creak3` (dropped for
    # exactly that -- a third of the length and an octave darker reads as a different object) and
    # 24-29 for the latch/door/leather families, which put most of their energy where a phone
    # cannot reproduce it. That band-vs-peak figure puts the pair level with the shipped
    # `pickup.weapon_01` (17.5) and `spawn` (17.6).
    #
    # Capped at 780 ms like `death.player`, for the same reason: the feedback gate is 800 ms and
    # `creak2` trims to 723, close enough that an encode rounding up would fail its own class.
    'chest.open': ([('rpg-audio/creak1.ogg', None),
                    ('rpg-audio/creak2.ogg', None)], 780,
                   'A wooden lid swinging open -- the mechanical event, not the reward, which '
                   '`pickup.weapon` already announces a tick later. The most homogeneous pair in '
                   'the pack: centroid 3230/3486 Hz, 500-4000 Hz RMS 17.1/17.3 dB below peak '
                   '(level with the shipped `pickup.weapon`/`spawn`), where the latch and door '
                   'families sit 24-29 dB down in the one band a phone speaker reproduces.'),

    'spawn': ([('sci-fi-sounds/forceField_000.ogg', None),
               ('sci-fi-sounds/forceField_002.ogg', None),
               ('sci-fi-sounds/forceField_004.ogg', None)], 400,
              'An energy field powering up, for a body that materialises inside an energy shell '
              'the game already simulates (design/07 two-pool). Mono in the pack, so no channel '
              'mixdown; a 137 ms attack makes it a swell rather than a pop, matching the spawn '
              'clip, which opens at 20% scale and releases 350 ms later. Capped at 400 ms.'),
}

# Peak to match each cue to, in dBFS: 20*log10(the `gain` argument of that cue's voice in
# platform/audioSynth.ts). Exact, not measured -- see the module docstring.
#
# Where each sits in the mix, and why:
#   swing        0.11  just under `muzzle` (0.12). Both announce an attack; the ranged one is
#                      the shot itself and should stay the louder of the two.
#   hurt         0.16  just under `impact`'s noise burst (0.18). Layered under the transient,
#                      never over it.
#   death.player 0.20  the loudest single voice in the table, and the only cue besides `win`
#                      that ends a run. Still under `win`'s stacked chord.
#   spawn        0.12  level with `muzzle`. It can arrive nine at a time.
#   chest.open   0.14  level with `wave-clear`, the game's other "this room is finished"
#                      moment, and above every `pickup.*` (0.10-0.13): the chest is the rarer
#                      event and the one the player walked into a dead-end room for.
VOICE_GAIN = {'swing': 0.11, 'hurt': 0.16, 'death.player': 0.20, 'spawn': 0.12, 'chest.open': 0.14}


def read_source(rel: str, region: tuple[float, float] | None) -> tuple[np.ndarray, int, int]:
    """Mono samples for one pick. Returns (mono, sample_rate, source_channel_count)."""
    path = os.path.join(SRC, rel)
    data, sr = sf.read(path, always_2d=True, dtype='float64')
    if region is not None:
        a, b = int(region[0] * sr), int(region[1] * sr)
        if not (0 <= a < b <= len(data)):
            raise SystemExit('region %s out of range for %s (%d frames)' % (region, rel, len(data)))
        data = data[a:b]
    return data.mean(axis=1), sr, data.shape[1]


def main() -> None:
    """Drive the conversion. Guarded so the module stays importable for tests."""
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    report = []
    for cue, (picks, cap_ms, why) in PICKS.items():
        ref_peak = 20 * np.log10(VOICE_GAIN[cue])
        for i, (rel, region) in enumerate(picks):
            src = os.path.join(SRC, rel)
            mono, sr, src_ch = read_source(rel, region)

            y, cut_h, cut_t = trim(mono, sr)
            y, capped = cap(y, sr, cap_ms)
            rates = allowed_rates(rolloff95(y, sr))
            peak = np.max(np.abs(y))
            gain = 10 ** (ref_peak / 20) / peak if peak > 0 else 1.0
            y = np.clip(y * gain, -1.0, 1.0)

            stem = '%s_%02d' % (cue.replace('.', '-'), i)
            path = os.path.join(OUT, stem + '.mp3')
            target_sr, out_bytes = encode_smallest(y, sr, rates, path)
            report.append({
                'cue': cue, 'source': rel, 'region': list(region) if region else None,
                'out': stem, 'sr': target_sr,
                'duration_ms': round(len(y) / sr * 1000, 1),
                'rates_tried': rates,
                'trimmed_ms': round(cut_h + cut_t, 1), 'capped_ms': round(capped, 1),
                'gain_db': round(20 * np.log10(gain), 2), 'ref_peak_dbfs': round(ref_peak, 2),
                'src_bytes': os.path.getsize(src), 'mp3_bytes': out_bytes,
                'src_channels': src_ch, 'why': why,
            })

    with open('process-reaction.json', 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'shipped': report}, f, indent=1)

    print('%-14s %-40s %6s %8s %7s %7s %8s %8s' % (
        'cue', 'source', 'sr', 'dur ms', 'trim', 'cap', 'gain dB', 'bytes'))
    print('-' * 104)
    for r in report:
        label = r['source'] + ('@%.2f' % r['region'][0] if r['region'] else '')
        print('%-14s %-40s %6d %8.0f %7.0f %7.0f %8.2f %8d' % (
            r['cue'], label[-40:], r['sr'], r['duration_ms'], r['trimmed_ms'],
            r['capped_ms'], r['gain_db'], r['mp3_bytes']))
    print('-' * 104)
    tot = sum(r['mp3_bytes'] for r in report)
    print('%d files across %d cues: %.1f kB' % (len(report), len(PICKS), tot / 1024))


if __name__ == '__main__':
    main()
