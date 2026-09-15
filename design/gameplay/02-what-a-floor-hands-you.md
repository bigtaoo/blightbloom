# What a floor hands you

Part 2 of the gameplay doc (index: [`design/05-gameplay.md`](../05-gameplay.md)). Staying alive
and getting paid: the HP/shield model, the pickup rules, the rooms that are a search rather than a
fight, and the whole loot economy a floor runs on.

## Survivability model (HP + shield)

Every actor has **two defensive pools**; the character (skin, `02`) contributes these plus one break-passive — and, since `ENGINE_VERSION` 60, `maxEnergy`, which is not a defensive pool at all and does not belong to this section (`03`). All offensive depth is still the weapon.

- **HP is the hard floor.** When HP hits 0 the actor dies (co-op: downed, revivable). HP is **recovered only by items** — a healing pickup restores a **flat +1 HP**, dropped by chests and AI enemies (`07`/`09`).
- **Shield is the soft buffer, taken first.** All incoming damage — including elemental DoT (`07`) — depletes shield before it touches HP.
- **Shield auto-regenerates; HP never does.** After **3 s without being hit**, shield trickles back at **1 point / ~2 s** (`SHIELD_REGEN_DELAY` 90t / `SHIELD_REGEN_INTERVAL` 60t). *(This bullet said 1 point / 10 s until 2026-09-03 — that was the shipped value only through `ENGINE_VERSION` 40; the "Room encounter budget" pass in [`01-the-run-and-its-rooms.md`](01-the-run-and-its-rooms.md) cut it to 2 s and this snapshot never followed.)* *Any* hit — including a burn/poison DoT tick — resets the 3 s timer, so clearing a lingering status (kiting, an item) is a precondition for regen. Shield is a between-fights recovery, not a mid-fight heal.
- **Breaking a shield can fire a character passive.** The instant a shield is depleted, the character's bound break-passive (e.g. an AoE burst / knockback on nearby enemies) triggers — this is the concrete form of `02`'s "skin may carry a minor passive." A 0-shield character simply never triggers one.
- **Characters differ only by `(maxHp, maxShield, maxEnergy)` + that break-passive.** They are *not* balanced to equal effective HP, and `maxEnergy` (`ENGINE_VERSION` 60, `03`) is deliberately outside the effective-HP question entirely — it is denominated in energy, spreads OPPOSITE the body (skirmisher 130 / vanguard 100 / juggernaut 70), and buys burst length rather than survivability or dps. The shipped launch roster (`content/skins.ts`, retuned against `pvpBalanceSim` on 2026-07-28) is **vanguard 6 / 3.2** (the default — hybrid body + shield, an AoE break burst), **skirmisher 3 / 6** (the biggest regenerating buffer, fragile the instant burst punches through) and **juggernaut 11 / 0** (the flat-HP tank: no regen buffer and no break-passive at all, since an empty shield can never break). *(This bullet used to illustrate the axis with an 8/0 starter and a 3/10 skirmisher — figures no character has ever had; `14`/`09`/`ROADMAP` 2.3 each carried a different stale triple, all corrected 2026-09-03.)* Note `maxShield` is deliberately **not** an integer on the vanguard — see `07`'s two-pool decision for why that is allowed and what it costs. The engine bodies (absorb order, regen timer, break event) live in `07`/`08`; the numbers live in `@dd/engine` config (`09`).

## Pickup rules

Three pickup classes, split by **whether the player must make a choice**. Materials, coins and consumables are pure upside → automatic; weapons are a trade-off → click-driven. All pickup/effect logic runs **inside the sim tick off deterministic state** (`06`/`08`) — identical on every client; only the weapon-pickup panel's rendering is render-only (the click itself is a real command, see below).

