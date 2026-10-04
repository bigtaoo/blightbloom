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
import { Button, createGameEngine, FP_SCALE, type PlayerActor } from '@dd/engine';
import { buildPvpEngineConfig, squadSizeForPlayerCount } from '../src/game/match/pvpConfig';
import { PvpBotController } from '../src/game/controllers/PvpBotController';
import { idleCommand } from '../src/game/controllers/ai/engage';
import { countsTowardShare, fairShares } from './pvp/fairShare';
import { deconfoundSkinSeating, MAX_START_DELAY, startDelays } from './pvp/matchSetup';

// Of SEEDS_PER_COUNT, per seat count: see `pvp/matchSetup.ts` on the start delays.
const MIN_DISTINCT = 20;

// Matches Matchmaker.MAX_PLAYERS' 8-seat ceiling (design/15); 7 skipped, no special
// meaning at odd counts a run of 6 doesn't already cover.
const PLAYER_COUNTS = [2, 3, 4, 5, 6, 8];
const SEEDS_PER_COUNT = 30;
// Real matches converge in ~1-2k ticks (observed) — this is a generous multiple, so a
// timeout is itself a real finding (the zone/bot-AI combo failed to converge), not an
// expected outcome the ceiling is meant to paper over.
const MAX_TICKS = 20000;
/** How near a seat's hit a vanished rebound was, the tick before, to be the bullet that dealt it:
 *  a bullet's step plus a body's radius, in fp. */
const REBOUND_MATCH_FP = 1.5 * FP_SCALE;

interface MatchResult {
  playerCount: number;
  seed: number;
  ticks: number;
  timedOut: boolean;
  winnerSkin: string; // 'tie' on the rare simultaneous-elimination edge case
  /** The skin on each seat, after the shuffle: what a character's fair share of wins is read off. */
  skins: string[];
  zoneStageAtEnd: number;
  placementsCount: number;
  /** Duration plus elimination order: two matches with the same one are the same match. */
  fingerprint: string;
  /** Bullets a seat batted back, and the rebounds that then landed on a seat, with their damage
   *  (the bot parries since 2026-10-03; `PVP_DEFLECT_DAMAGE_PERMILLE` was never in play before). */
  deflects: number;
  reboundHits: number;
  reboundDamage: number;
  /** Guns a seat picked up, blades drawn for a gun it could not pay for, and seat-ticks spent
   *  holding such a gun (the bot loots and falls back to the blade since 2026-10-03). */
  gunsLooted: number;
  dryDraws: number;
  dryTicks: number;
}

/** The seat holds a gun it cannot pay for a pull of. */
function holdsDryGun(p: PlayerActor): boolean {
  const spec = p.weapon?.spec;
  return spec?.kind === 'ranged' && p.energy < spec.energyCost;
}

function runMatch(seed: number, playerCount: number, maxDelay = MAX_START_DELAY): MatchResult {
  const config = deconfoundSkinSeating(buildPvpEngineConfig(seed, playerCount), seed);
  const engine = createGameEngine(config);
  const bots = Array.from({ length: playerCount }, () => new PvpBotController());
  const delays = startDelays(seed, playerCount, maxDelay);

  let ticks = 0;
  const parry = { deflects: 0, reboundHits: 0, reboundDamage: 0 };
  const kit = { gunsLooted: 0, dryDraws: 0, dryTicks: 0 };
  const seatIds = new Set(engine.state.players.map((p) => p.id));
  while (engine.state.phase !== 'gameover' && ticks < MAX_TICKS) {
    const nextTick = engine.state.tick + 1;
    const cmds = bots.map((bot, seat) => (nextTick <= delays[seat]! ? idleCommand(seat, nextTick) : bot.build(engine.state, seat, nextTick)));
    // A rebound that lands is gone after the step; the hit it dealt is the seat hit nearest it.
    const rebounds = engine.state.projectiles.filter((b) => b.alive && b.deflected).map((b) => ({ b, gx: b.gx, gy: b.gy }));
    engine.state.players.forEach((p, seat) => {
      if (!p.alive || p.downed || !holdsDryGun(p)) return;
      kit.dryTicks++;
      if (cmds[seat]!.buttons & Button.SWAP_WEAPON) kit.dryDraws++;
    });
    engine.step(cmds);
    ticks++;
    for (const e of engine.state.events) {
      if (e.type === 'deflect') parry.deflects++;
      if (e.type === 'pickup' && e.kind === 'weapon' && seatIds.has(e.by)) kit.gunsLooted++;
      if (e.type !== 'hit' || !seatIds.has(e.target)) continue;
      const landed = rebounds.find((r) => !r.b.alive && Math.hypot(r.gx - e.gx, r.gy - e.gy) <= REBOUND_MATCH_FP);
      if (!landed) continue;
      rebounds.splice(rebounds.indexOf(landed), 1);
      parry.reboundHits++;
      parry.reboundDamage += e.damage;
    }
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
    skins: config.players!.map((p) => p.skinId ?? 'unknown'),
    zoneStageAtEnd: s.zone?.stage ?? -1,
    placementsCount: s.placements.length,
    fingerprint: `${ticks}:${JSON.stringify(s.placements)}`,
    ...parry,
    ...kit,
  };
}

