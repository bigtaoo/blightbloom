/**
 * Hostile-target pooling (design/15 — the PvP team/hostility model, ROADMAP
 * 4.2a). Every combat system used to pick "the opposite array" via a hardcoded
 * `faction === 'player' ? state.enemies : state.players` ternary — an
 * assumption baked in that there are only ever two sides. That breaks the
 * moment two players can be on different teams (PvP) or the same team
 * (squads): the correct question was never "which array," it's "who is
 * hostile to me," which spans both arrays and can exclude members of either.
 *
 * `hostileTargets`/`nearestHostile` are the shared replacement, used by
 * HitResolveSystem, DeflectSystem, ProjectileStepSystem, and combat.ts.
 * Iteration is players-then-enemies, matching every other array-order-is-the-
 * tiebreak convention in the engine (design/06) — deterministic regardless of
 * how many teams are actually in play.
 */
import type { Fp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import { isDowned, isHostile, type Actor, type Teamed } from '../state/entities';
import { nearestByPosition } from './nearest';

/**
 * Per-tick cache of "which players/enemies are on a team hostile to teamId T"
 * (perf: `hostileTargets` used to be called once per LIVE PROJECTILE — 50-150+
 * times/tick in a busy PvP arena — each rescanning every player+enemy through
 * `isHostile`, almost always recomputing the identical set). Team membership
 * (`teamId`) never changes mid-match, so this is safe to cache per team, but
 * ALIVE STATE does change mid-tick (an earlier bullet this same tick can kill an
 * actor a later bullet would otherwise still try to hit) — so only the team-
 * hostility partition is cached; `.alive`/`isDowned` are re-checked fresh on
 * every call below, exactly as before caching. Keyed by the GameState object
 * itself (WeakMap, not a module-level singleton) so multiple concurrent engine
 * instances (e.g. the PvP balance sim's bot-vs-bot loop) never cross-contaminate.
 */
interface TeamPoolCache {
  tick: number;
  playerCount: number;
  enemyCount: number;
  hostilePlayersByTeam: Map<number, Actor[]>;
  hostileEnemiesByTeam: Map<number, Actor[]>;
}
const teamPoolCache = new WeakMap<GameState, TeamPoolCache>();

function getTeamPools(state: GameState, teamId: number): { players: Actor[]; enemies: Actor[] } {
  let cache = teamPoolCache.get(state);
  // Also invalidated by an actor joining or leaving either array mid-tick. Until ENGINE_VERSION
  // 79 the first query of a tick came at step 5 or later, after anything that adds actors had
  // run; `WeaponFireSystem` now queries at step 3 (`muzzle.ts`), and a cache keyed on the tick
  // alone would hide an actor added after it for the rest of that tick.
  if (!cache || cache.tick !== state.tick || cache.playerCount !== state.players.length || cache.enemyCount !== state.enemies.length) {
    cache = {
      tick: state.tick,
      playerCount: state.players.length,
      enemyCount: state.enemies.length,
      hostilePlayersByTeam: new Map(),
      hostileEnemiesByTeam: new Map(),
    };
    teamPoolCache.set(state, cache);
  }
  let players = cache.hostilePlayersByTeam.get(teamId);
  let enemies = cache.hostileEnemiesByTeam.get(teamId);
  if (!players || !enemies) {
    players = [];
    for (const p of state.players) if (isHostile({ teamId }, p)) players.push(p);
    enemies = [];
    for (const e of state.enemies) if (isHostile({ teamId }, e)) enemies.push(e);
    cache.hostilePlayersByTeam.set(teamId, players);
    cache.hostileEnemiesByTeam.set(teamId, enemies);
  }
  return { players, enemies };
}

/**
 * Every alive actor hostile to `self` that a hit/target query is allowed to
 * reach. In PvE co-op, downed players are excluded unconditionally — they are
 * invulnerable and untargetable regardless of who's asking (design/07, ROADMAP
 * 3.2) — so every caller gets that guarantee for free instead of repeating the
 * check. In PvP (`state.zoneEnabled`), design/05/15 leans the other way: a
 * downed player IS a valid target, same as anyone standing — the exclusion
 * only ever applied here in the first place.
 */
export function hostileTargets(state: GameState, self: Teamed): Actor[] {
  const { players, enemies } = getTeamPools(state, self.teamId);
  const out: Actor[] = [];
  for (const p of players) {
    if (p.alive && (state.zoneEnabled || !isDowned(p))) out.push(p);
  }
  for (const e of enemies) {
    if (e.alive) out.push(e);
  }
  return out;
}

/** Nearest hostile actor to a point, or null. Ties broken by array order
 * (players before enemies, then push order within each) — deterministic
 * (design/06). Used for a deflected bullet's new target and homing's turn. */
export function nearestHostile(state: GameState, self: Teamed, x: Fp, y: Fp): Actor | null {
  return nearestByPosition(x, y, hostileTargets(state, self));
}
