/**
 * The two AMMO-CONSUMPTION tables — per floor and per weapon — split out of `report.ts`
 * (CLAUDE.md "500-line file convention", form ①: this file is a set of independent pure
 * functions over `RunMetrics`, with no shared private state, so it splits by TABLE).
 * `report.ts` re-exports everything here, so every existing `from './report'` import is
 * unchanged.
 *
 * Its own boundary: the fire tables read what a run SPENT. `report.ts` keeps the room,
 * summary and drop tables, which read what a run was given and what it survived.
 *
 * The one engine import in the report layer is here, and it is deliberate:
 * `floorShare` prices a collected refill, and pricing it at a literal 30 would keep
 * reporting 30 after `ENERGY_PICKUP_AMOUNT` moved. It is a content constant, not a
 * runtime dependency — nothing here constructs or steps an engine.
 */
import { ENERGY_PICKUP_AMOUNT } from '@dd/engine';
import type { FireRecord, RunMetrics } from './levelSim';
import { round1, round3 } from './reportRound';

/**
 * One floor's AMMO CONSUMPTION, the counterpart of `FloorDropStats`' production side
 * (design/05's loot economy). The two tables are read together: an energy/ammo pool
 * is only sized correctly if what a floor SPENDS and what a floor HANDS BACK are
 * measured against the same runs.
 *
 * Everything here is per-floor-VISIT, and `complete` is again the only honest
 * denominator for a "per full floor" reading — a run that died in the second room
 * spent two rooms' worth of trigger pulls, and averaging that in understates the
 * cost of the floor by however far it got.
 */
export interface FloorFireStats {
  floorIndex: number;
  samples: number;
  complete: number;
  avgKills: number;
  /** Ranged trigger PULLS per visit — the unit a per-shot cost is charged in. */
  avgTriggers: number;
  /** Projectiles per visit. Differs from `avgTriggers` exactly by the spread frames,
   *  which is the whole reason both are recorded (design/03 emission axis). */
  avgBullets: number;
  /** Melee swings per visit — the FREE half under a Soul-Knight energy model. */
  avgSwings: number;
  /** Pulls on a COMPLETE visit, min/max. A pool sized to the mean runs dry on half
   *  the runs; the max is what a "never strands the player" pool has to cover. */
  minTriggers: number | null;
  maxTriggers: number | null;
  /** Share of all pulls that were melee. The measured value of the "melee is free"
   *  assumption: near zero means an energy pool has no fallback to fall back TO. */
  meleeShare: number;
  /** Pulls per kill, and projectiles per kill — the two candidate exchange rates a
   *  refill drop can be priced in ("one drop = N kills of shooting"). */
  triggersPerKill: number;
  bulletsPerKill: number;
  /** Share of this floor's LIVE ticks on which the player held a ranged weapon it could
   *  not afford to pull (ENGINE_VERSION 60 — `levelSim.ts`'s `trackEnergy`). The column
   *  that says whether the ammo economy is biting at all. A flat 0 here means an A/B
   *  over any capacity change measured nothing, in exactly the way `meleeShare`'s 0
   *  means the "melee is the free fallback" claim is unmeasured rather than verified. */
  dryShare: number;
  /** Energy this floor's pulls actually COST, per visit — `avgTriggers` priced. */
  avgSpend: number;
  /**
   * Share of that spend funded by refills the player walked over, as opposed to by the
   * regen clock (ENGINE_VERSION 62). The column the 2026-09-11 report
   * (*"地图上掉落的子弹价值变得非常低"*) is answered in: it read **2.4%** at a 20/s regen
   * line, for every loadout tried — a fresh save, a mid frame and the most expensive gun
   * in the roster alike.
   *
   * Two things about it that are easy to get wrong, both learned the hard way in the same
   * pass:
   *
   *   - **It does not move with the regen rate.** Numerator and denominator are both
   *     properties of the drop table and the weapon's price, so lowering regen leaves this
   *     column where it was (it read 1-2% before AND after the 20/s -> 15/s change). What
   *     the regen rate moves is `dryShare`. Reading a flat `floorShare` as "the change did
   *     nothing" is the specific misreading to avoid.
   *   - **A floor drops ~7 refills against ~2000 energy of pulls**, so ~10% is the ceiling
   *     the drop table sets even at perfect collection. Judge the number against that, not
   *     against 100%.
   */
  floorShare: number;
  /**
   * Refills collected / produced on this floor, summed over the sweep.
   *
   * **The gap between them is mostly the BOT, not the game**, and reading it as the game is
   * a mistake this pass made and had to correct. The control is `material`, which has no
   * usefulness gate at all and so measures pure "did the bot walk over it": it reads ~20%
   * collected, against ~6-12% for energy, over the same runs. So the bot misses ~80% of
   * everything, and what the gate is worth is the RATIO between the two, not either alone.
   *
   * Both are also single-digit event counts per sweep, far too few to A/B a change with.
   * Read this pair for the mechanism, never for a delta.
   */
  refillsTaken: number;
  refillsSpawned: number;
}

