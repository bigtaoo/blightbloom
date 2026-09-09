/**
 * The page renderers, and the escaping rule they all rest on.
 *
 * ## Why the escaping is the important half of this file
 *
 * `webhook_events.raw` is a verbatim copy of bytes an outside party POSTed to the billing
 * plane (`billingDb.ts`: "the ORIGINAL bytes, verbatim, exactly as they arrived — parsed or
 * not"). The console renders that column. So this is a page where attacker-authored text is
 * displayed in the browser of the one account that can read every player's row, and an
 * unescaped interpolation is a stored XSS with the session cookie behind it.
 *
 * The test that matters therefore is not "esc() escapes five characters" — it is that a
 * payload put through a VIEW's own shape comes out as text on the rendered page. Both are
 * here; the second is the one that would fail if a template gained an unwrapped `${}`.
 *
 * Everything under `page/` is pure, so none of this needs a database or a socket. That is
 * the point of the split: the interesting cases are formatting decisions on data a live box
 * may not have for weeks (an unaged cohort cell, a truncated body, an account with no
 * rating), and reaching through SQLite to produce one would mostly test SQLite.
 */
import { describe, it, expect } from 'vitest';
import {
  TABS,
  document as htmlDocument,
  esc,
  fmtPercent,
  fmtTime,
  loginPage,
  shell,
  tabFrom,
  unavailable,
} from '../src/adminsvc/page/layout';
import { commerceSection, playersSection, retentionSection } from '../src/adminsvc/page/sections';
import type { PlayerSearchResult } from '../src/adminsvc/views/players';
import type { CommerceSnapshot } from '../src/adminsvc/views/commerce';
import type { RetentionGrid } from '../src/adminsvc/views/retention';

const XSS = `<script>alert("x")</script>`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

