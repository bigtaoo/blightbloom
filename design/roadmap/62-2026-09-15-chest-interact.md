# Work log — 2026-09-15

Volume 62. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The chest nobody could open (2026-09-15, engine + client + art + audio + docs, `ENGINE_VERSION` 65→66)

> *"宝箱无法打开。"* — with a screenshot of a player standing on one.

The mechanic was fine. That is the whole finding, and everything below follows from it: a headless
run opens the shipped level-1 cache chest the tick a command carries `INTERACT`, and the running
client opens it on the first frame a `KeyE` reaches `WebInput` — both verified **before** anything
was changed, which is what kept this from becoming a hunt through `ChestSystem` for a bug that was
not there.

What was missing was any way to find out the mechanic existed. A chest had **no art, no sound and
no prompt**, and `INTERACT` is taught nowhere — `tutorial.hint*` covers move, attack, swap and
deflect and stops. **A mechanic nobody can discover is indistinguishable from a broken one**, and
that failure is structurally invisible to a green engine suite: every `ChestSystem` case passed
all day.

### Two fixes, and the second deleted half the first

The first pass added the missing sentence: `ui/ChestPrompt.ts`, a bottom-centre caption naming the
control this device actually has (`E`, or the touch `+` pad). The owner's answer a few hours later
was to **delete the step instead** — *"开普通箱子不要额外操作，玩家靠近后自动打开"* — so a small chest now opens
on APPROACH and its caption is gone with its button, along with three strings in eight locales.
Both halves are worth keeping in mind, because they are different lessons: a step nobody can
discover needs explaining, **and the cheapest way to make a step discoverable is often not to need
it.**

`ChestSystem.openWanted` drops the `interacting` term for a small chest; `CHEST_INTERACT_RANGE_GRID`
became `CHEST_OPEN_RANGE_GRID` (same 1.5 — the word stopped being true). A big chest is untouched:
it never read a button, and still wants every mechanism plate occupied on the same tick. What
survives of the caption is the big chest's live `{on}/{total}` plate count, shown from the
mechanism ring outward so it stays up while the player walks out to a plate to do the thing it
asked for — a rule a ring of discs cannot state on its own.

**v63's argument for the button is recorded rather than erased**, in `ChestSystem`'s own header: a
held `INTERACT` was chosen so that spending a floor's loot was *a decision*. It assumed the player
knew the button existed. The decision a small chest still carries is whether to walk into its
dead-end side room at all, which is the choice that was actually costing something.

**The revive arbitration went with it.** v63 mirrored `ReviveSystem.findReviver` inside this system
so a rescuer's held button could not also spend a chest; no chest reads input now, so the mirror is
deleted rather than kept — a rule that cannot fire is a rule nobody can test. The visible
consequence is intended and pinned by a test: **a small chest beside a downed teammate opens while
you revive them.**

### The golden gate was blind to the rule it is the only witness to

`goldenHash.test.ts` stayed green across the change, before and after, with no re-record. The
`chest-room` scenario pulsed `INTERACT` every 3 ticks — and `tick % 3` includes **tick 0**, so its
small chest opened on the first tick under both rules. The one scenario that can see `ChestSystem`
at all could not tell the two apart.

The fix is the scenario, not the hash: `chest-room` now presses **nothing** (`chest: false`), so
both chests open with no button anywhere in its input stream, and the old rule would finish that
run with `chest_open: 1` instead of 2. The recorded hashes moved on the version stamp only
(`replay.ts` hashes `ENGINE_VERSION`), with **all seven witnesses identical** — which is the check
that the rule change really is invisible to every other fixture.

### Art: four states, and the number that let the pairs ship

Four generations, all accepted first time, measured before being called usable: `chest_small`
(874×629 body, aspect 1.39, median luma **107**), `chest_small_open` (0.94 / 41),
`chest_big` (1.45 / **49**), `chest_big_open` (0.82 / 30).

- **Footprint share** is what decided the pairs could ship at all — the widest opaque run in the
  bottom tenth of the file over the file width, i.e. how much of the picture is the box standing
  on the floor. The two sprites of a pair swap in place on one ground point and are scaled by
  WIDTH, so a smaller share in the open file would visibly shrink the chest at the moment it pays
  out. The four land within **0.026** of each other; `scene/chestArt.test.ts` holds each pair to
  0.05.
- **The long axis is per FILE, not per cue**: 8× the drawn long axis, and for the two open files
  that is the HEIGHT (the lid is up) — 153 and 275, not 144 and 224. Each pair still came out the
  same WIDTH, which is what makes the in-place swap stable, and it fell out of the arithmetic
  rather than being forced.
