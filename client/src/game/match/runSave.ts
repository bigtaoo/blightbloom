/**
 * Save-and-continue for an unfinished single-player run (design/05 "Only the boss floor
 * ends a run", ENGINE_VERSION 61).
 *
 * ## What a save actually is, and why that is all it is
 *
 * A seed, a command stream, and an `ENGINE_VERSION`. Nothing else — no positions, no HP, no
 * room state. That is not a shortcut, it is the same property `design/08` already builds the
 * whole replay system on: a fresh engine on the same seed, fed the same inputs, reconstructs
 * every frame bit-for-bit. So "resume" is "replay the recording, then keep playing" —
 * `RunLifecycle.resumeSavedRun` advances a fresh engine through the saved stream and hands
 * the same `LocalInputSource` back to the live command builder, which appends to it.
 *
 * The upshot is that a save cannot desync from the sim, because there is no second
 * description of the sim to disagree with it. A snapshot format would have needed one field
 * per piece of engine state and would have gone stale on every version that added a field —
 * silently, since a missing field reads as a default rather than as an error.
 *
 * ## The two things that CAN invalidate one, and how each is caught
 *
 *  1. **The sim's arithmetic changed.** `engineVersion` is compared on load and a mismatch
 *     refuses the save outright (`checkResumable`), the same "fail loud, never replay garbage"
 *     rule `ReplayInputSource` enforces for recordings. Without it a stream recorded before a
 *     retune replays into a different world and the player is returned to a run that is
 *     subtly not theirs.
 *  2. **The CONTENT changed.** This is the hole `ENGINE_VERSION` does not cover and
 *     `replayFile.ts` avoids by embedding the whole `EngineConfig` in the file. A save cannot
 *     afford that: the dungeon library is the bulk of the config, and a save is written to
 *     `localStorage` next to the account, not handed to a developer. So the config is REBUILT
 *     from today's content on resume and only its content half is fingerprinted
 *     (`contentHash`) — a floor's geometry moving under a save is then a refusal, not a
 *     player spawned inside a wall.
 *
 * ## Mutation battery — what these tests are MEASURED to catch
 *
 * Recorded 2026-09-10, 21 mutants across this module, `runSaveStore.ts`, `RunLifecycle`,
 * `RunOutcome`, `PortalPrompt`, `PauseMenu` and `Forge`, run against the 387 tests in
 * `src/game/match/**` plus the six affected controller/screen suites. **All 21 killed** — but
 * one of them only after the test it should have failed was fixed, and that one is the reason
 * this block exists rather than a claim that the suite is fine:
 *
 *   SURVIVED -> KILLED  `resumeSavedRun` stops clearing the fast-forward's stale events
 *
 * The assertion was `expect(state.events).toEqual([])` on a save taken at tick 5 — and tick 5
 * of that seed emits nothing at all, so it passed with `clearEvents()` deleted. It now saves at
 * tick 2 (the first tick that emits: `room_enter`, `door_locked`) and advances a reference
 * engine to prove tick 2 still emits, so the test cannot go vacuous again without saying so.
 * A re-drained `room_enter` rebuilds the room geometry, so the mutant was a real bug wearing a
 * green test.
 *
 * The other 20, grouped: both refusals dropped independently (2 kills each); each `savableRun`
 * exclusion dropped one at a time; the parser's brad range check; the store cache left stale
 * past a clear (10 failures — the widest blast radius, which is what a shared memo should
 * have); all three save-dropping call sites; the portal's one-button rule in both directions
 * and its carry-out total; and the three LAYOUT mutants that stack two buttons in one slot,
 * which are the ones a human would never notice reading a diff.
 *
 * Re-run it after changing any of this. A gate whose kills are assumed rather than measured is
 * the failure mode a green suite is best at hiding.
 *
 * ## Why the commands are tuples rather than objects
 *
 * A `PlayerCommand` serialized as JSON with its keys is ~110 bytes, and the sim runs at
 * 30 Hz, so a ten-minute run is ~2 MB against a `localStorage` budget of about 5 MB for the
 * whole origin — which the account save shares. The fixed-order tuple below is ~22 bytes,
 * which puts the same run at ~400 KB. A quota failure is still possible on a very long run
 * and is reported rather than swallowed (`runSaveStore.ts`'s `writeSavedRun` returns false),
 * because the one unacceptable outcome is telling a player their run was saved when it was
 * not.
 */