interface FloorFireVisit {
  floorIndex: number;
  complete: boolean;
  kills: number;
  triggers: number;
  bullets: number;
  swings: number;
  /** Summed `FireRecord.energySpent`. Pulls on a weapon-swap tick carry null there and
   *  are skipped here, for the same reason they are left unattributed in `weapon`. */
  spend: number;
}

function fireVisitsOf(runs: readonly RunMetrics[]): FloorFireVisit[] {
  const out: FloorFireVisit[] = [];
  for (const r of runs) {
    const byFloor = new Map<number, FloorFireVisit>();
    const visit = (floorIndex: number): FloorFireVisit => {
      let v = byFloor.get(floorIndex);
      if (!v) {
        v = {
          floorIndex,
          complete: r.checkpointFloors.includes(floorIndex),
          kills: 0,
          triggers: 0,
          bullets: 0,
          swings: 0,
          spend: 0,
        };
        byFloor.set(floorIndex, v);
      }
      return v;
    };
    for (const [floor, kills] of Object.entries(r.killsByFloor)) visit(Number(floor)).kills = kills;
    for (const f of r.fires) countFire(visit(f.floorIndex), f);
    out.push(...byFloor.values());
  }
  return out;
}

function countFire(v: FloorFireVisit, f: FireRecord): void {
  v.spend += f.energySpent ?? 0;
  if (f.kind === 'melee') {
    v.swings++;
    return;
  }
  v.triggers++;
  v.bullets += f.bullets;
}

export function floorFireStats(runs: readonly RunMetrics[]): FloorFireStats[] {
  const grouped = new Map<number, FloorFireVisit[]>();
  for (const v of fireVisitsOf(runs)) {
    const list = grouped.get(v.floorIndex);
    if (list) list.push(v);
    else grouped.set(v.floorIndex, [v]);
  }

  const out: FloorFireStats[] = [];
  for (const [floorIndex, visits] of grouped) {
    const n = visits.length;
    const complete = visits.filter((v) => v.complete);
    const completeTriggers = complete.map((v) => v.triggers);
    const kills = visits.reduce((a, v) => a + v.kills, 0);
    const triggers = visits.reduce((a, v) => a + v.triggers, 0);
    const bullets = visits.reduce((a, v) => a + v.bullets, 0);
    const swings = visits.reduce((a, v) => a + v.swings, 0);
    const pulls = triggers + swings;
    // Dry/alive ticks come off the RUNS rather than off `visits`, since they are counted
    // per tick and not per pull — a floor with zero pulls still has a denominator.
    const dryTicks = runs.reduce((a, r) => a + (r.dryTicksByFloor[floorIndex] ?? 0), 0);
    const aliveTicks = runs.reduce((a, r) => a + (r.aliveTicksByFloor[floorIndex] ?? 0), 0);
    const spend = visits.reduce((a, v) => a + v.spend, 0);
    // Same reason as dry/alive above: collected refills are counted per EVENT, not per
    // pull, so they come off the runs. Produced ones are already in `drops`, which is the
    // production side and deliberately a different list.
    const taken = runs.reduce((a, r) => a + (r.energyRefillsTakenByFloor[floorIndex] ?? 0), 0);
    const spawned = runs.reduce(
      (a, r) => a + r.drops.filter((d) => d.floorIndex === floorIndex && d.kind === 'energy').length,
      0,
    );
    out.push({
      floorIndex,
      samples: n,
      complete: complete.length,
      avgKills: round1(kills / n),
      avgTriggers: round1(triggers / n),
      avgBullets: round1(bullets / n),
      avgSwings: round1(swings / n),
      minTriggers: completeTriggers.length === 0 ? null : Math.min(...completeTriggers),
      maxTriggers: completeTriggers.length === 0 ? null : Math.max(...completeTriggers),
      meleeShare: pulls === 0 ? 0 : round3(swings / pulls),
      triggersPerKill: kills === 0 ? 0 : round1(triggers / kills),
      bulletsPerKill: kills === 0 ? 0 : round1(bullets / kills),
      dryShare: aliveTicks === 0 ? 0 : round3(dryTicks / aliveTicks),
      avgSpend: round1(spend / n),
      floorShare: spend === 0 ? 0 : round3((taken * ENERGY_PICKUP_AMOUNT) / spend),
      refillsTaken: taken,
      refillsSpawned: spawned,
    });
  }
  return out.sort((a, b) => a.floorIndex - b.floorIndex);
}

