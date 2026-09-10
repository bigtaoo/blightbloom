/**
 * Step 12 — Extraction (design/05, ROADMAP 1.4/1.5, PvE only). A complete no-op
 * unless `state.floorsEnabled` (EngineConfig.floors was provided) — every config
 * that predates this feature leaves it doing nothing, every tick, forever. That is
 * why this new step needed no ENGINE_VERSION bump when first added: it is exactly as
 * inert for an old config as the AABB wall-collision loops (ROADMAP 1.2) are when
 * state.walls is empty.
 *
 * The per-floor checkpoint is "this floor's waves are exhausted and no enemies
 * remain" (the same condition WinConditionSystem used to auto-win on when floors
 * are disabled — see its own floorsEnabled guard). At that point the run waits on
 * player 0's explicit portal-popup pick (single-player only; co-op's shared
 * decision is a Phase 3 concern), and WHICH pick the portal accepts depends only on
 * whether this is the last floor:
 *   - the LAST floor is the only floor that can END a run. CONFIRM_EXTRACT banks and
 *     wins; a CONFIRM_DESCEND press there is ignored, since design/05's "the last
 *     floor's boss room IS its extraction room" leaves nowhere to descend to.
 *     Extracting USED to auto-resolve the instant the capstone cleared, with no
 *     gesture at all — dropped (2026-08-12, live bug report: the boss's own death
 *     drops never had a chance to be picked up, since the run ended the same tick
 *     the boss died, before the player could walk over to them). The portal now
 *     opens and waits, exactly like every other floor's checkpoint, just without a
 *     Descend button — "walking through the portal after is automatic" now means
 *     the player chooses to walk up and confirm, not that the game does it for them.
 *   - every OTHER floor accepts CONFIRM_DESCEND and nothing else. A CONFIRM_EXTRACT
 *     press on an interior floor is ignored the same way a CONFIRM_DESCEND press on
 *     the last one is — **the mid-floor extraction option is gone** (ENGINE_VERSION
 *     61, design/05 "Only the boss floor ends a run"). It was a real choice for six
 *     weeks: reaching any floor's checkpoint let you bank and leave. What replaced it
 *     is not a nerf of the decision but a MOVE of it — a single-player run that is
 *     not finished is now SAVED and resumed instead (client/src/game/match/runSave.ts),
 *     so "leave with what I have" became "come back to it" rather than
 *     "cash out early". Both directions of the old choice are still reachable; what
 *     is not reachable any more is banking materials without beating the boss.
 *
 * Both resolutions bank state.floorMaterials into state.bankedMaterials (design/05
 * "materials so far are locked in" on descend; "keep materials" on extract) — a
 * run-ending DEATH never reaches here, so the floor buffer is simply never merged.
 *
 * That is only HALF the forfeit rule, and this comment used to name the wrong half
 * ("forfeit only this floor's un-banked buffer" — design/05's own locked wipe rule
 * is stricter, and had been since ROADMAP 3.2). `bankedMaterials` is not safe either:
 * it leaves the sim only when the CLIENT hands it to the meta layer, and
 * `RunOutcome.lose()` deliberately never does. So the shipped rule is **a death
 * forfeits the entire un-extracted carry-out**, both tiers, and the two-tier split
 * here is per-floor bookkeeping for the HUD — not a risk boundary. Nothing in this
 * file needs to change for that; the merge simply is not where the guarantee lives.
 */
import type { GameState } from '../state/GameState';
import { capstoneCentre, payFloorWeaponShortfall } from './floorLoot';
import { cardBuffId, rollFloorCardOffer, tallyCardVote } from '../balance/floorCards';