- **Materials — auto, into the floor buffer.** Walking within a material's pickup radius auto-collects it into **this floor's un-banked buffer** (a temporary bag). There is no save action to bank it — banking is the **extraction-room checkpoint**: when you **DESCEND or EXTRACT**, the floor buffer merges into the run's carry-out bag (the only thing that leaves a run — the locked decisions in [`design/05`](../05-gameplay.md#the-decisions-locked)). The carry-out only becomes *account* materials on a successful **EXTRACT**; a run-ending death or team wipe forfeits the **whole un-extracted carry-out** (this floor's buffer plus everything descended-but-not-extracted this run) — that at-risk pile is exactly the "bank now or dive deeper" stake (see the co-op wipe decision in the index's [Open questions](../05-gameplay.md#open-questions)). The persistent account stash is never at risk. ✅ **Shipped 2026-07-24 (ROADMAP 1.4/1.5, `ENGINE_VERSION` 15, additive):** `PickupSystem` sums a collected material's qty into `state.floorMaterials`; `ExtractionSystem` (new step 12) merges it into `state.bankedMaterials` on either resolution and resets the buffer — a run-ending death simply never reaches that merge, which **is** the forfeit rule, no extra code needed. The EXTRACT/DESCEND choice itself: reaching the per-floor checkpoint (this floor's waves exhausted, no enemies left) opens a window where a **sustained INTERACT hold** (~1 s, mirrors the revive-channel's held-vs-tapped precedent) resolves EXTRACT, and a **tap** (hold released early) resolves DESCEND — first-pass input mapping, `10`'s UI/HUD work may refine the actual button feel. The last floor has no descend option, but still needs the same explicit EXTRACT press as every other floor before the run ends — it does NOT auto-resolve the instant the boss dies (dropped 2026-08-12: an instant, no-gesture resolution ended the run the same tick the boss died, before the player could ever walk over to its own death drops). *Runs today on the demo's single arena/wave-list, not yet a distinct `RoomPiece` per floor — see `09`'s dungeon-assembly note.* **Since `ENGINE_VERSION` 61 there is no EXTRACT/DESCEND choice to make ("Only the boss floor ends a run", in [`01-the-run-and-its-rooms.md`](01-the-run-and-its-rooms.md)): an interior checkpoint offers only DESCEND, so the buffer still merges into the carry-out bag exactly as described, but the bag now only becomes account materials at the BOSS floor's portal. Every sentence above about the forfeit rule is unchanged and strictly more load-bearing — the at-risk pile no longer has an early exit.**
- **Consumables — auto-apply, but only when useful.** An instant item (healing pickup = flat **+1 HP**, `07`/`09`) is consumed on contact, no inventory. To avoid overheal waste with **no item bag**, the pickup radius only triggers **when the effect would actually do something** — at full HP the health pickup is left on the floor for you to grab later. Same rule generalizes to any future instant item (shield/temp buff): auto-grab only if it changes state. ✅ **Shipped 2026-09-03 (`ENGINE_VERSION` 54):** `PickupSystem`'s `pickupWouldApply` gate, per-player (so a full-HP teammate standing on a heal cannot deny it to a hurt one). It had been unimplemented since this rule was written — `apply` clamped with `Math.min` and consumed the item regardless, binning the only thing in the game that restores the only pool nothing else restores. A run buff is deliberately NOT gated by it: its cap is applied Σ-then-clamp at *use* time, so "already wasted" is not a question the pickup site can answer, and a buff is a stack entry rather than an instant item.
- **Weapon energy — auto, under the same usefulness gate as a consumable** (`ENGINE_VERSION` 59, `03`). Restores `ENERGY_PICKUP_AMOUNT` to the player's shared ammo pool; at a full pool it is left on the floor, exactly like the health pickup, and for the same reason (no item bag, so collecting one at full destroys it for nothing). It is the second instant item, and the first added since `pickupWouldApply` was implemented — the rule's own note said *"if a shield/temp-buff instant item is ever added, this is the one place it needs a clause"*, and this is that clause.
- **Weapons — click-driven, drop-on-replace.** Not auto (swapping is a choice). A non-blocking **weapon-pickup panel** (`10`, ENGINE_VERSION 32) lists every floor weapon within reach (real icon + name); tapping a row IS the pickup — no modal, no pause, lockstep can't stop for one player. `PickupSystem` swaps it into the active slot and **the replaced weapon drops back onto the floor** (`02`/`03`). The switch button picks which of the two slots to overwrite. (Superseded the original single-nearest "ground compare card" + tap-`INTERACT` gesture — see `03`'s "Pickup & switch" section for the full history.)

