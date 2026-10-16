/**
 * The launch section renderer (design/21 §2.9) — a sibling of `sections.ts`, same rules: a
 * pure function from `views/launch.ts`'s result to an HTML fragment, every interpolated
 * string through `esc`.
 *
 * Three tables, in the order a portal grades them: did the page turn into a game (the open
 * funnel), how long did a new install stay on its first day, and who were they (the segment
 * split, pooled over the window).
 */
import { esc, fmtPercent } from './layout';
import { SEGMENT_DIMS } from '../../analytics/newInstallSegments';
import { OPEN_STEPS } from '../../analytics/pageOpens';
import type { LaunchView, SegmentRow } from '../views/launch';

const OPEN_HEADS: Record<string, string> = { open: 'Opened', boot: 'Booted', menu: 'Menu', run_start: 'Run started' };
const DASH = '<td class="num dim">—</td>';

/** Whole seconds as `m:ss`, or the dash for unknown. */
export function fmtSeconds(s: number | null): string {
  if (s === null) return '—';
  const r = Math.max(0, Math.round(s));
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

const num = (n: number | null, of?: number | null): string =>
  n === null
    ? DASH
    : `<td class="num">${n}${of !== undefined && of !== null && of > 0 ? ` <span class="dim">${fmtPercent(n / of)}</span>` : ''}</td>`;

function segmentTable(dim: string, rows: SegmentRow[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map((r) => {
      const ret = Object.entries(r.returns)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, { back, base }]) =>
          base > 0 ? `<td class="num" title="${back} of ${base}">${fmtPercent(back / base)}</td>` : DASH,
        )
        .join('');
      const avg = r.playtimeN > 0 ? `<td class="num" title="over ${r.playtimeN} measured">${fmtSeconds(r.playtimeS / r.playtimeN)}</td>` : DASH;
      return `<tr><td>${esc(r.value)}</td>${num(r.installs)}${num(r.menu, r.installs)}${num(r.run_start, r.installs)}${num(r.run_finished, r.installs)}${avg}${ret}</tr>`;
    })
    .join('');
  const dHead = Object.keys(rows[0].returns)
    .sort((a, b) => Number(a) - Number(b))
    .map((d) => `<th class="num">D${esc(d)}</th>`)
    .join('');
  return `<h3>By ${esc(dim)}</h3><table><thead><tr><th>${esc(dim)}</th><th class="num">New</th><th class="num">Menu</th><th class="num">Run started</th><th class="num">Run finished</th><th class="num">Avg playtime</th>${dHead}</tr></thead>
<tbody>${body}</tbody></table>`;
}

/** The launch-metrics card. */
export function launchSection(view: LaunchView): string {
  const title = `Launch metrics — conversion, playtime, segments (${esc(view.host)})`;
  const note = `<p class="ro"><b>Opened</b> counts page loads the beacon in <code>index.html</code> saw, before
the game had downloaded; each later step is the share of those visits that got there. <b>Boot</b> is
open-to-<code>session_start</code>, download included. <b>Playtime</b> is a new install's visible
first-day time, averaged over the installs that reported one (<b>Measured</b>). The segment tables
pool the last ${view.days.length} days; a D<i>n</i> rate only counts days whose return is already known.
<span class="dim">—</span> means not known, never 0.</p>`;

  if (view.days.length === 0) {
    return `<div class="card"><h2>${title}</h2>${note}
<p class="dim">No launch rows yet. They are written by the same hourly rollup as the new-install grid.</p></div>`;
  }

  const days = view.days
    .map((d) => {
      const open = OPEN_STEPS.map((s) => (d.open === null ? DASH : num(d.open[s], s === 'open' ? null : d.open.open))).join('');
      const boot = `<td class="num">${d.bootP50 === null ? '—' : `${(d.bootP50 / 1000).toFixed(1)}s`} / ${d.bootP90 === null ? '—' : `${(d.bootP90 / 1000).toFixed(1)}s`}</td>`;
      const hist = d.buckets.length === 0 ? '<td></td>' : `<td>${d.buckets.map(([b, n]) => `${b}m+:${n}`).join(' · ')}</td>`;
      return `<tr><td>${esc(d.day)}</td>${open}${boot}${num(d.measured)}<td class="num">${fmtSeconds(d.avgS)}</td><td class="num">${fmtSeconds(d.p50S)}</td>${hist}</tr>`;
    })
    .join('');
  const openHead = OPEN_STEPS.map((s) => `<th class="num">${OPEN_HEADS[s]}</th>`).join('');
  const segs = SEGMENT_DIMS.map((dim) => segmentTable(dim, view.segments[dim])).join('');

  return `<div class="card"><h2>${title}</h2>${note}
<table><thead><tr><th>Day</th>${openHead}<th class="num">Boot p50 / p90</th><th class="num">Measured</th><th class="num">Avg playtime</th><th class="num">Median</th><th>Playtime (min+:installs)</th></tr></thead>
<tbody>${days}</tbody></table>${segs}</div>`;
}
