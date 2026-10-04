/**
 * Step 14 — Win condition. PvE: no player "up" (all downed-or-dead) → enemies win;
 * last wave cleared with no enemies left → the (single) player wins. PvP (arena
 * mode, design/15 ROADMAP 4.2e): last SQUAD standing wins (design/05/15's squad
 * follow-up groups seats by `teamId`; a solo/FFA match is just every squad being a
 * singleton), with a finish order recorded as each squad is eliminated. Sets
 * state.winner + phase='gameover' once and emits a win event. After gameover the
 * orchestrator returns early and never re-enters here.
 *
 * Runs AFTER ReviveSystem (step 13, ROADMAP 3.2) so a completed revive / bleedout death
 * has already resolved this tick, and AFTER ExtractionSystem (step 12, ROADMAP 1.4/1.5): when `floorsEnabled`,
 * reaching wavesExhausted-with-no-enemies is a per-floor CHECKPOINT, not an
 * automatic win — ExtractionSystem owns that transition (EXTRACT/DESCEND), so this
 * system's wavesExhausted branch is skipped entirely for a floors-mode run. For
 * every config that predates 1.4 (floorsEnabled always false), this guard never
 * fires and behavior is byte-identical to before — additive, no ENGINE_VERSION bump.
 *
 * Ports Game.ts win()/lose() outcome logic; the menu/result shell (design/10)
 * stays render-side and is not the engine's concern.
 */
import type { GameState } from '../state/GameState';

export class WinConditionSystem {
  tick(state: GameState): void {
    if (state.winner !== null) return;

    // Arena mode (design/15) is a completely different win model — elimination
    // placement, not "enemies win"/wave-clear — so it branches BEFORE any PvE check
    // below rather than layering onto them (every pre-4.2e config never sets
    // zoneEnabled, so this is additive — byte-identical, no ENGINE_VERSION bump).
    if (state.zoneEnabled) {
      this.tickPlacement(state);
      return;
    }

    // "Up" = alive AND not downed (design/05/07, ROADMAP 3.2). A run ends the moment no
    // player is up — every player downed-or-dead, so no one remains to revive. In
    // single-player this fires the same tick the sole player goes down (its old death
    // behaviour); in co-op the run survives as long as one teammate is still standing.
    if (!state.players.some((p) => p.alive && !p.downed)) {
      state.winner = 'enemies';
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 'enemies' });
      return;
    }

    // Nor once every person is dead and only bots stand (ENGINE_VERSION 88). A bot never opens
    // the portal, so a run its player bled out of could only end when the bot died too, with
    // the player watching. A downed person is still alive, and the bot may yet revive them.
    // With no bot seat at all (solo, and every config before 88) every person dead is nobody up,
    // which the check above has already ended; with no person at all (a sim's all-bot run)
    // there is nobody to strand.
    const people = state.players.filter((p) => !p.bot);
    if (people.length > 0 && people.every((p) => !p.alive)) {
      state.winner = 'enemies';
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 'enemies' });
      return;
    }

    if (state.floorsEnabled) return; // ExtractionSystem (12) owns the win transition instead

    if (state.wavesExhausted && state.enemies.length === 0) {
      state.winner = 0; // single-player: player id 0
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 0 });
    }
  }

  /**
   * Battle-royale placement (design/15), squad-aware (design/05/15's PvP squad
   * follow-up). Players are grouped by `teamId` into squads (a solo/FFA match is just
   * every squad being a singleton — the exact pre-squad behavior, unchanged). A squad
   * is eliminated once EVERY member is `!alive`; record every one of its seats (worst
   * place first) the tick that happens. When exactly one squad still has a living
   * member, that squad wins. The zero-surviving-squads case (two-or-more squads wiped
   * on the identical tick) is design/15's explicit same-tick tiebreak — deterministic,
   * never a coin flip: among the squads wiped on that tick, ascending `teamId` places higher.
   *
   * `state.winner`/the `'win'` event still carry a single representative SEAT index
   * (the winning squad's lowest seat index) — every consumer (`RunOutcome.ts`,
   * `replay.ts`, the HUD) already expects one seat number, and squad-mates share the
   * same outcome regardless of which one is named.
   *
   * NOTE: squad-mates eliminated together land at ADJACENT, not identical, numeric
   * placements (whichever order they're pushed within the batch) — full squad-tied
   * ranking would need `ladderReport.ts`'s per-seat rating math to become squad-aware
   * too, which is a deliberate follow-up, not done here (every other `placements`
   * consumer only cares about seat-index order, which this preserves exactly).
   */
  private tickPlacement(state: GameState): void {
    const seatsByTeam = new Map<number, number[]>();
    state.players.forEach((p, i) => {
      let seats = seatsByTeam.get(p.teamId);
      if (!seats) {
        seats = [];
        seatsByTeam.set(p.teamId, seats);
      }
      seats.push(i);
    });

    // Squads wiped on THIS tick: the only ones the zero-survivors tiebreak may choose from.
    const wipedNow: number[] = [];
    for (const [team, seats] of seatsByTeam) {
      if (!seats.every((i) => !state.players[i]!.alive)) continue; // squad still has a survivor
      if (seats.some((i) => !state.placements.includes(i))) wipedNow.push(team);
      for (const i of seats) {
        if (!state.placements.includes(i)) state.placements.push(i);
      }
    }

    const aliveTeams = new Set<number>();
    state.players.forEach((p) => {
      if (p.alive) aliveTeams.add(p.teamId);
    });
    if (aliveTeams.size > 1) return; // match continues

    let winnerTeam: number;
    if (aliveTeams.size === 1) {
      winnerTeam = [...aliveTeams][0]!;
    } else {
      // Simultaneous wipe: the lowest teamId among the squads that went out together wins. Not
      // among every squad: until 2026-09-30 a seat eliminated long before could be named winner.
      winnerTeam = Math.min(...wipedNow);
    }
    const winnerSeats = seatsByTeam.get(winnerTeam)!;
    for (const i of winnerSeats) {
      const pos = state.placements.indexOf(i);
      if (pos !== -1) state.placements.splice(pos, 1); // the winning squad is 1st, not losers
    }
    const winnerIdx = Math.min(...winnerSeats);

    state.winner = winnerIdx;
    state.phase = 'gameover';
    state.events.push({ type: 'win', winner: winnerIdx });
  }
}
