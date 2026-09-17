# Work log — 2026-09-17

Volume 71. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## CONTINUE RUN moves to the front door, and the button that could only apologise (2026-09-17, client + docs, no engine change)

Volume 70 audited the lobby as a front door and ended with a finding it did not fix: *"一个昨晚存在
第三层的玩家，今天打开游戏，首页对他的存档只字不提"* — a player who saved on floor 3 last night opens
the game and the home screen says nothing about it. CONTINUE RUN
([`Forge.ts:178`](../../client/src/game/screens/Forge.ts)) lived one click behind SOLO PvE. This
pass puts the offer on the lobby and, in doing so, found that the offer itself had been wrong
since the day it shipped.

**No engine change.** `ENGINE_VERSION` is untouched: a save is a seed and a command stream and
nothing about either moved.

### The defect that was hiding behind the Forge

The row the brief asked for had to go through `checkResumable` — the `ENGINE_VERSION` compare plus
the content fingerprint — rather than through "a save exists". Writing that check is what exposed
the existing one:

| | what it asked | what it drew |
| --- | --- | --- |
| `Forge` (2026-09-10 → 2026-09-17) | `savedRunSummary() !== null` — **a save exists** | a full-size primary CONTINUE RUN |
| `RunLifecycle.resumeSavedRun` | `checkResumable(save, config)` — **a save this build can rebuild** | on refusal: drop the save, toast, re-render |

So a save written before an `ENGINE_VERSION` bump, or one whose floor library had moved under it,
drew a primary button whose only possible outcome was to delete the save and apologise. Nothing
was red: the toast is a real string with a real locale key in all eight files, the refusal path has
its own tests, and `Forge.test.ts` asserts the button appears for a save — which it does.

Two answers to one question is the shape, and it survived because the wrong answer was one screen
deep and the right one ran a frame later. Neither of those is true on a front door. Both screens
now read [`client/src/game/match/resumableRun.ts`](../../client/src/game/match/resumableRun.ts),
which rebuilds the run config from **today's** content for the save's own seed and loadout — via
the same `buildDungeonRunConfig` the resume itself calls, not a stand-in — and asks the same
`checkResumable`. `RunLifecycle`'s branch stays as belt and braces rather than being deleted,
because the alternative is a `return` that silently does nothing.

### Three decisions the change forced

**Where the check may cost what it costs.** `contentHashOf` is `JSON.stringify(config.dungeon)`
plus an FNV pass, and that string is **20,724 characters** for `EMBER_DUNGEON` + `EMBER_L1_ROOMS`
— ~0.08 ms for the stringify alone, measured. The Forge asks twice per `render()` and re-renders on
every keystroke. So the verdict is memoised against the save OBJECT the process-wide slot hands
back, which changes identity exactly when the save does; `resumableRun.test.ts` pins the direction
that matters, a refusal that outlives the save it was about.

