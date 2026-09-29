/**
 * Headless bot-vs-bot PvP balance data (ROADMAP 4.x — `PVP_SCALE_FACTOR`
 * (balance/build.ts) and the zone shrink-step tuning (content/arenas.ts) are both
 * explicitly flagged "first-pass, real play required"). Real human playtesting is
 * the actual ground truth this feeds; this sim's job is a cheap, repeatable
 * FIRST SIGNAL — win-rate skew, whether matches converge, how long they run — that
 * doesn't need to wait for a human play session, and can be re-run after any tuning
 * change to see the direction it moved.
 *
 * Drives the engine directly (`createGameEngine` + `PvpBotController.build()` each
 * tick) rather than through MatchRoom/CoopSession/a real socket — this is a
 * gameplay-outcome question, not a net-layer one, and `buildPvpEngineConfig` is the
 * SAME function `Game.buildOnlineConfig`/`server/src/BotClient.ts` use for a real
 * match, so the simulated config is byte-identical to a real arena run (design/06
 * anti-drift — no hand-mirrored second copy of the config logic).
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine, Prng, type EngineConfig } from '@dd/engine';
import { buildPvpEngineConfig, squadSizeForPlayerCount } from '../src/game/match/pvpConfig';
import { PvpBotController } from '../src/game/controllers/PvpBotController';
import { idleCommand } from '../src/game/controllers/ai/engage';

// SIM-ONLY deconfounding: `buildPvpEngineConfig` skins seats BY INDEX (seat i -> the
// i-th SKIN_DEFS entry) — a real, load-bearing property of the real match config
// (design/15: spawns are system-assigned, no player choice), so this must NOT change
// `pvpConfig.ts` itself. But that seat-index-is-character correlation means any
// seat/spawn-position advantage silently reads as a character-balance signal in this
// sim's win-rate report. Reusing `buildPvpEngineConfig` for the byte-identical base
// config, then shuffling ONLY here which skinId lands on which seat (a distinct Prng
// stream, seeded off the match seed but never touching a gameplay stream — same
// isolation rule design/15's `integrityPrng` uses) breaks that correlation: over many
// seeds, every character lands on every seat/spawn roughly equally, so a persistent
// win-rate skew can no longer be explained by spawn position alone.
function deconfoundSkinSeating(config: EngineConfig, seed: number): EngineConfig {
  const players = config.players!;
  const skinIds = players.map((p) => p.skinId);
  new Prng(seed ^ 0x5eed0001).shuffle(skinIds);
  return {
    ...config,
    players: players.map((p, i) => ({ ...p, skinId: skinIds[i]! })),
  };
}

// SIM-ONLY deconfounding, the second one: per-seat reaction offsets at the drop. The arena is
// one fixed map and `PvpBotController` is a pure function of state, so without them a match is
// fixed by its seating alone � measured 2026-09-29, 30 seeds replayed only 12 (2 seats), 16, 22,
// 21, 23 and 9 (8 seats) distinct matches, and the win-rate report was counting the same game
// several times over. Each seat stands idle for 0..MAX_START_DELAY ticks off its own Prng stream
// (never a gameplay one), which is also closer to real play: nobody moves on the first tick.
// 45 ticks (1.5 s) takes every count from 3 seats up to 28-30 distinct; 2 seats stop near 23,
// since only the relative offset and two seatings vary there. The gate below holds that.
const MAX_START_DELAY = 45;
const MIN_DISTINCT = 20; // of SEEDS_PER_COUNT, per seat count

function startDelays(seed: number, playerCount: number, maxDelay: number): number[] {
  const prng = new Prng(seed ^ 0x0de1a7ed);
  return Array.from({ length: playerCount }, () => prng.nextInt(maxDelay + 1));
}

// Matches Matchmaker.MAX_PLAYERS' 8-seat ceiling (design/15); 7 skipped, no special
// meaning at odd counts a run of 6 doesn't already cover.
const PLAYER_COUNTS = [2, 3, 4, 5, 6, 8];
const SEEDS_PER_COUNT = 30;
// Real matches converge in ~1-2k ticks (observed) — this is a generous multiple, so a
// timeout is itself a real finding (the zone/bot-AI combo failed to converge), not an
// expected outcome the ceiling is meant to paper over.
const MAX_TICKS = 20000;

interface MatchResult {
  playerCount: number;
  seed: number;
  ticks: number;
  timedOut: boolean;
  winnerSkin: string; // 'tie' on the rare simultaneous-elimination edge case
  zoneStageAtEnd: number;
  placementsCount: number;
  /** Duration plus elimination order: two matches with the same one are the same match. */
  fingerprint: string;
}

function runMatch(seed: number, playerCount: number, maxDelay = MAX_START_DELAY): MatchResult {
  const config = deconfoundSkinSeating(buildPvpEngineConfig(seed, playerCount), seed);
  const engine = createGameEngine(config);
  const bots = Array.from({ length: playerCount }, () => new PvpBotController());
  const delays = startDelays(seed, playerCount, maxDelay);

  let ticks = 0;
  while (engine.state.phase !== 'gameover' && ticks < MAX_TICKS) {
    const nextTick = engine.state.tick + 1;
    const cmds = bots.map((bot, seat) => (nextTick <= delays[seat]! ? idleCommand(seat, nextTick) : bot.build(engine.state, seat, nextTick)));
    engine.step(cmds);
    ticks++;
  }

  const s = engine.state;
  const winnerSeat = s.players.findIndex((p) => p.alive);
  const winnerSkin = winnerSeat >= 0 ? (config.players![winnerSeat]!.skinId ?? 'unknown') : 'tie';

  return {
    playerCount,
    seed,
    ticks,
    timedOut: ticks >= MAX_TICKS,
    winnerSkin,
    zoneStageAtEnd: s.zone?.stage ?? -1,
    placementsCount: s.placements.length,
    fingerprint: `${ticks}:${JSON.stringify(s.placements)}`,
  };
}

