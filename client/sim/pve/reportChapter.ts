/**
 * Aggregation + text rendering for the chapter comparison (`chapterTrial.ts`, 2026-10-06) —
 * a sibling of `report.ts` (CLAUDE.md form ①: pure functions over recorded runs, no engine
 * dependency), so the numbers the chapter-2 gates assert on are computed somewhere testable.
 */
import type { BossTrialRun } from './chapterTrial';
import type { RunMetrics } from './levelSim';
import { median } from './report';
import { round1, round2 } from './reportRound';

const TICKS_PER_SEC = 30;

/** How far full runs get, floor by floor: of the runs that REACHED floor k, how many
 *  reached its checkpoint. The conditional rate is the one two chapters can be compared on —
 *  an unconditional "reached floor 3" mixes every earlier floor's difficulty into floor 3's. */
export interface DepthRow {
  floorIndex: number;
  reached: number;
  checkpoint: number;
  /** checkpoint / reached, null when no run reached the floor. */
  passRate: number | null;
}

export function depthStats(runs: readonly RunMetrics[], floorCount: number): DepthRow[] {
  const rows: DepthRow[] = [];
  for (let k = 0; k < floorCount; k++) {
    const reached = runs.filter((r) => r.floorReached >= k).length;
    const checkpoint = runs.filter((r) => r.checkpointFloors.includes(k)).length;
    rows.push({ floorIndex: k, reached, checkpoint, passRate: reached > 0 ? round2(checkpoint / reached) : null });
  }
  return rows;
}

/** One floor played from a fresh start (`floorTrial`). `extracted` = the floor was cleared. */
export interface FloorTrialStats {
  runs: number;
  clearRate: number;
  timeouts: number;
  /** Seconds to clear, over clearing runs only; null when none cleared. */
  avgClearSec: number | null;
  avgDamage: number;
  avgKills: number;
}

export function floorTrialStats(runs: readonly RunMetrics[]): FloorTrialStats {
  const n = Math.max(1, runs.length);
  const cleared = runs.filter((r) => r.outcome === 'extracted');
  return {
    runs: runs.length,
    clearRate: round2(cleared.length / n),
    timeouts: runs.filter((r) => r.outcome === 'timeout').length,
    avgClearSec: cleared.length > 0 ? round1(cleared.reduce((a, r) => a + r.ticks, 0) / cleared.length / TICKS_PER_SEC) : null,
    avgDamage: round1(runs.reduce((a, r) => a + r.damageTaken, 0) / n),
    avgKills: round1(runs.reduce((a, r) => a + r.enemiesKilled, 0) / n),
  };
}

export interface BossTrialStats {
  runs: number;
  bossMaxHp: number;
  /** Share of runs where the boss died (the player may still have died to adds after). */
  killRate: number;
  deathRate: number;
  medianTtkSec: number | null;
  avgTtkSec: number | null;
  /** Damage taken between activation and the boss's death (or the run's end). */
  avgFightDamage: number;
  effectiveHp: number;
  /** Boss HP left over the runs that did NOT kill it — how close a loss was. */
  avgHpLeftOnFail: number | null;
  chilledPct: number;
  /** Average share of the fight the player carried a poison stack, as a percentage. */
  poisonedPct: number;
}

export function bossTrialStats(trials: readonly BossTrialRun[]): BossTrialStats {
  const n = Math.max(1, trials.length);
  const kills = trials.filter((t) => t.ttkTicks !== null).map((t) => t.ttkTicks!);
  const fails = trials.filter((t) => t.ttkTicks === null);
  const med = median(kills);
  return {
    runs: trials.length,
    bossMaxHp: trials[0]?.bossMaxHp ?? 0,
    killRate: round2(kills.length / n),
    deathRate: round2(trials.filter((t) => t.playerDied).length / n),
    medianTtkSec: med === null ? null : round1(med / TICKS_PER_SEC),
    avgTtkSec: kills.length > 0 ? round1(kills.reduce((a, b) => a + b, 0) / kills.length / TICKS_PER_SEC) : null,
    avgFightDamage: round1(trials.reduce((a, t) => a + t.fightDamage, 0) / n),
    effectiveHp: trials[0]?.effectiveHp ?? 0,
    avgHpLeftOnFail: fails.length > 0 ? round2(fails.reduce((a, t) => a + t.bossHpLeftFrac, 0) / fails.length) : null,
    chilledPct: Math.round((trials.reduce((a, t) => a + t.chilledFrac, 0) / n) * 100),
    poisonedPct: Math.round((trials.reduce((a, t) => a + t.poisonedFrac, 0) / n) * 100),
  };
}

const dash = (v: number | null): string => (v === null ? '-' : String(v));
const pct = (v: number): string => `${Math.round(v * 100)}%`;

export function formatDepthTable(rows: Record<string, readonly DepthRow[]>): string {
  const lines = ['chapter  floor  reached  checkpoint  pass%'];
  for (const [chapter, list] of Object.entries(rows)) {
    for (const r of list) {
      if (r.reached === 0) continue;
      lines.push(`${chapter.padEnd(9)}${String(r.floorIndex).padEnd(7)}${String(r.reached).padEnd(9)}${String(r.checkpoint).padEnd(12)}${r.passRate === null ? '-' : pct(r.passRate)}`);
    }
  }
  return lines.join('\n');
}

export function formatFloorTrialTable(rows: readonly { chapter: string; floorIndex: number; scale: number; stats: FloorTrialStats }[]): string {
  const lines = ['chapter  floor  scale  runs  clear%  clearSec  dmg   kills  timeouts'];
  for (const { chapter, floorIndex, scale, stats: s } of rows) {
    lines.push(
      `${chapter.padEnd(9)}${String(floorIndex).padEnd(7)}${String(scale).padEnd(7)}${String(s.runs).padEnd(6)}${pct(s.clearRate).padEnd(8)}${dash(s.avgClearSec).padEnd(10)}${String(s.avgDamage).padEnd(6)}${String(s.avgKills).padEnd(7)}${s.timeouts}`,
    );
  }
  return lines.join('\n');
}

export function formatBossTrialTable(rows: readonly { label: string; stats: BossTrialStats }[]): string {
  const lines = ['condition                          bossHp  runs  kill%  died%  ttk(med/avg s)  fightDmg/effHp  hpLeftOnFail  chilled%  poisoned%'];
  for (const { label, stats: s } of rows) {
    lines.push(
      `${label.padEnd(35)}${String(s.bossMaxHp).padEnd(8)}${String(s.runs).padEnd(6)}${pct(s.killRate).padEnd(7)}${pct(s.deathRate).padEnd(7)}${`${dash(s.medianTtkSec)}/${dash(s.avgTtkSec)}`.padEnd(16)}${`${s.avgFightDamage}/${s.effectiveHp}`.padEnd(16)}${(s.avgHpLeftOnFail === null ? '-' : pct(s.avgHpLeftOnFail)).padEnd(14)}${String(s.chilledPct).padEnd(10)}${s.poisonedPct}`,
    );
  }
  return lines.join('\n');
}
