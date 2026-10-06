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

> **Status (2026-10-06, last): a sixth loop, `dungeon.blight`, for chapter 4.** "Ominous Goings-On"
> by Eric Matyas (CC-BY 4.0), 49.5 s, seam 0.65 dB, no shelf, chosen by measurement from 38 CC0/CC-BY
> candidates. To make room the `music` subpackage's own limit went from 3 MiB to 4 MiB (a standard
> WeChat subpackage has no individual cap; only the 30 MB whole-game total binds it). The music set
> is now 3.41 MB, 3.26 of the 4 MiB. See "Music" below.
>
> **Status (2026-10-06, later): a fifth loop, `dungeon.storm`, for chapter 3.** "Endless Cyber
> Runner" by Eric Matyas (CC-BY 4.0), 50.0 s, seam 1.20 dB, chosen by measurement from 16 CC0/CC-BY
> candidates. The music set was then 2.99 MB, 2.85 of the `music` subpackage's 3 MiB (the limit the
> sixth loop raised). See "Music" below.
>
> **Status (2026-10-06): the music is now open-licensed, and there are four loops.** The two
> AI-generated (Suno) masters are gone; the owner judged them not good enough. `menu`, `dungeon.ember`
> (which had borrowed `menu.mp3` since 2026-08-31), the new `dungeon.frost` (chapter 2) and `boss` are
> CC0/CC-BY music by Scott Buckley, Wolfgang_, Synth-thetic and Matthew Pablo, 2.46 MB together, and
> the CC-BY credit is shown on the Settings screen. Every loop ships at its written tempo. See
> "Music" below. The 2026-09-06 note directly under this one describes the files it replaced.
>
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
> **Status (2026-09-15): a chest makes a sound.** `chest.open`, 2 variants, **8.5 kB; the cue set is 63 files, 131.2 kB** and still inside its 160 KiB budget. It exists because of a report rather than a plan: a chest had no art, no sound and no prompt, and was reported from real play as unopenable — twice in one day, by two different routes (see `design/05-gameplay.md` "Chest rooms"). The cue is the LID, not the reward: the payout already announces itself through `pickup.weapon` a tick later, which is a step-order claim now pinned in `engine/systems/chests.test.ts` rather than asserted in a comment. Picked from the RPG Audio pack the game already uses, on the 500-4000 Hz band metric the `hurt` pass introduced. **Nobody has listened to it, or to the 61 cues before it.**
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
| RPG Audio | 52 | `pickup.weapon`, `pickup.material`, `chest.open` |
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
| `chest.open` | `creak1.ogg`, `creak2.ogg` | 2 | A wooden lid swinging open (2026-09-15). The cue is the mechanical event and deliberately not a reward sting — the payout gets `pickup.weapon` a tick later, so a second fanfare here would double it. Of fourteen candidates measured out of this pack (creaks, latches, doors, coins, leather, book), these two are the pair that measure as one action twice: centroid 3230/3486 Hz and a 500–4000 Hz RMS **17.1/17.3 dB under their own peak**, level with the shipped `pickup.weapon` (17.5) and `spawn` (17.6). `creak3` was dropped for being a third of the length and an octave darker — variety, not a variant; the latch/door/leather families sit 24–29 dB down in the one band a phone reproduces. **Capped at 780 ms**, inside the feedback gate's 800. |
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

## Music (2026-10-06; first built 2026-08-31)

Six loops, all **openly licensed music written by people**, from OpenGameArt and Scott Buckley's
CC library. The first four replaced the two AI-generated (Suno) masters of 2026-08-31, which the owner
judged not good enough ("音乐我发现ai生成的并不好"); the fifth, `dungeon.storm`, and the sixth,
`dungeon.blight`, were added the same day for chapters 3 and 4. The earlier belief that open music
meant chiptune held for CC0 and not for CC-BY: CC-BY has orchestral and ambient work at a production
standard, and five of these six are CC-BY. Sources are archived under `sources/music/`.
`tools/audio-pipeline/process_music.py` cuts them; `audit.py --class music` gates them.