/**
 * Per-WEAPON consumption across the whole sweep — the input to pricing a pull
 * against the MECHANIC rather than against `damage` (design/03: rarity buys a
 * mechanic, and mean dps by rarity already runs downward, so a damage-indexed cost
 * would tax the weakest guns hardest).
 *
 * `unattributed` is reported rather than silently folded in: it is the pull count
 * from ticks that also collected a weapon (see `FireRecord.weapon`). A big number
 * there means this table is measuring less than it claims to.
 */
export interface WeaponFireStats {
  weapon: string;
  kind: 'ranged' | 'melee';
  pulls: number;
  bullets: number;
  bulletsPerPull: number;
  /** Share of every pull in the sweep this weapon accounts for. */
  share: number;
}

export function weaponFireStats(runs: readonly RunMetrics[]): { rows: WeaponFireStats[]; unattributed: number } {
  const acc = new Map<string, { kind: 'ranged' | 'melee'; pulls: number; bullets: number }>();
  let unattributed = 0;
  let total = 0;
  for (const r of runs) {
    for (const f of r.fires) {
      total++;
      if (f.weapon === null) {
        unattributed++;
        continue;
      }
      const key = `${f.kind}:${f.weapon}`;
      const e = acc.get(key) ?? { kind: f.kind, pulls: 0, bullets: 0 };
      e.pulls++;
      e.bullets += f.kind === 'ranged' ? f.bullets : 0;
      acc.set(key, e);
    }
  }
  const rows = [...acc.entries()]
    .map(([key, e]) => ({
      weapon: key.slice(key.indexOf(':') + 1),
      kind: e.kind,
      pulls: e.pulls,
      bullets: e.bullets,
      bulletsPerPull: e.pulls === 0 ? 0 : round1(e.bullets / e.pulls),
      share: total === 0 ? 0 : round3(e.pulls / total),
    }))
    .sort((a, b) => b.pulls - a.pulls || a.weapon.localeCompare(b.weapon));
  return { rows, unattributed };
}

export function formatFireTable(rows: readonly FloorFireStats[]): string {
  const head =
    'floor  visits(complete)  kills  triggers(avg/min/max)  bullets  swings  melee%  trig/kill  bul/kill  dry%  spend   clock%  floor%  refills(taken/spawned)';
  const body = rows.map(
    (r) =>
      `${String(r.floorIndex).padEnd(7)}${`${r.samples}(${r.complete})`.padEnd(18)}${String(r.avgKills).padEnd(7)}` +
      `${`${r.avgTriggers}/${r.minTriggers ?? '-'}/${r.maxTriggers ?? '-'}`.padEnd(23)}` +
      `${String(r.avgBullets).padEnd(9)}${String(r.avgSwings).padEnd(8)}` +
      `${String(Math.round(r.meleeShare * 100)).padEnd(8)}${String(r.triggersPerKill).padEnd(11)}` +
      `${String(r.bulletsPerKill).padEnd(10)}${String(Math.round(r.dryShare * 100)).padEnd(6)}` +
      `${String(r.avgSpend).padEnd(8)}${String(Math.round((1 - r.floorShare) * 100)).padEnd(8)}` +
      `${String(Math.round(r.floorShare * 100)).padEnd(8)}${r.refillsTaken}/${r.refillsSpawned}`,
  );
  return [head, ...body].join('\n');
}

export function formatWeaponFireTable(stats: { rows: readonly WeaponFireStats[]; unattributed: number }): string {
  const head = 'weapon                kind     pulls   bullets  bul/pull  share%';
  const body = stats.rows.map(
    (r) =>
      `${r.weapon.padEnd(22)}${r.kind.padEnd(9)}${String(r.pulls).padEnd(8)}${String(r.bullets).padEnd(9)}` +
      `${String(r.bulletsPerPull).padEnd(10)}${Math.round(r.share * 100)}`,
  );
  return [head, ...body, `(unattributed pulls — fired on a weapon-pickup tick: ${stats.unattributed})`].join('\n');
}
