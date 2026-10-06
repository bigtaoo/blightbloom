/**
 * PvE chapter balance sim — chapters 2, 3 and 4 against chapter 1 (2026-10-06). Runs with
 * `npm run test:pve-sim`, next to `pveLevelSim.sim.ts` (chapter 1's own sweep and gates,
 * which this file does not touch).
 *
 * Three measurements, each answering a question the other two cannot:
 *   1. FULL RUNS of each chapter (the same sweep `pveLevelSim` does for chapter 1) — how far
 *      a run gets, and of the runs that reach floor k, how many pass it.
 *   2. FLOOR TRIALS (`sim/pve/chapterTrial.ts`) — every floor of every chapter from a fresh
 *      start at that floor's own difficulty scale. Full runs never reach the deep floors, so
 *      this is the only per-floor comparison past floor 1.
 *   3. BOSS TRIALS — each boss in its own chapter's boss room at its boss-floor scale, with
 *      the room's adds (the real fight) and alone (where all damage is the boss's), plus each
 *      later chapter's boss staged in chapter 1's room at chapter 1's scale as the control that
 *      separates "this is a harder boss" from "this chapter scales everything harder".
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
const CHAPTER_IDS: readonly ChapterId[] = ['ember', 'frost', 'storm', 'blight'];
/** The chapters this file gates; chapter 1 is `pveLevelSim.sim.ts`'s. */
const LATER_CHAPTERS: readonly ChapterId[] = ['frost', 'storm', 'blight'];
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
  { label: 'storm voltreaver +adds', spec: { room: 'storm', boss: 'voltreaver', adds: true } },
  { label: 'storm voltreaver alone', spec: { room: 'storm', boss: 'voltreaver', adds: false } },
  // Control: chapter 3's boss under chapter 1's room and scale.
  { label: 'control: voltreaver in ember alone', spec: { room: 'ember', boss: 'voltreaver', adds: false } },
  { label: 'blight rotbloom +adds', spec: { room: 'blight', boss: 'rotbloom', adds: true } },
  { label: 'blight rotbloom alone', spec: { room: 'blight', boss: 'rotbloom', adds: false } },
  // Control: chapter 4's boss under chapter 1's room and scale.
  { label: 'control: rotbloom in ember alone', spec: { room: 'ember', boss: 'rotbloom', adds: false } },
];

