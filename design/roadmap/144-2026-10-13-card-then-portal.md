# Work log — 2026-10-13

Volume 144. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Pick a card, then descend (2026-10-13, client + ui + i18n + test + docs, no ENGINE_VERSION change)

> 这里要先选能力在进下一层，可是玩家很难理解。而且点进下一层没反应。分两次显示会不会更好？

The screenshot was a cleared floor: the three-card panel stacked over the portal popup, and
a "Descend to Floor 2" button that did nothing when pressed. That was not a bug in the
press. `ExtractionSystem` holds a Descend until some seat has voted a card
(`floorCardCheckpoint.test.ts` pins it), and nothing on screen said so. The popup offered a
button the engine was going to ignore.

**Two steps.** The checkpoint now asks one question at a time.

1. **Pick.** The card panel alone, titled "FLOOR CLEARED — choose an upgrade". The portal
   popup stays shut while this seat is still picking, unless a co-op countdown is running,
   in which case it shows its countdown title with no button.
2. **Descend.** Once the seat has voted, the cards fold into a 60 px strip:
   "Upgrade: Surge" (solo) or "Squad pick: Surge (2 votes)" (co-op, the `tallyCardVote`
   winner), with the card's description on a second line and a **Change** button that
   reopens the cards. The portal popup and its Descend button appear below the strip.

**Co-op.** A teammate's vote is enough for the engine, but it does not pick for this seat:
a seat that has not voted sees the cards, not the strip, even with a countdown running.
Change is local UI state (`reopened`). It resets when a new offer is rolled and closes again
on the next card tap.

**How the two panels agree.** `checkpointOverlays.ts` updates the card panel FIRST and passes
its `isPicking` to `PortalPrompt.update` as `descendLocked`, so the portal reads this tick's
answer rather than last tick's. Fire is suppressed at the portal while EITHER panel is open,
since on a floor still picking the card panel is the only one there.

**Live check.** Solo run on a worktree dev server: clear the floor, walk to the portal (cards
only), tap Surge (strip + Descend), tap Change (cards back, Descend gone), tap Bulwark, tap
Descend. `floorIndex` became 1 and `floorCards` was `["bulwark"]`, so the vote changed
through Change is the one that landed.

**Tests.**
- `FloorCardPrompt.test.ts` "two steps": 10 cases (pick-only, the strip's text, Change,
  offer reset, co-op squad pick, a teammate's vote not skipping mine, an unknown id, the
  relayout).
- `PortalPrompt.test.ts` "Descend waits for the card": 4 cases.
- `checkpointOverlays.test.ts`: the lock argument, the update order, and fire gating.
- `hudLabelFit.test.ts`: the strip's folded text and the Change label, for every card in
  solo and co-op, in all eight locales.
- `cardThenPortal.test.ts` (new): a real engine, both real panels and the real overlay pass,
  with the panels' taps routed into real commands. Every tick it asserts that a Descend
  button on screen is a press the engine takes. Never locking Descend, or updating the
  portal before the cards, turns all five cases red.
- One trap: a closed Pixi panel returns early and leaves its buttons' own `visible` flags
  stale, so "drawn" is asserted as `isOpen && btn.view.visible`.

`en.ts` reached 503 lines with the three new keys (`floorCardChosen`, `floorCardSquadPick`,
`floorCardChange`); two comments were trimmed back to 500. client **8796** tests after the
merge with the shop-row work.
