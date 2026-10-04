import { SKIN_DEFS, EMBER_DUNGEON, EMBER_L1_ROOMS, type EngineConfig, type MatchStart } from '@dd/engine';
import { buildPvpEngineConfig } from './pvpConfig';

// Ignored once `dungeon`/`arena` is set (each mode's own geometry defines the bounds) —
// mirrors the PLACEHOLDER_WORLD literal Game.ts uses for its own offline configs.
const PLACEHOLDER_WORLD = 800;

/**
 * Build the run config from `match_start`. MUST be byte-identical on every client
 * (determinism, design/06), so it derives ONLY from the shared seed + playerCount:
 * seats are skinned by index (distinct, agreed characters), and neither the local
 * chosen character nor the crafted loadout enters — carrying those into online play
 * needs them to travel through matchmaking first (a later step).
 *
 * `m.mode === 'pvp'` (design/15, ROADMAP Phase 4 closeout) branches to the arena
 * shape instead (buildPvpEngineConfig, shared with server/src/BotClient.ts) — setting
 * `arena` is what flips `state.zoneEnabled` and turns on ZoneSystem/EnvironmentSystem/
 * the placement win condition, AND (ENGINE_VERSION 20, ROADMAP 4.2c) what makes
 * `GameState.buildSeat` resolve each seat's weapons/HP through `buildArenaSpecs`
 * instead of the PvE run-builder path — no `loadout` needs setting here at all, since
 * an arena seat never reads it.
 */
export function buildOnlineConfig(m: MatchStart): EngineConfig {
  if (m.mode === 'pvp') return buildPvpEngineConfig(m.seed, m.playerCount);
  const ids = Object.keys(SKIN_DEFS);
  return {
    seed: m.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    // A bot's seat is flagged (ENGINE_VERSION 88) only when `match_start` names it, so a room of
    // people builds the same config it always did.
    players: Array.from({ length: m.playerCount }, (_, i) => ({ skinId: ids[i % ids.length]!, ...(m.botSeats?.includes(i) ? { bot: true } : {}) })),
    dungeon: { config: EMBER_DUNGEON, library: EMBER_L1_ROOMS },
  };
}
