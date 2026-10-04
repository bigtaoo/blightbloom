# Work log — 2026-10-04

Volume 126. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## The co-op ally holds back (2026-10-04, client + server + tools + test + docs, no ENGINE_VERSION change)

Volumes 124 and 125 both left one item open: the co-op ally fought with `engageNearest`, which
chases the nearest live enemy anywhere on the floor and closes to 4 grid. So it ran into rooms its
player had not entered, inside the mob's own reach. With a careful leader it went down first in
30 of 40 runs, against 5 or 6 the other way, and its revive rule seldom got a turn.

### The rule (`ai/holdBack.ts`)

Both halves come from the careful level-sim bot (`sim/pve/PveBotController`), which holds its
range and has never had this problem:

- **Who it fights:** only an enemy in its own room or its leader's. A mob two rooms on is left
  alone until the leader gets there. With no room layout at all (an arena), every enemy, as
  before. It shipped with a third arm, in a doorway any enemy in fire range, removed the same day:
  see "The doorway arm" below.
- **Where it stands:** 7.5 grid off the target (`HOLD_BACK_FP`), outside every mob's own engage
  range of 5.6 grid. Inside a 1-grid band it stands still. Closer, it backs off, still firing. Further,
  it walks there, through the doors when the target is in the other seat's room (`walkTo`).
  It fires within 11 grid, as before.
- **A blade in hand** keeps the old close-in shape: nothing hits from 7.5 grid with one.

With nothing in reach it regroups on the leader, as it did once the floor was clear. Revive, the
chest plate and the portal confirm keep their places ahead of the fight. `AllyController` takes
`{ holdsBack?: boolean }`, and `false` is the control. The server's backfill bot drives the same
controller, so the rule holds online too.

### Measured

`npm run test:coop-revive` has a new condition, `ally rushes`: the shipped ally with the old
fight. It reproduces volume 125's `ally as shipped` row exactly (6 / 34 / 0, floor 2.75, 16 big
chests), so the control is the old ally and not a near copy. Same 40 seeds. `down (mate up)`
counts every down, and in brackets those with the other seat still standing.

| profile | condition | extracted / wiped / stranded | mean floor | leader: down (mate up) / revived | ally: down (mate up) / revived | big chests |
|---|---|---|---|---|---|---|
| careful | ally rushes | 6 / 34 / 0 | 2.75 | 35 (6) / 1 | 35 (30) / 0 | 16 |
| careful | **ally holds back** | **13 / 26 / 1** | **2.88** | 51 (32) / 24 | 28 (21) / 0 | 21 |
| careful | holds back + reviving leader | 18 / 21 / 1 | 3.08 | 48 (35) / 26 | 47 (39) / 26 | 28 |
| careful | holds back, revive off | 11 / 19 / 10 | 2.73 | 29 (11) / 0 | 21 (20) / 0 | 19 |
| aggressive | ally rushes | 0 / 37 / 3 | 1.65 | 44 (17) / 4 | 37 (27) / 0 | 2 |
| aggressive | **ally holds back** | **1 / 38 / 1** | **1.77** | 126 (120) / 87 | 38 (6) / 0 | 8 |
| aggressive | holds back + reviving leader | 1 / 38 / 1 | 1.77 | 128 (123) / 89 | 39 (6) / 1 | 8 |
| aggressive | holds back, revive off | 0 / 6 / 34 | 0.85 | 40 (40) / 0 | 6 (0) / 0 | 1 |

- **The ally now outlives its leader.** Careful: it goes down with the leader up 21 times, not
  30. Aggressive: 6, not 27.
- **So its revive gets turns, and the rule works when it does.** Careful: 24 of 32 leader downs
  answered, against 1 of 6. Aggressive: 87 of 120, against 4 of 17.
- **Runs go further.** Careful extractions go from 6 to 13, mean floor from 2.75 to 2.88, and
  big chests from 16 to 21. Aggressive gets its first extraction in these sweeps.
- **The leader goes down more often.** An ally at 7.5 grid no longer stands between the leader and the mob.
  An aggressive leader goes down 126 times, against 44. Most come back: 87 are revived and 1
  bleeds out. A human leader would see this as many revives per run. Whether that is fun is a
  playtest question, not one the sim can answer.
- **Without its revive, a held-back ally leaves runs stranded.** Look at the `revive off` rows.
  The aggressive leader charges in alone, the ally stands back, and the leader bleeds out with the
  ally still up: 34 stranded in 40. That is the open "bot left alone after its player dies" case,
  and the shipped ally (revive on) keeps it to 1 in 40 at each profile. The case is still open,
  and holding back makes it the main way a revive-less ally loses a run.

### Tests

- `ai/holdBack.test.ts`, 10 cases on volume 125's L of three rooms:
  - the reach filter keeps either seat's room and drops a third;
  - with no leader it keeps only the ally's own room;
  - an enemy in a third room stays out even inside fire range, and outside every rect only the
    leader's room counts (both replaced the doorway case, see below);
  - with no rooms it keeps every enemy;
  - nothing in reach is null, with the old fight chasing the same enemy as the control;
  - it stands still in the band, backs off inside it, and closes from past fire range without
    firing;
  - it routes to the leader's room through the door, not toward the target;
  - a blade keeps the close-in shape, with the gun backing off as the control.
- `ally.test.ts`: the "holds position inside spacing" case now pins the back-off, and the old
  hold moves to a `holdsBack: false` control. The "advancing" case put its enemy at 6.25 grid,
  which now backs off and still passed on `moveMag > 0`. The case moves the enemy to 10 grid and
  asserts the heading.
- `server/test/BotClient.test.ts`: the brain-separation fixture put the enemy at 6.25 grid east.
  The held-back ally then backs off west, the PvP bot also walks west, and the two commands
  matched. The enemy moves to 9.4 grid.

### The doorway arm, removed

The first cut kept a third arm: standing in a doorway, in no room's rect, any enemy in fire range
counted. It never fired on a generated floor. `placeFloor` lays adjacent rooms edge to edge and
the door straddles the shared edge, so every point is in some room's rect; only the test floor
has a gap.

The worry it left was the reverse case: an enemy just across a door, in a room neither seat is
in, shooting the ally unanswered. That cannot happen either. When a room's fight starts,
`DoorSystem` pulls every standing seat onto its entrance and locks its doors. A rule that let the
ally answer any enemy with a clear shot from fire range was built and measured: over
`test:coop-revive`'s ten conditions, about a million held-back fight ticks, it never once found
such an enemy, and every row of the table above came out unchanged. So the rule was not
shipped, and the dead arm went instead. Reach is now the two seats' rooms and nothing else.

### Still open

- ~~**A bot left alone after its player dies**~~ (volume 125). Done in
  [volume 129](129-2026-10-04-bot-only-wipe.md): every stranded run above is now a wipe.
- **Party-size scaling** for co-op PvE (volume 124).
- Whether a leader revived three times a run feels like help or like nagging. That needs a
  playtest.
