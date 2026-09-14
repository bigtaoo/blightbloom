/**
 * GameEngine — the single orchestrator (design/08). Owns a GameState and the 18
 * systems, instantiated once and run in the frozen step() order. That order IS the
 * determinism contract; reordering it (or changing how a system iterates a
 * collection) bumps ENGINE_VERSION. ExtractionSystem (12, ROADMAP 1.4/1.5),
 * ZoneSystem/EnvironmentSystem (8a/8b, ROADMAP 4.2d), DoorSystem (11.5,
 * design/05 "Room & door model") and ChestSystem (10.5, design/05 "Chest rooms")
 * are the exceptions to "adding a step bumps the version": each is a strict no-op
 * for any config that doesn't opt into `floors`/`arena`/`dungeon`/an authored chest
 * respectively, so their presence changes nothing for an older config or replay.
 * (ChestSystem's ARRIVAL was therefore free; what costs ENGINE_VERSION 63 is the
 * shipped level authoring chests, which moves the drop stream on a floor with one.)
 *
 * step(commands) is the direct entry (headless/tests). The InputSource seam
 * (advance/submit) pulls confirmed frames from the source; runHeadless() (replay.ts)
 * drives it for re-judge/replay, and the render layer's accumulator drives it live
 * (Stage D). A net stall (take → null) surfaces as advance() → null; local/replay
 * sources never stall.
 */
import { createGameState, type EngineConfig, type GameState } from './state/GameState';
import { LocalInputSource, type InputSource, type PlayerCommand } from './state/commands';
import type { GameEvent } from './state/events';
import {
  AIDecideSystem,
  ApplyInputSystem,
  ChestSystem,
  DeathDropsSystem,
  DeflectSystem,
  DoorSystem,
  EnvironmentSystem,
  ExtractionSystem,
  HitResolveSystem,
  MovementSystem,
  PickupSystem,
  ProjectileStepSystem,
  ReviveSystem,
  SpawnSystem,
  StatusEffectSystem,
  WeaponFireSystem,
  WinConditionSystem,
  ZoneSystem,
} from './systems';

export class GameEngine {
  readonly state: GameState;
  private readonly input: InputSource;

  private readonly applyInput = new ApplyInputSystem();
  private readonly aiDecide = new AIDecideSystem();
  private readonly weaponFire = new WeaponFireSystem();
  private readonly movement = new MovementSystem();
  private readonly projectileStep = new ProjectileStepSystem();
  private readonly deflect = new DeflectSystem();
  private readonly hitResolve = new HitResolveSystem();
  private readonly statusEffect = new StatusEffectSystem();
  private readonly zone = new ZoneSystem();
  private readonly environment = new EnvironmentSystem();
  private readonly deathDrops = new DeathDropsSystem();
  private readonly pickup = new PickupSystem();
  private readonly chests = new ChestSystem();
  private readonly spawns = new SpawnSystem();
  private readonly doors = new DoorSystem();
  private readonly extraction = new ExtractionSystem();
  private readonly revive = new ReviveSystem();
  private readonly winCondition = new WinConditionSystem();

  constructor(config: EngineConfig, input: InputSource) {
    this.state = createGameState(config);
    this.input = input;
  }

  /**
   * Advance one sim frame with the confirmed commands for this tick. The fixed
   * system order is the determinism contract (design/08). Returns the events
   * produced this step (also readable as state.events until the next step).
   */
  step(commands: readonly PlayerCommand[]): GameEvent[] {
    const s = this.state;
    if (s.phase === 'gameover') return s.events; // don't clear events (design/08)
    if (s.phase === 'idle') s.phase = 'playing';
    s.clearEvents();
    s.tick++;
    // Anti-cheat padding draw (design/15, ROADMAP 4.4) — advances every tick,
    // unconditionally, regardless of mode; never read by any system (see
    // GameState.integrityPrng's doc comment). The discarded value IS the point —
    // only its cursor position (hashed in replay.ts serializeState) matters.
    s.integrityPrng.nextInt(0x7fffffff);

    this.applyInput.tick(s, commands); // 1
    this.aiDecide.tick(s); //             2  (PvE)
    this.weaponFire.tick(s); //           3
    this.movement.tick(s); //             4
    this.projectileStep.tick(s); //       5
    this.deflect.tick(s); //              6  (melee swing parries bullets in its arc)
    this.hitResolve.tick(s); //           7
    this.statusEffect.tick(s); //         8  (burn/poison DoT + chill countdown)
    this.zone.tick(s); //                 8a (PvP, arena-mode only — ROADMAP 4.2d)
    this.environment.tick(s); //          8b (PvP, arena-mode only — ROADMAP 4.2d)
    this.deathDrops.tick(s); //           9
    this.pickup.tick(s); //              10
    this.chests.tick(s); //            10.5 (design/05 "Chest rooms" — no-op with no authored chest)
    this.spawns.tick(s); //              11  (PvE)
    this.doors.tick(s); //              11.5 (PvE dungeon only — design/05 "Room & door model")
    this.extraction.tick(s); //          12  (PvE, floors-mode only — ROADMAP 1.4/1.5)
    this.revive.tick(s); //              13  (co-op downed/revive — ROADMAP 3.2)
    this.winCondition.tick(s); //        14

    return s.events;
  }

  /** Submit a command to the input source (Stage E net/replay seam). */
  submit(cmd: PlayerCommand): void {
    this.input.submit(cmd);
  }

  /**
   * Pull the confirmed commands for `frame` from the input source and step. Returns
   * null on a net stall (input not yet confirmed); LocalInputSource never stalls.
   * The full frame-broadcast/replay behavior is Stage E.
   */
  advance(frame: number): GameEvent[] | null {
    const cmds = this.input.take(frame);
    if (cmds === null) return null;
    return this.step(cmds);
  }
}

/**
 * Factory (design/08). `input` defaults to a non-stalling LocalInputSource so
 * single-player and tests need no net setup.
 */
export function createGameEngine(config: EngineConfig, input: InputSource = new LocalInputSource()): GameEngine {
  return new GameEngine(config, input);
}
