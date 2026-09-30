/**
 * PvP energy capacity, measured with a bot that uses its weapons (design/03 "What the sim can
 * and cannot see"). The shipped arena bot never swaps or parries, so its matches cannot say
 * whether a seat's bar ever runs dry. `ArenaBotController` adds looting, a blade when the gun
 * is dry, and parries, one flag at a time, and every condition below plays the same seeds.
 *
 * What it gates is the instrument, not a balance verdict:
 *   - the dry counter can move (looted guns empty bars the landing blaster never does);
 *   - the full bot really loots, swaps and parries;
 *   - a smaller bar shows up as more emptied seats;
 *   - the blade fallback keeps a dry gun out of the hand;
 *   - matches end, every one of them. Until `ENGINE_VERSION` 85 two frame-perfect parriers could
 *     return one bullet between them for good, and the parrying profiles were allowed 2% of
 *     their matches at the tick limit. A bullet now turns back once (`DeflectSystem`).
 * The win split per condition is printed, not asserted.
 *
 * Solo seat counts and squads are measured apart (volume 118). Eight seats is the only count
 * with squads (`squadSizeForPlayerCount`), and pooling it with the solo counts would let a
 * squad-only failure hide under the solo matches. The squad block runs the same gates, plus two
 * of its own: each squad starts on its own half, and a match ends with one squad standing. Its
 * win split is keyed by the half the winning squad started on, since a squad's skin says little.
 */
import { describe, expect, it } from 'vitest';
import { ARENA_PROFILES } from './pvp/ArenaBotController';
import { runArenaMatch, type ArenaMatch } from './pvp/arenaMatch';

const SOLO_SEATS = [2, 4, 6];
const SQUAD_SEATS = 8;
const SEEDS = Array.from({ length: 30 }, (_, i) => 3_000_000 + i * 7);

const CONDS: [string, keyof typeof ARENA_PROFILES, number | undefined][] = [
  ['shipped', 'shipped', undefined],
  ['loots', 'loots', undefined],
  ['lootsDry', 'lootsDry', undefined],
  ['parries', 'parries', undefined],
  ['full', 'full', undefined],
  // The roster's pools are 130 / 100 / 70. Everyone at 100 asks whether they decide
  // anything; everyone at 30 is the control that capacity can show up at all.
  ['full pool100', 'full', 100],
  ['full pool30', 'full', 30],
];

interface Summary {
  matches: ArenaMatch[];
  dryPct: number;
  emptied: number;
  guns: number;
  swaps: number;
  parries: number;
  timeouts: number;
  line: string;
}

