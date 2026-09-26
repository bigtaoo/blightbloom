/**
 * Per-weapon PvE sweep — the whole roster played through the shipped level, one weapon at
 * a time. Run it with:
 *
 *     npm run test:weapon-sim            (repo root, or -w client)
 *
 * ## Why this exists
 *
 * The two existing balance sims never touched the weapon roster. `pvpBalanceSim.sim.ts`
 * measures character win-rate; `pveLevelSim.sim.ts` plays level 1 with the STARTER loadout
 * only (`blaster` + `saber`, i.e. `RunOptions.loadout: []`). Counted on 2026-09-04: the
 * other 22 player-facing weapons had never appeared in ANY simulation. The `loadout` hook
 * that makes this possible had been on `RunOptions` the whole time and was never swept.
 *
 * It is also the empirical half of a gap `engine/balance/weaponBalance.test.ts` states and
 * cannot close: **a static profile cannot price a mechanic.** Homing, a blast radius, a
 * hitscan beam, a bounce, a chill — the authored numbers say nothing about what each is
 * worth. This sim answers that question the only way it can be answered, by playing the
 * weapon and counting what it kills.
 *
 * ## The standoff problem, and why the bot is re-tuned per weapon
 *
 * Two false readings had to be designed out before any number here meant anything, and both
 * were the HARNESS's fault, not the weapons'. `BOT_PROFILES.careful` holds a 7.5-grid
 * standoff and opens fire at 11 grid, tuned for the starter pistol whose bullets reach 30.
 *
 *   1. REACH. The first cut reported ZERO kills for `lasercutter`, `gyre` and all seven
 *      blades. A lasercutter's beam is 3.5 grid long, a gyre blade circles at 1.6, a hammer
 *      reaches 1.3 — the bot stood outside its own weapon's range and fired into empty
 *      floor for the whole run.
 *   2. FLIGHT TIME. Capping the standoff by reach alone still left `mortar` scoring zero on
 *      four of eight seeds, and that looked like a weapon finding until it was measured:
 *      sweeping mortar's standoff from 9 grid down to 2 takes it from 11 kills (three seeds
 *      at zero) to 35 kills with 4-5 on EVERY seed. Nothing about the weapon changed. The
 *      bot does not lead its shots, so an 8 grid/s shell with a 1-second flight lands where
 *      the target used to be, and a 1.3-grid blast does not forgive that. Reach said 8 grid
 *      was fine; flight time said it was not.
 *
 * So the standoff is capped by BOTH (`profileForWeapon`): a fraction of the weapon's own
 * reach envelope (`reachGrid`, the same engine function `balance/weaponProfile.ts` uses),
 * and half a second of projectile flight. Whichever is tighter wins, and the shipped
 * `careful` spacing is the ceiling. Every weapon is then measured at a range where it can
 * actually connect, which is the only way a cross-weapon comparison means anything.
 *
 * ## How to read the report — the confounds, stated up front
 *
 * Same standing caveat as the PvP sim: a cheap repeatable FIRST SIGNAL, not a tuning
 * verdict. No single column is the answer, and two of them mislead on their own:
 *
 *   - `t/kill` REWARDS DYING EARLY. It is total ticks ÷ total kills, and a weapon whose run
 *     ended quickly in a target-rich room scores well on it. On the 2026-09-04 run
 *     `lasercutter` and `gyre` led the table at ~46 t/kill on 54-55 total kills and floor 0,
 *     while `stormglaive` sat mid-table at ~54 on 882 kills and floor 3 — the beam is not
 *     better than the glaive, it died sooner. Read t/kill beside the kill total and the
 *     floor reached, never alone.
 *
 *   - The bot does not lead shots and does not aim AoE at clusters, so slow projectiles
 *     (`seeker` 7 grid/s, `frostseeker` 6, `mortar` 8) and blast radii are under-reported
 *     on principle. It also never swaps weapons — the point of the sweep, but it means each
 *     weapon is judged with no fallback for the situations it is bad at.
 *
 * Any absolute figure quoted in this header is ILLUSTRATIVE, not pinned: these are real runs
 * against the shipped level and the shipped enemy AI, so every number here moves whenever
 * either changes. That is why the pace gate below compares each weapon against the SAME
 * run's best rather than against a recorded constant.
 *
 * Read a LOW score as "the bot could not use this" before "this is weak". Read the GATES as
 * the real regression checks: they encode "the mechanic fires at all", which is the failure
 * mode a static test genuinely cannot see.
 */
