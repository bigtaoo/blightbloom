# Work log — 2026-10-03

Volume 125. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Any seat opens the portal (2026-10-03, engine + client + ui + tools + test + docs, ENGINE_VERSION 87)

Volume 124's co-op sim found two gaps, and the owner settled both:

- **A leader who bled out with a teammate up stranded the run.** Only seat 0's press took the
  portal. Online, the second human was stuck the same way.
- **A bot ally never opened a big chest.** It stood on no plate.

### The portal (engine, `ENGINE_VERSION` 87)

The owner's rule:

- any player can open the portal;
- that starts a 30 s countdown, and every other player gets a confirm button;
- the portal goes as soon as everyone has confirmed;
- if someone has not confirmed when the countdown ends, it goes anyway.

What ships (`ExtractionSystem`):

- **Who may open it:** any standing seat, meaning alive and not downed. It uses the floor's own
  button: DESCEND on an interior floor, EXTRACT on the boss floor. The other button is still
  ignored (`ENGINE_VERSION` 61).
- **The countdown:** the opening press sets `GameState.portalCountdownTicks` to
  `PORTAL_COUNTDOWN_TICKS` (900, 30 s). Every later press is a confirm, `PlayerActor.portalReady`.
- **When it goes:** the tick every living seat has confirmed, or when the countdown reaches zero.
  - A downed seat cannot confirm, but is still waited for, so the countdown is time to revive it.
  - A dead seat is not waited for. A seat whose mate is dead goes on its own press.
- **Cards:** descend still needs a card voted before the opening press. A vote can change but
  never goes back to 0, so the tally is non-zero when the portal goes.
- **The boss floor** extracts the same way. The owner named the descend; the extract got the same
  rule because volume 124's stranded runs ended on that floor too.
- **Solo is unchanged:** the press confirms the only seat, and the run resolves on that tick.

Both new fields are hashed in `serializeState`. The golden gate was run first, before the bump and
before the fields were hashed, and it was green: every scenario has one seat. A recorded co-op run
diverges at its first checkpoint.

### The popup (client)

- **Who sees it:** once a seat has opened the portal, every seat sees the portal popup and the
  card offer wherever it stands, so it can confirm or vote (`checkpointOverlays.ts`).
- **The title** becomes the countdown and the confirmed count over living seats: "Squad leaves in
  23s — 1/2 ready". It is new in all eight locales (`hud.portalCountdown`).
- **The button** is the same one, now a confirm. It is hidden once the seat has pressed it, or
  while it cannot (downed or dead).
- **Fire** is gated only at the portal. Away from it a teammate may still be fighting, and gating
  fire would disarm it for up to 30 s. So the popup swallows its own presses
  (`PortalPrompt.onPressStart`), the way the card panel already did.

### The ally (client)

- **It confirms at once** while a countdown runs, on top of whatever it is doing that tick. A bot
  never holds its player back. It does not open the portal itself, so a bot left alone after its
  player dies still cannot leave.
- **It takes the second plate.** Once a squadmate stands on a plate of an unopened big chest, the
  ally walks to the nearest free plate and holds it (`ai/chestPlate.ts`). The plate comes before
  the fight unless an enemy is in fire range. `engageNearest` chases the nearest live enemy anywhere
  on the floor, rooms not yet entered included, so "no enemy left" almost never comes in a dungeon.
- **It routes through doors to get there** (`ai/dungeonRoute.ts`). The first sweep with the plate
  rule left the ally against the vault's outer wall. A vault is a dead end off one room, and from
  the next room along the way in is several rooms round, outside the box `steer` searches.
  `roomRoute.ts`'s door-graph walk, until now arena-only, takes a structural `RouteMap`, and a
  dungeon floor is adapted to one.

The server's backfill bot drives the same `AllyController`, so all three rules hold online too.

### The sim leader

`PveBotController.chestToOpen` changes in three ways:

- volume 124's "pass over any big chest with more than one plate" is gone;
- the leader keeps the plate it stands on. Its own plate reads occupied, by itself, so "the first
  free plate" walked it off to the other one, and the ally chased it round the ring;
- it passes over a big chest with more plates than there are standing seats. In the second sweep,
  6 careful runs timed out with the leader on its plate and the ally dead.

Solo runs are unchanged: a solo big chest has one plate. `test:pve-sim` passes.