## Chest rooms: not every room is a fight ✅ (locked AND shipped 2026-09-14, `ENGINE_VERSION` 63)

This doc's core loop had said **search**-fight-extract since it was written, and the game did not
have the first verb. Every room held enemies, every drop came off a corpse, and a room was
therefore a thing to survive rather than a thing to look into — `ROADMAP` B1, filed 2026-09-03,
decided and built 2026-09-14.

**What shipped:** `ChestSystem` (step 10.5), `GameState.chests`, `content/chests.ts`'s two pure
rules, and chests authored into the shipped level. ~~The drawn form is procedural: no chest art
exists yet.~~ **Art landed 2026-09-15** — four files (`chest_small`, `chest_small_open`,
`chest_big`, `chest_big_open`), the same staged rollout walls, pillars, doors and drops each went
through. `client/src/game/scene/ChestLayer.ts` keeps its Graphics form as the fallback, anchored
at the feet in the same box the sprite occupies, so a state whose file has not loaded still draws
something the right size. Audio is still unstarted: a chest opens in silence.

**Where they actually sit — rewritten 2026-09-14 the same day** (`ENGINE_VERSION` 65). The first
pass put the chests on the pieces that already existed (a big one in `ember_l1_extraction`, a small
one in `alcove` / `court` / `rampart` / `gallery`), which meant a floor got whatever its piece draw
happened to include — two small and one big on the early floors, no big chest at all on the boss
floor. The owner's call replaced that with a distribution stated as a decision, carried by three
**dedicated enemy-free side rooms** (`ember_l1_cache` / `ember_l1_vault` / `ember_l1_market`), each
hung off its floor's chain as a **dead end**:

| floor | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| side room | cache | cache | **vault** | cache + **market** | cache |
| what is in it | 1 small chest | 1 small chest | the big chest | 1 small chest, the shop | 1 small chest |

Three things follow from it, and the first is the reason this section's own header was only ever
half-true. **The level now has rooms that are not fights** — previously the only ungarrisoned room
was the extraction capstone, which is empty because it is the checkpoint, not because it is a
search. **Walking in is optional**: a dead-end room is the first room in this level a player may
simply not enter, so a skipped chest is a real cost rather than a hypothetical one. And **which
floor holds what is now a floor-map decision**, editable in `tools/map-editor` without touching a
combat piece. (This is not `ROADMAP` B3: B3 wants rooms left *unfought* on the way down, which
needs a route around a garrison. Every chain room between the entrance and the capstone still has
to be cleared.)

- **A floor mixes combat rooms with chest rooms.** Not every room has enemies in it. A chest
  room's content *is* the chest; whether one also holds a fight stays a per-piece authoring
  choice rather than a rule, so the mix is tunable in the editor without an engine change.
- **A small chest opens solo, and since 2026-09-15 it opens on APPROACH** (`ENGINE_VERSION` 66).
  One player, no button, no gate — walking into `CHEST_OPEN_RANGE_GRID` is the whole gesture.
  ~~One player, one `INTERACT`, no gate.~~ The owner's call, and the reason it overturned an
  argument this doc had made deliberately is in the next bullet. This is still the find that has
  to work in the mode most runs are actually played in.
- **A big chest is opened by the whole party at once, and pays one weapon per head.** It is
  ringed by **mechanisms**, one per player who entered the map, and it opens only while **every**
  mechanism has a player standing on it simultaneously. **Its reward scales the same way**: one
  player opens one weapon, four players open four (locked 2026-09-14). So the per-capita reward
  is FLAT and what actually scales is the coordination cost — a big chest is never the reason to
  bring more players or to play alone, which is the property that keeps it out of the party-size
  balancing problem entirely. A smaller party is not locked out of the content and a larger one
  is not farming it.
