/**
 * The on-disk replay envelope: a recorded match as a single JSON file (design/06/08).
 *
 * `replay.ts` already had everything needed to RE-RUN a match — a Replay is
 * seed + config + input stream, and `runReplay` reconstructs it bit-for-bit. What it
 * never had was a way to get one OUT of a live session: nothing in `client/` or
 * `server/` referenced `toReplay`, so a player who hit a bug could hand over a seed
 * and nothing else. A seed is not a repro. Every position in a run — including where
 * a monster dies, and therefore where its loot lands — is a function of the input
 * stream, so the stream is the only thing that reproduces a report.
 *
 * This module is the file format around that stream, and it lives in the engine (not
 * the client) for one reason: the writer is the client and the reader is a headless
 * harness, and a format with two independent parsers is a format that drifts. It is
 * pure data — no DOM, no fs — so the engine stays host-free (see engine/README.md).
 *
 * The whole `EngineConfig` is embedded rather than a "how to rebuild it" descriptor
 * (mode + seed + arena id). That costs file size and buys the thing this format
 * exists for: the geometry in the file IS the geometry the run had. A descriptor
 * would rebuild the world from today's content, and "the level changed under the
 * repro" is precisely the class of confusion a bug report cannot afford. Content is
 * not covered by ENGINE_VERSION, so nothing else would catch it.
 */
import { ENGINE_VERSION } from './config';
import type { Replay } from './replay';
import type { EngineConfig } from './state/GameState';
import type { PlayerCommand } from './state/commands';
import { BRAD_FULL, type Brad } from './math/trig';

/** Bumped only for a BREAKING envelope change; unrelated to ENGINE_VERSION. */
export const REPLAY_FILE_VERSION = 1;

/** Magic string, so a truncated/foreign JSON fails on identity instead of on a field.
 *  Deliberately NOT renamed with the game (DayDayUp -> Blightbloom, 2026-09-06): this is
 *  matched against bytes on disk, so changing it would reject every replay a player has
 *  already saved. The human-readable half of that read did move — see the throw below. */
export const REPLAY_FILE_KIND = 'daydayup.replay';

/**
 * A moment the recorder was asked to remember — "it happened HERE". The reason the
 * format has marks at all: a bug report is a tick, not a run, and the person who saw
 * it is the only one who knows which tick. `note` is free text (a dev hotkey supplies
 * a fixed one today) and is never interpreted by any tool.
 */
export interface ReplayMark {
  tick: number;
  note: string;
}

export interface ReplayFile {
  kind: typeof REPLAY_FILE_KIND;
  fileVersion: number;
  /** ENGINE_VERSION at record time. Duplicated from `replay.version` deliberately —
   *  it is the first thing a human reads, and parse checks the two agree. */
  engineVersion: number;
  /** Wall clock at export, milliseconds. Metadata only: nothing in the sim reads it,
   *  and it must never reach a system (design/06 — no wall-clock in the sim). */
  recordedAtMs: number;
  /** Which client path built the config ('dungeon', 'arenaDemo', 'tutorial', …).
   *  Human orientation only; the config itself is authoritative. */
  label: string;
  /** Ticks the run actually advanced, for a reader that wants a maxTicks. */
  ticks: number;
  marks: ReplayMark[];
  /** Exactly what `runReplay()` consumes. */
  replay: Replay;
}

export function packReplayFile(opts: {
  config: EngineConfig;
  commands: readonly PlayerCommand[];
  ticks: number;
  label: string;
  marks?: readonly ReplayMark[];
  recordedAtMs: number;
}): ReplayFile {
  return {
    kind: REPLAY_FILE_KIND,
    fileVersion: REPLAY_FILE_VERSION,
    engineVersion: ENGINE_VERSION,
    recordedAtMs: opts.recordedAtMs,
    label: opts.label,
    ticks: opts.ticks,
    marks: (opts.marks ?? []).map((m) => ({ tick: m.tick, note: m.note })),
    replay: {
      version: ENGINE_VERSION,
      config: opts.config,
      commands: opts.commands.map((c) => ({ ...c })),
    },
  };
}

/**
 * Validate an untrusted parsed-JSON value into a ReplayFile, or throw. Deliberately
 * strict about the command stream: a stream with a bad `tick` replays as garbage
 * rather than failing, which is the one outcome design/08 forbids ("fail loud, never
 * replay garbage"). Deliberately NOT strict about ENGINE_VERSION — reading an old
 * file's metadata is legitimate, and `ReplayInputSource` refuses to REPLAY it.
 */
