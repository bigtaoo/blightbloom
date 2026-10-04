# Work log — 2026-10-03

Volume 124. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## A co-op run, measured (2026-10-03, client + tools + test + docs, no ENGINE_VERSION change)

The owner picked an item from the 2026-10-03 status review: the shipped co-op ally
(`AllyController`) has revived a downed leader since volume 118, but the only PvE sim played one
seat, so nobody had measured what that rule buys a run.

### The instrument

- **`client/sim/pve/coopRun.ts`** plays one co-op run headless:
  - seat 0 is the level sim's `PveBotController`, standing in for the player;
  - seat 1 is the shipped `AllyController`, called as `GameLoop` calls it;
  - the config comes from `buildDungeonRunConfig({ coop: true })`, the function `Game.beginRun`
    calls.
- **The leader has no revive of its own.** It stands in for a human. A condition lays the
  ally's rule (`ai/revive.ts`) over it as well, as an upper bound on what a player who always goes
  back for the ally buys.
- **Per seat it counts:**
  - downs;
  - downs with the other seat still up, the only ones a revive could answer;
  - revives and bleedouts.
- **`AllyController` takes `{ revives?: boolean }`.** `false` is the control.
- **`client/sim/coopRevive.sim.ts`**, `npm run test:coop-revive` (~55 s, folded into
  `test:sims`), plays 40 seeds at both bot profiles in four conditions:
  - solo, for scale;
  - the ally with its revive off;
  - the ally as it ships;
  - the ally plus a reviving leader.
- **It gates the instrument, not a balance verdict:**
  - nobody comes back up with both rules off;
  - the shipped ally does bring the leader back up;
  - a seat is revived only from a down its mate was up for;
  - every run ends.

### Measured

40 seeds per row. `down (mate up)` counts every down, and in brackets those with the other seat
still standing.

| profile | condition | extracted / wiped / stranded | mean floor | leader: down (mate up) / revived | ally: down (mate up) / revived |
|---|---|---|---|---|---|
| careful | solo | 0 / 40 / – | 0.42 | – | – |
| careful | ally, revive off | 6 / 30 / 4 | 2.73 | 34 (5) / 0 | 31 (30) / 0 |
| careful | ally as shipped | 7 / 33 / 0 | 2.83 | 37 (6) / 4 | 34 (32) / 0 |
| careful | ally + reviving leader | 12 / 27 / 1 | 3.13 | 34 (18) / 6 | 78 (67) / 51 |
| aggressive | solo | 0 / 40 / – | 0.00 | – | – |
| aggressive | ally, revive off | 0 / 35 / 5 | 1.68 | 40 (13) / 0 | 35 (27) / 0 |
| aggressive | ally as shipped | 0 / 39 / 1 | 1.75 | 47 (18) / 7 | 39 (29) / 0 |
| aggressive | ally + reviving leader | 0 / 38 / 2 | 1.85 | 50 (35) / 10 | 67 (44) / 29 |

- **The ally goes down first, so its revive rarely gets a turn.** With a careful leader, the
  ally went down with the leader still up 30 times in 40 runs. The leader went down with the ally
  still up only 5 times. The ally fights at the nearest enemy (`ai/engage.ts`), while the careful
  leader holds its range.
- **When its turn comes, the shipped rule mostly works.** It answers 4 of 6 such downs at
  careful, and 7 of 18 at aggressive. At aggressive it holds off more often, because it will not
  start a channel while an enemy has a clear shot in fire range.
- **Its main effect is on stranded runs:** 4 to 0 at careful, 5 to 1 at aggressive. Depth moves
  by 0.1 of a floor.
- **The player reviving the ally is the lever that moves runs:**
  - careful extractions go from 7 to 12, and mean floor from 2.83 to 3.13;
  - a reviving leader answers 51 of 67 ally downs at careful.
  This is an upper bound: the bot goes back every time.
- **Co-op is far easier than solo.** The careful bot never extracts alone and dies on floor 0 or
  1 (mean 0.42). With the ally it reaches floor 2.7 even with no revives at all. Nothing in the
  engine scales enemies with the number of seats (no `players.length` term outside chest plates
  and payouts), so a second gun is simply a second gun.

### Found on the way

- **A bot ally never opens a big chest.** A big chest has one plate per seat
  (`content/chests.ts`), and every plate must be held on the same tick. `AllyController` stands
  on none. So a player with a bot ally can never open one. In the first sweep, this left the
  leader bot on its plate for 34,000 ticks waiting for the second one. The sim leader now passes
  over a chest it cannot open alone (`PveBotController.chestToOpen`, plus a test); solo runs have
  one plate and are unchanged. The ally itself is not changed here. *(Superseded the same day by
  [volume 125](125-2026-10-03-any-seat-portal.md): the ally takes the second plate, and the
  leader passes over a big chest only when it lacks the standing seats for it.)*
- **A leader that bleeds out with the ally up strands the run.** Only seat 0 can confirm the
  portal (`ExtractionSystem`), and the run only ends when nobody is up. So the ally fights on
  with no way to leave, and the player watches until it dies. The sim cuts such a run and counts
  it as `stranded`. The shipped revive takes these from 9 in 80 runs to 1 in 80. It does not
  close the case. *(Volume 125: any standing seat now opens the portal, `ENGINE_VERSION` 87.)*

### Tests

- `ally.test.ts`: `revives: false` never holds INTERACT over the body. Its control is the
  existing case where the shipped ally does.
- `PveBotController.test.ts`: a big chest with two plates is passed over. The control is the
  one-plate case, which draws the bot to its plate. Without the change, the test fails.

### Still open

- ~~**A bot ally that works chest plates**~~ and ~~**a stranded run**~~: settled by the owner the
  same day, [volume 125](125-2026-10-03-any-seat-portal.md).
- **Party-size scaling** for co-op PvE, if co-op is meant to be as hard as solo.
- ~~**An ally that holds back** rather than charging the nearest enemy.~~ Done in
  [volume 126](126-2026-10-04-ally-holds-back.md): it goes down less, and its revive gets turns.
