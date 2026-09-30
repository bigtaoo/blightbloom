/**
 * Squad revive, measured with a bot that revives (volume 118). No bot shipped or simulated had
 * ever held INTERACT over a downed squadmate, so every eight-seat match any sim played ended with
 * each downed seat bleeding out, and the channel (`REVIVE_CHANNEL_TICKS`), the bleedout
 * (`DOWNED_BLEEDOUT_TICKS`) and the bandage supply (`ARENA_DROP_TABLE`) had never been measured.
 *
 * Six conditions over the capacity sim's eight-seat seeds, two squads of four:
 *   - `full`: the capacity sim's full bot, which never revives: the control;
 *   - `full bandage1`: every seat starts with a bandage and nobody uses it: bandages alone
 *     revive nobody;
 *   - `revives`: the same bot, reviving, on whatever bandages the floor supplies;
 *   - `revives bandage1`: reviving with a bandage each from the drop, the channel measured
 *     apart from the supply;
 *   - `shipped`: the bot that fills empty seats in real matches, its revive rule off;
 *   - `shipped revives`: that bot as it ships.
 *
 * Every condition plays ENGINE_VERSION 86's rule: a reviver cannot attack.
 *
 * What it gates is the instrument, not a balance verdict: nobody comes back up without a bot
 * that revives, the reviving bot does bring seats back up once it can pay for it, every
 * revive spends exactly one bandage, and matches end. The rest is printed.
 */
import { describe, expect, it } from 'vitest';
import { ARENA_PROFILES } from './pvp/ArenaBotController';
import { runArenaMatch, type ArenaMatch, type SeatStats } from './pvp/arenaMatch';

const SEATS = 8;
// The capacity sim's eight-seat block plays `seed + seats`: the same matches, so the control
// here is that block's `full` line.
const SEEDS = Array.from({ length: 30 }, (_, i) => 3_000_000 + i * 7 + SEATS);

const CONDS: [string, keyof typeof ARENA_PROFILES, number | undefined][] = [
  ['full', 'full', undefined],
  ['full bandage1', 'full', 1],
  ['revives', 'fullRevives', undefined],
  ['revives bandage1', 'fullRevives', 1],
  ['shipped', 'shipped', undefined],
  ['shipped revives', 'shippedRevives', undefined],
];

type Count = 'downs' | 'revived' | 'bledOut' | 'bandagesPicked' | 'bandagesSpent' | 'channelTicks' | 'interrupted';

interface Summary {
  matches: ArenaMatch[];
  seats: SeatStats[];
  total: Record<Count, number>;
  timeouts: number;
  line: string;
}

function summarize(label: string, ms: ArenaMatch[]): Summary {
  const seats = ms.flatMap((m) => m.bySeat);
  const keys: Count[] = ['downs', 'revived', 'bledOut', 'bandagesPicked', 'bandagesSpent', 'channelTicks', 'interrupted'];
  const total = Object.fromEntries(keys.map((k) => [k, seats.reduce((n, s) => n + s[k], 0)])) as Record<Count, number>;
  const timeouts = ms.filter((m) => m.timedOut).length;
  const ticks = Math.round(ms.reduce((n, m) => n + m.ticks, 0) / ms.length);
  // Seats of the winning squad still up at the end: what a revive is for.
  const standing = ms.reduce((n, m) => n + m.bySeat.filter((s) => s.survived).length, 0) / ms.length;
  const line =
    `${label.padEnd(17)} downs ${total.downs} revived ${total.revived} bledOut ${total.bledOut} interrupted ${total.interrupted}` +
    `  channel ${total.channelTicks} ticks  bandages picked ${total.bandagesPicked} spent ${total.bandagesSpent}` +
    `  standing ${standing.toFixed(2)}/match  ticks ${ticks} timeouts ${timeouts}`;
  return { matches: ms, seats, total, timeouts, line };
}

describe('PvP squad revive (bot that revives — first-signal data, not a balance verdict)', () => {
  it('measures downs, revives and bleedouts per condition, and gates the instrument', () => {
    const r: Record<string, Summary> = {};
    for (const [label, prof, bandages] of CONDS) {
      r[label] = summarize(label, SEEDS.map((seed) => runArenaMatch(seed, SEATS, ARENA_PROFILES[prof], { bandages })));
    }
    console.log(`\n${Object.values(r).map((x) => x.line).join('\n')}\n`);

    // Something to revive: squads go down in every condition.
    for (const k of Object.keys(r)) expect(r[k]!.total.downs, k).toBeGreaterThan(0);
    // Nobody comes back up without a bot that revives, bandages in hand or not, and no
    // channel ever starts.
    for (const k of ['full', 'full bandage1']) {
      expect(r[k]!.total.revived, k).toBe(0);
      expect(r[k]!.total.channelTicks, k).toBe(0);
      expect(r[k]!.total.bandagesSpent, k).toBe(0);
    }
    // The reviving bot brings seats back up once it can pay for the channel, and so does the
    // shipped one on the floor's bandages alone.
    for (const k of ['revives bandage1', 'shipped revives']) expect(r[k]!.total.revived, k).toBeGreaterThan(0);
    expect(r.shipped!.total.revived).toBe(0);
    for (const [k, x] of Object.entries(r)) {
      // Every revive spends one bandage, and a seat is revived only after going down.
      expect(x.total.bandagesSpent, k).toBe(x.total.revived);
      for (const s of x.seats) expect(s.revived, k).toBeLessThanOrEqual(s.downs);
      // A down ends in a revive, a bleedout, or the match ending first.
      expect(x.total.revived + x.total.bledOut, k).toBeLessThanOrEqual(x.total.downs);
      expect(x.timeouts, k).toBe(0);
      // The match still ends with one squad standing, or none.
      for (const m of x.matches) expect(m.bySeat.filter((s) => s.survived && s.team !== m.winnerTeam), `${k} seed ${m.seed}`).toEqual([]);
    }
  }, 900_000);
});