- **The button a chest needed had to be findable, was not, and is now gone** (2026-09-15, two
  passes the same day). A chest shipped with no art, no sound and no prompt, and `INTERACT` is
  taught nowhere: the tutorial's hint list covers move, attack, swap and deflect and stops. The
  report was *"the chest cannot be opened"* — about a chest the player was standing on — and the
  mechanic turned out to be fine: the sim opens it in a headless run, and the shipped client
  opens it on the first frame a `KeyE` reaches `WebInput`, both verified before anything was
  changed. **The missing piece was never the mechanic, only any way to find out the mechanic was
  there**, which is a failure a green engine suite structurally cannot see. The first fix was a
  caption naming the key; the owner's answer, hours later, was to **delete the step instead**
  (`ENGINE_VERSION` 66). Both halves are worth keeping in mind, because they are different
  lessons: a mechanic nobody can discover is indistinguishable from a broken one, AND the
  cheapest way to make a step discoverable is often not to need it. What survives of the caption
  is the BIG chest's (`client/src/game/ui/ChestPrompt.ts`, `10`'s HUD table): a live
  `{on}/{total}` plate count, shown from the mechanism ring outward so it stays up while the
  player walks out to a plate. That rule — every plate at once — is the one no player can infer
  from a ring of discs, and it is still gated on nothing a player can press. Art and an
  open/close sound are still unstarted, and would each say the same thing in a channel this
  caption cannot reach. (Art landed hours later, the same day; the open/close sound has not.)
- **More chest-room types come later.** Deliberately deferred. These two are the slice worth
  building and validating first, and a third kind that arrives before they have been played is
  a guess stacked on a guess.
- **A chest's payout IS the floor's weapon supply.** ~~It counts against the floor's weapon
  allowance, and the allowance is a FLOOR rather than a ceiling.~~ **Superseded 2026-09-14**
  (`ENGINE_VERSION` 64): the allowance is gone along with the kill-table weapon entry that
  motivated it ("A floor's weapon ALLOWANCE" below), so there is nothing left to charge a chest
  against. What used to be a re-routing of loot the floor already owed is now the loot itself,
  which is what the paragraph this replaced was reaching for: a skipped chest room is a floor
  with fewer weapons in it.

### The constraints this inherited, and how each was met

- **The mechanism count is the run's SEAT count, fixed at run start** (`EngineConfig.players`),
  not "how many players are currently alive, connected, or in the room". Both are engine state
  and both are deterministic, but only the first is stable: a count that tracks the living turns
  a teammate bleeding out into a chest that silently re-gates itself, and a count that tracks
  presence makes the puzzle re-solve every time someone steps off. Fixed at start is also the
  only version a downed teammate cannot soft-lock.
- ~~**`INTERACT` already has an owner.**~~ **Moot since 2026-09-15** (`ENGINE_VERSION` 66). It
  drives the revive channel and nothing else (`07`/`08`), and a chest was briefly the second
  consumer — which made button arbitration a real question the first time a chest sat next to a
  downed player. `ChestSystem` answered it by mirroring `ReviveSystem.findReviver` and yielding.
  With a small chest opening on approach and a big one never having read a button, no chest reads
  input at all, so the mirror is deleted rather than kept: a rule that cannot fire is a rule
  nobody can test. The visible consequence is intended — a small chest beside a downed teammate
  now opens while you revive them.
- **A chest is engine state, so it is replay and netcode state.** Opened-ness lives in
  `GameState` and the contents roll off `dropPrng` like every other drop (`06`/`09`); anything
  else desyncs a co-op run on the first chest and stops every recorded run reproducing. The
  mechanism ring is derived with integer trig and NO draw at all (`content/chests.ts`), so how
  many chests a floor holds cannot shift that floor's later loot rolls.

### What this still does *not* decide

- ~~**Rooms that are not fights.**~~ **Closed 2026-09-14** (`ENGINE_VERSION` 65). This bullet said
  the header was half-true — chests were authored into rooms that held their garrisons, and the
  only no-fight room was the extraction capstone — and that *"a dedicated chest-room piece placed
  into the floor maps is content work, not engine work, and it is the obvious next pass."* That is
  exactly what the three side rooms above are. What it still does not decide is whether a chest
  room should ever ALSO hold a fight: today none of them do, which is the simple end of a knob the
  per-piece authoring model leaves open on purpose.
- **What a chest contains.** It pays weapons. `ROADMAP` B2 — the run-buff offering flow — is the
  obvious tenant, and **the shop took the first bite of it on 2026-09-14**: a counter stocks a buff
  as one of its three lines, so a buff is now something you can choose and pay for rather than only
  something that falls off the kill table. What is still open is the same question this bullet
  asked, unchanged by that: whether a chest (or a counter) hands over a **choice of buffs** the way
  the floor cards do, rather than one line at one price.