export function parseReplayFile(value: unknown): ReplayFile {
  const o = asObject(value, 'replay file');
  if (o.kind !== REPLAY_FILE_KIND) {
    throw new Error(`Not a Blightbloom replay (kind=${JSON.stringify(o.kind)}, want "${REPLAY_FILE_KIND}").`);
  }
  const fileVersion = asInt(o.fileVersion, 'fileVersion');
  if (fileVersion !== REPLAY_FILE_VERSION) {
    throw new Error(`Replay file version ${fileVersion} != reader ${REPLAY_FILE_VERSION}; refusing to guess.`);
  }
  const engineVersion = asInt(o.engineVersion, 'engineVersion');
  const replay = asObject(o.replay, 'replay');
  const replayVersion = asInt(replay.version, 'replay.version');
  if (replayVersion !== engineVersion) {
    throw new Error(`Replay file disagrees with itself: engineVersion ${engineVersion} vs replay.version ${replayVersion}.`);
  }
  const config = asObject(replay.config, 'replay.config');
  if (typeof config.seed !== 'number') throw new Error('replay.config.seed is not a number.');
  if (!Array.isArray(replay.commands)) throw new Error('replay.commands is not an array.');
  const commands = replay.commands.map((c, i) => asCommand(c, i));

  return {
    kind: REPLAY_FILE_KIND,
    fileVersion,
    engineVersion,
    recordedAtMs: typeof o.recordedAtMs === 'number' ? o.recordedAtMs : 0,
    label: typeof o.label === 'string' ? o.label : '',
    ticks: typeof o.ticks === 'number' ? o.ticks : lastTick(commands),
    marks: Array.isArray(o.marks) ? o.marks.map((m, i) => asMark(m, i)) : [],
    replay: { version: replayVersion, config: config as unknown as EngineConfig, commands },
  };
}

/** Parse from text — the shape both the download and the harness actually deal in. */
export function parseReplayFileText(text: string): ReplayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Replay file is not valid JSON: ${(e as Error).message}`);
  }
  return parseReplayFile(parsed);
}

/** A stable, human-typeable file name. No wall-clock formatting: a timestamp string
 *  would be locale- and timezone-dependent, and the ms value is already in the file. */
export function replayFileName(label: string, recordedAtMs: number): string {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '') || 'run';
  return `ddreplay-${safe}-${recordedAtMs}.json`;
}

function lastTick(commands: readonly PlayerCommand[]): number {
  let max = 0;
  for (const c of commands) if (c.tick > max) max = c.tick;
  return max;
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not an object.`);
  return v as Record<string, unknown>;
}

function asInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${what} is not an integer.`);
  return v;
}

function asMark(v: unknown, i: number): ReplayMark {
  const o = asObject(v, `marks[${i}]`);
  return { tick: asInt(o.tick, `marks[${i}].tick`), note: typeof o.note === 'string' ? o.note : '' };
}

/** A brad is 0..BRAD_FULL-1 (math/trig); anything else is a corrupt stream. */
function asBrad(v: unknown, what: string): Brad {
  const n = asInt(v, what);
  if (n < 0 || n >= BRAD_FULL) throw new Error(`${what} is not a brad (0..${BRAD_FULL - 1}): ${n}`);
  return n as unknown as Brad;
}

function asCommand(v: unknown, i: number): PlayerCommand {
  const o = asObject(v, `replay.commands[${i}]`);
  if (o.type !== 'input') throw new Error(`replay.commands[${i}].type is not "input".`);
  return {
    type: 'input',
    owner: asInt(o.owner, `replay.commands[${i}].owner`),
    tick: asInt(o.tick, `replay.commands[${i}].tick`),
    // `Brad` is a branded number (math/trig) — the brand exists to stop a raw angle
    // being passed where a quantized one belongs, and a parser reading untrusted JSON
    // is exactly where the value enters the branded world. Range-checked, then cast.
    moveBrad: asBrad(o.moveBrad, `replay.commands[${i}].moveBrad`),
    moveMag: asInt(o.moveMag, `replay.commands[${i}].moveMag`),
    buttons: asInt(o.buttons, `replay.commands[${i}].buttons`),
    pickupTargetId: asInt(o.pickupTargetId, `replay.commands[${i}].pickupTargetId`),
    cardVote: asInt(o.cardVote, `replay.commands[${i}].cardVote`),
  };
}