describe('PvP balance sim (bot vs bot — first-signal data for PVP_SCALE_FACTOR/zone tuning, not a replacement for real playtesting)', () => {
  it('runs a sweep across seat counts and seeds, asserts convergence, reports win-rate/duration', () => {
    // (timeout below: 240 real bot-vs-bot matches, the control included, take ~80 s of
    // wall-clock since seats spawn apart and the bots path round solids: a spread lobby wakes
    // many rooms' mobs at once, and the bot's own tick costs about what the engine's does)
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
    // The control proves this can fail: a harness that dropped its seed, 30 runs of one seed
    // with the offsets off, has to read as one match (and so doubles as a determinism check).
    const distinct = (rows: MatchResult[]) => new Set(rows.map((r) => r.fingerprint)).size;
    const distinctByCount = PLAYER_COUNTS.map((pc) => [pc, distinct(results.filter((r) => r.playerCount === pc))] as const);
    for (const [pc, n] of distinctByCount) expect(n, `${pc} seats`).toBeGreaterThanOrEqual(MIN_DISTINCT);
    const control = Array.from({ length: SEEDS_PER_COUNT }, () => runMatch(1_000_000 + 2 * 10_000, 2, 0));
    expect(distinct(control)).toBe(1);

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
    // <8% ties — a spike would flag a real placement/elimination bug. It was <5% until 2026-09-30,
    // when the v83 chevron change moved this block from 6 ties to 9 with no change in the rate:
    // three 180-match blocks read 16 ties of 540 on v83 and 19 on v82. Every tie was the last
    // two seats downed on one tick, bleeding out together 900 ticks later, and 13 of the 16 were
    // the two seats shooting each other down on that tick. Once the bot took turns holding fire
    // in a head-on trade (`ai/fireYield.ts`, same day) the same 540 read 0 ties: one seat of a
    // pair fires at a time, so their hits never land together (volume 118).
    expect(ties.length).toBeLessThan(results.length * 0.08);

    // Win rate per character. `deconfoundSkinSeating` (`pvp/matchSetup.ts`) shuffles which skinId
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
    // The raw counts above are NOT comparable across characters (`pvp/fairShare.ts` has why):
    // wins against seat share is the number to read. Volume 127: raw totals read 357/360/352,
    // level, while the juggernaut won 1.45x its share over 900 matches.
    const share = fairShares(results);
    // The shares of a decided match sum to one, so the fair shares sum to the decided matches.
    const decided = results.filter(countsTowardShare).length;
    expect([...share.values()].reduce((n, x) => n + x.fair, 0)).toBeCloseTo(decided, 6);

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
    console.log('Wins by character (raw, NOT comparable, see share below):', JSON.stringify(Object.fromEntries(bySkin)));
    // eslint-disable-next-line no-console
    console.log('Wins / fair share, 2-6 seats (1.00 = par):', [...share].map(([k, x]) => `${k} ${x.wins}/${x.fair.toFixed(1)} = ${(x.wins / x.fair).toFixed(2)}`).join(', '));
    // eslint-disable-next-line no-console
    console.log('Duration (ticks @30Hz) / max zone stage reached, by seat count:', JSON.stringify(Object.fromEntries(byPlayerCount)));
    // eslint-disable-next-line no-console
    console.log('Distinct matches of', SEEDS_PER_COUNT, 'seeds, by seat count:', JSON.stringify(Object.fromEntries(distinctByCount)), `(control, one seed 30 times: ${distinct(control)})`);
    // eslint-disable-next-line no-console
    console.log(`Ties (simultaneous elimination, no clear winner): ${ties.length}/${results.length}`);
    const total = (k: 'deflects' | 'reboundHits' | 'reboundDamage' | 'gunsLooted' | 'dryDraws' | 'dryTicks') => results.reduce((n, r) => n + r[k], 0);
    // eslint-disable-next-line no-console
    console.log(`Parries: ${total('deflects')}, rebounds that landed on a seat: ${total('reboundHits')} for ${total('reboundDamage')} damage`);
    // The shipped bot parries (`ai/parry.ts`), and a rebound reaches a seat at the deflect damage:
    // until 2026-10-03 neither happened in any match, sim or real.
    expect(total('deflects')).toBeGreaterThan(0);
    expect(total('reboundHits')).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`Guns looted: ${total('gunsLooted')}, blades drawn for a dry gun: ${total('dryDraws')}, seat-ticks holding a dry gun: ${total('dryTicks')}`);
    // The shipped bot loots and draws its blade for a dry gun (`ai/loot.ts`, `ai/dryBlade.ts`):
    // until 2026-10-03 only the sim-only `ArenaBotController` did either.
    expect(total('gunsLooted')).toBeGreaterThan(0);
    expect(total('dryDraws')).toBeGreaterThan(0);
  }, 300_000);
});
