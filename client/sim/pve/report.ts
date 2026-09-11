/**
 * Aggregation + text rendering for the level simulator's output (CLAUDE.md form ①:
 * pure functions, no engine dependency), so the numbers the balance discussion
 * actually turns on are computed somewhere testable rather than inline in the sim
 * entry point's console.log calls.
 *
 * The unit of the report is the ROOM, not the run: "the run died on floor 1" is not
 * actionable, "the 15-enemy spawn room lands its first hit 8 ticks after waking up
 * and peaks at 6 simultaneous shooters" is.
 *
 * Holds the room / summary / drop tables. The two AMMO-CONSUMPTION tables moved to
 * `reportFire.ts` when this file crossed 500 lines (CLAUDE.md, form ①) and are
 * re-exported below, so `from './report'` still reaches every one of them.
 */
import type { DropRecord, RoomEncounter, RunMetrics } from './levelSim';
import { round1, round2, round3 } from './reportRound';

// The ammo-consumption half of the report lives next door; re-exported so this path stays
// the single import site for callers (CLAUDE.md: the split is invisible to them).
export * from './reportFire';

export interface RoomStats {
  key: string; // `${floorIndex}:${roomId}`
  floorIndex: number;
  roomId: string;
  samples: number;
  garrison: number;
  /** Median reaction window (ticks from activation to first damage), null when the
   *  room never hit anyone in any sample. Median, not mean: a single sample where
   *  the bot happened to walk in from a far corner should not move it much. */
  medianReactionTicks: number | null;
  maxPeakShooters: number;
  avgPeakShooters: number;
  avgDamageTaken: number;
  /** Share of samples where the room was cleared (its last enemy died). */
  clearRate: number;
  /** Average ticks from activation to clear, over cleared samples only. */
  avgClearTicks: number | null;
}