import { describe, expect, it } from 'vitest';
import { WEAPON_SPECS, resolveLoadout, weaponProfiles, type WeaponProfile } from '@dd/engine';
import { BOT_PROFILES, type BotProfile } from './pve/PveBotController';
import { runLevel, type RunMetrics } from './pve/levelSim';
import { profileForWeapon as standoffFor } from './pve/weaponStandoff';

const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];

/**
 * Long enough for a weapon to show what it does (200 s of game time clears the entrance
 * room and usually a floor or two), short enough that 24 weapons × 8 seeds stays in the
 * seconds. A run that hits this ceiling is NOT a softlock — it is a run still in progress,
 * and `outcome: 'timeout'` here carries none of the meaning it does in `pveLevelSim`
 * (whose 40 000-tick ceiling is a runaway guard). The no-softlock gate stays that sim's.
 */
const MAX_TICKS = 6000;

/**
 * A bot profile matched to one weapon — the shared rule in `pve/weaponStandoff.ts` (moved
 * there 2026-09-26 when `PveBotController` started swapping guns and needed the same answer),
 * over the shipped `careful` spacing. See the header for the two false readings its reach and
 * flight bounds each fixed.
 */
export function profileForWeapon(reachGrid: number, speedGridPerSec: number): BotProfile {
  return standoffFor(BOT_PROFILES.careful, reachGrid, speedGridPerSec);
}

interface WeaponRow {
  readonly profile: WeaponProfile;
  readonly runs: readonly RunMetrics[];
  /** Total enemies killed across every seed. 0 means the weapon never connected at all. */
  readonly kills: number;
  /** Ticks of game time per kill — the empirical pace number, lower is faster. */
  readonly ticksPerKill: number;
  readonly damageTaken: number;
  readonly bestFloor: number;
  readonly seedsWithNoKill: readonly number[];
}

function sweepWeapon(p: WeaponProfile): WeaponRow {
  const spec = WEAPON_SPECS[p.id]!;
  const bot = profileForWeapon(p.axes.reachGrid!, spec.kind === 'ranged' ? spec.bulletSpeed : 0);
  const runs = SEEDS.map((seed) => runLevel({ seed, loadout: [p.id], profile: bot, maxTicks: MAX_TICKS }));
  const kills = runs.reduce((s, r) => s + r.enemiesKilled, 0);
  const ticks = runs.reduce((s, r) => s + r.ticks, 0);
  return {
    profile: p,
    runs,
    kills,
    ticksPerKill: kills > 0 ? ticks / kills : Infinity,
    damageTaken: runs.reduce((s, r) => s + r.damageTaken, 0),
    bestFloor: Math.max(...runs.map((r) => r.floorReached)),
    seedsWithNoKill: runs.filter((r) => r.enemiesKilled === 0).map((r) => r.seed),
  };
}

function formatTable(rows: readonly WeaponRow[]): string {
  const head = [
    'weapon'.padEnd(14),
    'k'.padEnd(2),
    'rarity'.padEnd(9),
    'reach'.padStart(6),
    'dps'.padStart(6),
    'kills'.padStart(6),
    't/kill'.padStart(7),
    'dmgTkn'.padStart(7),
    'floor'.padStart(6),
  ].join(' ');
  const body = [...rows]
    .sort((a, b) => a.ticksPerKill - b.ticksPerKill)
    .map((r) =>
      [
        r.profile.id.padEnd(14),
        r.profile.kind[0]!.padEnd(2),
        r.profile.rarity.padEnd(9),
        r.profile.axes.reachGrid!.toFixed(2).padStart(6),
        r.profile.axes.dps!.toFixed(2).padStart(6),
        String(r.kills).padStart(6),
        (Number.isFinite(r.ticksPerKill) ? r.ticksPerKill.toFixed(1) : 'INERT').padStart(7),
        String(r.damageTaken).padStart(7),
        String(r.bestFloor).padStart(6),
      ].join(' '),
    );
  return [head, '-'.repeat(head.length), ...body].join('\n');
}