export class ExtractionSystem {
  tick(state: GameState): void {
    if (!state.floorsEnabled) return;
    if (state.phase === 'gameover') return;

    // The checkpoint condition differs by mode (design/05, 2026-08-04). Dungeon mode's
    // old `wavesExhausted` (a floor-wide "last sequential stage cleared" flag) doesn't
    // make sense once every room is co-resident and independently activated — it is
    // simply never set anymore in dungeon mode. Availability is instead a direct check
    // against the floor's own capstone (extraction/boss) room: reached (activated) and
    // cleared (no live enemy) — never true before a player has actually been inside it,
    // which is what `activated` guards against (DoorSystem's own softlock-prevention
    // reasoning applies here too). The flat `floors` list (no dungeon config) keeps the
    // original floor-wide flag untouched.
    if (state.dungeonEnabled) {
      if (!this.capstoneCleared(state)) return;
      // The floor is finished. Hand over any weapons its kills did not produce
      // (design/05 per-floor allowance, ENGINE_VERSION 57) — this is the path for a
      // capstone with no enemies in it, which is four of the shipped level's five
      // floors; a BOSS floor has already paid on the body back in DeathDropsSystem,
      // and this call finds nothing owed. Idempotent, which is what lets it sit in a
      // block that re-runs every tick the portal stays open.
      const centre = capstoneCentre(state);
      if (centre) payFloorWeaponShortfall(state, centre.gx, centre.gy);
    } else {
      if (!(state.wavesExhausted && state.enemies.length === 0)) return;
    }

    // Last-floor test differs by mode: the flat-`floors` list counts extraFloors; a
    // generated dungeon counts its configured floorCount (design/05 "the last floor's
    // boss room IS its extraction room" — it just has no Descend option, below).
    const isLastFloor = state.dungeonEnabled
      ? state.floorIndex >= state.dungeonConfig!.floorCount - 1
      : state.floorIndex >= state.extraFloors.length;

    // The floor-card offer (design/05, ENGINE_VERSION 58) opens with the portal and
    // only on a floor there is somewhere to descend TO — a card the last floor hands
    // out could never be spent, and rolling one would cost `cardPrng` draws for a
    // choice with no consequence. Rolled once: a non-empty offer is the "already
    // open" flag, and `resolveDescend` is the only thing that empties it.
    if (!isLastFloor && state.floorCardOffer.length === 0) {
      state.floorCardOffer = rollFloorCardOffer(state.cardPrng);
    }

    const p = state.players[0];
    if (!p || !p.alive) return;
    if (isLastFloor) {
      // EXTRACT ends the run, so whatever the squad had voted for is moot — the card
      // is deliberately NOT applied on the way out. Nothing else resolves here: the
      // last floor has no next floor, so CONFIRM_DESCEND falls off the end below.
      if (p.confirmExtract) this.resolveExtract(state);
      return;
    }
    // Interior floor: descend or stay. CONFIRM_EXTRACT is not consulted at all
    // (ENGINE_VERSION 61 — see the header). It is dropped silently rather than
    // treated as a descend: the two are different intentions, and turning one into
    // the other would spend a floor card the player never chose.
    if (!p.confirmDescend) return;

    // Descend needs a card chosen. The vote is the squad's, not the presser's
    // (2026-09-05: "whichever card the most people chose takes effect"), so this
    // tallies every seat and takes the winner — and a tally of 0 means nobody has
    // tapped a card yet, which HOLDS the portal rather than descending without one.
    //
    // Holding on >=1 vote rather than on "everyone has voted" is the co-op call: a
    // downed or disconnected teammate must not be able to strand the squad on a
    // cleared floor. It also leaves the descend authority exactly where it already
    // was — player 0's press — so this pass does not have to settle design/05's
    // still-open question of whose press a shared descend decision should be.
    const slot = tallyCardVote(state.players.map((seat) => seat.cardVote), state.floorCardOffer.length);
    if (slot === 0) return;
    this.resolveDescend(state, state.floorCardOffer[slot - 1]);
  }

  /** The floor's capstone (extraction/boss) room — always the LAST entry, since
   * `generateFloor` always appends it last (design/05/09). `undefined` before a
   * fresh floor has been placed yet (`dungeonRooms` still empty). */
  private capstoneCleared(state: GameState): boolean {
    const rt = state.dungeonRoomRuntime[state.dungeonRoomRuntime.length - 1];
    return rt !== undefined && rt.activated && !rt.hasLiveEnemy;
  }

  /** Merge this floor's buffer into the run's carry-out bag and reset it. Insertion
   * order (= pickup order) is deterministic, so the merge is replay-stable (design/06). */
  private bankFloorMaterials(state: GameState): void {
    for (const [id, qty] of Object.entries(state.floorMaterials)) {
      state.bankedMaterials[id] = (state.bankedMaterials[id] ?? 0) + (qty ?? 0);
    }
    state.floorMaterials = {};
  }

  private resolveExtract(state: GameState): void {
    this.bankFloorMaterials(state);
    state.winner = 0; // single-player: player id 0 (matches the old wavesExhausted win)
    state.phase = 'gameover';
    state.events.push({ type: 'win', winner: 0 });
  }