**A non-resumable save is left in storage.** Clearing it in the provider would make a re-render a
side effect, and clearing it at boot would spend a capability on a player who may never open the
lobby. The slot is reclaimed by the next `beginRun`. The honest cost is that a player whose save we
broke is now told nothing, where before they were told at the moment they pressed a button that
could not work — which design/10 already calls the worse of the two ("a refusal a player cannot
predict reads as a broken button").

**On a portal, CONTINUE takes quick-play's slot rather than standing beside it.** Both answer
"start playing now"; the CrazyGames requirement behind PLAY is that a **first-time** visitor reach
gameplay in one click, and a player with an unfinished run is not one. It is also the only shape
that fits, and that was measured rather than argued — see below. What was explicitly not done is
re-point PLAY at the resume: one button whose meaning depends on the state is how a player loses a
run they meant to keep, the rule that already keeps SAVE & QUIT and QUIT as two rows in the pause
menu. Two labels, one drawn at a time, is a different thing from one label that changes its mind.

### The sweep failed, which is the only reason the portal rule exists

The first version stacked CONTINUE under the portal's PLAY. `viewportFit.test.ts`'s new tallest
case — portal quick-play, the data notice, a 140-character maintenance banner AND the CONTINUE
block — came back at **702px against a 640px design height, in all eight locales**. The banner
reserve pins the top of the block at y=72, so there is nowhere for a sixth row to centre into.

That is the second time in eight days this file has answered a layout question the design was
about to answer by taste, and both times the answer changed the product rather than the numbers
(2026-09-10: the half-width two-up row). Worth stating as a habit rather than a coincidence: put
the tallest legal CONFIGURATION in the sweep before deciding what the screen looks like, because
the configuration that fits easiest is the one a new case defaults to.

The caption went the same way. `CONTINUE — FLOOR {n}` in the button's own label is 316px of Russian
in a 280px row, so the floor and the elapsed time became a separate 11px line: 152-165px in the
worst locale, measured. It is one unwrapped line on purpose — wrapping would make the routes
block's height a `Text` measurement, and every position in these screens is arithmetic on constants
precisely so a layout needs no canvas. `labelFit.test.ts` sweeps BUTTONS and is structurally blind
to it, so `LobbyRoutes.test.ts` measures it against the row width in all eight locales itself, with
the widest plausible readout (a two-digit floor, a 99-minute run).

### What shipped

- **`client/src/game/match/resumableRun.ts`** (new) — the single answer, memoised, plus
  `refuseResume` for the tests that want the reason rather than the verdict.
- **`client/src/game/ui/LobbyRoutes.ts`** — a sixth row at the TOP of the stack, its caption, a
  state-dependent `height`, and `applyHierarchy`: exactly one green button, and it is the topmost
  row that starts a run. Every row below moves down by the whole block rather than sharing a slot.
- **`client/src/game/screens/MainMenu.ts`** — the `resumableRun` provider (`Forge.savedRun`'s
  shape, for `Forge.savedRun`'s reason: `show()` runs on every entry and every relayout) and
  `applyPrimary`, which is where quick-play and a resumable run are reconciled. `setQuickPlay` is
  a request now, not the final answer.
- **`gameAssembly.ts` / `gameWiring.ts`** — both screens wired to the one provider and the one
  handler. `RunLifecycle.resumeSavedRun`'s refusal re-renders **the screen the press came from**;
  answering "no" with a navigation is its own defect.
- **Eight locale files** — `mainMenu.continueRun` + `mainMenu.continueRunAt`, the button label
  reusing each locale's existing Forge wording so one verb has one name.

### The battery, and the file that had never been tested

Asked afterwards whether more tests were worth adding, and answered by measuring rather than
guessing: 21 mutants over `resumableRun.ts`, `LobbyRoutes.ts`, `MainMenu.ts`,
`RunLifecycle.resumeSavedRun` and `gameAssembly.ts`, against the ~1,600 tests in
`src/game/{match,ui,screens,controllers}`. **19 killed. Two CONTROLS survived as designed** —
building the check config as co-op, and with an empty seat, both invisible to `contentHashOf`,
which reads `config.dungeon` alone. A battery that kills its controls is a broken harness, and
this one did not.

**Two real survivors, both in `gameAssembly.ts`, and both the same hole:**

```
SURVIVED  p.mainMenu.resumableRun = () => null    the lobby wired to nothing
SURVIVED  p.forge.savedRun        = () => null    the Forge never offering CONTINUE
```

`MainMenu.test.ts` and `Forge.test.ts` each drive their screen from an INJECTED provider. That
is the right way to test a screen, and it is precisely why neither can see the provider the
product installs — so *"both screens read one function"*, the sentence this pass turns on, was
a claim in a comment with nothing behind it. `gameAssembly.ts` had **no tests at all**; 237
lines of wiring table, and two live mutants walked straight through the client suite.

`gameAssembly.test.ts` (new) closes it behaviourally rather than by reading the source — put a
real save in the real slot, assemble, ask both providers, and assert they agree save by save,
including the stale-save case where both must withdraw. A grep-shaped test would pass against
`() => resumableRunSummary()` written twice with one of them typo'd back to `savedRunSummary`,
which is the exact regression it exists to stop. Negative-controlled: both mutants now go red,
and **only that file goes red**.

Worth generalising, because the shape is not specific to this feature: **a screen tested
through an injected provider and an assembly that installs the real one are two halves, and
this repo had only ever built the first.** Anywhere a `() => T` provider is a screen's input,
the default is fail-closed (here, "no save"), so a completely unwired screen and a correct one
look identical — which is why the assembly test has to put a real save in before it asks.

### Numbers

- 20,724 characters of dungeon content per un-memoised `contentHashOf`; ~0.08 ms per stringify.
- 702px vs a 640px design height for the tallest both-buttons lobby, in 8/8 locales.
- The caption at its widest: 165px (German) against a 280px row.
- Mutation battery: 21 mutants, 19 killed, 2 controls survived, 2 real survivors (both closed).
- New tests: 20 in `LobbyRoutes.test.ts`, 8 in `resumableRun.test.ts`, 5 in
  `gameAssembly.test.ts`, 5 in `MainMenu.test.ts`, 2 in `RunLifecycle.test.ts`, 1 in
  `gameWiring.test.ts`; 3 new sweep cases across `labelFit`/`viewportFit`. Coverage holds over
  the 90/90 gate.

### Still open

- **The player whose save died is told nothing.** Weighed above and accepted; if it turns out to
  matter, the place to say it is the Forge's info line, not a toast on a button press.
- **`gameAssembly.ts` is tested for exactly one thing now.** The new file asserts the two
  CONTINUE providers and nothing else; the other ~29 assignments in that table are still
  unasserted, and the battery says that is where a wiring regression would hide. The stub the
  new file builds is the hard part and it is done, so extending it is cheap.
- **The three shut-or-slow routes volume 70 found are still shut or slow** — CO-OP's dead queue,
  PvP's 30-second empty-queue answer, and whether a route that cannot be walked through should
  carry the same visual weight as one that can. This pass moved the returning player's need to the
  front door and did not touch the other three.
