# Audio (source)

> **Loading — two different paths, on purpose.** The **cues** are fetched and DECODED at boot by
> `client/src/audio/SampleBank.ts`, driven by `client/src/audio/cueCatalogue.ts` (design/11, "The
> cue catalogue & the loading path"): the catalogue derives each path from a cue id + variant
> count, and `cueCatalogue.test.ts` checks the generated set against both this directory and
> `credits.json`, so renaming or dropping a shipped file fails a test rather than going quiet.
> The **music** is never decoded — a 69 s stereo loop is ~26 MB of `AudioBuffer`, so it STREAMS
> through two long-lived decks (`client/src/audio/MusicPlayer.ts`, 2026-08-31), catalogued
> separately in `musicCatalogue.ts` and gated separately in `musicAssets.test.ts`.

Mirrors the `art/` convention: this directory holds the **source** audio and its licence
paperwork. Nothing here is loaded at runtime — what the game ships is the processed copy
under `client/public/audio/`.

> **Status (2026-09-06): the two music loops got shorter and slower.** A balance pass wanted the
> beds more relaxed (0.7x tempo) and quieter under the SFX bus. Tempo has no runtime knob — every
> track is a fixed AI-generated master — so `tools/audio-pipeline/process_music.py` now stretches
> each master with `pedalboard.time_stretch` (pitch preserved) before slicing out its loop region,
> and BOTH regions had to be re-picked: the 2026-08-31 regions did not survive being stretched
> (`menu`'s band-diff went from 1.15 dB natively to 6.6 dB once stretched, `boss`'s from 1.63 to
> 2.2-2.9 dB — the first far past the 2.5 dB gate, the second too close to it to keep). New
> shipped files: `menu.mp3` 68.0 s / 482.2 kB (was 69.0 s / 511.8 kB), `boss.mp3` 47.5 s / 381.9 kB
> (was 64.5 s / 603.4 kB) — both loops measure comfortably inside the gate (1.77 dB / 1.60 dB) and
> the music subpackage dropped from 1.09 MB to 0.84 MB. See "Music" below for the updated table and
> `design/11-audio.md`'s "The music runtime" for why this was tried as a runtime `playbackRate`
> first and reverted (WeChat's `InnerAudioContext` has no documented pitch-preservation guarantee,
> so the same multiplier would have shipped a different pitch on each platform). Still nobody has
> listened to any of it.
>
> **Status (2026-09-02): the four cues a CHARACTER makes about itself now exist.** `swing`, `hurt`, `death.player` and `spawn` — the audio half of the rig's own authored clips, which had animated a body since earlier the same day and made no sound. **11 more files, 20.9 kB; the set is 61 files, 122.7 kB** and still inside its 160 KiB budget, which was not raised. `death` was renamed `death.enemy` at the same time (it only ever fired for an enemy, so a player death had no sound at all). One new SOURCE came with them, the first that is not a Kenney zip: **BigSoundBank**, because none of the six packs' 323 files is a whoosh — see "Provenance" below for what changes when a source is per-sound instead of a pack. Still nobody has listened to any of it.
>
> **Status (2026-08-31): the SFX set is complete and playing, and so is MUSIC.** Two loops ship under `client/public/audio/music/` (`menu.mp3` 69.0 s / 511.8 kB, `boss.mp3` 64.5 s / 603.4 kB), cut from AI-generated masters in `sources/suno/` — see "Music" below. They are **not** CC0 library material like everything else here, so their provenance is a separate `music`/`music_terms` block in `credits.json` rather than an entry in `packs.json`. Two passes the same day: the first cut and gated the files, the second built the runtime that plays them (`client/src/audio/musicCatalogue.ts` + `MusicPlayer.ts`, a deck per platform, and `client/src/game/musicDirector.ts`). **Nobody has listened to them, or to the 50 cues.** That is the one open item on this set a measurement cannot close.
>
> **Status (2026-08-30): 19 of 20 cues have assets, and all of them play.** The set is
> **50 processed MP3s, 101.9 kB** under `client/public/audio/`. The 2026-08-28 pass wired the
> original 46 up (`client/src/audio/`, above); the 2026-08-30 pass added the **four `ui.*`
> cues** — `ui.tap`, `ui.back`, `ui.toggle`, `ui.denied` — which are the sounds a *screen*
> makes rather than the ones an engine event makes (design/11's "The UI cues"). Only
> `status.burn` is still deliberately synth-only. **Nobody has listened to any of the 50.**
>
> <details><summary>The original 2026-08-27 status, kept for the record</summary>
>
> **The SFX pass is complete — 15 of 16 cues have assets; nothing
> loads them yet.** `client/public/audio/` holds **46 processed MP3s, 95.0 kB total**,
> covering every cue in `platform/audioSynth.ts`'s voice table except `status.burn`, which
> deliberately stays on its synth voice (reason below). No code references any of them:
> `audioSynth.ts` still generates every cue live. Wiring them up needs the cue catalogue
> that `design/11-audio.md` still lists under "To design" (where cue ids → files live: a
> `content/audio.ts` map, or the `12` manifest). Until that exists these files are staged,
> not shipped. Music and ambience remain untouched.
>
> </details>

## Provenance

Six CC0 packs from Kenney, plus one per-sound CC0 library. **Only the files actually used are
archived here**, under `sources/<pack>/` — the full zips come to 10.7 MB against under 500 kB of
used source, so `packs.json` records each pack's download URL and **sha256** instead, making the
whole pack re-fetchable and verifiable. Every `licenses/<pack>-LICENSE.txt` was read out of the
pack itself and checked to contain CC0.

**BigSoundBank is the exception, and the exception is the interesting part (2026-09-02).** The
six Kenney packs are a fixed inventory, and it ran out: there is no whoosh, swoosh or
air-movement family anywhere in their 323 files, so the `swing` cue — which fires on every melee
stroke in the game — had no material at all. BigSoundBank is a real-world foley library that can
be **queried**, which is the only kind of source that can answer "does this sound exist"; the
sibling project `funny` reached the same conclusion from the other end and added freesound.org
there for the same reason. Three things differ, and all three are recorded rather than waved
through:

| | a Kenney pack | BigSoundBank |
|---|---|---|
| integrity | one `sha256` over the zip, in `packs.json` | one `source_sha256` per file, in `credits.json` — narrower and stronger: it covers the exact bytes that were processed |
| licence | `LICENSE.txt` read out of the zip | stated on each sound's page; `fetch_bigsoundbank.py --license` captures that statement **verbatim** into `licenses/bigsoundbank-LICENSE.txt` with its source URL |
| what is archived | the used files | the used file only — `sources/bigsoundbank/fetched.json` keeps the whole surveyed pool (20 candidates: id, title, page, sha256) so a rejected one is re-fetchable without keeping its bytes |

`platform/audioAssets.test.ts` holds both shapes to the same standard: a pack marked
`per_sound` must have no zip hash AND every credited file from it must carry a
`source_sha256` that **matches the archived bytes**. A flag with no hashes behind it would be
an exemption; this is the same promise kept a different way.

| Pack | Files | Used for |
|---|---|---|
| Impact Sounds | 130 | `impact`, `deflect`, `shield.break`, `hurt` |
| Interface Sounds | 100 | `clash`, `status.shock`, `status.chill`, `pickup.material`, `wave-clear`, and all four `ui.*` |
| Sci-Fi Sounds | 73 | `muzzle`, `death.enemy`, `spawn` |
| Digital Audio | 63 | `status.poison`, `pickup.heal`, `pickup.buff` |
| RPG Audio | 52 | `pickup.weapon`, `pickup.material` |
| Music Jingles | 86 | `win`, `death.player` |
| BigSoundBank (per sound) | 20 surveyed | `swing` |

**Licence: CC0 1.0** for all seven — commercial use allowed, attribution not required.
Per-file provenance (source file, sample rate, gain applied, bytes) is in `credits.json`.

## What was measured

All **556 files** were audited with `tools/audio-pipeline/audit.py` before anything was
picked. The corpus is far dirtier than the first pack suggested:

- **43 files clip**, with peaks up to **+3.51 dBFS** — above full scale. Excluded from
  selection; clipping already baked into a source cannot be undone.
- **233 files carry >5 ms of leading silence** — pure added latency. Recoverable, and the
  pipeline trims it.
- **247 files are bit-identical dual-mono**; 186 are genuinely mono. Half the bytes of the
  former are a duplicate channel.
- Mixed 44.1 kHz and 48 kHz sources, centroids spanning 178 Hz to 12 kHz.

## What was picked, and why

Chosen on measured fit against the synth voice each cue replaces, plus the material the
world already specifies (`design/13`: crystal-mirror enemies). Variant counts scale with how
often a cue fires — `design/11` gives every cue a variation-count, and one sample on a cue
that fires many times per second machine-guns.

**Nobody has listened to any of these files.** The selection rules out defects and matches
each synth voice; it cannot judge whether a sound is *right*. That sign-off is still open,
and the game is designed to be fully playable silent (`design/11`), so nothing depends on it.
The weakest pick on that basis is `win` — choosing pizzicato strings over sax, steel drum, or
chiptune is a style judgement made from spectra alone.

| Cue | Source family | Variants | Why |
|---|---|---|---|
| `impact` | `impactGeneric_light` | 5 | Tightest length match to the 70 ms synth voice (118–140 ms); most consistent set at 16 % centroid spread. Fires many times per second, so density beats variety. |
| `muzzle` | `laserRetro` | 5 | A laser shot is the right semantics for orb-core weapon fire. **Capped at 140 ms** — the corpus has no 60 ms shot, and this is the most-emitted cue in the game. |
| `deflect` | `impactMetal_light` | 5 | Bright and sharp (2440–3172 Hz), closest to the 700→1400 Hz triangle shipping now; 27 % spread keeps the set coherent. |
| `shield.break` | `impactGlass_heavy` | 5 | Best objective fit in the corpus (0.18). Glass is the literal material of a crystal-mirror enemy; 46 % spread means the variants genuinely differ. |
| `status.shock` | `glitch` | 4 | 10–30 ms electric ticks. The semantically obvious `zap` runs 1019–1228 ms and clips — far too long for a status tick that repeats. |
| `status.chill` | `glass` | 4 | 111–125 ms against a 120 ms target. Glass is both the right timbre for ice and the world's own material. |
| `clash` | `tick` | 3 | 23–55 ms against a 50 ms target, centroid 3786–7920 vs 4894 — the tightest match found for any cue. |
| `death.enemy` | `explosionCrunch` | 3 | Centroid 2223–3386 vs 3556. **Capped at 600 ms**: an unbounded 2 s tail times many simultaneous deaths is mud. Still the most expensive cue at 19.5 kB. Named `death` until 2026-09-02 — see below. |
| `status.poison` | `lowRandom`, `lowDown` | 2 | Centroid 249 and 178 Hz against a 236 Hz target — the closest spectral match in the corpus. Only two files exist at this pitch. |
| `pickup.heal` | `pepSound` | 2 | Centroid 643 and 808 Hz bracket the 823 Hz target. |
| `pickup.weapon` | `drawKnife` | 2 | Chosen on semantics — it *is* a weapon pickup. Brighter than the chime it replaces. |
| `pickup.material` | `handleCoins`, `pluck` | 2 | handleCoins at 7194 Hz against a 6573 Hz target, and literally the sound of handling loot. Its sibling file clips; this one does not. |
| `pickup.buff` | `phaserUp` | 2 | Centroid 1316 and 1230 Hz against a 1427 Hz target. |
| `wave-clear` | `confirmation` | 1 | Centroid 1536 vs 1278 Hz. Fires once per wave. |
| `win` | `jingles_PIZZI` | 1 | Centroid 1356 Hz against 1318 Hz — near exact. Pizzicato over the chiptune and sax alternatives, which fight the flat-cel world. |

### The character-reaction cues (2026-09-02)

The four sounds a *body* makes about itself, and the audio half of the rig's six authored clips:
`attack` is `swing`, and the other three are `hurt`, `death` and `spawn`. (`idle` and `move` are
the two that never should make one.) All four had animated a character since earlier the same day
with no sound attached.

Picked the UI pass's way round — **sample first, voice written afterwards to imitate it** — for
the same reason: none of these cues had a synth voice to match. That also settles where the
peak-match reference comes from. Each new voice in `platform/audioSynth.ts` is a **single**
`tone()`, whose envelope ramps 0 → `gain` → 0 over a unit-amplitude oscillator, so its delivered
peak *is* its `gain` argument, exactly; `process_reaction.py` reads those four numbers instead of
the re-rendered `synth.json` that `process_all.py` needs and that no longer exists in the repo.
`audioSynth.test.ts` asserts the property both drivers depend on: one oscillator, no noise burst,
first envelope ramp exactly the documented gain.

**`death` became `death.enemy`, and `death.player` is new.** The old cue was only ever played
inside `if (faction === 'enemy')`, so the moment a run ends — the local player bleeding out — was
the one lifecycle event in the game with no sound at all. Two named cues make that a decision
instead of a branch nobody reads, and it is design/11's own written vocabulary
(`death.<enemy/player>`).

| Cue | Source | Variants | Why |
|---|---|---|---|
| `swing` | `bigsoundbank/whoosh_s0572.ogg`, four regions | 4 | The one cue with no material in any Kenney pack. The useful takes turned out not to be the 1-second files at all: this is an **11 s mono take holding eleven discrete sword whooshes**, and across all eleven they are far more homogeneous (centroid 1433–1806 Hz, −40 dB extent 124–153 ms) than four separate files could be — which is what a variant set wants, four takes of one action. Ships at 126–155 ms, next to `muzzle`'s 140. |
| `hurt` | `impactGlass_light` | 3 | **The pick that took three tries, and the metric that decided it is in the table below.** Light glass to `shield.break`'s heavy glass: one material, two severities, so the shell has a vocabulary. Centroid 1465–1818 Hz sits an octave above `impact` (793–927) and an octave below `deflect` (2465–3082). |
| `spawn` | `forceField` | 3 | An energy field powering up, for a body that materialises inside an energy shell the sim already runs (design/07 two-pool). Mono in the pack, so no mixdown. Its 130–139 ms attack makes it a swell rather than a pop, which is what matches the spawn clip — it opens at 20 % scale and releases 350 ms later. **Capped at 400 ms.** |
| `death.player` | `jingles_PIZZI14.ogg` | 1 | The counterpart of `win`, so it comes from `win`'s own instrument. Measuring the fundamental of all 17 pizzicato jingles in 120 ms frames gives eight that fall and nine that rise; this is the clearest fall — a six-note descending scale, 417 → 371 → 331 → 294 → 263 → 262 Hz. It cannot be confused with `win` (494 ms, two notes) or with `death.enemy` (an explosion crunch). **Capped at 780 ms**, inside the feedback gate's 800. |

#### What `hurt` cost, and the measurement that was worth more than the centroid

The first two candidate sets were body impacts — `impactPunch_heavy`, on the reasoning that a
punch is what "you took it" sounds like — and they were picked among by **spectral centroid**,
which is the number every other row in this document is chosen on. Both were wrong, and one
measurement showed it: band-limit each candidate to **500–4000 Hz**, the range a phone speaker can
actually reproduce, and take its RMS.

| | 500–4000 Hz RMS |
|---|---|
| shipped `impact` set (the reference) | −38.7 … −39.7 dBFS |
| `impactPunch_heavy` (rejected) | **−48 … −57 dBFS** |
| `impactGlass_light` (shipped as `hurt`) | −32.5 … −33.1 dBFS |

96–98 % of the punches' energy sits below 300 Hz. On the WeChat target the game's most important
feedback cue would have been inaudible while the cue it layers under was not — and the centroid
had hidden exactly that, because a sparse high tail pulls it up to 594–873 Hz over a spectrum that
is essentially all sub-bass. **Centroid describes where a spectrum is centred; it says nothing
about whether the listener's speaker reaches it.** For any cue that has to be heard on a phone,
measure the band, not the centre.

The trade taken with the shipped set: `hurt` fires at the same instant as `impact`, and they are
separated by material and register rather than by envelope. Whether the two read as one event or
as two is a **listening** question, which is this document's standing open item.

### The UI cues (2026-08-30)

Picked the other way round from everything above. There was no synth voice to match — the UI
had no sound at all — so the **sample was chosen first**, on `audit.py`'s `ui` gate (≤350 ms,
≤5 ms of lead, mono, no clipping) plus what the pack's own family names mean, and the synth
voice in `platform/audioSynth.ts` was then written to imitate the file's measured duration and
centroid. All four are **one variant**: a UI cue answers the player's own finger and must read
as the same affordance every press, which is the opposite of the repetition-fatigue argument
that gives `muzzle` five.

The four sit in a deliberate pitch order — `back` (1833 Hz) under `tap` (2629) under `denied`
(4270) under `toggle` (6399) — so leaving a screen sounds lower than entering one, and a state
change sounds brightest. `denied` is separated from `tap` by **length and density** rather than
pitch: 192 ms of sustained buzz against a 43 ms transient.

| Cue | Source | Variants | Why |
|---|---|---|---|
| `ui.tap` | `select_002.ogg` | 1 | 43 ms at 2629 Hz — the shortest clean file in the pack that still has a body. The 10 ms `click_00x` pair carries measurable DC bias (0.004–0.005), and a 10 ms transient peak-matched against a 190 ms buzz reads far quieter than its peak claims. |
| `ui.back` | `back_002.ogg` | 1 | 70 ms at 1833 Hz, the lowest centroid among the clean short files. Named for the job by the pack itself. |
| `ui.toggle` | `toggle_004.ogg` | 1 | 66 ms at 6399 Hz with a 0.1 ms attack: brightest and shortest of the toggle family — its siblings run 139 ms, which outlasts a settings tap. |
| `ui.denied` | `error_007.ogg` | 1 | 192 ms at 4270 Hz, crest 12.2 — a sustained buzz, not a click. The only error file that is both mono and clean: `error_002` peaks at **+0.6 dBFS** (clipped), `error_003/005/006` run 500 ms behind 10–35 ms of lead, `error_001/004` are dual-mono. |

### Kept on the synth voice

- **`status.burn`** — no fire crackle exists in any of the six packs. The closest family
  (`scratch`) centres at 6401–12076 Hz against a 2389 Hz target — a high scrape, not a burn —
  and every other candidate is a 5-second engine loop. The synth voice is a filtered noise
  burst at 1800 Hz, which is already the right shape.
- **`footstep`** — appears in `design/11`'s event map but has no synth voice, so an asset
  would be an addition rather than a replacement. Whether a top-down bullet-hell wants
  footsteps at all is a design call, not a sourcing problem.

## Processing applied

Run via `tools/audio-pipeline/process_all.py`. Every step fixes a measured defect:

1. **Mono** — collapse channels (verified bit-identical on the dual-mono sources).
2. **Trim** — drop head/tail below −40 dBFS with 4 ms/8 ms fades so the new edges cannot
   click. Removed up to 224 ms of inaudible material from individual files.
3. **Cap** — per-cue duration ceiling matched to how often the cue fires, applied as a 20 ms
   fade-out rather than a cut. Only `muzzle`, `status.poison`, `death.enemy`, `pickup.*`,
   `wave-clear` and (2026-09-02) `hurt`, `spawn`, `death.player` needed one.
4. **Encode** — MP3 at the **smallest** output among all sample rates that still clear
   2.2 × the file's own measured 95 % rolloff. Bytes are *not* monotonic in sample rate
   (libsndfile picks its own VBR quality per rate — one file is smallest at 16 kHz, another
   at 24 kHz), so this is a measured search, not a heuristic. It found 95.0 kB where a
   plausible per-family guess gave 99.1 kB.
4b. **Extract a region**, for `swing` only (2026-09-02) — the four whooshes are windows into
   one 11 s take, taken generously at both ends so that step 2 above decides the real edges.
   The times are written down as measured rather than found by an onset detector: a detector in
   a shipping driver is a second thing that can drift, and the source file's `source_sha256` in
   `credits.json` is what keeps the numbers meaningful.
5. **Peak-normalise** to the peak of the synth cue being replaced, so swapping an asset in
   does not change perceived loudness and the `AudioBus` calibration still holds. Gains
   range from −20.2 dB to +6.5 dB; the one positive gain (`drawKnife2`, a quiet −22.95 dBFS
   recording) raises its noise floor with it.

The four `ui.*` files run the same five steps through `tools/audio-pipeline/process_ui.py`,
which differs in exactly one place: **where the peak-match reference comes from**.
`process_all.py` reads `synth.json`, an audit of re-rendered synth voices, because those voices
stack several `tone()` calls and their peak cannot be read off the table. Every UI voice is a
*single* `tone()`, whose envelope ramps 0 → `gain` → 0 over a unit-amplitude oscillator, so its
peak **is** its `gain` argument (0.08–0.10, about −21 dBFS). No render, no measurement, and no
scratch input that has to survive between sessions.

### Verification

- `audit.py --by-cue`: **50 / 50 pass**, routed 33 to the strict `sfx` gate, 13 to `feedback`
  and 4 to `ui`. Zero clipping, zero dual-mono, zero stereo, zero DC offset.
- Decoded in a real browser: **46 / 46**, duration error ≤ 0.1 ms (mean 0.01 ms), all mono,
  peaks −23.5…−9.7 dBFS.
- WeChat main package: 3.31 → **3.41 MB / 4.00 MB**.

Two gate bugs surfaced during this pass and were fixed in `audit.py`: a −12 dBFS peak floor
that spuriously failed 40 of 46 peak-matched files, and a cue-class matcher that missed the
`.`→`-` flattening in shipped filenames, routing every `pickup.*` asset to the combat gate.

## Why MP3 and not OGG

Measured, not assumed. OGG/Vorbis carries a **~3.6 kB fixed setup header** (the codebooks)
per file, which dwarfs a short SFX payload — a 5 ms clip costs 3685 bytes as Vorbis against
703 as MP3, and the two formats only converge around 2 s of audio. Decoded in a real browser,
MP3 also came back sample-exact where Vorbis added up to 30 ms of padding; both showed 0 ms
leading silence, so MP3's encoder delay is not a latency problem here. This agrees with
`design/11`, which already prefers MP3 as universally decoded on WeChat.

**Still unverified:** MP3 decoding on a real WeChat device at the lowest base library — the
same open checklist item as `design/04` item 2. OGG/Vorbis remains the right choice for music
loops, where the fixed header amortises away.

## Music (2026-08-31)

Two loops, from **AI-generated masters (Suno)** rather than the CC0 library material every cue here
came from — CC0 music turned out to be almost entirely chiptune, a direct style mismatch for
`design/13`'s flat-cel direction. Masters are kept in `sources/suno/`, one directory per source
exactly like the Kenney packs. `tools/audio-pipeline/process_music.py` cuts them; `audit.py --class
music` gates them.

| shipped | from | native region | shipped length | bytes | rate | xfade band-diff | mid-band |
|---|---|---|---|---|---|---|---|
| `music/menu.mp3` | `Crystal Menu.mp3` (322.7 s) | ~56.7 s (native) | 68.0 s | 482.2 kB | 24 kHz stereo | 1.77 dB | -30.00 dBFS |
| `music/boss.mp3` | `Frozen Resonance.mp3` (248.0 s) | ~103.2 s (native) | 47.5 s | 381.9 kB | 24 kHz stereo | 1.60 dB | -30.00 dBFS |

**Tempo (2026-09-06).** Both loops are stretched to 0.7x tempo (`process_music.py`'s
`TEMPO_FACTOR`, `pedalboard.time_stretch`, pitch preserved) as part of a balance pass that wanted
the beds more relaxed — baked into the file rather than applied by the player, because
`InnerAudioContext.playbackRate` has no documented pitch-preservation guarantee on WeChat, where
`HTMLMediaElement.preservesPitch` is a real guarantee on web. **Both regions above were re-picked
for this pass**, not just re-cut: the 2026-08-31 regions (69.0 s from 218.5 s native for `menu`,
64.5 s from 145.0 s native for `boss`) did not survive being stretched — `menu`'s band-diff went
from 1.15 dB natively to 6.6 dB once stretched, `boss`'s from 1.63 to 2.2-2.9 dB, the first far
past the 2.5 dB gate and the second too close to it to keep. The "native region" column above is
where each loop sits in the ORIGINAL master, for anyone locating the passage by ear; "shipped
length" is what the file actually plays for and what `MusicCatalogue.lengthS` records.

**Per-track selection rationale.**

- **`menu`** — the second generation, after the first came back in the wrong register (below). Best
  loop region in the whole track at any length (native tempo). Energy sits 160 Hz-1.2 kHz; 40-49 Hz
  reads -66 dBFS, so no shelf was needed. The requested high sparkle above 4 kHz never arrived
  (-70 dBFS and below): not a defect, an open taste question. Its region was re-picked post-stretch
  (see "Tempo" above) to the 68.0 s / 1.77 dB region in the table; a shorter candidate measured as
  low as 0.83 dB post-stretch but was not worth trading this much loop length away for.
- **`boss`** — generated against the **menu** brief and measured as something else entirely: 90% of
  its energy below 109 Hz, 95% below 198 Hz, nothing above 2 kHz, with the 40-49 Hz band 13 dB above
  every other. That is dread, not a calm hub, so it became the boss bed. A 4th-order zero-phase shelf
  at 80 Hz / -14 dB took its 20-250 Hz RMS from -11.1 to -26.7 dBFS. Its region was likewise
  re-picked post-stretch to the 47.5 s / 1.60 dB region in the table; a tighter 20-30 s cluster
  measured better still (down to 1.27 dB) but roughly halves the loop length, and nobody has heard
  either to judge whether the shorter one reads as repetitive in a boss fight.
- **`dungeon.ember`** — no master yet. It is the only one of the three that has to survive real
  combat density, so its brief depends on how the two above actually sound in the game. **The
  runtime plays `menu.mp3` in its place**, declared as such in the catalogue
  (`TrackDef.borrowedFrom: 'menu'`) rather than left as a comment, so `PLACEHOLDER_TRACKS` is
  derived and a test asserts exactly which tracks are standing in. It borrows `menu` and NOT `boss`
  even though `boss` is the closer match in mood: with one file on both sides of the boss-room
  threshold the switch would be inaudible, and a transition nobody can hear reads as a broken
  feature, where a bed that is wrong for the room reads as a bed that is wrong for the room.
  Closing this is one file plus one catalogue line — drop the master in `sources/suno/`, re-cut with
  `process_music.py`, and change `path`/`lengthS`/`borrowedFrom`.

**Level.** Both are normalised so their 250-2000 Hz RMS is -30 dBFS, which leaves every cue's peak
9.1-15.7 dB above the bed in the band they share (`ui-tap` +9.1, `muzzle` +13.4, `impact` +15.3,
`deflect` +15.7). The masters arrived at -0.1 dBFS peak, roughly 20 dB hotter than the cue set, which
was deliberately peak-matched down to the quiet synth voices it replaced. Expect every AI master to
need 13-15 dB off.

**Licensing.** AI-generated, so the CC0 paperwork in `licenses/` does not cover these two. The
service's commercial-use terms were accepted as adequate by the project owner for purely
instrumental output. **As of the runtime pass (2026-08-31) there IS a `credits.json` entry** — a
`music` array plus a `music_terms` block, kept deliberately separate from `cues` and outside
`packs.json`, because that file declares every SFX source pack CC0 and a test asserts it of every
entry: filing a Suno master there would either break that gate or quietly weaken it. Two gaps remain
and are now **declared rather than absent**: no licence text is archived (`license_text_archived:
false`) and the verbatim prompt was never captured (`prompt: null`, `prompt_archived: false`, with
the brief recorded instead). `client/src/audio/musicAssets.test.ts` gates the record and asserts
those two flags are false, so filling either one is a visible change — a reconstructed prompt would
be a guess that reads like a record.

**What gates these files.** Not `client/src/platform/audioAssets.test.ts`: it reads `public/audio/`
**non-recursively**, so the moment music shipped into a subdirectory it fell out of that file's byte
budget, credits cross-check, format check and licence sweep, silently and all at once.
`client/src/audio/musicAssets.test.ts` is the music counterpart, and three of its rules are
inversions rather than copies — **stereo is required** where the cue gate requires mono (if those two
assertions ever agree, one is broken); the catalogue **length** is checked against each file's real
audible duration to 50 ms, because that number is where `MusicPlayer` places the crossfade; and
`XFADE_S` is read out of `tools/audio-pipeline/audit.py` and asserted equal to the player's, since
the 1.77 / 1.60 dB figures in the table above ARE a measurement over a window of exactly that
width.

**Why MP3 here too, against this file's own earlier note.** The OGG-vs-MP3 section below ends by
saying Vorbis is the right choice for music loops. On bytes it is; on decode support it is not —
ogg/Vorbis is unreliable on iOS Safari and absent from WeChat `InnerAudioContext`'s documented format
list. A few tens of kB is not worth a chance of silence on two major targets.
