/**
 * PvE chapter balance sim — chapter 2 against chapter 1 (2026-10-06). Runs with
 * `npm run test:pve-sim`, next to `pveLevelSim.sim.ts` (chapter 1's own sweep and gates,
 * which this file does not touch).
 *
 * Three measurements, each answering a question the other two cannot:
 *   1. FULL RUNS of each chapter (the same sweep `pveLevelSim` does for chapter 1) — how far
 *      a run gets, and of the runs that reach floor k, how many pass it.
 *   2. FLOOR TRIALS (`sim/pve/chapterTrial.ts`) — every floor of both chapters from a fresh
 *      start at that floor's own difficulty scale. Full runs never reach the deep floors, so
 *      this is the only per-floor comparison past floor 1.
 *   3. BOSS TRIALS — each boss in its own chapter's boss room at its boss-floor scale, with
 *      the room's adds (the real fight) and alone (where all damage is the boss's), plus
 *      Glacimaw staged in chapter 1's room at chapter 1's scale as the control that
 *      separates "Glacimaw is a harder boss" from "chapter 2 scales everything harder".
 *
 * Read every number as a LOWER bound on a human (the bot never dodges a shot on purpose) and
 * the trials as "how hard is this floor/boss", not "how hard is it to arrive there".
 */
import { describe, expect, it } from 'vitest';
import { CHAPTERS, type ChapterId } from '@dd/engine';
import { runLevel, type RunMetrics } from './pve/levelSim';
import { floorScale, floorTrial, runBossTrial, type BossTrialRun, type BossTrialSpec } from './pve/chapterTrial';
import {
  bossTrialStats,
  depthStats,
  floorTrialStats,
  formatBossTrialTable,
  formatDepthTable,
  formatFloorTrialTable,
  type BossTrialStats,
  type FloorTrialStats,
} from './pve/reportChapter';
import { entranceRoomStats, formatRoomTable, formatSummary, roomStats, summarize } from './pve/report';

/** The same 40 seeds `pveLevelSim.sim.ts` uses (see its `SEEDS` comment for why 40). */
const SEEDS = Array.from({ length: 40 }, (_, i) => 101 + i * 101);
/**
 * 80 for the careful FULL runs, whose descent counts the chapter-vs-chapter gate compares.
 * On the first 40 seeds the two chapters read 8 vs 6 descents — a margin of two, which the
 * next content change re-rolling `dropPrng` could flip with the level's real difficulty
 * unmoved (the trap `pveLevelSim`'s own `SEEDS` comment records). Over 80 they read 20 vs 10.
 */
const WIDE_SEEDS = Array.from({ length: 80 }, (_, i) => 101 + i * 101);
const PROFILES = ['careful', 'aggressive'] as const;
const CHAPTER_IDS: readonly ChapterId[] = ['ember', 'frost'];
const FLOORS = [0, 1, 2, 3, 4] as const;

const CH1_BOSSES = ['blightlord', 'pyrefang', 'ironwarden'] as const;
interface BossCondition {
  label: string;
  spec: BossTrialSpec;
}
const BOSS_CONDITIONS: readonly BossCondition[] = [
  ...CH1_BOSSES.flatMap((boss) => [
    { label: `ember ${boss} +adds`, spec: { room: 'ember', boss, adds: true } as BossTrialSpec },
    { label: `ember ${boss} alone`, spec: { room: 'ember', boss, adds: false } as BossTrialSpec },
  ]),
  { label: 'frost glacimaw +adds', spec: { room: 'frost', boss: 'glacimaw', adds: true } },
  { label: 'frost glacimaw alone', spec: { room: 'frost', boss: 'glacimaw', adds: false } },
  // Control: chapter 2's boss under chapter 1's room and scale.
  { label: 'control: glacimaw in ember +adds', spec: { room: 'ember', boss: 'glacimaw', adds: true } },
  { label: 'control: glacimaw in ember alone', spec: { room: 'ember', boss: 'glacimaw', adds: false } },
];