describe('PvP balance sim (bot vs bot — first-signal data for PVP_SCALE_FACTOR/zone tuning, not a replacement for real playtesting)', () => {
  it('runs a sweep across seat counts and seeds, asserts convergence, reports win-rate/duration', () => {
    // (timeout below: 210 real bot-vs-bot matches, the no-offset control included, take ~15 s of
    // wall-clock, past vitest's 5s default per-test timeout)
    const results: MatchResult[] = [];
    for (const playerCount of PLAYER_COUNTS) {
      for (let i = 0; i < SEEDS_PER_COUNT; i++) {
        results.push(runMatch(1_000_000 + playerCount * 10_000 + i, playerCount));
      }
    }

    // The zone's own no-stalemate structural bound (design/15 — the final shrink
    // stage loops HOLD forever rather than shrinking to nothing) should mean bots
    // always reach a winner well inside MAX_TICKS. A real regression check, not
    // just a report — if this ever fails, the zone/bot-AI combo stopped converging.
    // Every seed has to be its own match, or the counts below weigh one game several times.
    // The control proves this can fail: with the offsets off, 2 seats replay 12 matches.
    const distinct = (rows: MatchResult[]) => new Set(rows.map((r) => r.fingerprint)).size;
    const distinctByCount = PLAYER_COUNTS.map((pc) => [pc, distinct(results.filter((r) => r.playerCount === pc))] as const);
    for (const [pc, n] of distinctByCount) expect(n, `${pc} seats`).toBeGreaterThanOrEqual(MIN_DISTINCT);
    const control = Array.from({ length: SEEDS_PER_COUNT }, (_, i) => runMatch(1_000_000 + 2 * 10_000 + i, 2, 0));
    expect(distinct(control)).toBeLessThan(MIN_DISTINCT);

    const timedOut = results.filter((r) => r.timedOut);
    expect(timedOut).toEqual([]);

    // Every match should resolve with exactly one non-eliminated SQUAD (design/05/15):
    // `placements.length === playerCount - <the winning squad's size>`. For any seat
    // count squads don't apply to (`squadSizeForPlayerCount` collapses to 1 — every
    // count in this sweep except 8), that's the original `playerCount - 1` invariant,
    // byte-identical to before squads existed. For 8 (2 squads of 4), an entire
    // LOSING squad's worth of seats lands in `placements` at once and the WINNING
    // squad's other 3 seats never appear there at all, alongside the 1 seat this sim
    // reports as `winnerSkin`. The 'tie' simultaneous-elimination edge case is
    // allowed but should stay rare.
    const ties = results.filter((r) => r.winnerSkin === 'tie');
    for (const r of results) {
      if (r.winnerSkin === 'tie') continue;
      expect(r.placementsCount).toBe(r.playerCount - squadSizeForPlayerCount(r.playerCount));
    }
    expect(ties.length).toBeLessThan(results.length * 0.05); // <5% ties — a spike would flag a real placement/elimination bug

    // Win rate per character. `deconfoundSkinSeating` (above) shuffles which skinId
    // lands on which seat per seed, independent of `buildPvpEngineConfig`'s own
    // seat-index assignment — so a seat/spawn-position advantage is no longer
    // entangled with a specific character across this seed sweep. Still first-signal
    // data to sanity-check against real playtesting, not a verdict (e.g. bot AI
    // quality/aggression isn't necessarily representative of human play).
    //
    // Squad follow-up caveat (design/05/15), not fixed here: for playerCount=8 (2
    // squads of 4), `winnerSkin` is just WHICHEVER surviving member of the winning
    // squad `runMatch` happens to find first — not necessarily the strongest
    // performer, since a squad's fate is shared regardless of which individual
    // member lands the last kill. This makes the win-rate-by-character read noisier
    // for 8-seat rows specifically (every other row in PLAYER_COUNTS is unaffected,
    // squadSizeForPlayerCount collapsing to 1 there) — a real win-rate-by-SQUAD
    // report would need its own aggregation, deliberately not built here.
    const bySkin = new Map<string, number>();
    for (const r of results) bySkin.set(r.winnerSkin, (bySkin.get(r.winnerSkin) ?? 0) + 1);

    const byPlayerCount = new Map<number, { avgTicks: number; maxZoneStage: number; n: number }>();
    for (const pc of PLAYER_COUNTS) {
      const rows = results.filter((r) => r.playerCount === pc);
      byPlayerCount.set(pc, {
        avgTicks: Math.round(rows.reduce((sum, r) => sum + r.ticks, 0) / rows.length),
        maxZoneStage: Math.max(...rows.map((r) => r.zoneStageAtEnd)),
        n: rows.length,
      });
    }

    // eslint-disable-next-line no-console
    console.log(`\n=== PvP balance sim: ${results.length} bot-vs-bot matches ===`);
    // eslint-disable-next-line no-console
    console.log('Win rate by character:', JSON.stringify(Object.fromEntries(bySkin)));
    // eslint-disable-next-line no-console
    console.log('Duration (ticks @30Hz) / max zone stage reached, by seat count:', JSON.stringify(Object.fromEntries(byPlayerCount)));
    // eslint-disable-next-line no-console
    console.log('Distinct matches of', SEEDS_PER_COUNT, 'seeds, by seat count:', JSON.stringify(Object.fromEntries(distinctByCount)), `(no-offset control, 2 seats: ${distinct(control)})`);
    // eslint-disable-next-line no-console
    console.log(`Ties (simultaneous elimination, no clear winner): ${ties.length}/${results.length}`);
  }, 60_000);
});