| shipped | track | from | licence | region (upstream) | length | bytes | seam | shelf |
|---|---|---|---|---|---|---|---|---|
| `music/menu.mp3` | `menu` | "Aurora", Scott Buckley | CC-BY 4.0 | 86.0 s of 498.8 s | 85.0 s | 721.9 kB | 0.83 dB | none |
| `music/dungeon-ember.mp3` | `dungeon.ember` | "Lava Area Theme", Wolfgang_ | CC-BY 4.0 | 12.5 s of 105.6 s | 60.0 s | 578.6 kB | 1.54 dB | 80 Hz / -10 dB |
| `music/dungeon-frost.mp3` | `dungeon.frost` | "Beyond the Frozen Veil" (loop version), Synth-thetic | CC0 | 34.5 s of 142.2 s | 71.5 s | 529.7 kB | 1.40 dB | none |
| `music/dungeon-storm.mp3` | `dungeon.storm` | "Endless Cyber Runner" (looping version), Eric Matyas | CC-BY 4.0 | 27.5 s of 96.0 s | 50.0 s | 522.9 kB | 1.20 dB | 80 Hz / -10 dB |
| `music/dungeon-blight.mp3` | `dungeon.blight` | "Ominous Goings-On" (looping version), Eric Matyas | CC-BY 4.0 | 15.0 s of 99.7 s | 49.5 s | 411.7 kB | 0.65 dB | none |
| `music/boss.mp3` | `boss` | "Colossal Boss Battle Theme" (no-vocals loop), Matthew Pablo | CC-BY 3.0 | 49.5 s of 117.6 s | 58.5 s | 570.1 kB | 1.31 dB | 80 Hz / -10 dB |

All 24 kHz stereo at -30.00 dBFS mid-band; 3.41 MB together (3.26 MB counted by the WeChat package
check, which counts MiB), inside the `music` subpackage's 4 MiB with ~0.74 MiB left. The limit was
3 MiB until the sixth loop, and the five before it left ~150 kB: rather than re-encode the shipped
loops, the limit was raised, because it is this project's own guard and not WeChat's (a standard
subpackage has no individual cap; the whole game is 8.6 of its 30 MB).

**How they were chosen.** Licences first: CC0 and CC-BY only, since both permit commercial use and an
edited loop. NC is out (the game earns from ads), ND is out (cutting a loop region is an adaptation),
SA is avoided. Then twelve candidate files were downloaded and measured, since nobody on the project
listens for a living and I cannot hear at all:

- **Seam:** `process_music.py --search` on each source; every pick closes at 0.83-1.54 dB against the
  2.5 dB gate. The gate's 90 s ceiling cut `menu` from a 105 s candidate to 85 s.
- **Near-perfect seams were refused.** Several sources offered a region at 0.06-0.3 dB ("Ice Cave"
  42 s, "Lava Area Theme" 40.5 s). That figure means the head and tail are the same bars: the piece
  repeats. The player crossfades with an equal-power curve, which swells by up to 3 dB over
  correlated material and combs wherever the two decks start a few ms apart. Both loops the player
  was built and measured for crossfaded different material at 1.6-1.8 dB, so that is what was taken.
- **Mono safety:** a phone speaker sums the channels. "The Frigid Seas" measured L/R correlation
  -0.64, so it partly cancels in mono, and was rejected for that alone.
- **Rejected on seams:** "Crystal Cave + Mysterious Ambience" (cynicmusic) could not close under
  2.4 dB anywhere and was 2.4 dB only with a 1.2 dB level jump.
- **Sub:** `dungeon.ember` and `boss` sat 6.4 and 5.3 dB above their own mids in 20-250 Hz, which
  a phone does not reproduce and MP3 pays for, so both get the pipeline's zero-phase shelf.