- **What separates a solo big chest from a small one.** One player means one mechanism, which
  that player is standing on by walking up to it, and one weapon out — so on COUNT alone the solo
  big chest is a small chest with an extra step. The flat per-capita rule above is deliberate and
  settles fairness; what it leaves open is whether the two chest kinds differ on **quality** (a
  rarity floor, a better pool, a guaranteed element) rather than on quantity. That knob is
  unset on purpose: it is cheap to turn later and it is exactly the kind of number that should be
  set against real play instead of guessed now. The one thing to avoid is discovering the answer
  by accident — if the two chests end up indistinguishable in solo, the big chest's whole design
  cost is being paid in the mode most runs are played in.

## Loot economy: what a floor hands you ✅ (2026-09-05, `ENGINE_VERSION` 57/58)

Two design calls from the game's owner, made together because they are one question — how
much does a floor give you, and how much of that do you choose?

> The drop rate in the levels is too high. I want each floor to produce only 2 to 3 weapons.
> And monsters should have a very low chance of dropping a health potion — the core of this
> kind of game is trying to clear it without taking damage. When you clear each floor, give
> three option cards for a power-up, like Soul Knight. One of them doubles the monster
> health-potion drop rate. In a multiplayer level, whichever card the most people chose takes
> effect.

**The state before the change was measured, not guessed.** `client/sim/pveLevelSim.sim.ts`
grew a per-floor loot table (`sim/pve/report.ts#floorDropStats`) *first*, and over 16 real bot
runs of the shipped level it read **0.215 health potions per kill — 7-10 a floor** — plus
weapon counts scattered from **0 to 5** on a single floor. Both numbers matched what
`DROP_TABLE` said they would be; nothing was broken, the table was simply tuned for a
different game than the one this is. That report is still printed on every sweep, so the same
question never has to be re-argued from memory.

### Potions are scarce; the shield is the sustain

`heal` went **18 -> 2** of the table's 84 points: 21.4% of kills to 2.4%. The 16 points moved
to `material`, not off the total, so `weapon` and `buff` keep the exact odds they had — the
weapon COUNT is a separate mechanism (below) and folding a weight change into the same pass
would have made the two impossible to read apart afterwards.

What replaces drinking is the shield's idle regen (`07`'s two-pool health), which was already
there and was simply being drowned out. "Clear it without getting hit" cannot be the goal in a
game that refills you every fifth kill.

### A floor's weapon ALLOWANCE — deleted 2026-09-14, and what replaced it

*This whole mechanism is gone (`ENGINE_VERSION` 64). It is described here because it ran for
nine days and because what replaced it only makes sense against it.*

"2 to 3 per floor" is not something a drop weight can express: at ~60-77 enemies a floor, any
per-kill probability produces a distribution, and lowering it only widens the spread relative
to a two-wide target. So the weight kept setting the PACING and a quota set the COUNT — rolled
once per floor (2 or 3), bounded to one weapon per room so a floor could not satisfy the range
off its first garrison, with the shortfall **paid on the capstone** so 2-3 was a guarantee in
both directions rather than a ceiling with a bad tail.

**It was deleted because its premise was.** A kill no longer drops a weapon at all (below), so
there is no per-kill weapon rate for an allowance to cap and no distribution for it to smooth.
Keeping the make-up payment would have been worse than useless: loot that materialises at the
floor's exit is exactly the thing that makes a search not worth doing.

What a floor hands you in weapons is now, in full: **what its chests pay, what its boss drops,
and what you buy.** The first two are found, the third is earned, and a floor with an unopened
chest room ends with fewer weapons in it than one without — which is the entire point of
putting them behind a verb.

### Weapons are found, not dropped ✅ (2026-09-14, `ENGINE_VERSION` 64)

A design call from the game's owner, in four sentences:

> 怪物是不掉落武器的。要获得武器，只有 boss 掉落和开箱子。有些房间还会有商店，怪物的掉落里加一个金币。
>
> *(Monsters do not drop weapons. The only ways to get one are a boss drop and opening a chest.
> Some rooms will also have shops, and enemy drops gain a coin.)*

