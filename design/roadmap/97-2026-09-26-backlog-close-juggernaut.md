# Work log — 2026-09-26

Volume 97. See [`design/ROADMAP.md`](../ROADMAP.md) for the index and the phase spine.

## B2, B3 and B4 closed, and juggernaut drops from the boss (2026-09-26, engine + content + ui + net + i18n + test + docs, `ENGINE_VERSION` 76)

Step 4 of the plan agreed after [volume 92](92-2026-09-26-backlog-resync.md), the engine half. All
three Backlog items that the resync had found "partly built" are finished with the decisions
recorded there. Juggernaut, which shipped "reserved" with no way to own it, now has the owner's
route: a 1% boss drop. All of it went into one engine bump.

### B2 — the shop's buff line is a pick-one-of-three

Decided in volume 92: the choice lives on the shop's buff line, not on a chest (chests stay the
weapon supply). A buff slot in `content/shops.ts rollSlot` used to roll one buff. It now offers
three distinct ones as `ShopOffer.choices`, each with its own id from `nextShopId()`, and the buyer
takes one at the line's single price.

- **The three come out of ONE draw.** `combinationAt(SHOP_BUFF_POOL, 3, nextInt(C(n,3)))` walks
  the k-subsets in lexicographic order, so every slot still costs exactly two draws whatever its
  category. That is the invariant the file's own header calls load-bearing.
- **The pool gains card-only `cell_up`** (`SHOP_BUFF_POOL`, ten possible lines). It was kept off
  the kill table because +max energy is worthless to a player on the starter blaster, and
  `balance/floorCards.ts` names a pick-one-of-three as exactly where such a conditional reward
  belongs. This is one.
- **No command-format change.** `PlayerCommand.shopBuyId` names a CHOICE id for a buff line.
  `ShopSystem` refuses a tap on the line's own id: it names no buff, and guessing which of three
  was meant would charge for a decision the player did not make. On the sale the offer records
  which buff was taken (`buffId`), and `shop_buy` carries it.
- **The panel** (`ui/ShopPrompt.ts`) draws a buff line as a header row with the price, then one
  row per choice, each with the icon of the floor card that wraps that buff. It is inline rather
  than the floor-card popup: that panel is the checkpoint's vote, and the shop stays the
  non-blocking counter it was. New string `hud.shop.buffPick`, in all eight locales and in
  `hudLabelFit`'s sweep.

### B3 — floors 3 and 4 get a skippable variant

`floorLayoutVariants` gains indices 2 and 3, drawn from `roomgenPrng` like floor 2's:

- **`ember_l1_floor_3_branch.json`**: `r5_bastion` becomes a dead-end spur off `r4_furnace`, which
  gains a direct door to `r6_crucible` (moved under it, with the capstone under that).
- **`ember_l1_floor_4_branch.json`**: `r4_rampart` becomes a spur off `r3_crucible`, which gains a
  direct door to `r5_caldera` (moved above it). The cache stays behind the rampart, so skipping
  that fight also walks past the floor's chest. That is design/05's "greed for the last chest vs.
  leave safe", on the floor before the boss.

Both keep the plain map's roster, array order, door count and door order, so enemy-id allocation
does not depend on the draw. `emberLevel1.test.ts` now runs its full passability suite over every
variant: overlap, shared walls, wall thickness, entrances, chests, the shop ring, extent. The one
existing variant used to carry a hand-copied subset. The variant block became a `describe.each`
that proves a FIGHT is skippable on each (a skippable side room alone proves nothing), that
nothing else is, and that the plain layout skips nothing. The interior-capstone half stays
dropped, as volume 92 decided. **B3 is closed:** every floor between the opener and the boss has a
draw with a skippable fight.

### B4 — both depth curves are `DungeonConfig` fields

- **`weaponRarityByDepth?: RarityWeightRow[]`** is read by all three weapon finds: chest payout,
  boss drop and shop weapon slot. `rollWeaponId(prng, floor, byDepth = DEFAULT_WEAPON_RARITY_BY_DEPTH)`
  expands a table once per identity (a `WeakMap`) and still costs one draw.
  `rarityTableProblems` names an unusable table: no rows, non-integer or negative weights, rows
  not summing to 100, all weight on empty tiers.