- **Taste, stated as taste:** `menu` is a slow synth-and-strings build (the lobby is where a player sits
  longest), `dungeon.ember` a lava-level theme, `dungeon.frost` an ice-kingdom ambient piece,
  `dungeon.storm` a driving 120 bpm electronic piece, `dungeon.blight` a dark, beatless suspense
  piece, `boss`
  orchestra and heavy drums with the choir version passed over because a choir sits in the band every
  combat cue peaks in. Nobody has listened to the result in the game yet.

**The chapter-3 bed (`dungeon.storm`, added later the same day).** Sixteen CC0/CC-BY candidate files for a
tense, electric, driving-but-not-boss bed were downloaded from OpenGameArt and measured; OGA-BY,
CC-BY-SA and GPL listings were skipped on licence alone. Three measurements beyond the gate decided it,
each run on the region with its shelf applied:

- **What the two decks sound like together.** The correlation of the outgoing tail and the incoming
  head over the 2 s overlap, and the level change the equal-power fade produces there. This is the
  "near-zero seam swells and combs" warning above, measured directly: "Blitz Kaskade" (FoxSynergy)
  and "Thunderous Fall" (iamoneabe) close at 0.0-0.4 dB because they repeat, and their overlaps
  correlate +0.4 to +0.9 and swell 1.0-1.9 dB. "Energy Storm" (iamoneabe, CC0) is the same
  repetition: its best region in every length bucket from 20 to 56 s reads 0.17-0.27 dB. The pick
  correlates +0.06 and moves +0.3 dB.
- **Whether the drums flam.** A beat-driven bed adds a failure an ambient one cannot have: if the
  loop length minus the crossfade is not a whole number of beats, the two decks' drums land apart for
  the whole fade. Measured as the lag of the best onset-envelope cross-correlation between tail and
  head. "Endless Cyber Runner" is 120 bpm, so every 0.5 s length the search tries lands on the grid
  (lag 0). "Electric Exodus" (FoxSynergy, CC-BY 3.0) closed at 1.05 dB but flams by 80 ms unless cut
  to an off-grid 52.92 s.
- **Brightness against the cues.** 2-8 kHz (where `deflect` cuts through) relative to the mids:
  `boss` -12.6 dB, `dungeon.ember` -13.1, `dungeon.frost` -19.0, `menu` -28.1. "Electric Exodus" read
  -3.0, ten dB brighter than any shipped bed, and near-mono (L/R +0.93); "Endless Cyber Runner" reads
  -14.9 and L/R +0.49. That, with the flam, is why the better-named track lost.

Also measured and passed over: "Perpetual Tension" (Zander Noriega; 20-250 Hz 13.4 dB above its mids),
"Trepidation" and "Sabotage" (Tsorthan Grove; seams 0.9-1.4 dB, passed over for character: suspense
pieces rather than driving ones), "Storm Chasers" (Eldritch Grim; an epic trailer cue, closer to a
boss theme, whose 1.23 dB seam flams by 400 ms), "Meteor (fight)" (Jan125; best seam 1.85 dB with a
+0.9 dB swell), "Tense Drive" (beardalaxy; best real seam 0.95 dB, flamming by 90 ms), "Tense Future
Loop" (gmason; a 59 s repeating loop whose seams are 0.4-0.5 dB or dip ~1 dB in the fade), "ICI
Storm" (an uplifting dance build whose master peaks above 0 dBFS), "Heart of Machine" (Alexandr
Zhelanov; 1.94 dB at best) and "The Memory Factory" (Eric Matyas; a 32.5 s file, too short to cut a
40 s region from).
The 50 s length is the byte budget's: 522.9 kB took the pack to 2.85 of 3 MiB.

