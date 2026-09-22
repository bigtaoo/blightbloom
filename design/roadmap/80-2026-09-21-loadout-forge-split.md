# Work log — 2026-09-21

Volume 80. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## One screen was answering two questions: the loadout leaves the forge (2026-09-21, client + docs, no engine change)

> *"change the screen you enter the game on. 1, give the currently selected character a picture, with the text to the right of it. 2, the weapons below should be only the ones already forged, with a jump to the forge at the end. 3, put forging on its own page, with its own entrance in the lobby."*

Three numbered asks against a screenshot of the screen SOLO PvE opens, with the character
line circled. Taken one at a time they are a portrait, a shorter list and a new route. Taken
together they say something about the screen: **it was answering two questions at once, and
the second one had taken four fifths of the pixels.**

"Who am I taking in, with what?" and "what should I spend my materials on?" shared one
screen. The second is a paged grid of the whole `BLUEPRINT_CATALOG` — 24 entries over three
pages, most of them locked or unaffordable on any given visit — and it sat where the kit
should have been, above a one-line `Loadout (none → Blaster + Saber)` that was the only
statement on the screen about what the run would actually carry.

So `Forge.ts` kept the crafting grid and became a page of its own, and everything else moved
to a new `screens/Loadout.ts`. What that split had to decide, rather than move, is the rest
of this entry.

### The weapon row is `resolveLoadout`'s answer, not `m.loadout`