export interface RunSummary {
  runs: number;
  extracted: number;
  died: number;
  timedOut: number;
  avgFloorReached: number;
  /** `${floorIndex}:${roomId}` → runs that ended there. */
  deathsByRoom: Record<string, number>;
  avgTicks: number;
  effectiveHp: number;
  maxPeakBurstDamage: number;
  avgPeakBurstDamage: number;
  avgEnemiesKilled: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarize(runs: readonly RunMetrics[]): RunSummary {
  const deathsByRoom: Record<string, number> = {};
  for (const r of runs) {
    if (r.outcome === 'extracted' || r.endRoom === null) continue;
    const key = `${r.floorReached}:${r.endRoom}`;
    deathsByRoom[key] = (deathsByRoom[key] ?? 0) + 1;
  }
  const n = Math.max(1, runs.length);
  return {
    runs: runs.length,
    extracted: runs.filter((r) => r.outcome === 'extracted').length,
    died: runs.filter((r) => r.outcome === 'died').length,
    timedOut: runs.filter((r) => r.outcome === 'timeout').length,
    avgFloorReached: runs.reduce((a, r) => a + r.floorReached, 0) / n,
    deathsByRoom,
    avgTicks: Math.round(runs.reduce((a, r) => a + r.ticks, 0) / n),
    effectiveHp: runs[0]?.effectiveHp ?? 0,
    maxPeakBurstDamage: Math.max(0, ...runs.map((r) => r.peakBurstDamage)),
    avgPeakBurstDamage: round1(runs.reduce((a, r) => a + r.peakBurstDamage, 0) / n),
    avgEnemiesKilled: round1(runs.reduce((a, r) => a + r.enemiesKilled, 0) / n),
  };
}

/** Per-room aggregation across every run's encounters, in first-seen order (which
 *  is authored floor order — floor 1's spawn room first, exactly where a "seconds
 *  into the run" complaint points). */
export function roomStats(runs: readonly RunMetrics[]): RoomStats[] {
  const grouped = new Map<string, RoomEncounter[]>();
  for (const r of runs) {
    for (const e of r.encounters) {
      const key = `${e.floorIndex}:${e.roomId}`;
      const list = grouped.get(key);
      if (list) list.push(e);
      else grouped.set(key, [e]);
    }
  }

  const out: RoomStats[] = [];
  for (const [key, encounters] of grouped) {
    const first = encounters[0]!;
    const reactions = encounters.map((e) => e.reactionTicks).filter((t): t is number => t !== null);
    const cleared = encounters.filter((e) => e.clearedTick !== null);
    out.push({
      key,
      floorIndex: first.floorIndex,
      roomId: first.roomId,
      samples: encounters.length,
      garrison: Math.max(...encounters.map((e) => e.garrison)),
      medianReactionTicks: median(reactions),
      maxPeakShooters: Math.max(...encounters.map((e) => e.peakShooters)),
      avgPeakShooters: round1(encounters.reduce((a, e) => a + e.peakShooters, 0) / encounters.length),
      avgDamageTaken: round1(encounters.reduce((a, e) => a + e.damageTaken, 0) / encounters.length),
      clearRate: round2(cleared.length / encounters.length),
      avgClearTicks:
        cleared.length === 0 ? null : Math.round(cleared.reduce((a, e) => a + (e.clearedTick! - e.activatedTick), 0) / cleared.length),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex || a.roomId.localeCompare(b.roomId));
}

/**
 * One floor's loot economy, aggregated across every run that played it (design/09
 * `DROP_TABLE`). Two targets live here, both stated as user requests on 2026-09-05:
 * a floor should hand out **2-3 weapons**, and a monster's chance of a health potion
 * should be **low** — the core loop is meant to be "take no damage", not "drink".
 *
 * Every count is per-floor-visit, and `complete` is the sample size that a "per full
 * floor" reading is allowed to use: on a floor the run died partway through, most of
 * the roster never died and so never rolled.
 */
export interface FloorDropStats {
  floorIndex: number;
  /** Floor-visits sampled (any run that killed anything here). */
  samples: number;
  /** Of those, visits that reached the floor's checkpoint — the honest denominator. */
  complete: number;
  avgKills: number;
  avgWeapons: number;
  avgHeals: number;
  avgMaterials: number;
  avgBuffs: number;
  /** Weapon-energy refills per visit (ENGINE_VERSION 59). Reported beside the others
   *  because the 16 weight points it carries came OUT of `material`, so the two have to
   *  be read together — a table that showed only the fall in materials would look like
   *  the floor got stingier when what changed is what it hands you. */
  avgEnergy: number;
  /** Weapon drops on a COMPLETE visit, min/max. The spread is the whole point: an
   *  average of 3 is equally consistent with "always 3" and with "0 here, 6 there",
   *  and only one of those meets the request. null when no visit was complete. */
  minWeapons: number | null;
  maxWeapons: number | null;
  /** Most weapon drops any single ROOM produced. A floor that hands out its whole
   *  allowance in one room technically hits the count and misses the point. */
  maxWeaponsInOneRoom: number;
  /** Observed heal drops per kill — comparable directly against the heal weight's
   *  share of `DROP_TABLE`, so a mis-tuned table shows up as a number, not a vibe. */
  healsPerKill: number;
  weaponsPerKill: number;
}

/** Per-(run, floor) tallies — the intermediate every field of FloorDropStats reads. */
interface FloorVisit {
  floorIndex: number;
  complete: boolean;
  kills: number;
  byKind: Record<string, number>;
  weaponsByRoom: Map<string, number>;
}

function visitsOf(runs: readonly RunMetrics[]): FloorVisit[] {
  const out: FloorVisit[] = [];
  for (const r of runs) {
    const byFloor = new Map<number, FloorVisit>();
    const visit = (floorIndex: number): FloorVisit => {
      let v = byFloor.get(floorIndex);
      if (!v) {
        v = { floorIndex, complete: r.checkpointFloors.includes(floorIndex), kills: 0, byKind: {}, weaponsByRoom: new Map() };
        byFloor.set(floorIndex, v);
      }
      return v;
    };
    for (const [floor, kills] of Object.entries(r.killsByFloor)) visit(Number(floor)).kills = kills;
    for (const d of r.drops) countDrop(visit(d.floorIndex), d);
    out.push(...byFloor.values());
  }
  return out;
}

function countDrop(v: FloorVisit, d: DropRecord): void {
  v.byKind[d.kind] = (v.byKind[d.kind] ?? 0) + 1;
  if (d.kind !== 'weapon') return;
  // A drop that landed in a door passage has no room to attribute it to; group those
  // under one bucket rather than dropping them, so the per-room max can never
  // silently under-report.
  const key = d.roomId ?? '(passage)';
  v.weaponsByRoom.set(key, (v.weaponsByRoom.get(key) ?? 0) + 1);
}

export function floorDropStats(runs: readonly RunMetrics[]): FloorDropStats[] {
  const grouped = new Map<number, FloorVisit[]>();
  for (const v of visitsOf(runs)) {
    const list = grouped.get(v.floorIndex);
    if (list) list.push(v);
    else grouped.set(v.floorIndex, [v]);
  }

  const out: FloorDropStats[] = [];
  for (const [floorIndex, visits] of grouped) {
    const n = visits.length;
    const complete = visits.filter((v) => v.complete);
    const completeWeapons = complete.map((v) => v.byKind.weapon ?? 0);
    const kills = visits.reduce((a, v) => a + v.kills, 0);
    const kindTotal = (k: string) => visits.reduce((a, v) => a + (v.byKind[k] ?? 0), 0);
    out.push({
      floorIndex,
      samples: n,
      complete: complete.length,
      avgKills: round1(kills / n),
      avgWeapons: round1(kindTotal('weapon') / n),
      avgHeals: round1(kindTotal('heal') / n),
      avgMaterials: round1(kindTotal('material') / n),
      avgBuffs: round1(kindTotal('buff') / n),
      avgEnergy: round1(kindTotal('energy') / n),
      minWeapons: completeWeapons.length === 0 ? null : Math.min(...completeWeapons),
      maxWeapons: completeWeapons.length === 0 ? null : Math.max(...completeWeapons),
      maxWeaponsInOneRoom: Math.max(0, ...visits.flatMap((v) => [...v.weaponsByRoom.values()])),
      healsPerKill: kills === 0 ? 0 : round3(kindTotal('heal') / kills),
      weaponsPerKill: kills === 0 ? 0 : round3(kindTotal('weapon') / kills),
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex);
}

export function formatDropTable(rows: readonly FloorDropStats[]): string {
  const head = 'floor  visits(complete)  kills  weapons(avg/min/max)  perRoomMax  heals  materials  buffs  energy  heal/kill  wpn/kill';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(7)}${`${r.samples}(${r.complete})`.padEnd(18)}${String(r.avgKills).padEnd(7)}` +
      `${`${r.avgWeapons}/${r.minWeapons ?? '-'}/${r.maxWeapons ?? '-'}`.padEnd(22)}` +
      `${String(r.maxWeaponsInOneRoom).padEnd(12)}${String(r.avgHeals).padEnd(7)}${String(r.avgMaterials).padEnd(11)}` +
      `${String(r.avgBuffs).padEnd(7)}${String(r.avgEnergy).padEnd(8)}${String(r.healsPerKill).padEnd(11)}${r.weaponsPerKill}`,
  );
  return [head, ...body].join('\n');
}

export function formatSummary(label: string, s: RunSummary): string {
  const pct = (n: number) => `${Math.round((n / Math.max(1, s.runs)) * 100)}%`;
  return [
    `--- ${label}: ${s.runs} runs ---`,
    `outcome        extracted ${s.extracted} (${pct(s.extracted)}) · died ${s.died} (${pct(s.died)}) · timeout ${s.timedOut}`,
    `progress       avg floor reached ${round1(s.avgFloorReached)} (0-based) · avg ${s.avgTicks} ticks (${round1(s.avgTicks / 30)}s) · avg ${s.avgEnemiesKilled} kills`,
    `burst damage   worst 1s window ${s.maxPeakBurstDamage} (avg ${s.avgPeakBurstDamage}) vs ${s.effectiveHp} effective HP`,
    `run ended in   ${Object.keys(s.deathsByRoom).length === 0 ? '(nothing — every run extracted)' : JSON.stringify(s.deathsByRoom)}`,
  ].join('\n');
}

export function formatRoomTable(rows: readonly RoomStats[]): string {
  const head = 'floor room                     garrison  react  shooters(max/avg)  dmg   clear%  clearTicks';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(6)}${r.roomId.padEnd(25)}${String(r.garrison).padEnd(10)}` +
      `${(r.medianReactionTicks ?? '-').toString().padEnd(7)}` +
      `${`${r.maxPeakShooters}/${r.avgPeakShooters}`.padEnd(19)}` +
      `${String(r.avgDamageTaken).padEnd(6)}${String(Math.round(r.clearRate * 100)).padEnd(8)}${r.avgClearTicks ?? '-'}`,
  );
  return [head, ...body].join('\n');
}
