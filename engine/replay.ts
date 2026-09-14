/**
 * Replay, headless re-judge, and deterministic state hashing (design/06/08).
 *
 * A replay is **seed + config + input stream, never state** (design/08): a fresh
 * engine on the same seed reconstructs every frame bit-for-bit. That is the whole
 * anti-cheat / re-judge backstop — the server (or a test) re-runs the recorded
 * input through runHeadless() and compares the outcome. ENGINE_VERSION guards the
 * stream: ReplayInputSource refuses a mismatched version rather than replaying
 * garbage against changed sim math.
 *
 * Stage E delivers the recorded path (ReplayInputSource) and the shared
 * authoritative loop (runHeadless); the live NetInputSource is post-MVP (design/06).
 */
import { ENGINE_VERSION } from './config';
import { createGameEngine, GameEngine } from './GameEngine';
import type { EngineConfig, GameState } from './state/GameState';
import type { InputSource, PlayerCommand } from './state/commands';

/**
 * A recorded match: everything needed to reconstruct it. `commands` is the sparse,
 * flat input stream (a frame with no command replays as idle-hold, design/08).
 */
export interface Replay {
  version: number; // ENGINE_VERSION at record time
  config: EngineConfig;
  commands: readonly PlayerCommand[];
}

/** Build a Replay from a finished match's recorded command stream (design/08). */
export function toReplay(config: EngineConfig, commands: readonly PlayerCommand[]): Replay {
  return { version: ENGINE_VERSION, config, commands: commands.map((c) => ({ ...c })) };
}

/**
 * Replays a recorded input stream. Like LocalInputSource it never stalls — a frame
 * absent from the recording is idle-hold ([]), not a net stall (null). Refuses a
 * version mismatch loudly at construction (design/08 "fail loud, never replay
 * garbage"): an old stream against changed sim math would silently diverge.
 */
export class ReplayInputSource implements InputSource {
  private readonly byFrame = new Map<number, PlayerCommand[]>();

  constructor(private readonly replay: Replay) {
    if (replay.version !== ENGINE_VERSION) {
      throw new Error(
        `Replay version ${replay.version} != engine ${ENGINE_VERSION}; refusing to replay (design/08).`,
      );
    }
    for (const cmd of replay.commands) {
      const list = this.byFrame.get(cmd.tick);
      if (list) list.push(cmd);
      else this.byFrame.set(cmd.tick, [cmd]);
    }
  }

  /** Replays are read-only; the stream is fixed at construction. */
  submit(): void {
    throw new Error('ReplayInputSource is read-only');
  }

  take(frame: number): PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }

  get config(): EngineConfig {
    return this.replay.config;
  }
}

/**
 * The shared authoritative loop (design/06/08 runHeadless): drive an engine from
 * an InputSource for up to maxTicks, stopping early on gameover. No render, no
 * wall-clock — used for post-match re-judge, anti-cheat, and golden-replay tests.
 * A net stall (take → null) ends the loop; local/replay sources never stall.
 */
export function runHeadless(config: EngineConfig, input: InputSource, maxTicks: number): GameEngine {
  const engine = createGameEngine(config, input);
  for (let frame = 1; frame <= maxTicks; frame++) {
    if (engine.advance(frame) === null) break; // net stall
    if (engine.state.phase === 'gameover') break;
  }
  return engine;
}

/** Convenience: reconstruct a recorded match end-to-end from its Replay. */
export function runReplay(replay: Replay, maxTicks: number): GameEngine {
  return runHeadless(replay.config, new ReplayInputSource(replay), maxTicks);
}

// ── deterministic state hashing (re-judge / golden-replay comparison) ──────────

/**
 * A stable, order-sensitive snapshot of everything the determinism contract
 * covers (design/08). Only integer sim fields — positions/velocities are fp,
 * angles brad, so this is exact, not float-fuzzy. The three PRNG cursors are
 * included so a divergence that has not yet surfaced in an entity is still caught.
 * Iteration follows the ordered arrays (push = spawn = iteration order).
 */