import { ENGINE_VERSION, type EngineConfig, type PlayerCommand } from '@dd/engine';
import type { Brad } from '@dd/engine/math/trig';
import { BRAD_FULL } from '@dd/engine/math/trig';

/** Bumped only for a BREAKING change to the shape below; unrelated to `ENGINE_VERSION`. A
 *  save written by a different reader is discarded rather than guessed at. */
export const RUN_SAVE_VERSION = 1;

/** `[tick, owner, moveBrad, moveMag, buttons, pickupTargetId, cardVote]` — see the header
 *  for why the stream is stored positionally. */
type PackedCommand = readonly [number, number, number, number, number, number, number];

/** An unfinished run, as it sits in storage. */
export interface SavedRun {
  saveVersion: number;
  /** `ENGINE_VERSION` at save time — the version compare on re-entry. */
  engineVersion: number;
  /** Fingerprint of the run config's CONTENT half (`EngineConfig.dungeon`), so a level
   *  edited between sessions refuses the save instead of diverging. */
  contentHash: number;
  seed: number;
  skinId: string;
  /** The loadout the run STARTED with. Read back from the run's own config rather than from
   *  the account, because `RunLifecycle.beginRun` spends the crafted loadout the moment the
   *  run begins — by save time the account's copy is empty. */
  loadout: string[];
  commands: PackedCommand[];
  /** Ticks the run had advanced. The resume replays exactly this many. */
  ticks: number;
  /** Which floor the player was on, 0-based. Display only — the sim re-derives it. */
  floorIndex: number;
  /** Render-side score (`RunState.score`), which the sim does not hold and therefore cannot
   *  reconstruct: it is accumulated from events as they stream past. Carried here so a
   *  resumed run's result screen reports the whole run rather than only its second half. */
  score: number;
  savedAtMs: number;
}

/** What the Forge needs to offer a CONTINUE button, without parsing a command stream. */
export interface SavedRunSummary {
  floorIndex: number;
  ticks: number;
  savedAtMs: number;
}

export interface RunSaveStore {
  load(): unknown;
  save(value: SavedRun): boolean;
  clear(): void;
}

/**
 * 32-bit FNV-1a — the same construction `replay.ts hashState` uses, deliberately reimplemented
 * here rather than imported: that one is part of the determinism contract and hashes
 * `ENGINE_VERSION` into its input, which is exactly wrong for a fingerprint that has to stay
 * comparable across a version bump. This one is a plain string digest with no contract.
 */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The CONTENT half of a run config — the part that can change under a save without
 *  `ENGINE_VERSION` noticing. `{}` for a config with no dungeon, which still fingerprints
 *  consistently rather than throwing. */
export function contentHashOf(config: EngineConfig): number {
  return fnv1a(JSON.stringify(config.dungeon ?? {}));
}

/**
 * Whether the run in progress may be saved at all.
 *
 * Single-player, offline, real dungeon runs only, and each exclusion is a rule rather than
 * caution. An ONLINE run's authoritative stream is the server's, not this client's
 * (`MatchRecorder`'s own header), so there is nothing here to save. A CO-OP run's second seat
 * is generated by the bot ally at submit time and is not in the recorded stream, so replaying
 * the stream alone would not reproduce it. The TUTORIAL is a fixed flat level whose quit
 * button already means "skip", and the arena/replay harnesses are not runs.
 */
export function savableRun(flags: {
  playing: boolean;
  online: boolean;
  coop: boolean;
  tutorial: boolean;
  arenaDemo: boolean;
  watchingReplay: boolean;
  dungeon: boolean;
}): boolean {
  return flags.playing && flags.dungeon
    && !flags.online && !flags.coop && !flags.tutorial && !flags.arenaDemo && !flags.watchingReplay;
}