- **`materialTierByDepth?: number[]`** is read at `DeathDropsSystem`'s `rollDrop` tier through
  `materialTierForFloor`, which plateaus past the curve's end and is the `tier = floorIndex`
  identity without one.
- **Absent, both reproduce the old behaviour exactly**, and `EMBER_DUNGEON` sets neither, so B4
  alone moves no hash. The buff pool stays depth-blind, as decided.
  `content/depthCurves.test.ts` drives each site with a curve no default could produce. A
  mutation battery confirmed that deleting any one site's argument turns a test red.

### Juggernaut, a 1% boss drop

The schematic's twin in every respect:

- **The drop.** `CHARACTER_DROP_PERMILLE = 10` and `DROP_CHARACTERS = ['juggernaut']` (an explicit
  list, so a new skin never silently becomes droppable). The pickup is a new `'character'` kind
  carrying `skinId`, auto-collected into the collector's own `PlayerActor.characterPickup`.
- **The roll.** It happens once per run behind its own `GameState.characterRolled` guard, and
  spends one extra `dropPrng` draw per boss kill (two on a hit), after the schematic's.
- **The client.** A won run grants the character through `grantRunCarryOut`, which is idempotent,
  so the rewarded-ad repeat is harmless. The run shows a violet bust on the floor, a toast, and a
  results line: *"Character unlocked: Juggernaut"*.

**The server half was not optional.** `ownedCharacters` is an ownership field: the server strips it
from every pushed blob and overwrites it on every read (ROADMAP 8.2). A drop granted only
locally would have lasted exactly until the next login. So:

- **`POST /account/claim-drop { skinId }`** grants `character:<id>` with source `drop`. It accepts
  only a `DROP_CHARACTERS` id, never a paid or free character, and is one idempotent row per
  account.
- **`createAccountSyncMetaStore.save()`** claims each droppable character in the saved state once
  per session token, and retries on a later save if the claim failed. `Game.ts`, at exactly 500
  lines, is untouched.

**What the route trusts, stated plainly: the client's word that the drop happened.** No PvE replay
verification exists (deliberately, volume 92), which is the same trust every material and
schematic in `meta_state` already rests on. The route bounds what that word buys, and `drop` is
among `grantAudit`'s counted sources, so a claim from an account that never finishes a run is
visible to the anomaly audit.

### A finding on the way: early draws across consecutive seeds

Measuring the 1% rate over seeds 1..6000 read **0.35%**. The drop code was not at fault: across
consecutive seeds, a fresh `Prng`'s first few draws are correlated. The second `nextInt(1000)`
landed under 10 in 20 of 6000 seeds, a third of what uniform draws give. With spread seeds
(`i * 2654435761`) the same draws are uniform (58–73 of 6000 for each of the first three), and so
is the drop rate. Play is unaffected: matchsvc's seed is a crypto draw since volume 93, and a boss
dies thousands of draws into the stream. But any rate test that sweeps `seed = 1..N` and reads an
early draw is measuring the PRNG's seeding, not the code. `characterDrop.test.ts` spreads its seeds
and says why. Two things are filed rather than changed here: the PRNG's seeding (a determinism
change) and the blueprint 5% test's own sweep.

### Numbers

- **Engine:** 1699 → 1762, all green. New: `characterDrop.test.ts`, `depthCurves.test.ts`, the
  shops pick-one-of-three suite, and the passability suite over three variants. The golden
  fixture was re-recorded: every hash moved because the state hash gained a per-seat field and a
  shop tuple shape. The witness columns (event counts, PRNG cursors) did not move in any scenario,
  so that change is the only one.
- **Client and server** gained the `ShopPrompt` choice rows, the claim call and its once-per-session
  hook, the grant, the toast, the results line and all twelve pickup shapes in `Pickup.test.ts`
  (six had never been drawn in a test). The server side is the claim route (unit and HTTP).

### Still open

- `DROP_CHARACTERS` claims are only as honest as the client. Closing that needs the PvE replay
  verification volume 92 deferred.
- A guest who finds juggernaut and later signs in keeps it only through the guest-merge flow,
  which unions characters into the pushed state and so reaches the claim. A plain login's pull
  happens before any save and replaces the local list.