The literal reading of ask 2 — *only the ones already forged* — draws an empty row most of
the time, and that would be a screen lying about the run it is introducing. A fresh save's
`loadout` is `[]`, and a crafted weapon is consumed by the run that carries it (design/05),
so **"nothing staged" is the state every run after the first begins in**. What the engine
does with that list is fill each free slot from `PLAYER_BASE.startWeapons` with a kind the
staged list does not already cover (`ENGINE_VERSION` 45, the rule that makes *"every loadout
carries one gun and one melee weapon, so parry is always OWNED"* true). A row drawn from
`m.loadout` would therefore show a player **nothing at all, immediately before handing them
two weapons**.

The row is drawn from `resolveLoadout(m.loadout)` — the same function the run itself is
built through — and the cards carry the difference: a forged one keeps the ▸ badge and a
green `forged`, a filled-in starter reads `default kit` in grey. A starter is deliberately
NOT drawn with the `locked` styling the crafting grid uses for a blueprint you cannot have;
it is a weapon the run IS carrying, and the first draft's grey name and 40%-alpha icon read
as *unavailable* in the screenshot.

The count beside the row is the other half of the same care: `Weapons taken in 0/2` counts
only the forged slots, applying the same two rules `resolveLoadout` applies (unknown ids
dropped, then capped at `weaponSlots`), because a count derived any other way eventually
disagrees with the cards next to it. An id no catalog knows reads `0/2` over two starter
cards rather than `1/2`.

### BACK is a recorded door, not a destination

The forge has two entrances now — the lobby's FORGE row and the loadout screen's FORGE
card — and a fixed BACK is wrong at one of them. `RunState.forgeReturnPhase` records which,
the same shape `matchmakingReturnPhase` already had for the two ways into a queue, and
`ScreenNav.leaveForge` honours it. The failure it prevents is small and irritating: a player
two clicks from starting a run, who stepped into the forge to look at a recipe, dropped back
onto the front door by the button that says it goes back.

The store's BACK passes `run.forgeReturnPhase` straight back through rather than re-recording
`'menu'`: a purchase screen is a round trip to the same page, not a third way in.

### The lobby row is arithmetic, not taste

FORGE is a sixth route, and it shares a line with SQUAD at half width. That is not a
composition choice. The **tallest legal lobby** — a portal build's quick-play row and data
notice, the longest legal maintenance banner, and a resumable save — already measures 630 of
a 640 px design height in all eight locales, so there were **10 px to spend and a full-width
row costs 47**.

A two-up row is exactly what the 2026-09-10 lobby pass tried and rejected: `PVP SOLO QUEUE`
needs 169 px of label in a 135 px button, and the same held in seven of eight locales. What
makes it safe here is that the labels are short — 8 characters at worst (`SCHMIEDE`,
`ESCOUADE`) against an ~87 px budget — and, more to the point, that the claim is now
*checkable*: `labelFit.test.ts` exists because of that rejection and measures every label
against its own button in every locale, so the sum in this paragraph is a prediction the
suite confirms rather than a comment nobody can re-run.

### The keyboard table split with the screens

`[1-9]`, `[↑↓]` and `[B]` act on the blueprint grid and now run **only** in the forge phase;
`[C]`, `[X]` and `[Enter]` act on the kit and run only in the loadout phase; `[F]` is a new
key and it is the bridge. A single merged table would leave `[X]` emptying a loadout whose
cards are not on screen, and `[Enter]` starting a run from a screen with no START RUN on it —
a key is an alias for a control, and a control that is not drawn has no business firing.

The floating SETTINGS button moved with the pre-run half, so `SettingsReturnPhase` is
`'menu' | 'loadout' | 'paused'`, and `openSettings` refuses from the forge: BACK out of
settings routes by that field, which has no `'forge'` member to be set to.

## The bug that shipped for one screenshot, and the gate it bought

`CLEAR LOADOUT` was aligned to the left edge of the weapon row — `cx - 212` — and `START RUN`
begins at `cx - 110`. A 160 px button was drawn **58 px underneath the primary action of the
screen**, and it was found by looking at a screenshot.

Both existing sweeps stayed green, and both were right to. `viewportFit.test.ts` asks whether
anything lands outside the design space; a button under another button is comfortably inside
it. `labelFit.test.ts` asks whether a label stays inside its own box; this one did. Both files
already carry the sentence — *"nothing is off screen, never as nothing collides"* — and
neither asks the half of it that was left: **do two press targets share pixels?**

`screens/widgetOverlap.test.ts` is that half. Three decisions in it are worth more than the
139 cases:

- **It measures the background `Graphics`, not the view.** That is the shape a press actually
  lands on — `widgets.ts` makes the label `eventMode: 'none'` for exactly that reason — so
  the file needs no text measurement at all and reads the same in every environment. Folding
  the label in would also make it disagree with `labelFit.test.ts` about what a button *is*,
  and start failing for a reason it could not describe.
- **It covers `BlueprintCard` as well as `Button`.** This screen's weapon row is cards and
  its action bar is buttons, and they are laid out against each other; a button-only sweep
  would have been blind to half of its own subject.
- **It is not an adjacency rule.** The lobby's rows sit 5 px apart, and a gate that flagged
  that would be switched off within a week. Only a genuine intersection fails, and a harness
  case asserts the non-failure directly against the real 5 px spacing.

It was checked by putting the defect back: restoring `cx - WEAPON_ROW_W / 2` turns **18 of
its cases red** across the eight locales, naming both pairs (`clearBtn`/`startBtn` and, with a
saved run, `clearBtn`/`continueBtn`). A sweep whose passing state has never been shown to be
reachable from a failing one is a sweep that proves nothing.

## The other two gaps, found by asking

*"are there tests worth adding"*, after the screens were already green.

**The portrait's art branch had never run.** `getRigSkin` answers `undefined` under plain
vitest — there is no asset pipeline in the runner — so every portrait assertion in the new
file was measuring the *fallback disc*, and the branch that binds a texture, contains it and
re-binds on a character change was unreachable. A mocked registry (`vi.hoisted`, the
convention `scene/Skin.test.ts` established) makes it reachable: contain-not-stretch is
asserted with a 160×80 texture, where a stretch is 0.55 on one axis and 1.1 on the other and
a contain is 0.55 on both. Two mutants — stretch instead of contain, and the sprite not
re-centred when the layout moves — both killed. **`ui/PlayerCard.ts` has the identical hole**
and is left open deliberately, with its own task: its one portrait case is literally *"survives
a skin id with no registered art"*.

**The craft → loadout seam belonged to neither screen's own file.** `Forge.test.ts` sees the
staged badge appear because `craftAt` re-renders the forge; `Loadout.test.ts` renders a
hand-built meta and sees the card. Neither exercises the `MetaState` travelling from one
screen object to the other, which is the only thing the split actually introduced. Two cases
in `ForgeActions.test.ts` do, and they killed a `craftAt` that drops its return value and a
`clear` that re-renders the forge instead of the screen its button is on.

## Numbers

- Client **6,895 → 7,040** tests green (300 files); coverage 97.90% → **97.98%** lines,
  93.74% → **93.80%** branches, against the unchanged 90/90 gate over the whole source tree.
- New: `screens/Loadout.ts` (390 lines), `screens/Loadout.test.ts` (35 cases),
  `screens/widgetOverlap.test.ts` (139 cases). `screens/Forge.ts` 433 → 368 lines.
- `Phase` gains `'loadout'` (13 members); `SettingsReturnPhase` swaps `'forge'` for
  `'loadout'`; `ForgeReturnPhase` is new. No `ENGINE_VERSION` bump — nothing in `@dd/engine`
  was touched.
- Driven in the running client at 800×450 and at a 844×390 landscape phone: lobby → loadout →
  forge → craft → back, both BACK doors, the character cycle, and a forged weapon appearing
  on the pre-run screen with its materials spent.

## Still open

- `ui/PlayerCard.ts`'s portrait branch, as above — the in-run HUD's own copy of the hole this
  pass closed on the new screen.
- The roster cycle is still forward-only: ‹ and › run the same verb, which is what
  `ForgeActions.cycleCharacter` offers. A true reverse cycle is a follow-up, and both buttons
  are wired to the one that exists rather than one of them being drawn and dead.
- `design/14`'s outpost UX is still to-design: this pass changed which screen asks which
  question, not what the outpost looks like.