/** Build a save from the live run's own config + recorded stream. */
export function packRunSave(opts: {
  config: EngineConfig;
  commands: readonly PlayerCommand[];
  ticks: number;
  floorIndex: number;
  score: number;
  nowMs: number;
}): SavedRun {
  return {
    saveVersion: RUN_SAVE_VERSION,
    engineVersion: ENGINE_VERSION,
    contentHash: contentHashOf(opts.config),
    seed: opts.config.seed,
    skinId: opts.config.skinId ?? '',
    loadout: [...(opts.config.loadout ?? [])],
    commands: opts.commands.map(
      (c) => [c.tick, c.owner, c.moveBrad as number, c.moveMag, c.buttons, c.pickupTargetId, c.cardVote] as const,
    ),
    ticks: opts.ticks,
    floorIndex: opts.floorIndex,
    score: opts.score,
    savedAtMs: opts.nowMs,
  };
}

/**
 * Validate an untrusted parsed value into a `SavedRun`, or return null.
 *
 * Strict about the command stream for the reason `parseReplayFile` is: a stream with a bad
 * tick or an out-of-range brad does not fail, it REPLAYS WRONG, which is the one outcome
 * design/08 forbids. Unlike that parser this one returns null instead of throwing — a
 * corrupt entry in a player's own storage is a "no save here", not an error to surface.
 */
export function parseRunSave(value: unknown): SavedRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.saveVersion !== RUN_SAVE_VERSION) return null;
  if (!isInt(o.engineVersion) || !isInt(o.contentHash) || !isInt(o.seed)) return null;
  if (!isInt(o.ticks) || o.ticks < 0) return null;
  if (!isInt(o.floorIndex) || o.floorIndex < 0) return null;
  if (typeof o.skinId !== 'string') return null;
  if (!Array.isArray(o.commands)) return null;

  const commands: PackedCommand[] = [];
  for (const entry of o.commands) {
    const packed = asPackedCommand(entry);
    if (!packed) return null;
    commands.push(packed);
  }
  return {
    saveVersion: RUN_SAVE_VERSION,
    engineVersion: o.engineVersion,
    contentHash: o.contentHash,
    seed: o.seed,
    skinId: o.skinId,
    loadout: Array.isArray(o.loadout) ? o.loadout.filter((x): x is string => typeof x === 'string') : [],
    commands,
    ticks: o.ticks,
    floorIndex: o.floorIndex,
    score: isInt(o.score) && o.score >= 0 ? o.score : 0,
    savedAtMs: isInt(o.savedAtMs) ? o.savedAtMs : 0,
  };
}

/** Why a save cannot be resumed, when it cannot. */
export type RunSaveRefusal = 'engine-version' | 'content';

/**
 * The re-entry check: does this save still describe a run this build can reconstruct?
 * `config` is the run config rebuilt from TODAY's content for the save's own seed/loadout.
 */
export function checkResumable(save: SavedRun, config: EngineConfig): RunSaveRefusal | null {
  if (save.engineVersion !== ENGINE_VERSION) return 'engine-version';
  if (save.contentHash !== contentHashOf(config)) return 'content';
  return null;
}

/** The saved stream as real `PlayerCommand`s, in the order it was recorded. */
export function unpackCommands(save: SavedRun): PlayerCommand[] {
  return save.commands.map(([tick, owner, moveBrad, moveMag, buttons, pickupTargetId, cardVote]) => ({
    type: 'input' as const,
    owner,
    tick,
    moveBrad: moveBrad as unknown as Brad,
    moveMag,
    buttons,
    pickupTargetId,
    cardVote,
  }));
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function asPackedCommand(v: unknown): PackedCommand | null {
  if (!Array.isArray(v) || v.length !== 7) return null;
  for (const n of v) if (!isInt(n)) return null;
  const [tick, owner, moveBrad, moveMag, buttons, pickupTargetId, cardVote] = v as number[];
  if (tick! < 1 || owner! < 0) return null;
  // A brad is 0..BRAD_FULL-1 (math/trig). Range-checked here for the same reason
  // `parseReplayFile` checks it: this is where an untrusted number enters the branded world,
  // and an out-of-range angle indexes off the end of the sin/cos table rather than failing.
  if (moveBrad! < 0 || moveBrad! >= BRAD_FULL) return null;
  if (moveMag! < 0 || moveMag! > 255) return null;
  if (buttons! < 0 || pickupTargetId! < 0 || cardVote! < 0) return null;
  return [tick!, owner!, moveBrad!, moveMag!, buttons!, pickupTargetId!, cardVote!] as const;
}
