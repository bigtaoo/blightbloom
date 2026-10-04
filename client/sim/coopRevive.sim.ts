/**
 * Co-op PvE revive, measured (2026-10-03). The shipped ally (`AllyController`) has revived a
 * downed leader since volume 118, but the only PvE sim played one seat, so what that rule buys a
 * co-op run had never been measured. Each condition plays the same 40 seeds of the shipped level
 * through `coopRun.ts`, at both bot profiles:
 *   - `solo`: the level sim's own single-seat run, for scale;
 *   - `ally off`: the ally with its revive rule switched off: the control;
 *   - `ally`: the ally as it ships, the leader not reviving (the leader bot has no rule of its own);
 *   - `ally + leader`: the same rule laid over the leader as well, a stand-in for a player who
 *     always goes back for the ally.
 *
 * What it gates is the instrument, not a balance verdict: nobody comes back up without a rule
 * that revives, the shipped ally does bring the leader back up, a seat is only revived from a down
 * its mate was still up for, and every run ends. The rest is printed.
 */
import { describe, expect, it } from 'vitest';
import { runLevel } from './pve/levelSim';
import { runCoop, type CoopRun, type CoopSeat } from './pve/coopRun';

const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i);
const PROFILES = ['careful', 'aggressive'] as const;
const CONDS: [string, { allyRevives: boolean; leaderRevives: boolean }][] = [
  ['ally off', { allyRevives: false, leaderRevives: false }],
  ['ally', { allyRevives: true, leaderRevives: false }],
  ['ally + leader', { allyRevives: true, leaderRevives: true }],
];

type Count = keyof CoopSeat;
const COUNTS: Count[] = ['downs', 'downsMateUp', 'revived', 'bledOut'];

interface Summary {
  runs: CoopRun[];
  leader: Record<Count, number>;
  ally: Record<Count, number>;
  outcomes: Record<CoopRun['outcome'], number>;
  channelTicks: number;
  bigChests: number;
}

function summarize(runs: CoopRun[]): Summary {
  const seat = (i: 0 | 1) => Object.fromEntries(COUNTS.map((k) => [k, runs.reduce((n, r) => n + r.seats[i][k], 0)])) as Record<Count, number>;
  const outcomes = { extracted: 0, wiped: 0, stranded: 0, timeout: 0 };
  for (const r of runs) outcomes[r.outcome]++;
  return { runs, leader: seat(0), ally: seat(1), outcomes, channelTicks: runs.reduce((n, r) => n + r.channelTicks, 0), bigChests: runs.reduce((n, r) => n + r.bigChests, 0) };
}

const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
const seatText = (c: Record<Count, number>) => `down ${c.downs} (mate up ${c.downsMateUp}) revived ${c.revived} bledOut ${c.bledOut}`;

describe('co-op PvE revive (shipped ally, bot leader — first-signal data, not a balance verdict)', () => {
  it('measures revives, bleedouts and run depth per condition, and gates the instrument', () => {
    const lines: string[] = [];
    for (const profileName of PROFILES) {
      const solo = SEEDS.map((seed) => runLevel({ seed, profileName }));
      lines.push(`${profileName.padEnd(10)} ${'solo'.padEnd(13)} extracted ${solo.filter((r) => r.outcome === 'extracted').length}/${SEEDS.length}  floor ${mean(solo.map((r) => r.floorReached))}`);
      const r: Record<string, Summary> = {};
      for (const [label, cond] of CONDS) {
        const x = (r[label] = summarize(SEEDS.map((seed) => runCoop({ seed, profileName, ...cond }))));
        const o = x.outcomes;
        lines.push(
          `${profileName.padEnd(10)} ${label.padEnd(13)} extracted ${o.extracted} wiped ${o.wiped} stranded ${o.stranded}  floor ${mean(x.runs.map((y) => y.floorReached))}` +
            `  ticks ${mean(x.runs.map((y) => y.ticks))}  leader: ${seatText(x.leader)}  ally: ${seatText(x.ally)}  channel ${x.channelTicks}  big chests ${x.bigChests}`,
        );
      }

      // Something to revive in every condition.
      for (const [k, x] of Object.entries(r)) expect(x.leader.downsMateUp, `${profileName} ${k}`).toBeGreaterThan(0);
      // Nobody comes back up without a rule that revives, and no channel ever runs.
      const off = r['ally off']!;
      expect(off.leader.revived + off.ally.revived + off.channelTicks, profileName).toBe(0);
      // The shipped ally brings the leader back up; the leader alone revives nobody.
      expect(r.ally!.leader.revived, profileName).toBeGreaterThan(0);
      expect(r.ally!.ally.revived, profileName).toBe(0);
      expect(r['ally + leader']!.ally.revived, profileName).toBeGreaterThan(0);
      // The ally takes the second plate of a big chest (`ai/chestPlate.ts`): until it did, no
      // co-op run ever opened one.
      expect(r.ally!.bigChests, profileName).toBeGreaterThan(0);
      for (const [k, x] of Object.entries(r)) {
        for (const run of x.runs) {
          for (const s of run.seats) {
            // A seat comes back up only from a down its mate was up for, and a down ends at most once.
            expect(s.revived, `${profileName} ${k} seed ${run.seed}`).toBeLessThanOrEqual(s.downsMateUp);
            expect(s.revived + s.bledOut, `${profileName} ${k} seed ${run.seed}`).toBeLessThanOrEqual(s.downs);
          }
        }
        expect(x.outcomes.timeout, `${profileName} ${k}`).toBe(0);
      }
    }
    console.log(`\n${lines.join('\n')}\n`);
  }, 900_000);
});