- **The alpha plateau arrived on all four**, exactly as the 2026-08-24 props batch predicted, and
  `alpha-audit.mjs` calls every one of them clean (haze 0.3-0.8%). What lied was the TRIM: the small
  chest's raw bounding box reads aspect **1.17 against its real 1.39**, a chest that would have
  stood 19% too short. `alphaClamp.mjs` first, measure after.
- `ChestLayer` draws a bottom-anchored sprite scaled by width with the art's aspect setting the
  height (`propRender`'s exact treatment) plus the ground shadow every other body in the scene
  casts; the Graphics form stayed as the fallback and was **re-anchored to the feet** so the two
  stand in the same box. A chest that jumped half its height the frame its texture arrived would
  be a cold-load-only bug nobody could reproduce.
- **Watch item, stated rather than found later:** the big chest reads at median luma 49 against the
  scenery crate's 53 — the comparison the small chest's own prompt spends a paragraph forbidding.
  It ships because SIZE and FORM carry the distinction (28 px domed iron against 18 px flat brass),
  which is design/13's dual-channel rule in the two channels that survive greyscale. If it reads
  wrong in play the fix is a brighter timber on a reroll, not a tint in the renderer.

### Audio: the band metric picks a cue for the third time

`chest.open`, 2 variants, 8.5 kB. Fourteen candidates out of the RPG Audio pack the game already
uses (zip re-fetched and **sha256-verified against `packs.json`** — the record that exists for
exactly this), ranked on the 500-4000 Hz band-vs-peak figure the `hurt` pass introduced, because
that is the band a phone reproduces. `creak1`/`creak2` are the pair that measure as **one action
twice** (centroid 3230/3486 Hz, band 17.1/17.3 dB under peak, level with the shipped
`pickup.weapon` at 17.5 and `spawn` at 17.6); `creak3` was dropped for being a third of the length
and an octave darker — variety, not a variant — and the latch/door/leather families for sitting
24-29 dB down in that one band.

**The cue is the LID, not the reward.** The payout announces itself through `pickup.weapon` a tick
later, and that step-order claim — made in `ChestSystem`'s header since v63 with nothing checking
it — is now a test. `process_reaction.py` grew the cue rather than a fifth driver being written:
what decides which driver a cue belongs to is where its peak reference comes from, and its
docstring now says that instead of naming a category it had outgrown. Re-running it reproduced all
eleven existing files **byte-identically**.

**Verified on the live SFX bus**, which is the only thing that replaces listening here: silence
reads 0.000, the cue fired directly reads **0.0695**, and a chest coming into range with the room
emptied reads the same 0.0695 through the real event path (`pickup.weapon` 0.0625, `wave-clear`
0.0862, `impact` 0.0907). The room has to be emptied first — driving frames by hand fires combat
cues, and the first attempt measured them instead.

### What the tests did, including to themselves

**Four existing gates fired on their own and all four were right**: the cue count, the audio
pipeline's fixture table, the "engine events the client deliberately does not react to" list (which
had carried `chest_open` as *"a chest pays out in silence"* for exactly one day before that silence
was reported as a bug — the list working as designed), and the voice-cap saturation case.

**A test that passed and pinned nothing.** The first version of the one-tick-gap test asked for the
payout's id only once it existed — a tick late by construction — and deleting `PickupSystem`'s
`spawnTick` guard did not make it fail. It now runs twice: once to learn the id (the engine is
deterministic), once with that request **already standing** from tick 1.

**A property defended twice looks like a gap in the test and is not.** With the rewrite, deleting
the `spawnTick` guard alone still leaves it green, and so does swapping step 10 with 10.5 — both
together turn it red. That is recorded in the test, so a future reader does not read a surviving
single mutant as a hole.

**A literal that stopped being true.** The saturation case asserted "every cue above priority 50
keeps its slot"; `chest.open` at 85 pushes `impact` at 60 over the cap edge, so the boundary is now
derived from the ladder — the same repair that case's own comment records for the literal `3` it
used to carry.

New: `scene/chestArt.test.ts` (the shipped PNGs), `ui/chestProximity.test.ts` + `ui/ChestPrompt.test.ts`
(the caption), `controllers/hudContext.test.ts` (the HUD context mapping, split out of `GameLoop`
when that file hit exactly 500 lines and needed one more field), four reactor cases for the cue, and
two engine cases for the gap. engine 1,600 → 1,602; client 6,305 → 6,369.

### Still open

- **The PvE sim's bot never enters a side room**, so the loot instrument reads **0 weapons per
  floor** on a level whose weapons have lived in chests since 2026-09-14. Not introduced here, but
  this pass is what makes it matter: the whole weapon economy is now behind a door the measurement
  never opens.
- **Nobody has listened** to `chest.open`, or to the 61 cues before it. Unchanged, and still the one
  open item on the audio set that measurement cannot close.