describe('esc', () => {
  it('escapes all five characters, ampersand first', () => {
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
    // Ampersand FIRST, or `<` becomes `&lt;` and the ampersand pass then makes it
    // `&amp;lt;` — visible garbage rather than a hole, but it is the same ordering bug that
    // in the other direction produces a working `<`.
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('escapes both quote characters, because this page has attributes', () => {
    // Escaping only `<` and `&` is safe in text and wrong the moment a value lands in an
    // attribute — and the search box's `value="…"` is exactly that.
    expect(esc(`" onmouseover="alert(1)`)).not.toContain('"');
    expect(esc(`' onmouseover='alert(1)`)).not.toContain("'");
  });

  it('leaves ordinary text alone', () => {
    expect(esc('Zoë from the portal — 100% done')).toBe('Zoë from the portal — 100% done');
  });
});

describe('fmtTime', () => {
  it('renders UTC to the minute', () => {
    expect(fmtTime(Date.UTC(2026, 8, 9, 14, 35, 22))).toBe('2026-09-09 14:35');
  });

  it('renders an absent or non-finite timestamp as an em dash, never as 1970', () => {
    // `reviewed_at` is NULL for every open item, and `new Date(null)` is the epoch — a
    // column full of `1970-01-01 00:00` that looks like data.
    expect(fmtTime(null)).toBe('—');
    expect(fmtTime(Number.NaN)).toBe('—');
    expect(fmtTime(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('fmtPercent', () => {
  it('renders a rate to one decimal', () => {
    expect(fmtPercent(0.5)).toBe('50.0%');
    expect(fmtPercent(0)).toBe('0.0%');
    expect(fmtPercent(1)).toBe('100.0%');
    expect(fmtPercent(1 / 3)).toBe('33.3%');
  });
});

describe('the document shell', () => {
  it('references nothing external, so a strict CSP describes it exactly', () => {
    // `http.ts` sends `default-src 'none'`. If the page ever grew a script src, a webfont
    // or an image, the policy would silently break the page rather than the page breaking
    // the policy — so the absence is asserted here rather than trusted.
    const html = htmlDocument('T', shell('players', '<div></div>'));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('escapes the title', () => {
    expect(htmlDocument(XSS, '')).toContain(ESCAPED);
  });

  it('asks not to be indexed', () => {
    // The console is on the public internet at a guessable path. A robots meta does not
    // secure anything and it does keep the login page out of a search index.
    expect(htmlDocument('T', '')).toContain('noindex');
  });
});

describe('loginPage', () => {
  it('posts to the login route and offers no password reset', () => {
    // There is no reset flow by design (B3: rotation is an env change plus a redeploy), so
    // a link would offer something that does not exist.
    const html = loginPage(null);
    expect(html).toContain('action="/admin/login"');
    expect(html).toContain('method="post"');
    expect(html.toLowerCase()).not.toContain('forgot');
    expect(html.toLowerCase()).not.toContain('register');
  });

  it('says the console is read-only before anybody has signed in', () => {
    expect(loginPage(null)).toContain('Read-only console');
  });

  it('shows an error when given one, and no error element when not', () => {
    expect(loginPage('Wrong operator or password.')).toContain('Wrong operator or password.');
    expect(loginPage(null)).not.toContain('class="err"');
  });
});

describe('the shell', () => {
  it('marks exactly one tab current, and links all of them', () => {
    const html = shell('commerce', '<p>x</p>');
    expect([...html.matchAll(/class="on"/g)]).toHaveLength(1);
    for (const tab of TABS) expect(html).toContain(`href="/admin/?tab=${tab}"`);
  });

  it('states that it cannot write player data, and names the one thing it can change', () => {
    // Not decoration: an operator looking for a ban button needs to be told where the
    // writes live (B2 — CLI scripts on the box) rather than concluding the page is broken.
    //
    // The second half arrived with Phase C, and it is the reason this test's name changed.
    // Once ONE tab can change something, an unqualified "this console cannot write" is no
    // longer true as stated, and a reader who acts on it is being misled about the flags
    // tab — so the notice names the three read-only handles and then names the exception.
    const html = shell('players', '');
    expect(html).toContain('cannot write player data');
    expect(html).toContain('scripts run on the box');
    expect(html).toContain('feature flag');
  });

  it('carries a logout form and says the times are UTC', () => {
    const html = shell('players', '');
    expect(html).toContain('action="/admin/logout"');
    expect(html).toContain('all times UTC');
  });

  it('escapes every note it is given', () => {
    expect(shell('players', '', [XSS])).toContain(ESCAPED);
  });
});

describe('tabFrom', () => {
  it('accepts the four tab names and falls back to players for anything else', () => {
    // A mistyped tab in a bookmark should open the console, not 404 it.
    expect(TABS).toEqual(['players', 'commerce', 'retention', 'flags']);
    expect(tabFrom('commerce')).toBe('commerce');
    expect(tabFrom('retention')).toBe('retention');
    expect(tabFrom('flags')).toBe('flags');
    expect(tabFrom('players')).toBe('players');
    expect(tabFrom(null)).toBe('players');
    expect(tabFrom('')).toBe('players');
    expect(tabFrom('__proto__')).toBe('players');
    expect(tabFrom('Commerce')).toBe('players');
  });
});

describe('unavailable', () => {
  it('names the section, gives the reason, and escapes it', () => {
    // An empty table is indistinguishable from a working section with nothing in it, which
    // is how "the commerce tab shows nothing" becomes half an hour.
    const html = unavailable('Commerce', 'unable to open database file');
    expect(html).toContain('Commerce');
    expect(html).toContain('unable to open database file');
    expect(unavailable('Commerce', XSS)).toContain(ESCAPED);
  });

  it('still says something when no reason was recorded', () => {
    // `AdminDbs.errors` is a TOTAL record with `''` for a handle that opened, so an empty
    // string is the "nothing recorded" value rather than `undefined` — which is what keeps
    // every call site free of a `?? ''` that no input could reach.
    expect(unavailable('Retention', '')).toContain('no reason recorded');
  });
});

// ───────────────────────────────── players ─────────────────────────────────

function playerResult(over: Partial<PlayerSearchResult> = {}): PlayerSearchResult {
  return {
    rows: [
      {
        id: 'a1',
        username: 'zoe',
        displayName: null,
        provider: 'local',
        createdAtMs: Date.UTC(2026, 8, 1),
        rating: 1180,
        entitlements: ['blueprint:cannon'],
        lastActiveDay: '2026-09-08',
      },
    ],
    matched: 1,
    truncated: false,
    term: '',
    ...over,
  };
}

describe('playersSection', () => {
  it('renders a row per account with its rating, entitlements and last active day', () => {
    const html = playersSection(playerResult(), false);
    expect(html).toContain('zoe');
    expect(html).toContain('1180');
    expect(html).toContain('blueprint:cannon');
    expect(html).toContain('2026-09-08');
    expect(html).toContain('2026-09-01 00:00');
  });

  it('shows an absent rating and no entitlements as absent, not as 0 and not as blank', () => {
    const html = playersSection(
      playerResult({ rows: [{ ...playerResult().rows[0]!, rating: null, entitlements: [] }] }),
      false,
    );
    expect(html).toContain('none');
    expect(html).not.toContain('>0<');
  });

  it('distinguishes "no event in the window" from "analytics is off"', () => {
    // Two different blanks with two different meanings, and the second one is the whole
    // reason the flag is passed in: a deployment that collects nothing must not look like a
    // player who never came back.
    const noEvent = playersSection(
      playerResult({ rows: [{ ...playerResult().rows[0]!, lastActiveDay: null }] }),
      false,
    );
    expect(noEvent).toContain('>—<');
    const analyticsOff = playersSection(
      playerResult({ rows: [{ ...playerResult().rows[0]!, lastActiveDay: null }] }),
      true,
    );
    expect(analyticsOff).toContain('n/a');
    expect(analyticsOff).toContain('analytics is not configured');
  });

  it('puts the term actually searched into the box, escaped', () => {
    const html = playersSection(playerResult({ term: XSS, rows: [], matched: 0 }), false);
    expect(html).toContain(`value="${ESCAPED}"`);
    expect(html).not.toContain('<script>');
  });

  it('says how many of how many when the page is truncated, and nothing when it is not', () => {
    expect(playersSection(playerResult({ matched: 120, truncated: true }), false)).toContain('of 120 matching');
    expect(playersSection(playerResult(), false)).not.toContain('matching');
  });

  it('says "no accounts match" rather than drawing an empty table', () => {
    const html = playersSection(playerResult({ rows: [], matched: 0 }), false);
    expect(html).toContain('No accounts match');
    expect(html).not.toContain('<tbody>');
  });

  it('escapes a hostile username and display name', () => {
    const html = playersSection(
      playerResult({ rows: [{ ...playerResult().rows[0]!, username: XSS, displayName: XSS }] }),
      false,
    );
    expect(html).not.toContain('<script>');
    expect([...html.matchAll(/&lt;script&gt;/g)].length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────── commerce ─────────────────────────────────

function snapshot(over: Partial<CommerceSnapshot> = {}): CommerceSnapshot {
  return {
    openReviews: [
      {
        id: 'money-taken-nothing-granted:d1',
        kind: 'money-taken-nothing-granted',
        accountId: 'a1',
        dayKey: null,
        summary: 'paid, nothing granted',
        evidenceJson: '{"deliveryId":"d1"}',
        state: 'open',
        createdAtMs: Date.UTC(2026, 8, 5),
        reviewedAtMs: null,
        note: null,
      },
    ],
    closedReviews: [],
    openTotal: 1,
    webhooks: [
      {
        id: 'txn1:settled',
        platform: 'paddle',
        orderId: 'o1',
        txnId: 'txn1',
        eventType: 'transaction.completed',
        outcome: 'settled',
        detail: null,
        raw: '{"a":1}',
        rawTruncated: false,
        firstSeenAtMs: Date.UTC(2026, 8, 5),
        lastSeenAtMs: Date.UTC(2026, 8, 5),
        seenCount: 1,
        divergences: 0,
      },
    ],
    webhookTotal: 1,
    divergentTotal: 0,
    ...over,
  };
}

describe('commerceSection', () => {
  it('renders both review lists and the webhook log with their totals', () => {
    const html = commerceSection(snapshot());
    expect(html).toContain('Review queue — open (1)');
    expect(html).toContain('paid, nothing granted');
    expect(html).toContain('Webhook events (1)');
    expect(html).toContain('transaction.completed');
  });

  it('says "nothing needs looking at" rather than drawing an empty queue', () => {
    const html = commerceSection(snapshot({ openReviews: [], openTotal: 0, webhooks: [], webhookTotal: 0 }));
    expect(html).toContain('Nothing needs looking at');
    expect(html).toContain('Nothing has been reviewed yet');
    expect(html).toContain('No platform callbacks recorded');
  });

  it('calls out divergences above the table, in words, when there are any', () => {
    // The count is over the WHOLE table while the table shows one page, so a per-row flag
    // misses the day the divergent row is row 51. And it is worth words rather than a
    // number: `billingDb.ts` calls this column the forgery shape.
    const html = commerceSection(snapshot({ divergentTotal: 3 }));
    expect(html).toContain('3 webhook row(s)');
    expect(html).toContain('DIFFERENT body');
    expect(commerceSection(snapshot())).not.toContain('DIFFERENT body');
  });

  it('flags a per-row divergence count and leaves a zero plain', () => {
    const divergent = commerceSection(
      snapshot({ webhooks: [{ ...snapshot().webhooks[0]!, divergences: 2 }], divergentTotal: 1 }),
    );
    expect(divergent).toContain('class="bad">2<');
    expect(commerceSection(snapshot())).not.toContain('class="bad">0<');
  });

  it('renders a review row that HAS a day key, and a callback with no ids at all', () => {
    // Two null columns and their non-null twins, all four in one rendered table. Each of
    // these appears in production on a different producer's rows — `review_queue.day_key` is
    // set by the daily grant audit and NULL for a delivery, and `webhook_events` carries no
    // txn or order id at all for a body it could not parse, which `billingDb.ts` calls the
    // case where the evidence matters most. A fixture with only one side of each pair leaves
    // the other's arm untested and looking fine.
    const html = commerceSection(
      snapshot({
        closedReviews: [
          { ...snapshot().openReviews[0]!, state: 'reviewed', reviewedAtMs: 9, dayKey: '2026-09-01', note: 'ok' },
        ],
        webhooks: [
          snapshot().webhooks[0]!,
          { ...snapshot().webhooks[0]!, id: 'unparsable', txnId: null, orderId: null, detail: null },
        ],
        webhookTotal: 2,
      }),
    );
    expect(html).toContain('2026-09-01');
    expect(html).toContain('<code>txn1</code>');
    expect(html).toContain('<code>o1</code>');
    expect([...html.matchAll(/<code>—<\/code>/g)]).toHaveLength(2);
  });

  it('says a raw body was truncated, and where the rest is', () => {
    const html = commerceSection(snapshot({ webhooks: [{ ...snapshot().webhooks[0]!, rawTruncated: true }] }));
    expect(html).toContain('truncated');
    expect(html).toContain('billing.db');
  });

  it('escapes the raw callback body — the one column an outsider authored', () => {
    // The reason `layout.ts`'s escaping rule is absolute. This body is bytes somebody POSTed
    // to the billing plane, rendered in the operator's browser.
    const html = commerceSection(snapshot({ webhooks: [{ ...snapshot().webhooks[0]!, raw: XSS, detail: XSS }] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain(ESCAPED);
  });

  it('escapes the review summary, the note and the evidence blob', () => {
    const html = commerceSection(
      snapshot({
        closedReviews: [{ ...snapshot().openReviews[0]!, state: 'reviewed', reviewedAtMs: 1, summary: XSS, note: XSS, evidenceJson: XSS }],
      }),
    );
    expect(html).not.toContain('<script>');
  });
});

// ───────────────────────────────── retention ─────────────────────────────────

function grid(over: Partial<RetentionGrid> = {}): RetentionGrid {
  return {
    offsets: [1, 2, 3, 4, 5, 6, 7],
    rollupRows: 42,
    rows: [
      {
        day: '2026-09-02',
        dau: 2,
        cells: { 1: { rate: 0, size: 2 }, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null },
      },
      {
        day: '2026-09-01',
        dau: 4,
        cells: {
          1: { rate: 0.5, size: 4 },
          2: { rate: 0, size: 4 },
          3: null,
          4: null,
          5: null,
          6: null,
          7: null,
        },
      },
    ],
    ...over,
  };
}

describe('retentionSection', () => {
  it('renders a measured zero as 0.0% and an unknown as an em dash', () => {
    // The one rule the whole section exists for. `rollup.ts` refuses to emit a gauge for an
    // unaged cohort, so an unknown arrives as a MISSING ROW — and rendering that as 0% says
    // "nobody came back" for every cohort in the first week after launch.
    const html = retentionSection(grid());
    expect(html).toContain('50.0%');
    expect(html).toContain('0.0%');
    expect(html).toContain('class="num dim">—<');
    // Both must be present, and they must not be the same string: if the zero branch and
    // the null branch ever converge, one of these two assertions goes red.
    expect(html.includes('0.0%') && html.includes('—')).toBe(true);
  });

  it('states that the table is the record and that a dash is not zero', () => {
    const html = retentionSection(grid());
    expect(html).toContain('This table is the record, not Prometheus');
    expect(html).toContain('never 0%');
  });

  it('prints the rollup row count even when the grid is empty', () => {
    // §2.5's "the instrument must be shown to see the change": an empty grid over zero rows
    // is an empty database; an empty grid over 300 is a bug in the reader.
    expect(retentionSection(grid())).toContain('42 rollup row(s)');
    const empty = retentionSection(grid({ rows: [], rollupRows: 0 }));
    expect(empty).toContain('0 rollup row(s)');
    expect(empty).toContain('No rollup rows for any day');
    expect(empty).not.toContain('<tbody>');
  });

  it('draws a column per offset and a row per cohort day', () => {
    const html = retentionSection(grid());
    for (const d of [1, 2, 3, 4, 5, 6, 7]) expect(html).toContain(`>D${d}<`);
    expect(html).toContain('2026-09-01');
    expect(html).toContain('2026-09-02');
  });

  it('carries the cohort SIZE in the cell title — the denominator, never a derived count', () => {
    // Written the other way round first, as "2 of 4 installs returned", and the first run of
    // this test showed it rendering "4 of 4" on a 50% cell: `daily_rollup` stores the rate
    // and the size and NOT the return count, so there was no numerator to print. A cell
    // whose tooltip contradicts its own percentage is the kind of instrument that gets
    // believed, so the title now states only what the table holds.
    const html = retentionSection(grid());
    expect(html).toContain('title="cohort of 4 installs on 2026-09-01"');
    expect(html).toContain('title="cohort of 2 installs on 2026-09-02"');
    expect(html).not.toMatch(/returned/);
  });

  it('renders a day with no DAU row as an em dash rather than as zero players', () => {
    // A day before the rollup job existed has no `dau` row, which is not the same as a day
    // on which nobody played.
    const html = retentionSection(grid({ rows: [{ ...grid().rows[0]!, dau: null }] }));
    expect(html).toContain('class="dim">—<');
  });

  it('tolerates a row missing an offset key entirely', () => {
    // `cohortGrid` always fills every offset, so this is the defensive arm — and it is
    // reachable the day the OFFSETS constant grows a column before the rollup writes it,
    // which the constant's own comment says is the correct order for those two edits.
    const html = retentionSection(grid({ offsets: [1, 2, 3, 4, 5, 6, 7, 14] }));
    expect(html).toContain('>D14<');
    expect(html).toContain('class="num dim">—<');
  });
});