Everything in this section follows from the first sentence; the other three are what had to
exist for it to be survivable.

- **`weapon` left `DROP_TABLE` structurally**, not as a zero weight. A zero is one edit away
  from being reachable again by accident, and a zero nobody can see is how a decision quietly
  un-decides itself.
- **Three sources remain, and they differ in kind.** A **chest** is a find — its payout is now
  the floor's weapon supply rather than a share of an allowance (see "Chest rooms" above). A
  **boss** drops `BOSS_WEAPON_DROPS` (1) on its body: the only guarantee left in the game, on
  the run's last room, to a player who beat the thing gating the exit. A **shop** sells one,
  which is the recoverable half — a floor whose chests rolled badly is fixable by buying, and
  that is a decision rather than a number the floor hands you.
- **PvP is untouched, deliberately.** The arena's own table keeps its weapon entry, because an
  arena has no chest, no boss and no shop: its loot pool IS its whole power curve (`15`), so the
  same deletion there would delete weapons rather than relocate them. `ARENA_DROP_TABLE`
  excludes `coin` for the mirror-image reason — nothing in an arena could spend one.

### Coins, and what they cost the meta ✅ (2026-09-14, `ENGINE_VERSION` 64)

`coin` took the weapon entry's 5 points plus 15 out of `material`, landing at **20/84 — 23.8%
of kills** — and the total stayed 84, so `heal`, `buff` and `energy` keep the per-kill odds they
have had since `ENGINE_VERSION` 59. That is the same discipline the two re-weights before it
followed, and it is what keeps each pass readable as one change.

**What it costs is named rather than hidden.** The carry-out currency falls from 55/84 (65.5%)
of kills to 40/84 (47.6%) — roughly a 27% cut in the rate a run banks materials, which slows
forge progression. That is the trade this design makes: value moves from the META ramp to the
IN-RUN one, which is where the search verb and the shop now live. It is one number to reverse
(raise the table's total instead of moving points inside it) if a measured sweep says the forge
went dry.

A coin is **run-scoped and per-seat**. It goes into the collecting player's own wallet
(`PlayerActor.coins`), never a shared floor buffer; it is never banked at a checkpoint and
never seen by the meta layer — **`bankedMaterials` is still the only carry-out**, and no path
turns a coin into account value. The per-seat half is the rule the big chest already runs on:
what a party shares is the coordination, never the wallet.

### Shops: the counter a run spends at ✅ (2026-09-14, `ENGINE_VERSION` 64)

A shop is a prop authored into a room (`RoomPiece.shops`), stocked from `dropPrng` when the
floor is placed, and gone when the floor is. That last part is the economy's only real
pressure: **coins saved for a deeper shop are a bet that a deeper shop exists**, and you cannot
walk back.

- **Three lines, and their KINDS are fixed** — a weapon, a buff, and a supply (heal or energy).
  Not three draws from one pool: the shop's job is to be the recoverable half of taking weapons
  off the kill table, and a counter that can roll three potions cannot do that job. Fixing the
  slots is also what lets each line carry one price instead of a price band.
- **Priced against a measured floor, not a feel.** At 23.8% of kills and `COIN_DROP_QTY` 5, the
  measured level (34.6 kills on floor 0, 52 on floor 2) yields roughly **40-60 coins a floor**.
  The first-pass prices — weapon 45, buff 30, supply 12 — mean a floor's whole income buys the
  gun, OR the buff and two supplies. Being unable to afford everything is the design; these are
  numbers to retune against `pveLevelSim`'s own coin figure, never against a guess.
- **The gesture is a tap on a row, not a held INTERACT.** `INTERACT` already has two consumers
  (the revive channel and a chest) and does not get a third — and buying is not that shape of
  verb anyway. It is *choosing which line*, and this game already has a vocabulary for "choose
  one of the things in reach": the ground-weapon panel's click-to-collect (`03`). A shop tap is
  the same one-shot latch on its own command field, and the panel is non-blocking for the same
  reason that one is — lockstep cannot stop for one player (`06`).
- **A bought weapon lands on the floor; a bought buff/heal/energy applies to the buyer.** That
  split is this doc's own pickup rule, not a new one: a weapon is a *choice* (which slot to
  overwrite) and stays click-driven, while the other three are pure upside. Dropping those as
  pickups would have let a teammate walk off with something somebody else paid for.
