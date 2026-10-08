# Work log — 2026-10-08

Volume 138. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## Co-op with a bot: the card vote that never arrived, and an ally with its own time (2026-10-08, engine + client + test + docs, no ENGINE_VERSION change)

> 和机器人组队之后，这里的ui点了没用，没法选buff，也没法进入下一层
>
> 另外，机器人不要像一个跟班一样老是跟随玩家，稍微有点自主行动

Two reports from one session of co-op with a bot. The first was a screenshot of the floor-clear
checkpoint: the "Choose an Upgrade" cards and the "Descend to Floor 2" button, and neither did
anything when tapped. The second was about how the ally behaves once a room is quiet.

### The card vote that never arrived (`engine/net/NetInputSource.ts`)

Since 2026-10-03 an online client sends a command only when it differs from the last one it sent;
the server holds the last one in between (sparse held-input sync). The comparison was a
hand-written list of fields: `moveBrad`, `moveMag`, `buttons`, `pickupTargetId`, `shopBuyId`.
`cardVote` was not on it.

At the checkpoint a player stands still and taps a card, so the vote is the one field that
changes, and the command was dropped as a duplicate of the idle one before it. The descend then
failed too, because `ExtractionSystem` opens the portal only for a seat with a non-zero vote
(`votedSlot`). Both buttons on the screen went dead for the same reason.

It hit **online** matches only, which includes a co-op seat backfilled by a server bot
(`server/src/BotClient.ts`). Offline local co-op (`?coop=1`) never goes through the filter; the
same screen reproduced there with the vote registering.

The filter now compares every field of `PlayerCommand` except `type`, `owner` and `tick`, so a
field added later is sent on change without anyone remembering to list it. Three tests:

- `netinput.test.ts`: a card vote on an otherwise idle tick is sent;
- `netinput.test.ts`: every command field except those three triggers a resend when it alone
  changes, enumerated from a real command's keys rather than a list (so it fails for the next
  forgotten field too), and a changed `owner`/`tick` alone does not;
- `framebroadcast.test.ts`, the loopback: a standing-still seat votes on frame 40, the server
  logs frames `[1, 40, 41]`, the engine's `players[0].cardVote` is 2, and the hash equals the
  local run's.

With the old comparison put back, the new tests fail.

### The ally has its own time (`client/src/game/controllers/ai/roam.ts`)

With nothing to fight, revive or stand on, `AllyController` closed on its leader whenever it was
more than 3 grid off, so in a cleared room it took a step after every step its player took. It
now wanders the quiet room instead:

- **Every 2.5 s** (`ROAM_PERIOD_TICKS`) it either picks a spot 2-6 grid from the leader
  (`POST_MIN_FP` / `POST_MAX_FP`) and strolls there at 2/3 deflection (`STROLL_MAG`), or rests
  where it stands. About one period in three is a rest.
- **It comes back at full pace** only when the leader leaves the room or gets more than 8 grid
  away (`LEASH_FP`).
- **The spot is a hash** of the seat, the floor and the period, never RNG, so a run stays a pure
  function of its inputs; two allies in one squad pick different spots.
- **A corner is handled.** A spot is accepted only if, pulled inside the room's 2-grid inset, it
  still lies in the 2-6 grid ring. The first version clamped a ring spot into the room and kept
  it; live, with the leader in the corner of a 15x15 room, most spots landed on the leader's feet
  and the ally milled there. It now tries six candidates per period, alternating anywhere in the
  room with a point on the ring, before it rests.

Fighting, reviving, the chest plate and the portal confirm all still come first, unchanged. Two
things the ally deliberately does NOT do, because each would cost the player:

- **It never picks a spot outside the leader's room.** `DoorSystem` pulls every standing seat into
  a room when that room's fight starts, so an ally that wandered into an unstarted room would
  drag its player into a fight they had not chosen.
- **It never goes after loot.** `PickupSystem` gives coins and materials to whoever collects them,
  so a bot that fetched them would be taking them from its player.

`AllyController` takes `{ roams?: boolean }`, with `false` as the control (the old follow). The
server's backfill bot drives the same controller, so this holds online too. `ally.test.ts`'s
chest-plate tests pin `roams: false`, since they measure the plate rule and not where an idle
ally stands.

`roam.test.ts` covers spots staying inside the room and the ring, the corner case (over half the
periods still find a spot, none closer than 2 grid), the rest fraction, a spot holding for a whole
period, two allies not sharing spots, the arena (no room layout: ring only), the regroup through
a door and past the leash, and an engine run through `step()`: with the leader standing still, the
roaming ally visits more than five cells and never leaves the leash, while the `roams: false`
control never moves.

Live (2026-10-08, local co-op in the browser pane, `AllyController` hot-swapped from the
worktree): the ally spent 5% of the time within 1.5 grid of a still leader and made excursions of
about 5 grid.

### Numbers

`npm run check` (every workspace: typecheck, file length, tests) and `npm run check:logic` are
green. `npm run test:sims`: all eight suites pass. The co-op revive sim runs the roaming ally by
default, and its 40-seed readings have no `stranded` and no `timeout` in any condition, so the
quiet-room wander did not leave the sim leader waiting on an ally that had walked off. The
`careful` / `ally` row read 11 extracted / 29 wiped, mean floor 2.92.

### Still open

- **Not played end to end online.** The vote fix is covered by the loopback test above, not by a
  real match against a backfilled bot.
- **The portal panel's title was missing in the report's screenshot** ("FLOOR CLEARED — a portal
  has opened"). It renders locally and nothing in the code explains its absence; nothing was
  changed for it.
- **The spacing constants are first guesses** (2-6 grid, 8 grid leash, 2.5 s), tuned by eye on
  one live run.