export function serializeState(s: GameState): unknown {
  return {
    version: ENGINE_VERSION,
    tick: s.tick,
    phase: s.phase,
    winner: s.winner,
    waveIndex: s.waveIndex,
    waveBreakTicks: s.waveBreakTicks,
    wavesExhausted: s.wavesExhausted,
    prng: [
      s.aiPrng.peek(), s.combatPrng.peek(), s.dropPrng.peek(), s.roomgenPrng.peek(),
      // ringPrng/integrityPrng (design/15, ROADMAP 4.2d/4.4) — included for the same
      // reason as the four above: a divergence that hasn't yet surfaced in an entity
      // still shows up here. integrityPrng especially: it's drawn every tick
      // unconditionally (GameEngine.step), so it's the fastest-moving signal in the
      // whole hash — exactly its purpose (design/15's "make divergence show up fast").
      s.ringPrng.peek(), s.integrityPrng.peek(),
      // cardPrng (design/05, ENGINE_VERSION 58) — one draw per offered card at each
      // checkpoint; a divergence in what a floor OFFERED shows up here immediately.
      s.cardPrng.peek(),
    ],
    players: s.players.map((p) => [
      p.id, p.teamId, p.gx, p.gy, p.z, p.vx, p.vy, p.knockVx, p.knockVy, p.facing, p.hp, p.maxHp, p.alive,
      // Two-pool health (design/07): shield absorbs first and its idle regen advances
      // ticksSinceHit every tick, so both must be hashed to catch a regen divergence.
      p.shield, p.maxShield, p.ticksSinceHit,
      p.activeSlot, p.firing, p.prevButtons,
      // Co-op downed/revive (design/05/07, ROADMAP 3.2): downed players are frozen with a
      // running bleedout + revive-channel clock — hash them so a revive/bleedout divergence
      // is caught directly. Stable (false/0/0) for a still-standing player.
      p.downed, p.bleedoutTicks, p.reviveProgressTicks,
      // PvP squad revive (design/05/15): a bandage is consumed on a successful revive
      // completion — hash it so a desync there (e.g. one client double-spending a
      // bandage) surfaces immediately instead of only showing up later as a revive
      // that should have failed but didn't. Always 0 in PvE.
      p.bandages,
      // Weapon energy (design/03/05, ENGINE_VERSION 59). Hashed for the same reason
      // `ticksSinceHit` is: it moves on a global regen cadence EVERY tick a player is
      // under the cap, and it moves again on every ranged pull — so a divergence in the
      // pool would otherwise surface only much later, as a shot one client fired and
      // another refused. `maxEnergy` too: a card or character that ever raises the cap
      // must not be able to differ silently while the current value happens to agree.
      p.energy, p.maxEnergy,
      // Coins (design/05 "Shops", 2026-09-14). A wallet decides whether a shop purchase is
      // affordable, so two clients that disagree about a balance disagree about what is on
      // the counter — and the drop that fills it is a table entry, i.e. a dropPrng draw
      // whose divergence would otherwise only surface much later as a refused buy.
      p.coins,
      // Run-buff stack (design/14): buffs scale damage/firerate at use time, so a buff
      // divergence would otherwise only surface indirectly — hash the ids directly.
      p.buffs,
      // Floor-card vote (ENGINE_VERSION 58): persistent per-seat state that decides
      // which card a descend applies, so a desync in the tally has to surface here.
      p.cardVote,
      // Resolved spec fields: a weapon drop swaps the active slot's spec, so include
      // the numbers (not just name) to catch a loadout divergence.
      p.weapons.map((w) => [
        w.spec.name, w.cooldownTicks, w.justSwung, w.spec.damage,
        // Melee active hit window (design/07 step 7, ENGINE_VERSION 53): a swing now spans
        // several ticks, and all three of these move WITHOUT necessarily moving anything
        // else the same tick — `swingTicksLeft` counts down on a tick where the arc connects
        // with nothing, `swingHitIds` grows when a body is caught, and `swingDamage` is the
        // frozen crit roll that decides how hard the REST of the window lands. Hashing them
        // is what lets a divergence in the window itself surface directly instead of only
        // showing up later as a hit that should have happened but didn't. Stable
        // 0/''/0 for every ranged weapon and for a blade at rest.
        w.swingTicksLeft, w.swingHitIds.join(','), w.swingDamage,
        // `energyCost` rides in the ranged tuple (ENGINE_VERSION 59) beside the other
        // resolved spec numbers, so a client holding a differently-priced build of the
        // same weapon id diverges here rather than silently paying a different price.
        w.spec.kind === 'ranged'
          ? [w.spec.fireRateTicks, w.spec.bulletSpeed, w.spec.energyCost]
          : [w.spec.range, w.spec.swingTicks],
      ]),
    ]),
    enemies: s.enemies.map((e) => [
      e.id, e.teamId, e.gx, e.gy, e.z, e.vx, e.vy, e.knockVx, e.knockVy, e.facing, e.hp, e.shield, e.alive,
      // Boss AI depth (design/09, ENGINE_VERSION 27): enraged is a one-way latch that
      // changes damage/fire-rate without necessarily moving hp/gx/gy the same tick.
      e.enraged,
    ]),
    projectiles: s.projectiles.map((b) => [
      b.id, b.teamId, b.gx, b.gy, b.z, b.vx, b.vy, b.faction, b.damage, b.lifeTicks, b.alive,
      // Ballistic runtime (design/03/09, ROADMAP 1.1): homing/boomerang/lob/beam carry
      // extra per-tick state (turn progress, landing flag, beam duration) that can
      // diverge without necessarily moving gx/gy/vx/vy the very same tick.
      b.ballistic ?? '', b.ticksAlive ?? 0, b.landed ?? false, b.beamTicksLeft ?? 0,
      // orbit: the live angle + owner catch a circular-motion divergence before it moves
      // gx/gy (stable 0/-1 for every non-orbit bullet, so byte-identical there).
      b.orbitAngleBrad ?? 0, b.ownerId ?? -1,
      // k_* on-hit procs (design/03/09, ENGINE_VERSION 28): ricochetsLeft counts down
      // independent of gx/gy the tick it bounces; hitIds (piercing) grows without
      // necessarily moving anything either. Stable -1/'' for every weapon without
      // either proc, so byte-identical there.
      b.ricochetsLeft ?? -1, b.hitIds?.join(',') ?? '',
    ]),
    pickups: s.pickups.map((k) => [
      k.id, k.kind, k.gx, k.gy, k.spawnTick, k.alive,
      k.weaponId ?? '', k.buffId ?? '', k.materialId ?? '', k.qty ?? 0, k.tier ?? 0,
    ]),
    // Chests (design/05 "Chest rooms", ENGINE_VERSION 63) and shops (design/05 "Shops",
    // 2026-09-14). `opened` and `sold` are one-way decisions the sim makes off shared state,
    // which is the definition of a thing this hash exists to catch — `ChestSystem`'s own
    // header says a chest that opened on one client and not another IS the desync.
    //
    // **The chest half was missing until 2026-09-14**, and the way it was missing is worth
    // recording: `fixtures/chestRoomFloor.ts` says in prose that "`state.chests` joining the
    // hashed payload" is what reaches the golden gate, and it never did. Nothing failed,
    // because a divergence in `opened` surfaces one tick later as a weapon pickup that exists
    // on one client and not the other — later, and attributed to the wrong system.
    //
    // A big chest's `mechanisms` are hashed for their `occupied` flags rather than their
    // positions: the positions are derived with integer trig from already-hashed inputs and
    // carry no independent information, but `occupied` is recomputed every tick from player
    // positions and is what the all-plates test reads.
    chests: s.chests.map((c) => [c.id, c.opened, c.mechanisms.map((m) => m.occupied)]),
    shops: s.shops.map((sh) => [sh.id, sh.stock.map((o) => [o.id, o.kind, o.price, o.sold])]),
    // Extraction / materials-banking (design/05, ROADMAP 1.4/1.5). floorIndex is a
    // plain number; the two material maps are sorted by key so the hash doesn't depend
    // on Object.entries' (already-deterministic) insertion order matching between two
    // independently-constructed-but-equal states.
    floorIndex: s.floorIndex,
    floorMaterials: sortedEntries(s.floorMaterials),
    bankedMaterials: sortedEntries(s.bankedMaterials),
    // Floor cards (design/05, ENGINE_VERSION 58). The picked list drives the run's
    // heal-drop and coin multipliers (`resolveFloorCards`), and the open
    // offer decides what a descend can even apply — both are read back into sim
    // decisions, so both belong in the hash. Buff cards additionally show up through
    // each player's own `buffs`, already hashed below.
    floorCardOffer: s.floorCardOffer,
    floorCards: s.floorCards,
    // Dungeon-mode co-resident room/door state (design/05 "Room & door model",
    // 2026-08-04). Empty/stable for a non-dungeon config, so this is safe to add
    // without a bump (the golden-replay test compares two independent runs, so a new
    // always-equal field never breaks it). Room SELECTION+PLACEMENT is deterministic
    // from roomgenPrng (already hashed above); this catches a PROGRESSION divergence —
    // a different room activated, locked, or cleared — before it surfaces in an entity.
    // Hashed per-room, not just "the current one": every room in a floor is
    // simultaneously live (design/05), so a divergence in any one of them must be
    // caught, not only whichever room a client happens to be standing in. Player/enemy
    // `roomId` is deliberately NOT hashed separately — it's a pure function of already-
    // hashed position + already-hashed room placement, so it carries no independent
    // information a divergence there wouldn't already show up as a position mismatch.
    dungeonRoomIds: s.dungeonRooms.map((r) => r.id),
    dungeonRoomRuntime: s.dungeonRoomRuntime.map((rt) => [
      rt.activated, rt.roomTick, rt.cursor, rt.hasLiveEnemy,
    ]),
    dungeonDoorsLocked: s.dungeonDoors.map((d) => d.locked),
    // PvP zone + placement (design/15, ROADMAP 4.2d/4.2e/4.4). undefined/empty for
    // every non-arena config (stable, safe to add without touching other modes).
    // Hashing the zone directly catches a stage/safe-set divergence before it would
    // otherwise surface indirectly (as a zone-damage difference a tick or more later)
    // — the same "don't wait for it to show up in an entity" reasoning as the PRNGs.
    zone: s.zone
      ? [s.zone.eye, s.zone.stage, s.zone.phase, s.zone.ticksToPhaseEnd, s.zone.safe, s.zone.closing, s.zone.escalation]
      : null,
    placements: s.placements,
  };
}

function sortedEntries(m: Partial<Record<string, number>>): [string, number][] {
  return Object.entries(m)
    .map(([k, v]) => [k, v ?? 0] as [string, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 32-bit FNV-1a of the serialized state — a compact byte-equality token. */
export function hashState(s: GameState): number {
  const json = JSON.stringify(serializeState(s));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