describe('PvE chapter sim — chapters 2 (frost), 3 (storm) and 4 (blight) against chapter 1 (ember)', () => {
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

  it('reports full runs of the later chapters, and how far each chapter gets floor by floor', () => {
    for (const c of LATER_CHAPTERS) {
      for (const p of PROFILES) {
        const rows = fullRuns(c, p);
        // eslint-disable-next-line no-console
        console.log(`\n${formatSummary(`chapter=${c} profile=${p}`, summarize(rows))}`);
        // eslint-disable-next-line no-console
        console.log(formatRoomTable(roomStats(rows)));
      }
    }
    for (const p of PROFILES) {
      // eslint-disable-next-line no-console
      console.log(`\n--- profile=${p}: floor pass rate, full runs ---`);
      // eslint-disable-next-line no-console
      console.log(formatDepthTable(Object.fromEntries(CHAPTER_IDS.map((c) => [c, depthStats(fullRuns(c, p), CHAPTERS[c].config.floorCount)]))));
    }
    for (const c of LATER_CHAPTERS) expect(fullRuns(c, 'careful').length).toBe(WIDE_SEEDS.length);
  }, 600_000);

  it('reports every floor of every chapter from a fresh start (floor trials, careful)', () => {
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
    expect(boss('storm voltreaver alone').bossMaxHp).toBeGreaterThan(0);
    expect(boss('blight rotbloom alone').bossMaxHp).toBeGreaterThan(0);
  }, 600_000);

  // ── Chapter-2 gates — the same shapes as `pveLevelSim.sim.ts`'s chapter-1 gates, plus the
  // two only a comparison can state: chapter 2 is the HARDER chapter, and its boss is a fight
  // of the same kind as chapter 1's. Difficulty bounds are two-sided, for the reason chapter
  // 1's are: a retune that overshoots into a walkover should fail too.

  it.each(LATER_CHAPTERS)("gate: %s's entrance room gives the player time to react", (c) => {
    const entrance = entranceRoomStats(fullRuns(c, 'careful'));
    expect(entrance?.garrison ?? 0, 'entrance has no garrison — the gate would be vacuous').toBeGreaterThan(0);
    expect(entrance!.medianReactionTicks ?? Infinity).toBeGreaterThanOrEqual(30);
  }, 600_000);

  it.each(LATER_CHAPTERS)('gate: no %s room focus-fires the player with more than the effective HP pool', (c) => {
    for (const p of PROFILES) {
      const rows = fullRuns(c, p);
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

  // ── Chapter-3 gates. Chapter 3 cannot be made harder at its entrance (STORM_DUNGEON's doc
  // comment: every base above chapter 2's walls floor 0), so "harder" is asserted where its
  // curve actually differs — past the entrance.

  it('gate: chapter 3 is not a wall — a careful player clears its entrance and sometimes floor 1', () => {
    const storm = fullRuns('storm', 'careful');
    const entrance = entranceRoomStats(storm);
    expect(entrance!.samples).toBe(storm.length);
    expect(entrance!.clearRate, `${entrance!.roomId} clear rate`).toBe(1);
    // Measured 13/80 at the shipped base; base 1.1875 read 0/80 and fails this.
    const d3 = storm.filter((r) => r.floorReached >= 1).length;
    expect(d3, `${d3}/${storm.length} careful chapter-3 runs descended off floor 0`).toBeGreaterThanOrEqual(Math.round(storm.length / 16));
  }, 600_000);

  it("gate: chapter 3's deep floors are harder than chapter 2's (floor trials)", () => {
    // Floor index 2 is the deepest floor a fresh starter-kit bot still makes real progress on
    // (20+ kills); past it every chapter's trial is 0% clears and single-digit kills, which
    // cannot tell two curves apart. Measured 14 kills against chapter 2's 27; chapter 3 at
    // chapter 2's own step read 23, so the bound fails that control.
    const k3 = floorRuns('storm', 2).avgKills;
    const k2 = floorRuns('frost', 2).avgKills;
    expect(k2, 'the chapter-2 floor-2 trial killed too little to compare against').toBeGreaterThan(15);
    expect(k3, `floor-2 trial kills: chapter 3 ${k3}, chapter 2 ${k2}`).toBeLessThanOrEqual(k2 * 0.75);
    // And no chapter-3 floor clears more often than chapter 2's (the same 0.1 noise allowance).
    for (const k of FLOORS) {
      const c2 = floorRuns('frost', k).clearRate;
      const c3 = floorRuns('storm', k).clearRate;
      expect(c3, `floor ${k}: chapter 3 clears ${c3}, chapter 2 ${c2}`).toBeLessThanOrEqual(c2 + 0.1);
    }
  }, 600_000);

  it("gate: Voltreaver is a fight of the earlier bosses' kind — a live threat, beatable, no deadlier than the deadliest", () => {
    // The homing orbs' danger is knife-edged on speed and turn rate (`enemyarcseeker`'s
    // comment): under 7 grid/s the bot's own fire erases every volley and the duel reads 100%
    // kills and 0 damage. Measured 50% kills / 50% deaths at the boss floor's 95 HP.
    const volt = boss('storm voltreaver alone');
    const ch1 = CH1_BOSSES.map((b) => boss(`ember ${b} alone`));
    expect(volt.avgFightDamage, 'no orb ever lands — the arc seeker is shot or flown out of every time').toBeGreaterThan(0);
    expect(volt.deathRate, 'Voltreaver (almost) never kills').toBeGreaterThanOrEqual(0.1);
    expect(volt.killRate, 'Voltreaver is (almost) never killed in a duel').toBeGreaterThanOrEqual(0.05);
    expect(volt.deathRate).toBeLessThanOrEqual(Math.max(...ch1.map((s) => s.deathRate)));
    const ch1Ttk = ch1.map((s) => s.medianTtkSec).filter((t): t is number => t !== null);
    expect(volt.medianTtkSec!).toBeLessThanOrEqual(2 * Math.max(...ch1Ttk));
    expect(volt.medianTtkSec!).toBeGreaterThanOrEqual(0.5 * Math.min(...ch1Ttk));
  }, 600_000);

  // ── Chapter-4 gates, the finale. The same three shapes as chapter 3's, one chapter on: not a
  // wall at the entrance, harder than chapter 3 past it, and a boss of the earlier bosses' kind.

  it('gate: chapter 4 is not a wall — a careful player clears its entrance and sometimes floor 1', () => {
    const blight = fullRuns('blight', 'careful');
    const entrance = entranceRoomStats(blight);
    expect(entrance!.samples).toBe(blight.length);
    expect(entrance!.clearRate, `${entrance!.roomId} clear rate`).toBe(1);
    // Measured 15/80 (chapter 3: 13); the base is chapter 3's, so this is the content's doing.
    const d4 = blight.filter((r) => r.floorReached >= 1).length;
    expect(d4, `${d4}/${blight.length} careful chapter-4 runs descended off floor 0`).toBeGreaterThanOrEqual(Math.round(blight.length / 16));
  }, 600_000);

  it("gate: chapter 4's deep floors are harder than chapter 3's (floor trials)", () => {
    // BLIGHT_DUNGEON's doc comment has the sweep. Measured 3.6 floor-2 kills against chapter 3's
    // 14; chapter 4 at chapter 3's own step read 22 (and cleared floor 1 68% against 33%), so
    // both bounds below fail that control.
    const k4 = floorRuns('blight', 2).avgKills;
    const k3 = floorRuns('storm', 2).avgKills;
    expect(k3, 'the chapter-3 floor-2 trial killed too little to compare against').toBeGreaterThan(8);
    expect(k4, `floor-2 trial kills: chapter 4 ${k4}, chapter 3 ${k3}`).toBeLessThanOrEqual(k3 * 0.75);
    for (const k of FLOORS) {
      const c3 = floorRuns('storm', k).clearRate;
      const c4 = floorRuns('blight', k).clearRate;
      expect(c4, `floor ${k}: chapter 4 clears ${c4}, chapter 3 ${c3}`).toBeLessThanOrEqual(c3 + 0.1);
    }
  }, 600_000);

  it("gate: Rotbloom is a fight of the earlier bosses' kind — a live threat through its poison, beatable, no deadlier than the deadliest", () => {
    // Like Voltreaver's orbs, a spore slower than 7 grid/s is erased by the bot's own fire
    // (`enemysporespray`'s comment). Measured 35% kills / 65% deaths at the boss floor's 105 HP,
    // the bot poisoned for 19% of the fight.
    const rot = boss('blight rotbloom alone');
    const ch1 = CH1_BOSSES.map((b) => boss(`ember ${b} alone`));
    expect(rot.avgFightDamage, 'no spore ever lands — the spray is shot down or outranged every time').toBeGreaterThan(0);
    expect(rot.poisonedPct, 'the player is never poisoned — the spray has lost its payload').toBeGreaterThanOrEqual(10);
    expect(rot.deathRate, 'Rotbloom (almost) never kills').toBeGreaterThanOrEqual(0.1);
    expect(rot.killRate, 'Rotbloom is (almost) never killed in a duel').toBeGreaterThanOrEqual(0.05);
    expect(rot.deathRate).toBeLessThanOrEqual(Math.max(...ch1.map((s) => s.deathRate)));
    const ch1Ttk = ch1.map((s) => s.medianTtkSec).filter((t): t is number => t !== null);
    expect(rot.medianTtkSec!).toBeLessThanOrEqual(2 * Math.max(...ch1Ttk));
    expect(rot.medianTtkSec!).toBeGreaterThanOrEqual(0.5 * Math.min(...ch1Ttk));
  }, 600_000);

  it('gate: nothing in the later chapters softlocks — full runs, floor trials and boss trials all end in a real outcome', () => {
    for (const c of LATER_CHAPTERS) {
      for (const p of PROFILES) {
        expect(fullRuns(c, p).filter((r) => r.outcome === 'timeout').map((r) => `${c}/${p}/seed=${r.seed}/${r.endRoom}`)).toEqual([]);
      }
    }
    for (const c of CHAPTER_IDS) for (const k of FLOORS) expect(floorRuns(c, k).timeouts, `${c} floor ${k} trial`).toBe(0);
    for (const c of BOSS_CONDITIONS) {
      expect(bossRuns(c).filter((t) => t.run.outcome === 'timeout').map((t) => `${c.label}/seed=${t.seed}`)).toEqual([]);
    }
  }, 600_000);
});