### Measured

Same 40 seeds as volume 124, now with the ally on the plates and confirming the portal.
`down (mate up)` counts every down, and in brackets those with the other seat still standing.

| profile | condition | extracted / wiped / stranded | mean floor | leader: down (mate up) / revived | ally: down (mate up) / revived | big chests |
|---|---|---|---|---|---|---|
| careful | solo | 0 / 40 / – | 0.42 | – | – | – |
| careful | ally, revive off | 6 / 33 / 1 | 2.75 | 34 (5) / 0 | 34 (30) / 0 | 16 |
| careful | ally as shipped | 6 / 34 / 0 | 2.75 | 35 (6) / 1 | 35 (30) / 0 | 16 |
| careful | ally + reviving leader | 13 / 26 / 1 | 3.10 | 31 (16) / 4 | 75 (64) / 48 | 30 |
| aggressive | solo | 0 / 40 / – | 0.00 | – | – | – |
| aggressive | ally, revive off | 0 / 36 / 4 | 1.63 | 40 (13) / 0 | 36 (27) / 0 | 2 |
| aggressive | ally as shipped | 0 / 37 / 3 | 1.65 | 44 (17) / 4 | 37 (27) / 0 | 2 |
| aggressive | ally + reviving leader | 0 / 36 / 4 | 1.73 | 48 (33) / 8 | 57 (36) / 21 | 5 |

- **Big chests open now.** None did in volume 124. Careful runs open 16 in 40, and 30 when the
  leader revives the ally and so keeps it alive to reach the vault.
- **Volume 124's readings hold:**
  - the ally goes down first (30 of 40 careful runs, against 5 or 6 the other way);
  - a reviving leader is the lever (careful extractions 6 to 13);
  - co-op still reaches floor 2.7 where solo dies on floor 0.4.
- **The shipped ally's own revive answers fewer downs here**: 1 of 6 careful, against 4 of 6 in
  volume 124. Six downs is too few to read a rule from. Each run now takes a different path
  (into the vault, through the portal a tick sooner), so the same seed downs the leader somewhere
  else.
- **`stranded`** still counts a leader dead with the ally up: the bot ally never opens the portal
  itself. Online, a human second seat now can.

### Tests

- `engine/systems/portalCountdown.test.ts`, 12 cases:
  - any seat opens it;
  - it goes on the last confirm, or on the countdown's last tick and not one before;
  - a second press does not restart it;
  - it needs a card vote, and the other floor's button does not open it;
  - a dead seat is not waited for;
  - a downed seat can neither open nor confirm, and is waited for to the end;
  - the boss floor's extract.
- `floorCardCheckpoint.test.ts`: the multi-seat cases now have every seat confirm, so the portal
  goes on the press as they assumed.
- `ally.test.ts`, 9 cases:
  - it holds the free plate where it would otherwise regroup, and walks to the plate, not to the
    leader;
  - it leaves a plate alone with no squadmate on one, and a chest whose plates are all held by
    other seats;
  - it fights an enemy in range first, but not one far off on the floor;
  - it opens a chest with the leader through `step()`;
  - it confirms during a countdown and not otherwise;
  - a leader's descend goes the next tick.
  Switching the plate rule off fails 4 of them; dropping the fire-range guard fails 1.
- `ai/dungeonRoute.test.ts`, 5 cases on an L of three rooms with no walls drawn. A straight walk
  would cut the corner; only the door route turns it east first.
- `PortalPrompt.test.ts`, `checkpointOverlays.test.ts` and `GameLoop.test.ts` cover the popup:
  - the countdown title, rounded up and counting living seats;
  - the confirm button's visibility;
  - the press swallow;
  - both panels away from the portal;
  - fire gated only at it.
- `PveBotController.test.ts`: the leader keeps its own plate, and passes over a chest it lacks the
  seats for. Both have controls.
- `coopRevive.sim.ts` prints big chests per condition, and gates the shipped ally opening at least
  one.

### Still open

- **A bot left alone after its player dies.** It neither opens the portal nor ends the run, so the
  player watches it fight on (volume 124's `stranded`). Ending the run when only bots are left
  standing is the candidate.
- **Party-size scaling** for co-op PvE (volume 124).
- **An ally that holds back** rather than charging the nearest enemy anywhere on the floor. The
  same chase is why the plate rule had to outrank the fight.
