/**
 * The level simulator: drive one full PvE run headlessly and record what it felt
 * like to be shot at.
 *
 * Built for a specific, repeated failure mode — a live report that a room's garrison
 * deletes the player before they can react ("一进游戏就被集火秒杀"). That bug has now
 * been "fixed" twice from reasoning alone (ENGINE_VERSION 40's fire-range gate, and
 * v37's chase before it) without anything in the repo able to say how much incoming
 * damage a room actually produces. This measures it:
 *
 *   - `reactionTicks` — activation → first damage taken. The number the report is
 *     really about; a player needs roughly a second to read a room.
 *   - `peakShooters` — most enemies firing at the player in the same tick, per room.
 *     The literal definition of 集火 (focus fire).
 *   - `peakBurstDamage` — worst 1-second damage window of the run, against the
 *     player's own effective HP pool (`hp + shield`), which is what decides whether
 *     a burst is survivable at all.
 *   - clear time and where the run ended, so a nerf can be checked for overshoot —
 *     an unkillable room and a boring one are both failures.
 *
 * It runs the REAL content through the REAL engine: `buildDungeonRunConfig` is the
 * same function `Game.beginRun` calls, so the simulated run is byte-identical to
 * pressing START (design/06 anti-drift — no second hand-mirrored copy of the run
 * config), and `PveBotController` reaches the engine through nothing but
 * `PlayerCommand`s. What it is NOT is a claim about human skill: a bot's aim is
 * perfect and its nerve never breaks. Read it as a floor on difficulty ("even a
 * tireless kiter dies here"), not as a verdict on how a person will do.
 *
 * The data shapes (`RunMetrics` and friends) and the per-tick observer that fills
 * them in live next door (`levelSimTypes.ts` / `levelSimTracker.ts` — CLAUDE.md
 * "500-line file convention") and are re-exported below, so this stays the one
 * import site for every existing caller.
 */
import { createGameEngine } from '@dd/engine';
import { buildDungeonRunConfig } from '../../src/game/match/offlineConfig';
import { BOT_PROFILES, PveBotController } from './PveBotController';
import { EncounterTracker } from './levelSimTracker';
import type { RunMetrics, RunOptions } from './levelSimTypes';

export * from './levelSimTypes';

/** 5 floors of hand-authored rooms with a slow starter pistol is a long run; this is
 *  a runaway guard, not an expected outcome — a timeout is reported as its own
 *  result so it can never be mistaken for a survival. */
const DEFAULT_MAX_TICKS = 40_000;

export function runLevel(opts: RunOptions): RunMetrics {
  const profileName = opts.profileName ?? 'careful';
  const profile = opts.profile ?? BOT_PROFILES[profileName];
  const skinId = opts.skinId ?? 'vanguard';
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;

  const engine = createGameEngine(
    buildDungeonRunConfig({
      seed: opts.seed,
      coop: false,
      localSeat: { skinId, loadout: opts.loadout ?? [] },
      allySkinId: 'juggernaut', // ignored: single-player config has no ally seat
    }),
  );
  const bot = new PveBotController(profile);
  const tracker = new EncounterTracker();

  let outcome: RunMetrics['outcome'] = 'timeout';
  let ticks = 0;
  while (ticks < maxTicks) {
    const nextTick = engine.state.tick + 1;
    engine.step([bot.build(engine.state, 0, nextTick)]);
    ticks++;
    tracker.observe(engine.state);
    if (engine.state.phase === 'gameover') {
      outcome = engine.state.winner === 0 ? 'extracted' : 'died';
      break;
    }
  }

  const s = engine.state;
  return {
    seed: opts.seed,
    profileName,
    skinId,
    outcome,
    ticks,
    floorReached: s.floorIndex,
    endRoom: tracker.playerRoom,
    encounters: tracker.encounters,
    enemiesKilled: tracker.enemiesKilled,
    damageTaken: tracker.damageTaken,
    peakBurstDamage: tracker.peakBurstDamage,
    effectiveHp: tracker.effectiveHp,
    lowestHpFrac: tracker.lowestHpFrac,
    drops: tracker.drops,
    fires: tracker.fires,
    killsByFloor: tracker.killsByFloor,
    checkpointFloors: tracker.checkpointFloors,
    dryTicksByFloor: tracker.dryTicksByFloor,
    heldTicksByWeapon: tracker.heldTicksByWeapon,
    dryTicksByWeapon: tracker.dryTicksByWeapon,
    aliveTicksByFloor: tracker.aliveTicksByFloor,
    energyRefillsTakenByFloor: tracker.energyRefillsTakenByFloor,
    finalMaxEnergy: tracker.finalMaxEnergy,
    vitalsAtCheckpoint: tracker.vitalsAtCheckpoint,
    roomsTotalByFloor: tracker.roomsTotalByFloor,
    shopSnapshots: tracker.shopSnapshots,
  };
}