- **An instant item that would do nothing is refused before the coins move**, through the same
  `pickupWouldApply` predicate that leaves a potion on the floor at full HP — so the counter and
  the floor can never disagree about what "would do something" means. A buff is deliberately
  exempt, exactly as it is exempt from that rule on the floor: its cap is applied Σ-then-clamp
  at *use* time, so "already wasted" is not a question the purchase site can answer.
- **Stock is shared, wallets are per-seat.** First come, first served — a small chest's rule
  again — so a party cannot each buy the one weapon.
- **The range gate is drawn.** `ShopSystem` refuses a purchase from outside
  `SHOP_INTERACT_RANGE_GRID`, and a refusal a player cannot predict reads as a broken button, so
  the counter's mat is drawn at exactly that radius (`scene/ShopLayer.ts`) and the panel opens on
  exactly that ring (`ui/shopProximity.ts`). Stand on the mat, the panel is live.

**Shipped placement — revised the same day** (`ENGINE_VERSION` 65). The first pass authored a
counter onto `ember_l1_forge` (floors 1-2) and `ember_l1_crucible` (floors 3-5), which put one on
each of the five floors because each floor drew one of those two pieces. The owner's call moved
the run's shop to **one counter, on floor 4**, in the dedicated `ember_l1_market` side room (see
"Chest rooms" above for the whole distribution). What that does to the economy is the point of it:
coins are run-scoped and never banked, so a single deep counter means a run's ENTIRE purse is
spendable exactly once, one floor before the boss — *"coins saved for a deeper shop are a bet
that a deeper shop exists"* stops being a bet spread over five floors and becomes one decision.
Nothing in `SHOP_PRICE_*` was retuned for it; whether 87 coins for all three lines is the right
ask against a five-floor purse is the first thing to measure once this has been played.

**What this does not yet answer** is `ROADMAP` B2's harder half. A shop offers a buff, so the
in-run power layer is no longer delivered *only* by a 6/84 weight on the kill table — but one
line at a fixed price is an offer, not the CHOICE between buffs the floor cards are. Whether a
chest or a counter should hand over a pick-one-of-three stays open.

**And a second thing, opened 2026-09-14 by the game's owner describing the shop as something it
was not yet:** *“商店是通过房间里的 npc 打开的，不是随时可以打开的。”* **There was no shopkeeper.** The
counter was a prop, and what opened the panel was PROXIMITY — stand inside `SHOP_INTERACT_RANGE_GRID`
of it and the panel is live (`ui/shopProximity.ts`), which is also the rule `ShopSystem` refuses a
purchase by. That is the same shape as the ground-weapon panel and it was a deliberate choice (see
"The gesture is a tap on a row" above), but it is not what the sentence describes: a counter that
opens because you walked near it is closer to a vending machine than to a person you talk to.

**Split in two and half of it shipped the same day.** The sentence names two separate things, and
they have nothing to do with each other:

- **"There is a person in the room."** A rendering fact. ✅ **Shipped 2026-09-14** — a shopkeeper
  sprite (`client/public/environment/npc_shopkeeper.png`, prompt and measurements in
  `art/npc/prompts.md`) standing one counter-depth north of the counter, in `layers.entities` on
  its own ground point so it Y-sorts against the actors and the counter's slab crosses the bottom
  of its silhouette. `scene/ShopLayer.ts` owns it; `render/environmentSprites.ts` loads it in the
  `run` pack alongside the doors and the props. **Zero engine change** — no `ENGINE_VERSION`, no
  golden re-record, no replay consequence, because nothing about the purchase rule moved.
- **"…and that is what opens the shop."** A change to the VERB, and still open. Deliberately not
  taken in the same pass: the panel opens on proximity today, and making it need an explicit
  gesture means answering *which* gesture first, given `INTERACT` already carries two consumers
  (the revive channel and a chest) and "The gesture is a tap on a row" above withheld a third on
  purpose. Doing the art first costs that decision nothing — a proximity-opened panel and a
  gesture-opened one both want a merchant standing there — which is exactly why it was split.

