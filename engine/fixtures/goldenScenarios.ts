/**
 * The scenarios behind `golden.json` — shared by the gate (`engine/goldenHash.test.ts`) and
 * the recorder (`engine/scripts/recordGolden.mjs`) so the two can never drift apart. See
 * design/18-test-strategy.md (G1) for why this file exists at all:
 *
 * every determinism assertion in this repo before it built TWO runs in the same process and
 * compared them to each other. That catches nondeterminism and nothing else — change
 * `WALL_NORTH_BRIM`, `solidRadius`, `muzzleOffset` or the step order and both runs change
 * identically, so every one of those tests stays green while replay compatibility silently
 * breaks. A recorded hash is the only thing that notices, and noticing is the whole job: the
 * gate does not decide whether a change is allowed, it forces the ENGINE_VERSION decision to
 * be made deliberately instead of forgotten.
 *
 * ## Why the input script is integer-only
 *
 * `replay.test.ts`'s in-process scripts use `Math.sin(tick * 0.07)` to drive the stick, which
 * is fine when both sides of the comparison run on the same machine in the same second. It is
 * NOT fine for a fixture committed to git: `Math.sin` is not specified to be bit-identical
 * across JS engines or platforms, `quantizeMove` would land a boundary value on a different
 * brad on some other machine, and the hash would differ for a reason that has nothing to do
 * with the sim. `inputFor` below is a pure integer hash (`Math.imul` is exact 32-bit
 * everywhere), so the same tick yields the same command on every machine, forever.
 */
import { createGameEngine } from '../GameEngine';
import { hashState } from '../replay';
import { Button, type PlayerCommand } from '../state/commands';
import { makeCommand } from '../state/input';
import { BRAD_FULL, type Brad } from '../math/trig';
import type { EngineConfig } from '../state/GameState';
import type { GameState } from '../state/GameState';
import { EMBER_DUNGEON } from '../world/rooms/ember';
import { EMBER_L1_ROOMS } from '../world/rooms/emberLevel1';
import { LAUNCH_ARENA } from '../world/arenas/launchArena';
import { BRIM_GRINDER_DUNGEON, BRIM_GRINDER_ROOMS } from './brimGrinderFloor';
import { EXTRACT_GATE_DUNGEON, EXTRACT_GATE_ROOMS } from './extractionGateFloor';