describe('per-weapon PvE sweep (first-signal data — see this file\'s header for the confounds)', () => {
  const bank = new Map<string, WeaponRow>();
  const row = (p: WeaponProfile): WeaponRow => {
    const cached = bank.get(p.id);
    if (cached) return cached;
    const fresh = sweepWeapon(p);
    bank.set(p.id, fresh);
    return fresh;
  };
  const all = (): WeaponRow[] => weaponProfiles().map(row);

  it('reports the whole roster: kills, pace, damage taken, depth', () => {
    const rows = all();
    // eslint-disable-next-line no-console
    console.log(`\n${SEEDS.length} seeds/weapon, ${MAX_TICKS} tick ceiling, standoff derived per weapon\n`);
    // eslint-disable-next-line no-console
    console.log(formatTable(rows));
    expect(rows.length).toBeGreaterThanOrEqual(24);
  }, 900_000);

  // ── Gates ───────────────────────────────────────────────────────────────────

  it('gate: the loadout hook really equips the swept weapon, ACTIVE — or the sweep is fiction', () => {
    // Asserted against `resolveLoadout` rather than inferred from the run: if a weapon id
    // silently failed to resolve, `resolveLoadout` would quietly hand back the starter kit
    // and every row in the table above would be a blaster run under another name. That is
    // the one failure that would make this whole file lie, so it is checked directly.
    for (const p of weaponProfiles()) {
      const resolved = resolveLoadout([p.id]);
      expect(resolved[0]?.name, `${p.id} did not resolve to itself, ACTIVE (slot 0)`).toBe(p.id);
      // The free slot is filled with the other kind, so a gun run still carries a blade for
      // parry and vice versa (content/players.ts) — worth pinning, since it means every row
      // is "this weapon plus the default of the other kind", not "this weapon alone".
      expect(resolved.length, `${p.id} loadout size`).toBe(2);
      expect(resolved[1]!.kind, `${p.id} should be backed by the other kind`).not.toBe(resolved[0]!.kind);
    }
  });

  it('gate: NO weapon is inert — every one of them kills something, on every seed', () => {
    // The regression check a static test cannot make. A weapon whose mechanic stops firing
    // (a ballistic param dropped in conversion, a proc that never triggers, a beam aimed
    // where nothing is) still passes every schema and every Pareto check while killing
    // exactly nothing. This is what caught the harness's own standoff bug: lasercutter,
    // gyre and all seven blades scored 0 because the bot stood outside their reach.
    const inert = all()
      .filter((r) => r.seedsWithNoKill.length > 0)
      .map((r) => `${r.profile.id} (seeds ${r.seedsWithNoKill.join(',')})`);
    expect(inert).toEqual([]);
  }, 900_000);

  it('gate: no weapon is an order of magnitude off the roster\'s pace', () => {
    // Measured spread on 2026-09-04 was 1.9x (lasercutter ~46.2 t/kill to leech ~87.6), so
    // 6x leaves ~3x of headroom: loose enough not to be a knee on any shipped number, tight
    // enough to fire if a weapon actually breaks. Compared against the SAME run's best, so
    // it survives the level and the enemy AI being retuned underneath it. Tightening this into a real
    // balance band needs human playtesting, not a bot that cannot lead a shot — and note
    // t/kill's own confound, in the header. Not an order of magnitude, deliberately: the
    // metric is not clean enough to carry one.
    const rows = all();
    const best = Math.min(...rows.map((r) => r.ticksPerKill));
    expect(best).toBeGreaterThan(0);
    const outliers = rows
      .filter((r) => r.ticksPerKill > best * 6)
      .map((r) => `${r.profile.id} ${r.ticksPerKill.toFixed(1)} t/kill vs best ${best.toFixed(1)}`);
    expect(outliers).toEqual([]);
  }, 900_000);

  it('gate: the two starter weapons still both work — the case every other sim already covers', () => {
    // Cross-check against `pveLevelSim`: if these two regressed, that sim's gates should
    // have fired first. This is here so a failure in THIS file can be told apart from a
    // level-content regression that happens to show up in every weapon's row at once.
    for (const id of ['blaster', 'saber']) {
      const r = all().find((x) => x.profile.id === id)!;
      expect(r.kills, `${id} kills`).toBeGreaterThan(0);
      expect(r.ticksPerKill, `${id} pace`).toBeLessThan(Infinity);
    }
  }, 900_000);
});
