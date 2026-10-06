/**
 * The Endless Descent's balance sim (design/gameplay/04-chapters.md, 2026-10-06). Runs with
 * `npm run test:pve-sim`, beside `chapterSim.sim.ts`.
 *
 * Endless is for a player who has cleared chapter 4, and nobody clears it on the starter kit: the
 * careful bot passes endless floor 0 in 1 run of 40 on it (chapter 1's own entrance: 8 of 40).
 * So the sweep carries the two pre-unlocked forge weapons (`STARTER_BLUEPRINTS`, three physical
 * materials each), the cheapest kit a chapter-4 graduate can have. Every number is a bot that
 * never dodges on purpose, so read it as a floor under a human.
 *
 * The step was set here. Careful bot, repeater + hammer, 40 seeds, floor index reached:
 *   perFloor 0.1875   median 3, top quarter 19+, deepest 29
 *   perFloor 0.25     median 3, top quarter 14+, deepest 22   <- shipped
 *   perFloor 0.3125   median 3, top quarter 9+,  deepest 19
 *   perFloor 0.375    median 3, top quarter 5+,  deepest 18
 * The median barely moves: most runs end on lap 1's early floors whatever the step. The step
 * decides how far the best runs go, and 0.25 lets the best few bots into lap 2 (floor 20 on).
 */
import { describe, expect, it } from 'vitest';
import { CHAPTERS, STARTER_BLUEPRINTS, type GameState } from '@dd/engine';
import { runLevel, type RunMetrics } from './pve/levelSim';

const SEEDS = Array.from({ length: 40 }, (_, i) => 101 + i * 101);
/** Two laps of the four chapters. */
const TWO_LAPS = 40;
/** Room for the deepest bot run so far (floor 22, under 200k ticks) with half again to spare. */
const MAX_TICKS = 300_000;

/** A run, and whether it ended standing in a room that still had live enemies in it. */
interface EndlessRun extends RunMetrics {
  endedInFight: boolean;
}

function endlessRun(seed: number): EndlessRun {
  let last: GameState | null = null;
  const run = runLevel({
    seed,
    profileName: 'careful',
    chapter: 'endless',
    loadout: [...STARTER_BLUEPRINTS],
    maxTicks: MAX_TICKS,
    onTick: (s) => (last = s),
  });
  const s = last as GameState | null;
  const room = s?.players[0]?.roomId;
  const i = room === undefined ? undefined : s!.dungeonRoomIndexById.get(room);
  return { ...run, endedInFight: i !== undefined && s!.dungeonRoomRuntime[i]!.hasLiveEnemy };
}

describe('PvE endless sim — the Endless Descent with the forge starter pair', () => {
  let memo: EndlessRun[] | null = null;
  const runs = (): EndlessRun[] => (memo ??= SEEDS.map(endlessRun));
  const floors = () => runs().map((r) => r.floorReached).sort((a, b) => a - b);

  it('reports how deep each run gets', () => {
    const f = floors();
    // eslint-disable-next-line no-console
    console.log(`\n--- endless, careful, ${STARTER_BLUEPRINTS.join(' + ')}: floor index reached ---\n${f.join(', ')}`);
    expect(runs()).toHaveLength(SEEDS.length);
  }, 1_200_000);

  it('gate: the entrance is not a wall for a chapter-4 graduate — most runs leave floor 0', () => {
    expect(floors().filter((f) => f > 0).length).toBeGreaterThanOrEqual(SEEDS.length / 2);
  }, 1_200_000);

  it('gate: the curve bites — the median run ends on lap 1, and at most a quarter reach lap 2', () => {
    const f = floors();
    expect(f[Math.floor(f.length / 2)]!).toBeLessThan(10);
    expect(f.filter((x) => x >= 20).length).toBeLessThanOrEqual(SEEDS.length / 4);
  }, 1_200_000);

  it('gate: some runs go deep — at least an eighth get past the first boss floor', () => {
    expect(floors().filter((x) => x >= 5).length).toBeGreaterThanOrEqual(SEEDS.length / 8);
  }, 1_200_000);

  it('gate: every run ends — a bot dies, or is caught in a stand-off, but nothing softlocks', () => {
    // One stand-off is known and is the bot's, not the game's: seed 404 on endless floor 1
    // (chapter 1's kiln, at that floor's HP) ends with the bot and two ranged mobs on opposite
    // sides of a pillar, every one of them holding position and firing into it for the rest of
    // the run. A player walks round the pillar; the bot's spacing keeps it where it is. So a
    // timeout INSIDE a live fight is reported and allowed, and a timeout anywhere else — out of
    // combat, the shape the v41 door-lock softlock had — fails.
    const standoffs = runs().filter((r) => r.outcome === 'timeout' && r.endedInFight);
    // eslint-disable-next-line no-console
    if (standoffs.length) console.log(`stand-offs: ${standoffs.map((r) => `seed ${r.seed} floor ${r.floorReached} ${r.endRoom}`).join('; ')}`);
    expect(standoffs.length).toBeLessThanOrEqual(2);
    const wedged = runs().filter((r) => r.outcome === 'timeout' && !r.endedInFight);
    expect(wedged.map((r) => `seed ${r.seed} floor ${r.floorReached} ${r.endRoom}`)).toEqual([]);
    expect(runs().some((r) => r.outcome === 'died')).toBe(true);
  }, 1_200_000);

  it('gate: an unkillable bot walks two whole laps — every floor, boss and lap wrap is passable', () => {
    // HP pinned to full every tick, so the only way to stop is a floor the bot cannot finish:
    // a door that never opens, a boss floor whose portal never takes DESCEND, a lap that does
    // not wrap back to chapter 1. Stopped at two laps by ending the run from the hook.
    const r = runLevel({
      seed: 101,
      profileName: 'careful',
      chapter: 'endless',
      maxTicks: 1_000_000,
      onTick: (s) => {
        const p = s.players[0]!;
        p.hp = p.maxHp;
        if (s.floorIndex >= TWO_LAPS) s.phase = 'gameover';
      },
    });
    expect(r.floorReached).toBe(TWO_LAPS);
    expect(r.ticks).toBeLessThan(1_000_000);
    expect(CHAPTERS.endless.config.endless!.segments).toHaveLength(4);
  }, 1_200_000);
});
