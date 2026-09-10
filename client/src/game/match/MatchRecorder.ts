/**
 * Records the offline run in progress so a player can hand over a real repro.
 *
 * Why this exists: the engine has been able to replay a match since Stage E
 * (`@dd/engine/replay` — seed + config + input stream reconstructs every frame
 * bit-for-bit), and nothing in `client/` or `server/` ever called `toReplay`. So the
 * best a bug report could carry was a seed, and a seed is not a repro: where a monster
 * dies — and therefore where its loot lands — depends on where the player was standing,
 * which is the input stream. The recurring "无法拾取的掉落物" report is exactly that
 * shape (see design/18 and ROADMAP's v50 entry: the engine sweeps come back clean, so
 * the next round needs the actual moment, not another sweep).
 *
 * It costs nothing to leave on. `LocalInputSource` has always retained every command it
 * was handed — that is what `recorded()` is for — so an offline run is ALREADY holding
 * its own replay in memory; this class only keeps the config beside it and packs the
 * two together on demand. That is what makes the hotkey usable: the player does not
 * have to decide to record BEFORE hitting the bug.
 *
 * Online runs are deliberately not recorded here: their input arrives on a confirmed
 * stream through `NetInputSource`, so the authoritative record is the server's
 * (`FrameBroadcast`), not this one.
 */
import { LocalInputSource, packReplayFile, type EngineConfig, type PlayerCommand, type ReplayFile, type ReplayMark } from '@dd/engine';

export class MatchRecorder {
  private config: EngineConfig | null = null;
  private source: LocalInputSource | null = null;
  private label = '';
  private marks: ReplayMark[] = [];

  /**
   * Start recording a fresh offline run. Returns the `InputSource` to hand
   * `createGameEngine` — the caller MUST use it, since an engine built with the
   * factory default would record into a source this object cannot see.
   */
  begin(label: string, config: EngineConfig): LocalInputSource {
    this.config = config;
    this.label = label;
    this.marks = [];
    this.source = new LocalInputSource();
    return this.source;
  }

  /**
   * Re-open a run from its saved command stream (`runSave.ts`, ENGINE_VERSION 61) — same as
   * `begin`, with the recording pre-loaded so the source holds the WHOLE run rather than
   * only the part played after the resume.
   *
   * That matters twice over. `RunLifecycle.resumeSavedRun` drives the engine forward off this
   * source to reach the saved tick, so the stream has to be in it before the engine is built;
   * and because the live builder then keeps submitting into the same source, saving again
   * later writes one continuous stream rather than a fragment that only replays from the
   * middle. F9 gets the same benefit for free: a bug hit after a resume exports a repro that
   * starts at tick 1.
   */
  resume(label: string, config: EngineConfig, commands: readonly PlayerCommand[]): LocalInputSource {
    const source = this.begin(label, config);
    for (const cmd of commands) source.submit(cmd);
    return source;
  }

  /** The config the run being recorded was built from, or null when nothing is. Read by the
   *  save path, which fingerprints its content half and reads back the loadout the run
   *  STARTED with — the account's own copy is already spent by then (`beginRun`). */
  get runConfig(): EngineConfig | null {
    return this.config;
  }

  /** The stream so far, in deterministic order, or null when nothing is being recorded.
   *  `pack` above wraps the same thing in a replay FILE; the save path wants the bare
   *  stream, since it stores a rebuild descriptor instead of an embedded config. */
  recordedCommands(): PlayerCommand[] | null {
    return this.source?.recorded() ?? null;
  }

  /** Stop holding the finished run's stream (a new `begin` also drops it). */
  end(): void {
    this.config = null;
    this.source = null;
    this.marks = [];
  }

  get recording(): boolean {
    return this.source !== null;
  }

  /** Remember "it happened here". Ignored (false) when nothing is being recorded. */
  mark(tick: number, note: string): boolean {
    if (!this.source) return false;
    this.marks.push({ tick, note });
    return true;
  }

  /**
   * The recorded run as a file, or null when nothing is being recorded. `nowMs` is
   * injected rather than read from the clock here so the caller owns the one
   * wall-clock read (and tests are not time-dependent).
   */
  pack(tick: number, nowMs: number): ReplayFile | null {
    if (!this.config || !this.source) return null;
    return packReplayFile({
      config: this.config,
      commands: this.source.recorded(),
      ticks: tick,
      label: this.label,
      marks: this.marks,
      recordedAtMs: nowMs,
    });
  }
}
