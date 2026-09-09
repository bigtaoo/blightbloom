/**
 * The three section renderers (design/21 §3.2). Pure functions from a view module's result
 * to an HTML fragment — no database, no request, no clock.
 *
 * That purity is what makes the rendering testable at all: every branch worth pinning here
 * is a formatting decision that only shows up on data a live box may not have for weeks (a
 * cohort cell that is unknown rather than zero, a webhook body that was truncated, an
 * account with no rating row), and a test that had to reach through SQLite to produce one
 * would mostly be testing SQLite.
 *
 * Every interpolated string goes through `esc` — see `layout.ts`'s header for why that rule
 * is absolute in this directory and which column makes it load-bearing.
 */
import { esc, fmtPercent, fmtTime } from './layout';
import type { PlayerSearchResult } from '../views/players';
import type { CommerceSnapshot, ReviewRow, WebhookRow } from '../views/commerce';
import type { RetentionGrid } from '../views/retention';

// ───────────────────────────────── players ─────────────────────────────────

/**
 * The players table, with the search box above it.
 *
 * `value` on the search input is the term the view actually USED, not the raw query
 * parameter — so a 200-character paste comes back showing the 64 characters that were
 * searched for, rather than silently searching for a prefix of what is on screen.
 */
export function playersSection(result: PlayerSearchResult, analyticsOff: boolean): string {
  const head = `<form class="card" method="get" action="/admin/">
<h2>Players</h2>
<input type="hidden" name="tab" value="players">
<input type="text" name="q" placeholder="username or display name" value="${esc(result.term)}" autofocus>
<button type="submit">Search</button>
<span class="dim"> ${result.rows.length} shown${result.truncated ? ` of ${result.matched} matching` : ''}</span>
</form>`;

  if (result.rows.length === 0) {
    return `${head}<div class="card"><p class="dim">No accounts match.</p></div>`;
  }

  const lastActiveHeader = analyticsOff
    ? '<th title="analytics is not configured on this deployment">Last active</th>'
    : '<th title="newest analytics event; blank means none in the last 90 days">Last active</th>';

  const rows = result.rows
    .map(
      (p) => `<tr>
<td><code>${esc(p.id)}</code></td>
<td>${esc(p.username)}</td>
<td>${p.displayName === null ? '<span class="dim">—</span>' : esc(p.displayName)}</td>
<td><span class="pill">${esc(p.provider)}</span></td>
<td>${fmtTime(p.createdAtMs)}</td>
<td class="num">${p.rating === null ? '<span class="dim">—</span>' : String(p.rating)}</td>
<td class="wrap">${p.entitlements.length === 0 ? '<span class="dim">none</span>' : p.entitlements.map((s) => `<code>${esc(s)}</code>`).join(', ')}</td>
<td>${p.lastActiveDay === null ? `<span class="dim">${analyticsOff ? 'n/a' : '—'}</span>` : esc(p.lastActiveDay)}</td>
</tr>`,
    )
    .join('');

  return `${head}<div class="card"><table>
<thead><tr><th>Account</th><th>Username</th><th>Display name</th><th>Provider</th><th>Created</th>
<th class="num">Rating</th><th>Entitlements</th>${lastActiveHeader}</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

// ───────────────────────────────── commerce ─────────────────────────────────

function reviewTable(rows: readonly ReviewRow[], empty: string): string {
  if (rows.length === 0) return `<p class="dim">${esc(empty)}</p>`;
  const body = rows
    .map(
      (r) => `<tr>
<td><span class="pill">${esc(r.kind)}</span></td>
<td><code>${esc(r.accountId)}</code></td>
<td>${r.dayKey === null ? '<span class="dim">—</span>' : esc(r.dayKey)}</td>
<td class="wrap">${esc(r.summary)}<pre>${esc(r.evidenceJson)}</pre></td>
<td>${fmtTime(r.createdAtMs)}</td>
<td>${fmtTime(r.reviewedAtMs)}</td>
<td class="wrap">${r.note === null ? '<span class="dim">—</span>' : esc(r.note)}</td>
</tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Kind</th><th>Account</th><th>Day</th><th>Finding</th>
<th>Filed</th><th>Reviewed</th><th>Note</th></tr></thead><tbody>${body}</tbody></table>`;
}

function webhookTable(rows: readonly WebhookRow[]): string {
  if (rows.length === 0) return '<p class="dim">No platform callbacks recorded.</p>';
  const body = rows
    .map(
      (w) => `<tr>
<td><span class="pill">${esc(w.platform)}</span></td>
<td>${esc(w.eventType)}</td>
<td>${esc(w.outcome)}</td>
<td><code>${w.txnId === null ? '—' : esc(w.txnId)}</code></td>
<td><code>${w.orderId === null ? '—' : esc(w.orderId)}</code></td>
<td class="num">${String(w.seenCount)}</td>
<td class="num">${w.divergences > 0 ? `<span class="bad">${String(w.divergences)}</span>` : '0'}</td>
<td>${fmtTime(w.lastSeenAtMs)}</td>
<td class="wrap">${w.detail === null ? '' : `${esc(w.detail)}`}<pre>${esc(w.raw)}${w.rawTruncated ? '\n… truncated — full bytes are in billing.db' : ''}</pre></td>
</tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Platform</th><th>Event</th><th>Outcome</th><th>Txn</th><th>Order</th>
<th class="num">Seen</th><th class="num">Diverged</th><th>Last seen</th><th>Detail / raw body</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

/**
 * The commerce section: the review queue split open/closed, then the webhook log.
 *
 * `divergentTotal` gets its own line above the table rather than being left to be noticed
 * in a column, because it is counted over the WHOLE table while the table shows one page —
 * a non-zero count whose row is not on screen is exactly the case a per-row flag misses,
 * and `billingDb.ts` calls that column the forgery shape.
 */
export function commerceSection(snapshot: CommerceSnapshot): string {
  const divergent =
    snapshot.divergentTotal > 0
      ? `<p class="ro bad">${snapshot.divergentTotal} webhook row(s) have seen a redelivery with a
DIFFERENT body under the same key. That is somebody varying fields under a key they do not own.</p>`
      : '';
  return `<div class="card"><h2>Review queue — open (${snapshot.openTotal})</h2>
${reviewTable(snapshot.openReviews, 'Nothing needs looking at.')}</div>
<div class="card"><h2>Review queue — reviewed</h2>
${reviewTable(snapshot.closedReviews, 'Nothing has been reviewed yet.')}</div>
<div class="card"><h2>Webhook events (${snapshot.webhookTotal})</h2>${divergent}
${webhookTable(snapshot.webhooks)}</div>`;
}

// ───────────────────────────────── retention ─────────────────────────────────

/**
 * The D1–D7 cohort grid.
 *
 * The one rule this renderer has: an unknown cell is `—` and a measured zero is `0.0%`.
 * They come in as `null` and `{ rate: 0 }` and they must not converge here — see
 * `views/retention.ts`'s header for why that distinction is the whole point of the
 * section. The title attribute on a measured cell carries the cohort size, so a 100% D1
 * off two people reads as what it is.
 *
 * `rollupRows` is printed even when the grid is empty. An empty grid over zero rollup rows
 * is an empty database; an empty grid over a few hundred is a bug in the reader — and
 * without the number on the page those two look identical.
 */
export function retentionSection(grid: RetentionGrid): string {
  const note = `<p class="ro">This table is the record, not Prometheus (design/21 A5): Grafana keeps 15 days
and a gauge cannot be backfilled. <span class="dim">—</span> means the answer is not known yet, never 0%.
${grid.rollupRows} rollup row(s) in the table.</p>`;

  if (grid.rows.length === 0) {
    return `<div class="card"><h2>Retention</h2>${note}
<p class="dim">No rollup rows for any day. The job runs on matchsvc and needs a complete day of
events before it writes anything.</p></div>`;
  }

  const head = grid.offsets.map((d) => `<th class="num">D${d}</th>`).join('');
  const rows = grid.rows
    .map((row) => {
      const cells = grid.offsets
        .map((d) => {
          const cell = row.cells[d] ?? null;
          if (cell === null) return '<td class="num dim">—</td>';
          // The title states the DENOMINATOR and nothing else. `daily_rollup` stores the
          // rate and the cohort size; it does not store the return COUNT, so any "N of M
          // returned" here would be a number this page derived and presented as a
          // measurement. The size is what a reader needs anyway — it is what makes a 100%
          // D1 off two people read as what it is.
          return `<td class="num" title="cohort of ${cell.size} installs on ${esc(row.day)}">${fmtPercent(cell.rate)}</td>`;
        })
        .join('');
      const dau = row.dau === null ? '<span class="dim">—</span>' : String(row.dau);
      return `<tr><td>${esc(row.day)}</td><td class="num">${dau}</td>${cells}</tr>`;
    })
    .join('');

  return `<div class="card"><h2>Retention — D1 to D7 by cohort</h2>${note}
<table><thead><tr><th>Cohort day</th><th class="num">DAU</th>${head}</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}