  private resolveDescend(state: GameState, cardId?: string): void {
    this.bankFloorMaterials(state);
    this.applyFloorCard(state, cardId);
    state.floorIndex++;
    if (state.dungeonEnabled) {
      // The next floor is generated + placed lazily by SpawnSystem when it sees a fresh
      // floor (`dungeonRooms.length === 0`) — the single owner of roomgenPrng draws, same
      // as floor 0. Just clear the co-resident room/door state; the current geometry
      // stays live until the new floor is placed and stitched in.
      state.dungeonRooms.length = 0;
      state.dungeonDoors.length = 0;
      state.dungeonRoomRuntime.length = 0;
      state.dungeonRoomRects.length = 0;
      state.dungeonRoomIndexById.clear();
      state.dungeonBaseWalls.length = 0;
      // Stranded enemies leave with the floor too (ENGINE_VERSION 39). In the
      // co-resident room model the checkpoint only asks that the CAPSTONE room be
      // cleared (`capstoneCleared` above) — every OTHER room can still be full of live
      // enemies when this runs (a room whose `WaveScript` has a late `atTick` entry
      // re-populates itself long after the player cleared it and walked on, and the
      // checkpoint never asks where the player is standing). Keeping them dragged every
      // one into the next floor still holding a `roomId` for a room that no longer
      // exists and a grid position measured against geometry that has just been torn
      // down — they'd surface embedded in the newly stitched floor's walls. Exactly the
      // reasoning behind clearing the room/door arrays above and `pickups` below: the
      // geometry it stood on is gone. Narrow back when a floor was 2-3 rooms of 1-2
      // enemies; v38's hand-authored level 1 (5 floors of 5/6/7/6/5 rooms at 15-30
      // enemies each, `world/rooms/emberLevel1.ts`) is what makes it ~100 stranded
      // enemies per floor for a player who beelines the capstone.
      //
      // Deliberately a silent discard, NOT a mass death. Routing them through
      // DeathDropsSystem instead would roll dropPrng once per stranded enemy (shifting
      // every later drop in the run), hand the player a floor's worth of materials for
      // kills they never made, and let a stranded boss's `onDeathSpawn` litter the fresh
      // floor with minions. The player chose to leave them behind; they get nothing for
      // it. Removal draws no PRNG and pushes no event, so the only observable change is
      // the enemies' absence.
      state.enemies.length = 0;
      // Their bullets go with them. A projectile's position is fp-in-this-floor's-
      // geometry like any actor's, and a shot fired in a room the player never entered
      // has no business landing on them at the next floor's spawn point. Dungeon-only on
      // purpose: a flat `floors` descend keeps the SAME arena geometry (only the wave
      // list is swapped), so a bullet still in flight there remains perfectly valid.
      state.projectiles.length = 0;
    } else {
      state.waves = state.extraFloors[state.floorIndex - 1]!;
    }
    state.waveIndex = -1;
    state.waveBreakTicks = 0;
    state.wavesExhausted = false;
    state.pickups.length = 0; // uncollected drops don't carry to the next floor
    state.events.push({ type: 'descend', floorIndex: state.floorIndex });
  }

  /**
   * Bank the squad's chosen floor card (design/05, ENGINE_VERSION 58) and close the
   * offer. `cardId` is undefined only for the flat-`floors` path and for any caller
   * that descends without an offer open, which then simply banks nothing.
   *
   * Two storage paths, and the split is the point. A BUFF card is pushed onto every
   * seat's own `buffs` stack — the same list a buff picked up off the floor lands in —
   * so it resolves through the existing `sumBuffs`/`BUFF_CAPS` arithmetic rather than a
   * second damage-scaling path that could disagree with it. The other kinds change the
   * RUN, not a person, and are re-derived from `state.floorCards` at the point of use
   * (`resolveFloorCards`) so the picked list stays the single source of truth.
   *
   * Team-wide on the owner's call (2026-09-05): the vote is collective, so the reward
   * is. A DOWNED seat is included deliberately — they are still on the team, they can
   * still be revived, and handing a squad a permanent asymmetry because someone was on
   * the floor at the wrong moment would make reviving them worth less than it should be.
   */
  private applyFloorCard(state: GameState, cardId: string | undefined): void {
    // The offer closes either way: a descend without a pick (flat-`floors` mode, which
    // never opens one) must not leave a stale offer for the next floor to inherit.
    state.floorCardOffer = [];
    for (const seat of state.players) seat.cardVote = 0;
    if (cardId === undefined) return;

    state.floorCards.push(cardId);
    const buffId = cardBuffId(cardId);
    if (buffId !== undefined) {
      for (const seat of state.players) seat.buffs.push(buffId);
    }
  }
}
