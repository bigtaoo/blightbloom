/**
 * Voice demand under real play — the measurement design/11's "Voice-count budget" item left
 * open. Run it with:
 *
 *     npm run test:voice-sim          (repo root, or -w client)
 *
 * It plays headless PvE runs of the shipped level 1 (the PvE bot, careful and aggressive,
 * solo and co-op, and unkillable so the boss floor is reached) and bot-vs-bot PvP matches at
 * 2, 4 and 8 seats. It records the cues the real `EventReactor` plays for one seat, and
 * replays them through the real `VoiceBudget` at a ladder of caps (`sim/audio/voiceDemand.ts`).
 * It prints, per mode, how many voices the mix actually reached and what each cap cost, and
 * gates that the shipped cap (`CueMixer.DEFAULT_CAP`) costs real play almost nothing.
 *
 * What it cannot say is what a phone can afford — that is a device measurement and is still
 * open. It answers the other half: how many voices real play asks for, and which cues pay
 * when it asks for more than the cap.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine, Prng, type GameState } from '@dd/engine';
import { buildDungeonRunConfig } from '../src/game/match/offlineConfig';
import { buildPvpEngineConfig } from '../src/game/match/pvpConfig';
import { PvpBotController } from '../src/game/controllers/PvpBotController';
import { BOT_PROFILES, PveBotController } from './pve/PveBotController';
import { CueLog, replayBudget, shippedDurations, type BudgetReport, type CueEvent } from './audio/voiceDemand';
import { DEFAULT_CAP } from '../src/audio/CueMixer';
import { CUE_CATALOGUE } from '../src/audio/cueCatalogue';
import type { AudioCue } from '../src/platform/types';

const PVE_SEEDS = Array.from({ length: 40 }, (_, i) => 101 + i * 101);
const PVP_SEEDS = Array.from({ length: 10 }, (_, i) => 7 + i * 13);
const PVP_SEATS = [2, 4, 8];
const CAPS = [4, 6, 8, 10, 12, 16, 17, 18, 20, 24];
/** Big enough never to bind: what the mix would reach with no cap at all. */
const UNCAPPED = 1000;

/**
 * @param unkillable pins every seat's hp to max each tick, so the run reaches the deep floors
 * and the boss — the densest fights in the level, which a mortal bot seldom sees (it averages
 * under floor 1). The same trick `tools/perf/accept.mjs` uses for a long browser run.
 */
function pveLog(seed: number, profile: keyof typeof BOT_PROFILES, coop: boolean, unkillable = false): CueEvent[] {
  const engine = createGameEngine(
    buildDungeonRunConfig({
      seed,
      coop,
      localSeat: { skinId: 'vanguard', loadout: [] },
      allySkinId: 'juggernaut',
    }),
  );
  const bots = Array.from({ length: coop ? 2 : 1 }, () => new PveBotController(BOT_PROFILES[profile]));
  const log = new CueLog();
  for (let t = 0; t < 40_000 && engine.state.phase !== 'gameover'; t++) {
    const next = engine.state.tick + 1;
    engine.step(bots.map((b, seat) => b.build(engine.state, seat, next)));
    if (unkillable) for (const p of engine.state.players) p.hp = p.maxHp;
    log.observe(engine.state as GameState);
  }
  return log.events;
}

/**
 * A bot-vs-bot match is the same match for every seed: the arena is fixed and the bots are
 * deterministic, so without this the ten "matches" per seat count were one match ten times.
 * The same deconfounding `pvpBalanceSim.sim.ts` uses: shuffle which skin (and so which
 * loadout) sits on which seat, off a Prng stream no gameplay system reads. The listening
 * seat rotates too, since what a seat hears depends on where it stands.
 */
function pvpLog(seed: number, seats: number): CueEvent[] {
  const config = buildPvpEngineConfig(seed, seats);
  const skins = config.players!.map((p) => p.skinId);
  new Prng(seed ^ 0x5eed0001).shuffle(skins);
  const engine = createGameEngine({ ...config, players: config.players!.map((p, i) => ({ ...p, skinId: skins[i]! })) });
  const bots = Array.from({ length: seats }, () => new PvpBotController());
  const log = new CueLog(seed % seats);
  for (let t = 0; t < 20_000 && engine.state.phase !== 'gameover'; t++) {
    const next = engine.state.tick + 1;
    engine.step(bots.map((b, seat) => b.build(engine.state, seat, next)));
    log.observe(engine.state as GameState);
  }
  return log.events;
}

const durations = shippedDurations();
const pct = (n: number, d: number): string => (d === 0 ? '-' : `${((100 * n) / d).toFixed(2)}%`);

function totals(r: BudgetReport) {
  let played = 0;
  let refused = 0;
  let stolen = 0;
  let cut = 0;
  for (const c of r.byCue.values()) {
    played += c.played;
    refused += c.refused;
    stolen += c.stolen;
    cut += c.cutSeconds;
  }
  return { played, refused, stolen, cut, asked: played + refused };
}

