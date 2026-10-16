// The open funnel (design/21 §2.9): of the pages that OPENED on a day, how many booted, reached
// the menu and started a run. An independent function module beside `newInstalls.ts`; the
// rollup calls in, nothing here calls back.
//
// ## Counted per VISIT, from the beacon
//
// `page_open` is sent by `index.html` before the bundle is requested, under the session id the
// game's own events later carry (`analyticsInstall.ts` takes it over). So every step here is
// "visits whose session also has X", and the first step is the one no other number has: the
// visitor who left while the game was still downloading. That gap is what a portal's
// "conversion to gameplay" punishes, and it was invisible before — everybody the analytics
// could see had already booted.
//
// It is per visit rather than per install on purpose: a first-time visitor who bounces has no
// install id yet (the beacon uses its visit id in its place), so an install-keyed funnel would
// lose exactly the rows it exists for.
//
// ## Boot time
//
// `session_start.boot_ms` is measured from the beacon's own clock, so it includes downloading
// the bundle — the wait a player sat through. Only visits that booted have one; the visits
// that gave up are the funnel's first gap, not a long boot time.
import type { Db } from 'mongodb';
import { eventsOf } from './db';
import { ALL_HOSTS } from './newInstallQueries';
import { addDays } from './rollupKeys';

export const OPEN_STEPS = ['open', 'boot', 'menu', 'run_start'] as const;
export type OpenStep = (typeof OPEN_STEPS)[number];

/** The `dailyRollup` metric names this module writes. */
export const OPEN_METRICS = {
  funnel: 'open_funnel',
  /** Boot time over the visits that booted, at {@link BOOT_QUANTILES}. */
  bootMs: 'open_boot_ms',
} as const;

export const BOOT_QUANTILES = { p50: 0.5, p90: 0.9 } as const;

/** One visit's progress, as far as the record shows. */
interface OpenVisit {
  host: string;
  boot: boolean;
  menu: boolean;
  run_start: boolean;
  bootMs: number | null;
}

/** The nearest-rank quantile of a non-empty sorted list. */
export function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * Every visit that sent `page_open` on `day`, with what its session went on to do. The
 * follow-on events are read on `day` AND the day after — a page opened at 23:59 that booted at
 * 00:01 booted — so the read stays on the `events_day_name` index (`session` has none).
 */
export async function openVisits(db: Db, day: string): Promise<Map<string, OpenVisit>> {
  const opens = await eventsOf(db)
    .aggregate<{ _id: string; host: string }>([
      { $match: { day, name: 'page_open' } },
      { $group: { _id: '$session', host: { $first: '$host' } } },
    ])
    .toArray();
  const out = new Map<string, OpenVisit>(opens.map((o) => [o._id, { host: o.host, boot: false, menu: false, run_start: false, bootMs: null }]));
  if (out.size === 0) return out;
  const later = await eventsOf(db)
    .find(
      {
        day: { $in: [day, addDays(day, 1)] },
        name: { $in: ['session_start', 'screen_view', 'run_start'] },
        session: { $in: [...out.keys()] },
      },
      { projection: { _id: 0, session: 1, name: 1, props: 1 } },
    )
    .toArray();
  for (const e of later) {
    const v = out.get(e.session) as OpenVisit;
    if (e.name === 'session_start') {
      v.boot = true;
      const ms = e.props?.boot_ms;
      if (typeof ms === 'number' && v.bootMs === null) v.bootMs = ms;
    } else if (e.name === 'screen_view') {
      if (e.props?.screen === 'menu') v.menu = true;
    } else {
      v.run_start = true;
    }
  }
  return out;
}

/**
 * The open-funnel rows for one day: per host (`all` first, then every host that had an open),
 * each step's visit count, and the boot-time quantiles where any visit booted with one. Steps
 * are counted independently, like the first-day funnel's, so an instrument gap shows as a
 * step exceeding the one before it rather than being hidden.
 */
export function openFunnelNumbers(visits: Map<string, OpenVisit>): { metric: string; labels: Record<string, string>; value: number }[] {
  const hosts = [...new Set([...visits.values()].map((v) => v.host))].sort();
  const out: { metric: string; labels: Record<string, string>; value: number }[] = [];
  if (visits.size === 0) return out;
  for (const host of [ALL_HOSTS, ...hosts]) {
    const mine = [...visits.values()].filter((v) => host === ALL_HOSTS || v.host === host);
    for (const step of OPEN_STEPS) {
      const n = step === 'open' ? mine.length : mine.filter((v) => v[step]).length;
      out.push({ metric: OPEN_METRICS.funnel, labels: { host, step }, value: n });
    }
    const boots = mine.map((v) => v.bootMs).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    if (boots.length === 0) continue;
    for (const [q, at] of Object.entries(BOOT_QUANTILES)) {
      out.push({ metric: OPEN_METRICS.bootMs, labels: { host, q }, value: quantile(boots, at) });
    }
  }
  return out;
}