/** Mean start column of a squad's seats. */
function squadGx(m: ArenaMatch, team: number): number {
  const xs = m.bySeat.filter((s) => s.team === team).map((s) => s.startGx);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The half the winning squad started on: the side of the map its spawns sit nearer. */
function winningHalf(m: ArenaMatch): string {
  if (m.winnerTeam < 0) return 'tie';
  const rival = m.bySeat.find((s) => s.team !== m.winnerTeam)!.team;
  return squadGx(m, m.winnerTeam) < squadGx(m, rival) ? 'west' : 'east';
}

function summarize(label: string, ms: ArenaMatch[], winKey: (m: ArenaMatch) => string): Summary {
  const seats = ms.flatMap((m) => m.bySeat);
  const live = seats.reduce((n, s) => n + s.liveTicks, 0);
  const dry = seats.reduce((n, s) => n + s.dryTicks, 0);
  const minE = seats.map((s) => s.minEnergyFrac).sort((a, b) => a - b);
  const sum = (k: 'pickedGuns' | 'swaps' | 'parries' | 'shots') => seats.reduce((n, s) => n + s[k], 0);
  const wins: Record<string, number> = {};
  for (const m of ms) wins[winKey(m)] = (wins[winKey(m)] ?? 0) + 1;
  const ticks = Math.round(ms.reduce((n, m) => n + m.ticks, 0) / ms.length);
  // A seat whose bar went under a tenth: one expensive pull short of empty.
  const emptied = seats.filter((s) => s.minEnergyFrac < 0.1).length;
  const timeouts = ms.filter((m) => m.timedOut).length;
  const dryPct = (100 * dry) / live;
  const sorted = Object.fromEntries(Object.entries(wins).sort());
  const line =
    `${label.padEnd(16)} dry ${dryPct.toFixed(2)}%  minE p50 ${minE[minE.length >> 1]!.toFixed(2)} p10 ${minE[Math.floor(minE.length * 0.1)]!.toFixed(2)}` +
    `  emptied ${emptied}/${seats.length}  guns ${sum('pickedGuns')} swaps ${sum('swaps')} parries ${sum('parries')} shots ${sum('shots')}` +
    `  ticks ${ticks} timeouts ${timeouts}  wins ${JSON.stringify(sorted)}`;
  return { matches: ms, dryPct, emptied, guns: sum('pickedGuns'), swaps: sum('swaps'), parries: sum('parries'), timeouts, line };
}

function measure(seatCounts: number[], winKey: (m: ArenaMatch) => string): Record<string, Summary> {
  const r: Record<string, Summary> = {};
  for (const [label, prof, pool] of CONDS) {
    r[label] = summarize(label, seatCounts.flatMap((n) => SEEDS.map((s) => runArenaMatch(s + n, n, ARENA_PROFILES[prof], { pool }))), winKey);
  }
  console.log(`\n${Object.values(r).map((x) => x.line).join('\n')}\n`);
  return r;
}

function gateInstrument(r: Record<string, Summary>): void {
  // The counter can move: a looted gun the bot never holsters empties bars.
  expect(r.loots!.guns).toBeGreaterThan(0);
  expect(r.loots!.dryPct).toBeGreaterThan(5 * r.shipped!.dryPct);
  expect(r.loots!.emptied).toBeGreaterThan(2 * r.shipped!.emptied);
  // The full bot exercises every mechanic it is meant to measure.
  for (const k of ['guns', 'swaps', 'parries'] as const) expect(r.full![k], k).toBeGreaterThan(0);
  expect(r.shipped!.swaps + r.shipped!.parries + r.shipped!.guns).toBe(0);
  // A smaller bar is visible.
  expect(r['full pool30']!.emptied).toBeGreaterThan(r.full!.emptied);
  // The blade fallback keeps a dry gun out of the hand.
  expect(r.lootsDry!.dryPct).toBeLessThan(1);
  expect(r.full!.dryPct).toBeLessThan(1);
  // Matches end, the parrying ones included (see the header).
  for (const k of Object.keys(r)) expect(r[k]!.timeouts, k).toBe(0);
}

describe('PvP energy capacity (bot that loots, swaps and parries — first-signal data, not a balance verdict)', () => {
  it('measures dry ticks and emptied bars per behaviour and pool, and gates the instrument', () => {
    // (timeout below: 7 conditions x 90 matches with seats spread over the map, ~4-5 min)
    gateInstrument(measure(SOLO_SEATS, (m) => m.winner));
  }, 900_000);

  it('measures the same at eight seats, where two squads of four play', () => {
    // (7 conditions x 30 matches, ~1.5 min)
    const r = measure([SQUAD_SEATS], winningHalf);
    gateInstrument(r);
    for (const [label, x] of Object.entries(r)) {
      for (const m of x.matches) {
        const where = `${label} seed ${m.seed}`;
        // Two squads, and each one's spawns all on its own side of the other's.
        const teams = [...new Set(m.bySeat.map((s) => s.team))];
        expect(teams, where).toHaveLength(2);
        const xs = teams.map((t) => m.bySeat.filter((s) => s.team === t).map((s) => s.startGx));
        const [w, e] = Math.min(...xs[0]!) < Math.min(...xs[1]!) ? [xs[0]!, xs[1]!] : [xs[1]!, xs[0]!];
        expect(Math.max(...w), where).toBeLessThan(Math.min(...e));
        // The match ends with one squad standing, or none.
        expect(m.bySeat.filter((s) => s.survived && s.team !== m.winnerTeam), where).toEqual([]);
      }
    }
  }, 900_000);
});