function ladderTable(label: string, logs: CueEvent[][]): string {
  const rows = [`\n${label}: ${logs.length} matches, ${logs.reduce((n, l) => n + l.length, 0)} cues`];
  const free = replayBudget(logs, durations, UNCAPPED);
  rows.push(`  uncapped: peak ${free.heldPeak} voices, p99 ${free.heldP99}`);
  rows.push('  cap | peak | p99 | refused (n) | stolen (n) | cut s');
  for (const cap of CAPS) {
    const r = replayBudget(logs, durations, cap);
    const t = totals(r);
    rows.push(
      `  ${String(cap).padStart(3)} | ${String(r.heldPeak).padStart(4)} | ${String(r.heldP99).padStart(3)} | ` +
        `${`${pct(t.refused, t.asked)} (${t.refused})`.padStart(11)} | ${`${pct(t.stolen, t.asked)} (${t.stolen})`.padStart(10)} | ${t.cut.toFixed(1)}`,
    );
  }
  return rows.join('\n');
}

function cueTable(label: string, logs: CueEvent[][], cap: number): string {
  const r = replayBudget(logs, durations, cap);
  const rows = [`\n${label} at cap ${cap}, by cue (priority, asked, refused, stolen, cut s)`];
  const cues = [...r.byCue.entries()].sort((a, b) => CUE_CATALOGUE[b[0]].priority - CUE_CATALOGUE[a[0]].priority);
  for (const [cue, c] of cues) {
    const asked = c.played + c.refused;
    rows.push(
      `  ${cue.padEnd(16)} ${String(CUE_CATALOGUE[cue as AudioCue].priority).padStart(3)} ${String(asked).padStart(7)} ` +
        `${String(c.refused).padStart(6)} ${String(c.stolen).padStart(6)} ${c.cutSeconds.toFixed(1).padStart(7)}`,
    );
  }
  return rows.join('\n');
}

/** A cap may cost real play at most this share of its voices (refused + stolen). 0.1% until
 *  volume 116's PvP bot started fighting mobs: 8-seat PvP then lost 16 of 11,528 voices at the
 *  shipped cap (0.14%), every one a stolen `muzzle` and 0.9 s of audio in ten matches. The
 *  cues that matter are gated separately below, so the ceiling moved rather than the cap —
 *  cap 17 would pass at 0.09%, but with no margin and at the price of the saturation test in
 *  `audioPipeline.test.ts`. */
const MAX_LOSS = 0.0025;
/** No cue at or above `impact` may lose a voice to the cap in real play: those are the cues
 *  that say something happened to someone, where `muzzle`/`swing`/`clash` below it only
 *  texture a shot the player already sees. */
const PROTECTED_FROM = CUE_CATALOGUE.impact.priority;

function lossShare(r: BudgetReport): number {
  const t = totals(r);
  return (t.refused + t.stolen) / t.asked;
}

describe('voice demand under real play', () => {
  const modes: [string, CueEvent[][]][] = [];

  it('records PvE and PvP matches', () => {
    modes.push(['PvE careful', PVE_SEEDS.map((s) => pveLog(s, 'careful', false))]);
    modes.push(['PvE aggressive', PVE_SEEDS.map((s) => pveLog(s, 'aggressive', false))]);
    modes.push(['PvE co-op, careful', PVE_SEEDS.map((s) => pveLog(s, 'careful', true))]);
    modes.push(['PvE careful, unkillable', PVE_SEEDS.map((s) => pveLog(s, 'careful', false, true))]);
    modes.push(['PvE co-op, unkillable', PVE_SEEDS.map((s) => pveLog(s, 'careful', true, true))]);
    for (const seats of PVP_SEATS) modes.push([`PvP ${seats} seats`, PVP_SEEDS.map((s) => pvpLog(s, seats))]);
    for (const [, logs] of modes) expect(logs.every((l) => l.length > 0)).toBe(true);
  });

  it('reports what each cap costs', () => {
    for (const [label, logs] of modes) {
      console.log(ladderTable(label, logs));
      console.log(cueTable(label, logs, DEFAULT_CAP));
    }
  });

  it(`gate: the shipped cap costs real play at most ${MAX_LOSS * 100}% of its voices`, () => {
    for (const [label, logs] of modes) {
      expect(lossShare(replayBudget(logs, durations, DEFAULT_CAP)), label).toBeLessThanOrEqual(MAX_LOSS);
    }
  });

  it('gate: at the shipped cap, no cue from impact up loses a voice', () => {
    for (const [label, logs] of modes) {
      for (const [cue, c] of replayBudget(logs, durations, DEFAULT_CAP).byCue) {
        if (CUE_CATALOGUE[cue].priority < PROTECTED_FROM) continue;
        expect(c.refused + c.stolen, `${label}: ${cue}`).toBe(0);
      }
    }
  });

  it('the gates can fail: a cap of 4 breaks both', () => {
    // Without this, a recorder that lost its cues (or a replay that stopped binding) would
    // pass both gates above with nothing measured.
    const all = modes.flatMap(([, logs]) => logs);
    const tight = replayBudget(all, durations, 4);
    expect(lossShare(tight)).toBeGreaterThan(MAX_LOSS);
    const hurtOrAbove = [...tight.byCue].filter(([cue, c]) => CUE_CATALOGUE[cue].priority >= PROTECTED_FROM && c.refused + c.stolen > 0);
    expect(hurtOrAbove.length).toBeGreaterThan(0);
  });
});
