import { SKIN_DEFS, CHAPTERS, chapterIdOr, type EngineConfig, type MatchStart } from '@dd/engine';
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
 *
 * The PvE dungeon is the room's chapter (`m.chapterId`, narrowed with `chapterIdOr`: absent —
 * every pre-chapter server — or unknown both mean chapter 1). It is the catalog's own
 * `{config, library}` objects rather than copies, so a chapter-1 room builds exactly the
 * config it did before chapters existed.
 */
export function buildOnlineConfig(m: MatchStart): EngineConfig {
  if (m.mode === 'pvp') return buildPvpEngineConfig(m.seed, m.playerCount);
  const ids = Object.keys(SKIN_DEFS);
  const chapter = CHAPTERS[chapterIdOr(m.chapterId)];
  return {
    seed: m.seed,
    worldW: PLACEHOLDER_WORLD,
    worldH: PLACEHOLDER_WORLD,
    waves: [],
    // A bot's seat is flagged (ENGINE_VERSION 88) only when `match_start` names it, so a room of
    // people builds the same config it always did.
    players: Array.from({ length: m.playerCount }, (_, i) => ({ skinId: ids[i % ids.length]!, ...(m.botSeats?.includes(i) ? { bot: true } : {}) })),
    dungeon: { config: chapter.config, library: chapter.library },
  };
}
