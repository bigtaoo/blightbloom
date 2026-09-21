# Work log — 2026-09-03: design-doc coherence

Volume 17, and the second doc audit of the same day — volume 16 is a concurrent session's
sweep of the technical docs' POINTERS (paths, links, quoted constants, the step order). The two
are complementary and were run without knowledge of each other: that one asks whether every
reference resolves, this one asks whether the gameplay rules a doc states are the rules the
code implements. Neither found the other's defects.

One pass: an audit of the gameplay design docs for self-consistency and
agreement with the code, and the four rounds of fixes it produced.

Indexed from [`../ROADMAP.md`](../ROADMAP.md).

## The docs' locked decisions had been superseded by their own later sections (2026-09-03, docs + engine + client, `ENGINE_VERSION` 54)

An audit rather than a report — *"analyse the current design docs: is the gameplay self-consistent, and is anything missing or out of step with what is implemented?"*.
The answer to the first half is yes: the loop, the two modes, the survivability model and the
parry mechanic hang together, and nothing in this pass changed a rule. The answer to the
second half is where the work was, and it has a shape worth naming, because it is not
"the docs are old" — most of these docs are edited weekly.

**The stale part of a doc is the part a reader meets first.** Every gameplay doc opens with a
`## The decisions (locked)` list. That list is the part nobody edits: a later dated section
revises the decision, and the locked bullet keeps stating the original. Four of them in
`design/05` alone, and one of those revisions said outright that it superseded *"the looser
phrasing at line 70"* — citing a line number, which had long since moved. Recorded as shape
(i) in the design-docs memory, with the schema-code-fence sibling below.

### 1. The death-forfeit rule — the one that mattered

The locked bullet said a death costs *"only this floor's un-banked materials (extraction
points are checkpoints)"*, and that promise is the entire justification for the mode
existing: it is what makes this "a softened extraction loop" rather than the extraction
shooter the same doc rejects three paragraphs earlier.

It is not what ships. `design/05`'s own Open-questions decision (ROADMAP 3.2) says a wipe
forfeits the **entire un-extracted carry-out**; `RunOutcome.lose()` never calls
`bankRunMaterials`, so `state.bankedMaterials` dies with the run; and
`RunOutcome.test.ts` already pinned that with a `bankedMaterials = { fire: 9 }` fixture
asserting nothing reaches the account. The same wrong claim also sat in `design/09`'s
materials bullet, ROADMAP 1.4, and `ExtractionSystem.ts`'s own module doc — which asserted
it as the rule its merge implements, while that merge is only half the story (the other half
is a client call the system cannot see).

**Docs were aligned to the shipped rule, not the reverse.** Changing the economy so that
DESCEND really does bank against a later death is a balance decision with an
`ENGINE_VERSION` bump, a golden re-record and a difficulty re-tune behind it; it is not a
drift fix, and it was flagged back to the user as the one open call rather than taken here.
Two consequences are now written down where they were previously left to inference: the
softening this mode offers is *"nothing persistent is ever lost"*, and the
`floorMaterials` → `bankedMaterials` split is per-floor bookkeeping for the HUD, **not** a
risk boundary — both pools go together.

**A player-facing instance of the same error, fixed:** the defeat screen said "The floor's
materials were lost" in all 8 locales while the run lost everything. `results.materialsLost`
now takes a `{count}` — the sum across both tiers — so the number on screen is the number
the run actually cost. Two new tests pin that the count spans both pools, since the copy
naming only one is exactly how it drifted.

### 2. Three behaviour bugs, each a claim the docs made that nothing enforced

The audit's real yield. None was found by reading code; each was found by taking a doc
sentence literally and asking what stops it from being false.

**A run could carry two guns, no melee weapon, and therefore no parry.** `design/03` and
`design/05` both state the invariant as fact — *"every loadout carries one gun and one melee
weapon, so parry is always OWNED"* (`ENGINE_VERSION` 45) — and `design/03` goes further,
using it to justify moving the ranged/melee trade-off from build-level to moment-level. It
was enforceable in neither place that could enforce it: `resolveLoadout` fills only FREE
slots by kind and honours a staged same-kind pair verbatim (deliberately — an explicit
choice is never discarded), and `meta/forge.ts craft` checked the slot COUNT only. A fresh
account starts with five blueprints unlocked, of which `repeater` and `scattergun` are both
guns, so this was reachable on the first run anyone plays. And `ENGINE_VERSION` 46's
same-kind pickup rule then *preserves* the broken state: with two guns, every floor blade
overwrites a gun rather than filling the missing kind.