The keeper is **art with no Graphics form**, which inverts this file's usual staging (walls,
pillars, doors, drops, props and chests each shipped a procedural shape first and grew a sprite
later, and the counter itself still has not). The reason is that the fallback question has a
different answer for a person: a room with a hole where a wall goes is unplayable, whereas a room
with no merchant is simply the room this section described before today. So a missing texture
draws nothing at all, and a procedural stand-in for a CHARACTER — a second authored body plan,
against `13`'s one — is never built.

### Floor cards: the reward becomes a choice

The checkpoint offers **three cards** (`balance/floorCards.ts`), drawn distinct from a
catalogue of seven by a dedicated `cardPrng`. Five wrap existing `RUN_BUFFS` ids so a card is
exactly as strong as the same buff picked off the floor and `BUFF_CAPS` bounds both together;
the other two are properties of the RUN rather than of a player — `potion_flow` (doubles the
heal weight, stacking to `HEAL_DROP_MULT_CAP` in three picks) and `arsenal` (+1 to every later
floor's weapon allowance).

**One of the five is card-ONLY, and that is the interesting part** (`ENGINE_VERSION` 60).
`capacitor` grants `cell_up`, the `flat_energy` family that raises the weapon-energy pool
(`03`), and `cell_up` is deliberately absent from `BUFF_DROP_POOL` — the one buff in the
catalogue a floor drop can never hand you. The reason is that it is the first **conditional**
reward in the set: capacity is worth exactly nothing to a player still on the starter blaster,
which is sustainable on regen alone and whose bar therefore never empties. As a 1-in-5 floor
drop that would spend a fifth of a run's buff drops on something most players cannot yet use,
taken out of four families that always do something. A pick-one-of-three offer is the right
home for a reward whose value depends on what you are currently holding — the player carrying
a 26-cost frame takes it, the player carrying a blaster takes `edge`, and neither pick is
wasted. `content/drops.ts`'s `CARD_ONLY_BUFF_IDS` names the exclusion so that "deliberately
undroppable" and "somebody forgot to add it to the pool" stop looking identical; a new family
in neither list fails `drops.test.ts`.

**No pause.** The offer is a non-blocking overlay over a still-running sim, the same shape the
portal popup has had since `ENGINE_VERSION` 31 — lockstep cannot stop for one player (`06`),
and a cleared floor is the one moment where that costs nothing. It opens with the portal, and
only where there is a next floor: the last floor never rolls one, because a card it handed out
could never be spent.

**A vote is state, not a pulse.** `PlayerCommand.cardVote` (1..3, 0 = "not changing my vote")
is copied onto `PlayerActor.cardVote` and stays there — unlike `confirmExtract`/`confirmDescend`,
which are one-tick latches. A vote is changeable right up to the descend, and every client
renders the live tally off shared state, which it can only do if the vote persists.

**Resolution — the majority, with two rules the request did not settle**, both decided toward
determinism because every client tallies this independently and must agree: a **tie goes to the
lowest slot** (arbitrary, but it has to be something, and "the leftmost card" is at least on
screen — a re-roll or a coin flip would not survive being computed on four machines at once),
and an **abstention is not a vote** (a `0` seat is skipped, never counted for slot 1).

**A tally of 0 holds the portal** rather than descending without a card. Holding on >=1 vote
rather than on "everyone has voted" is the co-op call: a downed or disconnected teammate must
not be able to strand the squad on a cleared floor. It also leaves the descend authority
exactly where it already was — player 0's press — so this pass does not settle the shared-descend
question still open below.

**The reward is team-wide** (the owner's call): the vote is collective, so a buff card pushes
onto every seat's stack, downed seats included. They are still on the team and still revivable,
and a permanent asymmetry earned by being on the floor at the wrong moment would make reviving
someone worth less than it should be. EXTRACT applies nothing — the run is over.

**Not built, deliberately:** a card that changes shield regen, pickup radius or revive speed.
Each needs its own engine plumbing, and this pass wanted the mechanism shipped and measurable
before the catalogue grows.
