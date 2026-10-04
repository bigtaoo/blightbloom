// The two sim-only deconfoundings every PvP balance sim plays its matches through, out of
// `pvpBalanceSim.sim.ts` so `pvpShieldRetreat.sim.ts` (volume 128) plays the same matches.
import { Prng, type EngineConfig } from '@dd/engine';

// SIM-ONLY deconfounding: `buildPvpEngineConfig` skins seats BY INDEX (seat i -> the
// i-th SKIN_DEFS entry) — a real, load-bearing property of the real match config
// (design/15: spawns are system-assigned, no player choice), so this must NOT change
// `pvpConfig.ts` itself. But that seat-index-is-character correlation means any
// seat/spawn-position advantage silently reads as a character-balance signal in this
// sim's win-rate report. Reusing `buildPvpEngineConfig` for the byte-identical base
// config, then shuffling ONLY here which skinId lands on which seat (a distinct Prng
// stream, seeded off the match seed but never touching a gameplay stream — same
// isolation rule design/15's `integrityPrng` uses) breaks that correlation: over many
// seeds, every character lands on every seat/spawn roughly equally, so a persistent
// win-rate skew can no longer be explained by spawn position alone.
export function deconfoundSkinSeating(config: EngineConfig, seed: number): EngineConfig {
  const players = config.players!;
  const skinIds = players.map((p) => p.skinId);
  new Prng(seed ^ 0x5eed0001).shuffle(skinIds);
  return {
    ...config,
    players: players.map((p, i) => ({ ...p, skinId: skinIds[i]! })),
  };
}

// SIM-ONLY deconfounding, the second one: per-seat reaction offsets at the drop. The arena is
// one fixed map and `PvpBotController` is a pure function of state, so a seed only changes a
// match through what it seeds. Measured 2026-09-29 (volume 114), when every seat still spawned
// on one shared point, 30 seeds replayed only 12 (2 seats), 16, 22, 21, 23 and 9 (8 seats)
// distinct matches. Each seat stands idle for 0..MAX_START_DELAY ticks off its own Prng stream
// (never a gameplay one), which is also closer to real play: nobody moves on the first tick.
// Since seats spawn at their own authored points (volume 115, `assignArenaStarts`) the seeded
// spawn shuffle does most of this work (27-30 distinct with the offsets off); the offsets stay
// as the second source. `pvpBalanceSim.sim.ts`'s distinct-match gate holds the result. Its control used to pin the spawns
// and drop the offsets; once the bot fought mobs and walked round solids (volume 116), those
// matches diverged on the skin shuffle and the loot rolls alone (23 distinct), so the control is
// now the defect the gate exists for, a seed that changes nothing.
export const MAX_START_DELAY = 45;

export function startDelays(seed: number, playerCount: number, maxDelay: number): number[] {
  const prng = new Prng(seed ^ 0x0de1a7ed);
  return Array.from({ length: playerCount }, () => prng.nextInt(maxDelay + 1));
}