`craft` now returns a new `'kind-taken'` failure for a kind already staged.
`resolveLoadout` is untouched, so a hand-built `EngineConfig` (tests, the sim harnesses)
can still ask for two of a kind on purpose — the forge is the only place a normal run can
acquire the pair, which is why it is the right gate. The blueprint card also had to learn
it: without a status the press just plays `ui.denied` on an unlocked, affordable weapon,
which reads as a lost input rather than a rule (`forge.kindTaken`, 8 locales).

**A heal collected at full HP was destroyed.** `design/05` has carried a locked clause since
the mode was written — *"the pickup radius only triggers when the effect would actually do
something — at full HP the health pickup is left on the floor for you to grab later"* — with
its own reason attached: there is no item bag, so an instant item collected at full effect is
gone for nothing. `PickupSystem.apply` implemented `p.hp = Math.min(p.maxHp, p.hp + 1)`
behind an unconditional overlap test. HP never regenerates (`design/07`: *"the hard floor…
recovered only by items"*), so this deleted the only source of the only pool nothing else
restores, in a mode whose difficulty target is *"hard overall"*.

Fixed by `pickupWouldApply(p, item)` ahead of the overlap test. It is a `continue`, not a
`break`, so a full-HP teammate standing on a drop cannot deny it to a hurt one on the same
tick. Only `heal` has a clause: `material`/`bandage` accumulate uncapped, and a `buff` is a
stack entry Σ-clamped at USE time rather than an instant item, so "already wasted" is not a
question the pickup site can answer.

*Two consumers of that rule caught themselves lying about it in the same run.*
`?pickupDebug=1`'s contract is "a green dot means the sim would collect this", and its
parity test drives the real `PickupSystem` beside the readout — it went red the moment the
gate landed, because distance had stopped being the only condition. `pickupWouldApply` is
exported and the overlay asks it rather than restating it (design/18 G6). `replay/inspect`
inherits the fix through `pickupDebugGate`, and its header now says that a heal reported as
never-collectible is a legitimate verdict to cross-check against the player's HP — worth
recording, since this tool exists for the *"there are still drops that cannot be picked up"* lineage and a new
benign cause of that reading would otherwise be read as the bug.

**The two weapon buttons were the same control.** `platform/TouchControls.ts` has a
`weapon1Btn` and a `weapon2Btn`, each passing the slot it names to `onSwitchWeapon(slot)`
(as do `Digit1`/`Digit2`); `Game.ts` discarded the argument and called `requestSwap()`
unconditionally. So both buttons toggled, and pressing "weapon 2" while slot 2 was active
switched you off it — a labelled control doing the opposite of its label every other press.
`design/05` and `design/10` had also disagreed about this for months (one switch button vs
weapon-1/weapon-2), and neither described what shipped. New pure
`controllers/weaponSlotSelect.ts` bridges the two: a press becomes a `SWAP_WEAPON` request
only when the slot it names is not already active. The engine's single-toggle bitfield is
unchanged — the answer to `design/10`'s old "two dedicated slots or one toggle?" open
question turns out to be both, bridged in the client.

### Why the bump, when the golden gate did not move

Measured before bumping, per the gate's own rule: all five scenarios' hashes **and**
witnesses came out byte-identical for the heal change. That is a statement about the
fixture, not about the change — no scenario in the set ever has a full-HP player overlap a
heal (the two that collect anything are damaged by then), so it is blind to this branch by
construction. The change can still diverge an old recording: an uncollected pickup stays in
`state.pickups`, which is hashed and which a later tick can still collect. Bumped to 54;
the five hashes then moved only because `version` is itself serialized, with every witness
unchanged. Coverage is unit-level instead (`systems/pickups.test.ts`, +4), and the
pre-existing "heal restores up to maxHp, never over" test gained a `pickups.length`
assertion at each step — it asserted `hp` only, and "hp unchanged at full HP" was already
true of the bug, which is why 1137 green engine tests never saw it.

### 3. Five mechanics the docs describe in the present tense and nothing implements

Filed as `ROADMAP` B1-B5 rather than left in running text, because a mechanic named in a
core-loop diagram reads as built — which is how all five survived. Each doc sentence now
points at its backlog item.

- **B1 chests.** `design/05`'s loop diagram says *"clear (some of) its rooms: fight, open
  chests, pick up weapons & materials"*, its controls section says `INTERACT` opens them, and
  `design/07` step 9 says a chest rolls the drop table. There is no chest entity in the repo;
  `INTERACT` drives the revive channel and nothing else, and every drop comes from a death or
  an arena loot marker. A room has nothing to *find*, only things to kill.
- **B2 the run-buff offering flow.** `design/05`/`design/14` both say buffs are found in
  *"chests / rooms / shop"*; `balance/runbuffs.ts` concedes the shipped reality. The in-run
  power layer that replaced the affix system is delivered by a 6/84 weight on the kill table
  — never offered, never chosen, never a decision.
- **B3 a mid-floor extraction room.** *"You need not clear a floor… an extraction room
  mid-floor lets you leave one or two rooms unfought"* is the source of the "greed for the
  last chest vs. leave safe" micro-decision. Zero rooms are skippable, for two independent
  reasons: the capstone is always last (`generateFloor` appends it; `placeAuthoredFloor` and
  the editor's save gate require `rooms[last]`), and a room's doors lock as a unit while it
  holds a live enemy, so on a chain floor every room on the way must be cleared. Level 1's
  floors are chains with no alternate route. Fixing it needs both halves. The same finding
  retired an over-claim in the 2026-08-15 stranded-enemy entry, which costed its bug at "a
  hundred enemies per floor for a player who beelines the capstone" — nobody can beeline
  anything; the two routes that entry names are real regardless.
- **B4 `dropTableByDepth` / `materialTierByDepth`.** `design/09`'s `DungeonConfig` lists
  both, and both that doc and ROADMAP 1.5 called `materialTierByDepth` "an unwired schema
  field" — a claim that sounds verified and is strictly worse than absent. Neither field was
  ever added to `world/dungeon/types.ts`. Depth buys material TIER via a `tier = floorIndex`
  identity in `rollDrop`, which is enough to make `minTier` recipes demand deeper floors; a
  configurable curve and a per-depth drop POOL are both unbuilt.
- **B5 blueprints that drop from runs.** `design/14`: *"2-3 common blueprints drop from
  runs"*. `Pickup` has no blueprint kind and no table can roll one. `STARTER_BLUEPRINTS`
  hands over every `source: 'drop'` entry — five, not two or three — at account creation
  instead, which `content/blueprints.ts` describes as a stand-in for exactly this. So a
  blueprint is obtainable only free-at-signup or bought, and the earn-by-playing path that
  makes *"sell breadth, not power"* read as fair does not exist.

### 4. The drift sweep

`00`/`02`/`03`/`05`/`07`/`09`/`10`/`14`/`15` + ROADMAP + two code comments. Grouped by what
went wrong, since the shapes repeat:

- **One retune, five wrong copies.** The 2026-07-28 skin rebalance (recorded in `design/15`)
  left `design/05`, `09`, `14`, `15` and ROADMAP 2.3 each carrying a **different** stale
  triple for the 3-character roster. Shipped is vanguard 6/3.2, skirmisher 3/6, juggernaut
  11/0; `content/skins.ts` is the source of truth and carries the per-character reasoning.
  `design/15`'s PvP scaling example was quoting the pre-retune inputs of the very pass the
  next paragraph describes.
- **A number superseded inside its own file.** `design/05`'s survivability bullet said shield
  regen is 1 point / 10 s; the Room-encounter-budget section further down the same file cut it
  to 2 s at `ENGINE_VERSION` 41 and explains why.
- **A locked type claim that shipped content breaks.** `design/07`/`09`/`02` said both health
  pools are integers. The vanguard's `maxShield` is **3.2**, deliberately, so no two
  characters share an `(hp + shield)` budget. It is safe — every operation on the pool is
  integer `+`/`-`, exact in IEEE-754 and therefore deterministic, and `replay.ts` hashes it
  directly — and it is not free: it is what puts `hpTotal: 3.4000000000000004` in the golden
  witness, and the first `*` or `/` on that field would put platform-dependent rounding into
  the state hash. `design/07` now says that, including the condition for keeping it safe.
- **A superseded model still in the future tense.** `design/07`'s locked list said faction
  gates every interaction, two `ENGINE_VERSION`s after `isHostile`/`teamId` replaced it —
  and `design/15`'s team-hostility section, which shipped that model, still read as a
  requirements list (*"today player-vs-player damage does not exist"*). Both corrected;
  `15`'s requirements prose is kept as written, since *why* each piece was needed is still
  the clearest account of it.
- **Schema code-fences drifting from the interface.** `design/09`'s `DungeonConfig` was wrong
  in five ways (a missing third `layout` member — the one the shipped config uses; two field
  names; two fields that do not exist) and its `Pickup` union was missing `bandage` and
  `crate`. A code-fence is prose and drifts like prose; these are mechanically checkable.
- **Two docs' worth of pickup rules that had been replaced twice.** `design/02` still
  described walking onto a weapon and pressing `INTERACT` to fill the ACTIVE slot — replaced
  by the click panel (v32) and then by same-kind matching (v46), the latter after a live
  report of exactly the bug the active-slot rule caused.
- **`k_*` procs listed among the things the affix cut removed** (`design/09`, `design/14`),
  while they are shipped weapon content (v28). The cut removed the per-instance ROLL; a proc
  baked into one weapon was never an affix. `design/09` also still called the affix removal
  "tracked as a separate task" 40 lines from its own record of it shipping.
- **"Twin-stick" describing a layout.** One stick since `design/10` v33 removed aim input.
  Fixed where it describes the controls (`00`, `05`, `10`); left where it is a genre label
  (*"a real-time twin-stick shooter"*, `06`/`08`), which is still fair.
- **`design/03`'s Frame-axis status cell** said *"only `straight` shipped — the main gap"*
  twenty lines above the table listing every frame as shipped.
- **`design/10`'s HUD table** promised an "Ammo / charge" row; no weapon has ever had an ammo,
  magazine or charge field. Kept as a struck row rather than deleted, so the table cannot be
  read as promising it.

### Verification

`typecheck` clean; the file-length gate green — `Game.ts` is baselined debt and the first
draft grew it by 9 lines, so the whole bridge moved into `weaponSlotSelect.ts` and the call
site came back to one line under the baseline.

**This pass adds 17 tests** — engine +4 (`systems/pickups.test.ts`), client +13
(`weaponSlotSelect.test.ts` 6, `meta/forge.test.ts` 7) — plus 2 repaired fixtures and 2 new
assertions on the pre-existing heal test. Absolute suite totals are deliberately not quoted:
volume 16's concurrent pass landed its own +23 engine and +40 client tests between this
branch's base and its merge, so any total measured here would be a number this pass did not
produce. `npm run check` is green on `main` after the merge, which is the run that counts —
and the root leg's honest count is measured with no sibling worktree checked out, since
`.claude/worktrees/` lives inside the repo and doubles that glob.

**Neither sim moved**, which is the check that matters for a change to a heal: `test:pve-sim`
passes all five gates with the careful bot still averaging deepest floor 1.9 and a worst
1-second window of 5 against 9.2 effective HP, and `test:pvp-sim`'s win rates come out
80/31/69 — identical to the same harness run on `main`. So none of this was a balance change
in disguise. The bots seek a heal only when hurt, which is exactly why the gate is invisible
to them and needed unit coverage instead.

Two fixtures had to be repaired rather than the code: `PickupDebugOverlay.test.ts`'s
distance sweep built a full-HP player (making every `heal` distance vacuously
uncollectible — caught by the sweep's own anti-vacuity guard), and `replay/inspect`'s
synthetic state omitted `hp`/`maxHp` entirely. Both now damage the player on purpose and say
why, and the usefulness rule got its own test in each file instead of riding on the
distance one.