**The chapter-4 bed (`dungeon.blight`, added last the same day).** Chapter 4, the Blight Descent, is
the poison biome and the finale: the source of the crystallising contamination. The brief was
ominous, organic and creeping rather than driving, and distinct from the four beds before it. 38
candidate files were measured: 28 from OpenGameArt (every Eric Matyas upload with a dark or eerie
title, plus searches for swamp, toxic, poison, plague, creeping, ominous, sinister, dread, sewer and
cavern) and 10 from Kevin MacLeod's incompetech library (CC-BY 4.0); OGA-BY, CC-BY-SA and GPL
listings were skipped on licence alone. The storm pass's three extra measurements were run on each
source's best regions from 40 to 62 s, and on the finalists again over a fine grid from 46 to 56 s:

- **The pick, "Ominous Goings-On"** (Eric Matyas, the composer's looping version): 49.5 s from 15.0 s
  closes at 0.67 dB on the upstream file (0.65 dB shipped), the overlap material correlates +0.05 and
  the equal-power fade moves the level +0.14 dB. It has no beat to flam: the best onset-envelope
  correlation between tail and head is 0.15, against 0.7-0.95 for the rhythmic sources below. At 2-8
  kHz it sits 25.0 dB under its mids (spectral centroid 404 Hz), the darkest run bed, so nothing in it
  competes with `deflect`; L/R +0.28. 20-250 Hz is 4.2 dB over the mids, under the 5.3-6.4 dB that got
  the shelf on the other three, so it ships without one. Its 0.65 dB is lower than the 1-2 dB the
  warning above asks for, and it was taken anyway because the warning is about correlated overlap and
  this overlap measures uncorrelated; regions of the same piece that do correlate (+0.39 at
  16.0 s / 47.0 s) swell +1.1 dB and were passed over.
- **Runners-up.** "Lightless Dawn" (Kevin MacLeod; 0.53 dB at 48.5 s, but a +0.7 dB swell and a
  sub 6.9 dB over the mids that wants the shelf); "Gathering Darkness" (Kevin MacLeod; 0.38 dB whose
  overlap anti-correlates -0.31 and dips 0.8 dB, or 0.74 dB with a +0.6 dB swell); "They're Here"
  (Eric Matyas; an alien-horror cue whose best region near 50 s is 1.43 dB with a 1.4 dB level step);
  "Sector Off Limits" (Eric Matyas; 0.35 dB, but a dystopian-city piece rather than an organic one);
  "Static Motion" (Kevin MacLeod; 0.53 dB only at 62 s, and 0.94 dB with a 0.9 dB dip near 48 s).
- **Rejected on a measurement.** "Diabolical Swamp" (Android128) repeats: overlaps correlate +0.97
  and swell 1.9-2.2 dB, and it is near-mono (L/R +0.93) with 20-250 Hz 10.4 dB over its mids.
  "Insistent" (yd) closes at 0.06-0.18 dB, the repeating-piece signature, and its best region
  correlates +0.55 and swells 1.3 dB. "Netherplace", "Lost and Faltering" (Eric Matyas), "Darkness is
  Coming" (Kevin MacLeod), "Menace" (yd) and "Imaginary Dystopia" (Spring Spring) are beat-driven and
  flam by 10-215 ms in every region the search ranked best. "Dark Cavern Ambient" (Paul Wortmann) and
  "Dark Fog" (Kevin MacLeod) are sub drones (14-18 dB over their mids). "Cryptic Dreams" (Eric
  Matyas) anti-correlates across the fade (-0.29, a 1.8 dB dip), "Mesmerize" (Kevin MacLeod) dips
  0.9-1.2 dB, "Hazy Darkness" (Eric Matyas) swells 2.2 dB at its only region under 2 dB, and
  "Ossuary 5 - Rest" (Kevin MacLeod) steps 0.9 dB in level at its best. "Disturbed Soundscape",
  "Uneasy Anticipation", "The Wizard's Concoction", "Sewer Creepers Down the Drain" (Eric Matyas),
  "Spider Eyes" (Kevin MacLeod), "Mysterious Sewer" (smark, and mono) and "Damp Cavern"
  (tcarisland) could not close under 1.9 dB; "Troubled Forest" (Eric Matyas) reached 1.87 dB only in a
  48 s file; "The Bog of Doom", "Mysterious Anomaly" and "Night Stalker" (Eric Matyas) are 30-36 s
  files, too short for a 40 s region.
- **Rejected on character, stated as taste.** "Dark Descent" (Matthew Pablo; 0.78 dB, but an epic
  choir-and-action cue, closer to `boss` and with the choir `boss` was cut to avoid); "The Plague"
  (Indieteur, CC0; an electronic apocalypse piece, 2-8 kHz only 7.9 dB under its mids, brighter than
  any shipped bed, and a master that peaks above 0 dBFS); "The Swamps" (fluffclipse; tagged calm, a
  swamp party theme); "Dubious Dungeon" (Bogart VGM; near-mono, L/R +0.97); "The Monster Factory"
  and "Dystopian Wasteland" (Eric Matyas; a funky industrial piece, and a drone 41 dB dark in
  2-8 kHz); "Long Note Four" (Kevin MacLeod; a ten-minute static drone); "Unseen Horrors" (Kevin
  MacLeod; 2-8 kHz 7 dB under its mids).

It costs 411.7 kB, the smallest of the six (a dark, slow piece is cheap to encode). Like the others,
nobody has listened to it in the game.

**Tempo.** Every loop ships at its written tempo. The 2026-09-06 "0.7x" request was about the two
Suno masters and was applied as one module-wide factor; it is now a per-track `tempo` in
`process_music.py`, 1.0 for all six, because a 30% Rubber Band stretch is audible processing on a
played recording. The mechanism (`time_stretch`, stretch-before-slice, search-on-the-stretched-signal)
is unchanged for the day a track wants it.

**Archive: verbatim or excerpt.** The upstream downloads are a 20 MB 320 kbps mp3, a 24 MB 7z holding
FLACs and a 50 MB zip holding WAVs. Archiving those would add ~95 MB to the repository for loops that
read ~60-85 s of each, so `sources/music/` holds the upstream file verbatim when it is small (the lava
ogg, 1.96 MB) and otherwise an EXCERPT: the loop region plus 5 s either side, Vorbis-encoded (the
storm excerpt keeps its upstream's 96 kHz and is 1.06 MB of a 6 MB file; the blight excerpt is
59.5 s, 0.79 MB of a 4.9 MB file). Each
`credits.json` record carries the upstream URL and SHA-256 (and the member file inside an archive),
so the whole master can be fetched back and checked; `region_start_s` is in the archived file's
seconds and `excerpt_start_s` places it upstream. `musicAssets.test.ts` hashes every archived file
against its record.

**Licensing and the credit.** Five loops are CC-BY, so for the first time something in the game
REQUIRES a visible credit. It is on the Settings screen, under both columns
(`client/src/audio/musicCredits.ts`): plain text, because WeChat cannot follow an outbound link, and
untranslated except for its label, because a title, a name and a licence are proper nouns. The CC0
track is credited too, so the list of composers is complete. Each licence statement is captured from
its source page in `licenses/music-*-LICENSE.txt`, and `musicAssets.test.ts` holds the in-game line,
title, author and licence equal to the `credits.json` record. One gap is recorded rather than filled:
Matthew Pablo's own attribution page is offline (it was unreachable through the Wayback Machine on
2026-10-06), so his credit follows the licence's own terms (CC BY 3.0 section 4(b)).

**What the Suno pass left that still holds.** The level target (250-2000 Hz RMS at -30 dBFS, which
leaves every cue's peak 9.1-15.7 dB above the bed), MP3 rather than Vorbis, stereo, the zero-phase
shelf, the search ranking on the same measure as the gate, and the player-closed loop. The
`music_terms` block and the declared prompt gaps went with the masters; the masters themselves were
deleted from `sources/suno/` (they remain in git history).

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