/** A stable 32-bit integer hash. Pure, platform-independent, no floating point anywhere. */
function mix(x: number, salt: number): number {
  let h = (x ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * One seat's command for one tick — a pure function of (tick, owner, salt), so the stream can
 * never depend on iteration order or on how many ticks were generated before it.
 *
 * `hold` keeps the stick pointed the same way for 8-tick runs rather than re-rolling every
 * tick: a stick that teleports around the circle every 33 ms never actually walks INTO
 * anything, and walking into things is the point of the wall scenarios below.
 */
function inputFor(tick: number, owner: number, salt: number, opts: ScenarioInput): PlayerCommand {
  const run = mix(Math.floor(tick / 8), salt ^ (owner * 0x9e37));
  const beat = mix(tick, salt ^ 0x5bf0 ^ (owner * 0x2545));
  let buttons = beat % 16 === 0 ? 0 : Button.FIRE; // mostly firing, with gaps for cooldown edges
  if (tick % 37 === 0) buttons |= Button.SWAP_WEAPON;
  if (opts.interact && tick % 53 === 0) buttons |= Button.INTERACT;
  if (opts.descend && tick % 61 === 0) buttons |= Button.CONFIRM_DESCEND;
  // CONFIRM_EXTRACT on a much tighter cadence than the descend above, and that gap is the
  // point (ENGINE_VERSION 61, `extractionGateFloor.ts`): the first extract pulse lands long
  // before the first descend, so a scenario that reaches an INTERIOR checkpoint proves the
  // press was ignored — if it were ever honoured again the run would end there, at a small
  // fraction of the tick budget and with `floorIndex` stuck at 0.
  if (opts.extract && tick % 7 === 0) buttons |= Button.CONFIRM_EXTRACT;
  // A descend needs a floor-card vote to be honoured (design/05, ENGINE_VERSION 58) —
  // without one the portal simply holds, and a scenario that used to change floors
  // would silently stop doing so while still passing its own hash. Varied by beat
  // rather than pinned to slot 1, so the tally and the offer indexing are both really
  // exercised rather than always taking the leftmost card.
  const cardVote = opts.descend && tick % 61 === 0 ? (mix(tick, salt) % 3) + 1 : 0;
  return makeCommand({
    owner,
    tick,
    cardVote,
    moveBrad: opts.press
      ? // Eight compass directions, each HELD for 100 ticks, starting due SOUTH (index 2 of 8
        // — brad 0 is +x/east, so BRAD_FULL/4 is +y/south).
        //
        // Two earlier versions of this failed, and both failures are the reason it is written
        // this literally. A pseudo-random stick never pressed the target block at all. A
        // steadily ROTATING stick (a "sweep") looked much more thorough — the player toured
        // gx 2076..18324, gy 3252..19500 of a 21000-fp room — and still spent **0 of 800
        // ticks** anywhere near the one face under test, because a smooth orbit traces a
        // circle and a circle is very good at going around things. Emergent motion cannot be
        // relied on to hit a specific 5x1-cell target; a held direction can.
        ((((Math.floor(tick / 100) + 2) % 8) * (BRAD_FULL / 8)) as number) as Brad
      : (((run >>> 16) & (BRAD_FULL - 1)) as Brad),
    // Bias the stick toward full deflection: a half-mag wander explores less geometry per tick,
    // and a press must be pinned all the way over or the actor never seats against the wall.
    moveMag: opts.press ? 255 : 128 + ((run >>> 8) & 0x7f),
    buttons,
  });
}

interface ScenarioInput {
  /** Pulse INTERACT — reaches revive/portal paths. */
  interact: boolean;
  /** Pulse CONFIRM_DESCEND — makes a dungeon run actually change floors. */
  descend: boolean;
  /** Pulse CONFIRM_EXTRACT — the button whose per-floor gate is v61's whole subject. Only
   *  meaningful for a scenario that actually reaches a checkpoint, which today means the
   *  purpose-built `extractionGateFloor.ts` (see its header for why the shipped floors cannot). */
  extract: boolean;
  /**
   * Replace the pseudo-random stick with long HELD cardinal/diagonal pushes. Use this whenever
   * a scenario has to make CONTACT with specific geometry rather than explore generally — see
   * the comment in `inputFor` for the two weaker input schemes that failed to.
   */
  press: boolean;
}

export interface GoldenScenario {
  name: string;
  /** What this scenario is here to pin, in one line. Read it before deleting or retuning one. */
  pins: string;
  config: EngineConfig;
  ticks: number;
  seats: number;
  input: ScenarioInput;
  /** Salt for the input script — distinct per scenario so two never share a stream. */
  salt: number;
}

/**
 * `witness` exists so a red gate is diagnosable. A bare "hash 123 !== 456" says a number
 * moved; these say WHICH way the world moved, and they are cheap to eyeball in a diff. They
 * are asserted too, not just recorded — a scenario that quietly stops spawning enemies would
 * otherwise keep "passing" its hash forever while testing nothing.
 */
export interface Witness {
  /** Where the run actually stopped. LOWER than the budget means it reached `gameover` — the
   *  engine's `step()` is a no-op after that — which is a decided outcome, not a broken run. */
  tick: number;
  phase: string;
  winner: string;
  seats: number;
  enemiesAlive: number;
  projectiles: number;
  pickups: number;
  floorIndex: number;
  hpTotal: number;
  /**
   * Every seat's weapon energy, summed — `hpTotal`'s counterpart for the ammo economy,
   * added at ENGINE_VERSION 62 by the pass that moved the regen line 20/s -> 15/s. That
   * change diverged two scenarios' hashes with every witness field identical, which is
   * the shape of a red gate nobody can read: "something moved" with no direction. The
   * ammo pool is the one player-visible pool the witness did not carry, and a hash is
   * the wrong instrument for a number a human has to reason about.
   */
  energyTotal: number;
  /**
   * The six PRNG cursors, summed. NOTE this is the summed internal STATE, not a draw count —
   * `Prng.peek()` returns the LCG's current value, which is already ~1e10 on a fresh engine.
   * It is a superb fingerprint (any new draw site anywhere moves it) and a useless activity
   * measure; `events` below is the activity measure. Naming it `prngDraws` and thresholding it
   * at `> 1000` was the first version of this file and proved exactly nothing.
   */
  prngCursors: number;
  /**
   * How many of each event the run emitted, summed over every tick — the real "did anything
   * happen" signal, and the one that makes the anti-vacuity guard meaningful. Zero-count types
   * are dropped so the fixture only carries what a scenario actually reaches.
   */
  events: Record<string, number>;
}

export function witnessOf(s: GameState, events: Record<string, number>): Witness {
  return {
    tick: s.tick,
    phase: s.phase,
    winner: String(s.winner),
    seats: s.players.length,
    enemiesAlive: s.enemies.filter((e) => e.alive).length,
    projectiles: s.projectiles.length,
    pickups: s.pickups.length,
    floorIndex: s.floorIndex,
    hpTotal: s.players.reduce((n, p) => n + p.hp, 0),
    energyTotal: s.players.reduce((n, p) => n + p.energy, 0),
    prngCursors:
      s.aiPrng.peek() +
      s.combatPrng.peek() +
      s.dropPrng.peek() +
      s.roomgenPrng.peek() +
      s.ringPrng.peek() +
      s.integrityPrng.peek(),
    events,
  };
}

/** Drive one scenario to completion and report both the hash and the witness. */
export function runScenario(sc: GoldenScenario): { hash: number; witness: Witness } {
  const engine = createGameEngine(sc.config);
  const events: Record<string, number> = {};
  for (let t = 1; t <= sc.ticks; t++) {
    const cmds: PlayerCommand[] = [];
    for (let owner = 0; owner < sc.seats; owner++) cmds.push(inputFor(t, owner, sc.salt, sc.input));
    // `step` returns this tick's events; they are cleared at the top of the NEXT one, so this
    // is the only place they can be counted.
    //
    // The `advanced` guard is load-bearing: after `gameover`, `step()` returns early and
    // deliberately does NOT clear events (design/08), so it keeps handing back the same final
    // batch every tick. Counting unconditionally reported `win: 316` for a run that won once —
    // 315 idle ticks re-counting one event. Only a tick that actually moved the sim counts.
    const before = engine.state.tick;
    const produced = engine.step(cmds);
    if (engine.state.tick === before) break; // gameover: nothing further can happen
    for (const ev of produced) events[ev.type] = (events[ev.type] ?? 0) + 1;
  }
  return { hash: hashState(engine.state), witness: witnessOf(engine.state, events) };
}

const NO_PULSE: ScenarioInput = { interact: false, descend: false, extract: false, press: false };

export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  {
    name: 'arena-waves',
    pins: 'the flat wave path: fire cadence, crit/drop rolls, actor pairs, win condition',
    config: {
      seed: 4242,
      worldW: 800,
      worldH: 800,
      playerStart: [400, 400],
      waves: [
        [
          [520, 400],
          [280, 400],
        ],
        [[400, 280]],
      ],
    },
    ticks: 500,
    seats: 1,
    input: NO_PULSE,
    salt: 0x1111,
  },
  {
    name: 'walls-and-pillars',
    pins: "MovementSystem's rect/circle push-out and its tie-breaks — the geometry half of design/18",
    config: {
      seed: 77,
      worldW: 960,
      worldH: 960,
      playerStart: [480, 480],
      // A cross of walls plus three pillars, tight enough that a full-deflection stick is
      // resolving a collision on most ticks rather than crossing open floor.
      walls: [
        [200, 440, 560, 64],
        [440, 200, 64, 560],
        [120, 120, 64, 240],
        [740, 640, 120, 64],
      ],
      obstacles: [
        [280, 300, 40],
        [660, 320, 52],
        [300, 700, 36],
      ],
      waves: [
        [
          [700, 700],
          [180, 700],
        ],
      ],
    },
    ticks: 600,
    seats: 1,
    input: NO_PULSE,
    salt: 0x2222,
  },
  {
    name: 'ember-dungeon-floor1',
    // Honest scope: a scripted stick does NOT clear rooms reliably, so this run never reaches a
    // checkpoint and `floorIndex` stays 0 for all 1500 ticks (asserted in the gate, so if a
    // future change DOES let it descend, that shows up as a deliberate decision rather than
    // drift). What it does pin is everything floor 1 touches: authored roomgen, room entry,
    // door lock/unlock, the free-standing north brim, and pickup clamping.
    pins: 'authored floor-1 roomgen + room entry + door lock/unlock + freeStanding north brim + pickup clamping',
    config: {
      seed: 20260830,
      worldW: 800,
      worldH: 800,
      waves: [],
      // The SHIPPED pairing (`client/src/game/match/matchConfig.ts`) — pinning the authored
      // level-1 content, not the older procedural pool it superseded.
      dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
    },
    ticks: 1500,
    seats: 1,
    input: { interact: true, descend: true, extract: false, press: false },
    salt: 0x3333,
  },
  {
    name: 'brim-grinder',
    // The scenario that exists because a mutation check found the other four could not see
    // `WALL_NORTH_BRIM` at all. See brimGrinderFloor.ts for the full account — the short
    // version is that a flat `walls` config cannot express `freeStanding`, and a random stick
    // never reliably presses the one face the brim governs.
    pins: 'WALL_NORTH_BRIM itself: a free-standing block\'s brimmed north face vs its three bare ones',
    config: {
      seed: 4801,
      worldW: 800,
      worldH: 800,
      waves: [],
      dungeon: { config: BRIM_GRINDER_DUNGEON, library: BRIM_GRINDER_ROOMS },
    },
    ticks: 800,
    seats: 1,
    input: { interact: false, descend: false, extract: false, press: true },
    salt: 0x5555,
  },
  {
    name: 'extraction-gate',
    // The scenario that exists because measuring v61 against the other five found ZERO
    // divergence — see extractionGateFloor.ts for the full account. The short version is that
    // no other scenario presses CONFIRM_EXTRACT, and the one dungeon scenario cannot reach a
    // checkpoint to press it at.
    pins: "which floor may END a run: an interior CONFIRM_EXTRACT ignored, the boss floor's honoured",
    config: {
      seed: 6101,
      worldW: 800,
      worldH: 800,
      waves: [],
      dungeon: { config: EXTRACT_GATE_DUNGEON, library: EXTRACT_GATE_ROOMS },
    },
    // Generous on purpose: the run is EXPECTED to end well inside this, and a budget that
    // merely happened to be long enough would hide a slower kill later. Reaching the cap
    // instead means the last floor stopped extracting, which the witness shows as
    // `phase: 'playing'`.
    ticks: 400,
    seats: 1,
    input: { interact: false, descend: true, extract: true, press: false },
    salt: 0x6161,
  },
  {
    name: 'launch-arena-pvp',
    pins: 'arena geometry + zone shrink + two hostile seats + per-skin arena stat scaling',
    config: {
      seed: 9090,
      worldW: 800,
      worldH: 800,
      waves: [],
      arena: LAUNCH_ARENA,
      // Distinct `teamId`s — a real PvP match (design/15), so this also pins the hostility
      // predicate. Two DIFFERENT skins so `buildArenaSpecs`' per-character scaling is live.
      players: [
        { skinId: 'vanguard', teamId: 0 },
        { skinId: 'skirmisher', teamId: 1 },
      ],
    },
    ticks: 900,
    seats: 2,
    input: { interact: true, descend: false, extract: false, press: false },
    salt: 0x4444,
  },
];
