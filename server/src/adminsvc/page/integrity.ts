/**
 * The integrity tab's renderer (design/15, "PvP integrity", decided 2026-09-26). Pure, like
 * `sections.ts` beside it: a view in, an HTML fragment out, every interpolated string through
 * `esc` — a display name here is player-chosen text.
 */
import { esc, fmtTime } from './layout';
import type { IntegrityReportRow, IntegrityView, SuspicionRow } from '../views/integrity';

function who(accountId: string | null, name: string | null): string {
  if (accountId === null) return '<span class="dim">guest/bot</span>';
  return name === null ? `<code>${esc(accountId)}</code>` : `${esc(name)} <code>${esc(accountId)}</code>`;
}

function suspectsTable(rows: readonly SuspicionRow[]): string {
  if (rows.length === 0) return '<p class="dim">No account has been named in a record.</p>';
  const body = rows
    .map(
      (s) => `<tr>
<td>${who(s.accountId, s.name)}</td>
<td class="num">${s.count}</td>
<td><code>${esc(s.lastRoomId)}</code></td>
<td>${fmtTime(s.lastAtMs)}</td>
</tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Account</th><th class="num">Records</th><th>Last room</th><th>Last named</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function reportsTable(rows: readonly IntegrityReportRow[]): string {
  if (rows.length === 0) return '<p class="dim">No PvP match has failed to settle cleanly.</p>';
  const body = rows
    .map((r) => {
      const named =
        r.suspects.length === 0
          ? '<span class="dim">nobody</span>'
          : r.suspects
              .map((s) => {
                const why = [s.dissented ? 'dissented' : '', s.kicked ? 'kicked' : ''].filter(Boolean).join(', ');
                return `seat ${s.seat}: ${who(s.accountId, s.name)} <span class="dim">(${why})</span>`;
              })
              .join('<br>');
      return `<tr>
<td>${fmtTime(r.receivedAtMs)}</td>
<td><code>${esc(r.roomId)}</code></td>
<td><span class="pill">${esc(r.verdict)}</span>${r.bounds === null ? '' : ` <code>${esc(r.bounds)}</code>`}</td>
<td class="num">${r.playerCount}</td>
<td class="num">${r.settleFrame}</td>
<td class="wrap">${named}</td>
<td class="num">${r.seed}</td>
<td class="num">${r.engineVersion}</td>
<td class="num">${r.logBytes === null ? `<span class="dim" title="dropped by the sender for size">dropped</span>` : String(r.logBytes)}</td>
</tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Received</th><th>Room</th><th>Verdict</th><th class="num">Seats</th>
<th class="num">Frame</th><th>Named</th><th class="num">Seed</th><th class="num">Engine</th><th class="num">Log bytes</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

export function integritySection(view: IntegrityView): string {
  return `<div class="card"><h2>Most-named accounts</h2>
<p class="dim">A count of PvP records naming the account — a dissenting vote or a checkpoint kick. Nothing acts on it; it is here to be noticed.</p>
${suspectsTable(view.suspects)}</div>
<div class="card"><h2>Recent records</h2>
<p class="dim">PvP matches that did not settle cleanly. <b>dissent</b> still rated; <b>no_consensus</b> and <b>bounds</b> rated nothing. Seed, engine version and the archived input log are kept for a replay that does not exist yet.</p>
${reportsTable(view.reports)}</div>`;
}
