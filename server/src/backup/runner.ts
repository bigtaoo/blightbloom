/**
 * One backup cycle, the status file it leaves behind, and the health verdict read back off
 * that file.
 *
 * The status file is the whole reason this worker is observable. It has no HTTP port and
 * nothing polls it, so without a written record the only evidence of a working backup is a
 * directory listing somebody would have to think to look at. `status.json` turns "are the
 * backups running" into a question `docker ps` answers — see `main.ts --health`.
 *
 * A cycle NEVER throws for a per-source failure: with two databases, one unreadable file
 * must not cost the other its backup. It records the failure, keeps going, and reports the
 * cycle as not-ok, which is what turns the container unhealthy.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupConfig } from './config';
import { prunable } from './prune';
import { snapshotDatabase } from './snapshot';

/** What one source did this cycle. */
export interface SourceResult {
  source: string;
  ok: boolean;
  /** Basename of the snapshot written, when `ok`. */
  file?: string;
  bytes?: number;
  rawBytes?: number;
  /** The failure's message, when not `ok`. Message only — a stack in a status file is
   *  noise, and the log line beside it carries the full error. */
  error?: string;
  /** Snapshots deleted after this source's cycle, by name. */
  pruned?: string[];
}

/** What the last cycle did, as written to `status.json`. */
export interface CycleResult {
  /** ISO timestamp of the cycle START. */
  at: string;
  /** True only when every source succeeded. */
  ok: boolean;
  sources: SourceResult[];
}

export const STATUS_FILE = 'status.json';

/** Injected by the tests; the real thing is the two functions this module would import. */
export interface CycleIo {
  snapshot: typeof snapshotDatabase;
  list: (dir: string) => string[];
  remove: (file: string) => void;
  log: (line: string) => void;
}

const realIo: CycleIo = {
  snapshot: snapshotDatabase,
  list: (dir) => readdirSync(dir),
  remove: (file) => rmSync(file, { force: true }),
  log: (line) => console.log(line),
};

/**
 * Snapshot every source once, then prune, then report.
 *
 * Pruning happens AFTER a successful snapshot of that source and only over that source's
 * own group (`prunable`), so a source that has been failing for a week keeps its last
 * good snapshots instead of ageing them out on schedule. That ordering is the difference
 * between a retention policy and a countdown to having nothing.
 */
export function runCycle(cfg: BackupConfig, at: Date, io: CycleIo = realIo): CycleResult {
  mkdirSync(cfg.destDir, { recursive: true });
  const sources: SourceResult[] = [];
  for (const source of cfg.sources) {
    try {
      const snap = io.snapshot(source, cfg.destDir, at);
      const pruned: string[] = [];
      for (const name of prunable(io.list(cfg.destDir), cfg.keep)) {
        // `prunable` groups by source itself; this loop only deletes names belonging to
        // the source just snapshotted, so one source's cycle never touches another's set.
        if (!name.startsWith(`${stemOf(source)}-`)) continue;
        io.remove(join(cfg.destDir, name));
        pruned.push(name);
      }
      io.log(`backup ok ${source} -> ${snap.file} (${snap.bytes} B gz, ${snap.rawBytes} B raw)${pruned.length ? `, pruned ${pruned.length}` : ''}`);
      sources.push({ source, ok: true, file: baseOf(snap.file), bytes: snap.bytes, rawBytes: snap.rawBytes, pruned });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.log(`backup FAILED ${source}: ${message}`);
      sources.push({ source, ok: false, error: message });
    }
  }
  return { at: at.toISOString(), ok: sources.every((s) => s.ok), sources };
}

function stemOf(source: string): string {
  return baseOf(source).replace(/\.[^.]*$/, '');
}

function baseOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Publish the cycle's result. Written via a temp file + rename so `--health` can never
 *  read a half-written JSON document and report a working backup as broken. */
export function writeStatus(destDir: string, result: CycleResult): void {
  const target = join(destDir, STATUS_FILE);
  const tmp = `${target}.part`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, target);
}

/** The last published cycle, or `null` when there is none (or it is unreadable). */
export function readStatus(destDir: string): CycleResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(destDir, STATUS_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const { at, ok, sources } = parsed as Partial<CycleResult>;
    if (typeof at !== 'string' || typeof ok !== 'boolean' || !Array.isArray(sources)) return null;
    return { at, ok, sources };
  } catch {
    return null;
  }
}

/** Slack on top of the interval before a missed cycle counts as unhealthy. A restart, a
 *  slow gzip and a clock nudge all cost seconds; this is generous on purpose, because the
 *  alarm this raises should mean "backups have stopped", not "one cycle ran late". */
export const HEALTH_SLACK_MS = 30 * 60_000;

/**
 * Is the last published cycle good enough to call this container healthy?
 *
 * Three ways to be unhealthy, and the third is the one worth having: no status at all, a
 * cycle where some source failed, or a status that is simply too OLD — a worker whose loop
 * died after one good cycle would otherwise stay green forever on a stale success.
 */
export function isHealthy(status: CycleResult | null, now: Date, intervalMs: number): boolean {
  if (status === null || !status.ok) return false;
  const at = Date.parse(status.at);
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  // A status from the future means a clock changed under us; treat it as fresh rather than
  // flapping the container on something a backup cannot fix.
  return age <= intervalMs + HEALTH_SLACK_MS;
}
