// Cause-of-death telemetry: what killed the local player, where, and how fast (design/21).
//
// ## Why it exists
//
// The first sandbox traffic (2026-11-08/09) showed most recorded runs ending in a death on
// floor 1, inside four minutes. The PvE bots clear that floor on every seed and take a few
// points of damage doing it, so the sim cannot say why people die there. `run_end` said
// THAT they died and nothing else. These four props are the smallest set that separates
// the hypotheses worth acting on:
//
// - `killer`: which enemy type landed the last hit. One type dominating is a tuning target.
// - `room`: which room it happened in. One room dominating is a layout problem.
// - `hits`: how many hits the player took in the whole run. Few hits means a fragile body
//   or a misunderstood heal; many means the player is not avoiding damage at all.
// - `burst_pct`: the damage taken in the five seconds before the last hit, as a percentage
//   of the full HP + shield pool. Near or over 100 is "I never saw it coming"; low is a
//   slow bleed the player did not notice.
//
// ## Why it reads events, not state
//
// A dead enemy is compacted out of `state.enemies` on the tick it dies, and a bullet keeps
// flying after its shooter is gone, so "who shot this" cannot be looked up after the fact.
// The engine's `hit` event carries the attacker's id (`by`), and the shooter's TYPE is
// remembered here from the frame it fired, while it was still alive to be read.
//
// ## Why module state
//
// The same reason as `analyticsTracking.ts`, whose `run_start` resets it: threading a
// dependency through `Game.ts` costs lines the drift gate pins, and a no-op default costs a
// test or a tool nothing. All the exported functions are cheap and allocation-light.
import { ENEMY_BLUEPRINTS, TICK_RATE, type GameEvent } from '@dd/engine';

/** The parts of an enemy actor that identify its blueprint. All three are copied from the
 *  blueprint verbatim by `buildEnemyActor` and never change afterwards. */
interface EnemyLike {
  id: number;
  tint?: number;
  bodyRig?: string;
  boss?: boolean;
}

interface PlayerLike {
  id: number;
  gx: number;
  gy: number;
  maxHp: number;
  maxShield: number;
}

interface RoomRectLike {
  id: string;
  rect: { x: number; y: number; w: number; h: number };
}

/** Structural view of `GameState`: only what this module reads, so a test needs no engine.
 *  The lists are optional because this runs on every frame of `EventReactor.consume`, whose
 *  callers include partial states, and a telemetry side channel must never be the thing
 *  that throws there. */
export interface DeathCauseState {
  tick: number;
  players?: readonly PlayerLike[];
  enemies?: readonly EnemyLike[];
  dungeonRoomRects?: readonly RoomRectLike[];
}

/** The props of `run_death`, sent after a lost run's `run_end`. Every field is optional:
 *  a run with no recorded hit (a disconnect, a resumed run killed on its first frame) sends
 *  whatever it does have rather than invented zeros. */
export interface DeathProps {
  killer?: string;
  room?: string;
  hits?: number;
  burst_pct?: number;
}

/** The burst window: five seconds of sim ticks, ending on the killing hit. */
export const BURST_WINDOW_TICKS = 5 * TICK_RATE;

const signature = (tint: number | undefined, bodyRig: string | undefined, boss: boolean | undefined): string =>
  `${tint ?? '-'}|${bodyRig ?? '-'}|${boss === true ? 'b' : '-'}`;

/** Blueprint signature → blueprint type. Built once; `deathCause.test.ts` pins that no two
 *  blueprints share a signature, which is what makes the reverse lookup sound. */
const TYPE_BY_SIGNATURE: ReadonlyMap<string, string> = new Map(
  Object.entries(ENEMY_BLUEPRINTS).map(([type, bp]) => [signature(bp.tint, bp.bodyRig, bp.boss), type]),
);

/** An enemy actor's blueprint type, or `'unknown'` for a shape no blueprint has. */
export function enemyTypeOf(e: EnemyLike): string {
  return TYPE_BY_SIGNATURE.get(signature(e.tint, e.bodyRig, e.boss)) ?? 'unknown';
}

interface Hit {
  tick: number;
  damage: number;
}

let shooterTypes = new Map<number, string>();
let recentHits: Hit[] = [];
let hitCount = 0;
let lastKiller: string | undefined;
let lastRoom: string | undefined;

/** Forget the previous run. Called on `run_start`. */
export function resetDeathCause(): void {
  shooterTypes = new Map();
  recentHits = [];
  hitCount = 0;
  lastKiller = undefined;
  lastRoom = undefined;
}

function roomAt(s: DeathCauseState, x: number, y: number): string | undefined {
  for (const r of s.dungeonRoomRects ?? []) {
    const { rect } = r;
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return r.id;
  }
  return undefined;
}

function rememberShooter(s: DeathCauseState, id: number): string | undefined {
  const known = shooterTypes.get(id);
  if (known !== undefined) return known;
  const e = s.enemies?.find((a) => a.id === id);
  if (e === undefined) return undefined;
  const type = enemyTypeOf(e);
  shooterTypes.set(id, type);
  return type;
}

/** Who dealt a hit, as an id fit for the analytics charset. */
function killerOf(s: DeathCauseState, e: Extract<GameEvent, { type: 'hit' }>): string {
  if (e.faction === 'environment') return 'environment';
  if (e.faction === 'player') return 'player';
  // No attacker: a burn or poison tick, or a lightning chain hop. Named by its element so
  // a run lost to a DoT is not filed under whichever mob happened to apply it.
  if (e.by === undefined) return `${e.damageType}_status`;
  return rememberShooter(s, e.by) ?? 'unknown';
}

/**
 * Fold one frame's events into the running record. Called from `EventReactor.consume`,
 * the one place every event of both the offline and the online loop passes through.
 */
export function noteDeathCauseEvents(s: DeathCauseState | null, localOwner: number, events: readonly GameEvent[]): void {
  if (s === null) return;
  const me = s.players?.[localOwner];
  if (me === undefined) return;
  for (const e of events) {
    if ((e.type === 'bullet_fired' || e.type === 'melee_swing') && e.faction === 'enemy') {
      rememberShooter(s, e.ownerId);
    } else if (e.type === 'hit' && e.target === me.id && e.damage > 0) {
      hitCount++;
      lastKiller = killerOf(s, e);
      // Read at each hit rather than at death: a player dies in a doorway gap no room rect
      // covers often enough that "the room of the last hit inside one" is the honest answer.
      lastRoom = roomAt(s, me.gx, me.gy) ?? lastRoom;
      recentHits.push({ tick: s.tick, damage: e.damage });
      const oldest = s.tick - BURST_WINDOW_TICKS;
      while (recentHits.length > 0 && recentHits[0]!.tick <= oldest) recentHits.shift();
    }
  }
}

/** The props of a lost run's `run_death`. Read once, from `RunOutcome`. */
export function deathReportProps(s: DeathCauseState | null, localOwner: number): DeathProps {
  const props: DeathProps = {};
  if (lastKiller !== undefined) props.killer = lastKiller;
  if (lastRoom !== undefined) props.room = lastRoom;
  if (hitCount > 0) props.hits = hitCount;
  const me = s?.players?.[localOwner];
  const pool = me === undefined ? 0 : me.maxHp + me.maxShield;
  const last = recentHits[recentHits.length - 1];
  if (last !== undefined && pool > 0) {
    let burst = 0;
    for (const h of recentHits) if (h.tick > last.tick - BURST_WINDOW_TICKS) burst += h.damage;
    props.burst_pct = Math.min(999, Math.round((burst * 100) / pool));
  }
  return props;
}