describe('PvE chapter sim — chapter 2 (frost) against chapter 1 (ember)', () => {
  const memo = new Map<string, unknown>();
  function cached<T>(key: string, make: () => T): T {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key) as T;
  }
  const fullRuns = (chapter: ChapterId, p: (typeof PROFILES)[number]): RunMetrics[] =>
    cached(`run:${chapter}:${p}`, () => (p === 'careful' ? WIDE_SEEDS : SEEDS).map((seed) => runLevel({ seed, profileName: p, chapter })));
  const floorRuns = (chapter: ChapterId, k: number): FloorTrialStats =>
    cached(`floor:${chapter}:${k}`, () => {
      const dungeon = floorTrial(chapter, k);
      return floorTrialStats(SEEDS.map((seed) => runLevel({ seed, profileName: 'careful', dungeon })));
    });
  const bossRuns = (c: BossCondition): BossTrialRun[] => cached(`boss:${c.label}`, () => SEEDS.map((seed) => runBossTrial(seed, c.spec)));
  const boss = (label: string): BossTrialStats => bossTrialStats(bossRuns(BOSS_CONDITIONS.find((c) => c.label === label)!));

  it('reports full runs of chapter 2, and how far each chapter gets floor by floor', () => {
    for (const p of PROFILES) {
      const rows = fullRuns('frost', p);
      // eslint-disable-next-line no-console
      console.log(`\n${formatSummary(`chapter=frost profile=${p}`, summarize(rows))}`);
      // eslint-disable-next-line no-console
      console.log(formatRoomTable(roomStats(rows)));
    }
    for (const p of PROFILES) {
      // eslint-disable-next-line no-console
      console.log(`\n--- profile=${p}: floor pass rate, full runs ---`);
      // eslint-disable-next-line no-console
      console.log(formatDepthTable(Object.fromEntries(CHAPTER_IDS.map((c) => [c, depthStats(fullRuns(c, p), CHAPTERS[c].config.floorCount)]))));
    }
    expect(fullRuns('frost', 'careful').length).toBe(WIDE_SEEDS.length);
  }, 600_000);

  it('reports every floor of both chapters from a fresh start (floor trials, careful)', () => {
    const rows = CHAPTER_IDS.flatMap((chapter) => FLOORS.map((k) => ({ chapter, floorIndex: k, scale: floorScale(chapter, k), stats: floorRuns(chapter, k) })));
    // eslint-disable-next-line no-console
    console.log(`\n--- floor trials: fresh careful bot, starter kit, floor k at floor k's scale ---\n${formatFloorTrialTable(rows)}`);
    // Anti-vacuity: a trial dungeon the bot could not even play would print clean zeroes.
    expect(floorRuns('ember', 0).avgKills, 'the floor-0 trial killed nothing — the trial measures nothing').toBeGreaterThan(5);
  }, 600_000);

  it('reports each boss fight (boss trials, careful)', () => {
    const rows = BOSS_CONDITIONS.map((c) => ({ label: c.label, stats: boss(c.label) }));
    // eslint-disable-next-line no-console
    console.log(`\n--- boss trials: fresh careful bot, starter kit, entering through the real door ---\n${formatBossTrialTable(rows)}`);
    // Anti-vacuity: the duel conditions must actually be fought.
    expect(boss('frost glacimaw alone').bossMaxHp).toBeGreaterThan(0);
  }, 600_000);

  // ── Chapter-2 gates — the same shapes as `pveLevelSim.sim.ts`'s chapter-1 gates, plus the
  // two only a comparison can state: chapter 2 is the HARDER chapter, and its boss is a fight
  // of the same kind as chapter 1's. Difficulty bounds are two-sided, for the reason chapter
  // 1's are: a retune that overshoots into a walkover should fail too.

  it("gate: chapter 2's entrance room gives the player time to react", () => {
    const entrance = entranceRoomStats(fullRuns('frost', 'careful'));
    expect(entrance?.garrison ?? 0, 'entrance has no garrison — the gate would be vacuous').toBeGreaterThan(0);
    expect(entrance!.medianReactionTicks ?? Infinity).toBeGreaterThanOrEqual(30);
  }, 600_000);

  it('gate: no chapter-2 room focus-fires the player with more than the effective HP pool', () => {
    for (const p of PROFILES) {
      const rows = fullRuns('frost', p);
      const worst = Math.max(...rows.map((r) => r.peakBurstDamage));
      expect(worst, `profile=${p} worst 1s burst ${worst} vs ${rows[0]!.effectiveHp} effective HP`).toBeLessThan(rows[0]!.effectiveHp);
    }
  }, 600_000);

  it('gate: chapter 2 is harder than chapter 1 but not a wall — a careful player clears its entrance and sometimes floor 1', () => {
    const frost = fullRuns('frost', 'careful');
    const ember = fullRuns('ember', 'careful');
    const entrance = entranceRoomStats(frost);
    expect(entrance!.samples).toBe(frost.length);
    expect(entrance!.clearRate, `${entrance!.roomId} clear rate`).toBe(1);

    // FROST_DUNGEON's doc comment has the 80-seed sweep that set `difficultyCurve.base`
    // (descents off floor 0: chapter 1 20/80; chapter 2 17 at base 1, 10 at 1.125, 4 at 1.25).
    // Both bounds are drawn so the two rejected bases FAIL here, checked by running them:
    //  - not a wall: at least 1/16 of the seeds (5 of 80) — base 1.25's 4 fails it;
    //  - harder: at most three quarters of chapter 1's count on the same seeds — base 1, where
    //    only the content swap separates the chapters, reads 17 vs 20 and fails it.
    const descended = (rows: readonly RunMetrics[]) => rows.filter((r) => r.floorReached >= 1).length;
    const d2 = descended(frost);
    const d1 = descended(ember);
    expect(d2, `${d2}/${frost.length} careful chapter-2 runs descended off floor 0`).toBeGreaterThanOrEqual(Math.round(frost.length / 16));
    expect(d2, `chapter 2 descents ${d2} vs chapter 1 ${d1}`).toBeLessThanOrEqual(Math.floor(d1 * 0.75));
  }, 600_000);

  it('gate: no chapter-2 floor is easier than the same floor of chapter 1 (floor trials)', () => {
    // Same layout and garrison (transposed, elements swapped), so the only difference left is
    // the curve; a chapter-2 floor clearing more often than its chapter-1 twin means the curve
    // stopped doing its job. The 0.1 allowance is sampling noise at 40 seeds: the content swap
    // alone, both at x1, measured 25% vs 21% on floor 0 over 80 seeds.
    for (const k of FLOORS) {
      const c1 = floorRuns('ember', k).clearRate;
      const c2 = floorRuns('frost', k).clearRate;
      expect(c2, `floor ${k}: chapter 2 clears ${c2}, chapter 1 ${c1}`).toBeLessThanOrEqual(c1 + 0.1);
    }
  }, 600_000);

  it("gate: Glacimaw is a fight of chapter 1's kind — a live threat, beatable, no deadlier than the deadliest chapter-1 boss", () => {
    // Read off the duels (`alone`). With the adds, every boss room is a wall for a fresh
    // starter-kit bot in both chapters (100% deaths for all four bosses), so those rows cannot
    // tell one boss from another.
    const glacimaw = boss('frost glacimaw alone');
    const ch1 = CH1_BOSSES.map((b) => boss(`ember ${b} alone`));
    // A live threat: the cone has to land and its chill has to be on the player for a real
    // share of the fight. (A single-bullet boss reads 0 damage against this kiting bot.)
    expect(glacimaw.deathRate, 'Glacimaw never kills — the shardfan is not landing').toBeGreaterThan(0);
    expect(glacimaw.chilledPct, 'the player is never chilled — the shardfan has lost its status').toBeGreaterThanOrEqual(15);
    // Beatable (measured 23%; the bound is two kills in 40, clear of seed noise), and no
    // deadlier than the deadliest chapter-1 boss (Pyrefang: no kills, every duel lost).
    expect(glacimaw.killRate, 'Glacimaw is (almost) never killed in a duel').toBeGreaterThanOrEqual(0.05);
    expect(glacimaw.deathRate).toBeLessThanOrEqual(Math.max(...ch1.map((s) => s.deathRate)));
    // Similar length: a won duel lasts within 2x of chapter 1's won duels, either way.
    const ch1Ttk = ch1.map((s) => s.medianTtkSec).filter((t): t is number => t !== null);
    expect(ch1Ttk.length, 'no chapter-1 boss was ever killed — nothing to compare length against').toBeGreaterThan(0);
    expect(glacimaw.medianTtkSec!).toBeLessThanOrEqual(2 * Math.max(...ch1Ttk));
    expect(glacimaw.medianTtkSec!).toBeGreaterThanOrEqual(0.5 * Math.min(...ch1Ttk));
  }, 600_000);

  it('gate: nothing in chapter 2 softlocks — full runs, floor trials and boss trials all end in a real outcome', () => {
    for (const p of PROFILES) {
      expect(fullRuns('frost', p).filter((r) => r.outcome === 'timeout').map((r) => `${p}/seed=${r.seed}/${r.endRoom}`)).toEqual([]);
    }
    for (const c of CHAPTER_IDS) for (const k of FLOORS) expect(floorRuns(c, k).timeouts, `${c} floor ${k} trial`).toBe(0);
    for (const c of BOSS_CONDITIONS) {
      expect(bossRuns(c).filter((t) => t.run.outcome === 'timeout').map((t) => `${c.label}/seed=${t.seed}`)).toEqual([]);
    }
  }, 600_000);
});
