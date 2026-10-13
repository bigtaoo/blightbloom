# Work log — 2026-10-13

Volume 142. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A drop that will not come says why (2026-10-13, client + ui + i18n + test + docs, no ENGINE_VERSION change)

> 玩家靠近物品却无法拾取，感觉非常奇怪。要么给个提示，要么直接拾取。你给个方案

The report: the player stands next to a drop and it is not picked up, which feels broken. The
user asked for either a hint or plain collection. The screenshot showed a full-energy player
beside an energy cell.

**Not a bug in the sim.** `pickupWouldApply` (design/gameplay/02, "auto-apply, but only when
useful", `ENGINE_VERSION` 54/59/71) leaves a heal at full HP, an energy cell at a full pool, a
shield battery at full shield and an EMP with no enemy inside `SIM.empRadius`. There is no item
bag, so collecting one of these at the cap destroys it for nothing. The rule stays. What was
missing was any sign of it on screen: the drop drew the same either way, and over the player's
head is only the health bar, so nothing said that energy was full.

**What shipped (client only):**

- **A refused drop is dimmed.** `Pickup.setRefused` puts the view at `REFUSED_ALPHA` (0.45) and
  turns its glow off. `Scene.reconcile` sets it on every drop every tick, judged for the LOCAL
  seat only, so a full-HP teammate does not dim a heal you need. A player can read "useless to me
  right now" from across the room, before walking over.
- **Walking onto one puts up the reason.** `scene/PickupRefusalLayer.ts` draws a short label
  ("Energy full", "HP full", "Shield full", "No enemies in range") on `layers.numbers` above the
  drop. It is in the pool's own pickup colour, rises 14 px and fades over its last 35% of 1.6 s.
  It has keys `pickupHint.*` in all eight locales.
- **When to announce is pure and tested** (`ui/pickupRefusal.ts`, listed in
  `pureLayerBoundary.test.ts`). `pickupRefusalReason` asks the engine's own `pickupWouldApply`
  and adds only the name of the reason. `RefusalHintTracker` is edge-triggered: it announces on
  entering range while refused, or on turning refused while already in range. It never repeats
  while the player stands still, and it waits 3 s per drop before announcing it again.
- **The hint ring is wider than the collect gate.** It is the sim gate (`SIM.pickupRadius +
  p.radius`, 31 px) plus 17 px, which makes 48 px, the height the body floats above its ground
  point. A player who looks as if they are standing on the drop always gets the explanation. This
  is the "the client OFFERS what the sim does not ACCEPT" class that the 2026-08-31 unpickable-loot
  notes left open, answered for the refusal case.

**Dropped from the proposal.** A flash on the HUD bar of the full pool: `GameLoop.ts` sits at 499
of the 500-line budget, and the label already names the pool. A "full" corner badge on the drop:
dimming plus glow-off says the same thing with less ink.

**Tests.**

- `pickupRefusal.test.ts` sweeps every `PickupKind`, held as an exhaustive `Record` so a new
  kind is a compile error until it is listed. It checks both pool states, with and without an
  enemy in EMP range, and asserts `reason !== null ⇔ !pickupWouldApply`. A future conditional
  kind that lands without a reason fails there, so it cannot go silent.
- It also runs the real `PickupSystem` on the screenshot case: the cell stays on the floor and the
  tracker announces it.
- A mutation battery on the tracker found one survivor. Dropping the edge check was hidden by the
  cooldown, so the suite gained "standing on it longer than the cooldown still does not repeat
  it".
- A follow-up pass found the Scene cases each ran one reconcile on a fresh view, which starts
  undimmed. A Scene that only ever called `setRefused(true)` passed them all; verified by applying
  exactly that mutation. Two cases were added: the dim follows the pool both ways, and a crate
  that resolves into a heal is dimmed on its rebuilt view. The second also covers that rebuild
  path for the first time.

Verified live on the dev server: at HP 6/6 and energy 100/100, an "Energy full" label sat over
the cell, the cell and a heal were dimmed (alpha 0.45, glow off), and a material drop was
untouched.
