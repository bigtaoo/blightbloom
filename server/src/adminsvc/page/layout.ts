/**
 * The console's document shell, its stylesheet, its login page — and {@link esc}, which is
 * the one function every untrusted value in this directory passes through.
 *
 * ## Escaping is here, once, and it is not optional
 *
 * The view modules under `adminsvc/views/` return raw strings straight out of SQLite:
 * usernames a player chose, display names a portal supplied, and — the one that actually
 * matters — `webhook_events.raw`, which is a verbatim copy of bytes an outside party POSTed
 * to the billing plane. That last column makes the console a place where attacker-authored
 * text is rendered in an operator's browser, so an unescaped interpolation here is a stored
 * XSS with the session cookie of the one account that can read every player's row.
 *
 * The rule that keeps that from happening is structural rather than careful: **no template
 * in this directory interpolates a value that is not wrapped in `esc()` or a number.** The
 * view modules deliberately do NOT pre-escape (see `views/commerce.ts`'s header), so there
 * is no "already safe" category to reason about — every string is unsafe until it goes
 * through here, and `adminsvc.page.test.ts` asserts a payload survives as text.
 *
 * `http.ts` sets `default-src 'none'` on top, so even a miss cannot load anything.
 */

/** HTML-escapes a value for text or an attribute. All five characters, including both
 *  quotes: escaping only `<`/`&` is safe in text and wrong the moment a value lands in an
 *  attribute, and this file has attributes. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A millisecond timestamp as `YYYY-MM-DD HH:MM` UTC, or `—` for absent. Every time on this
 *  page is UTC and says so in the header, because the day keys the analytics tables use are
 *  UTC and a mixed page would silently compare two different days. */
export function fmtTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/** A ratio as a percentage with one decimal. Never called with `null` — an unknown cell is
 *  rendered as `—` by its own branch, and routing it through here would be the exact
 *  absent-is-not-zero confusion the retention view exists to prevent. */
export function fmtPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #16181d; --dim: #6b7280; --bg: #fbfbfc; --card: #fff;
        --line: #e3e5ea; --accent: #2b6cb0; --warn: #b45309; --bad: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e8ee; --dim: #9aa1ad; --bg: #14161a; --card: #1c1f25; --line: #2c3039;
          --accent: #7cb0e8; --warn: #e0a13a; --bad: #f08a84; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
         padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--card); }
header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .01em; }
header .meta { color: var(--dim); font-size: 12px; }
header form { margin-left: auto; }
nav { display: flex; gap: 4px; padding: 10px 20px 0; }
nav a { padding: 6px 12px; border-radius: 6px 6px 0 0; text-decoration: none; color: var(--dim);
        border: 1px solid transparent; border-bottom: none; }
nav a.on { color: var(--fg); background: var(--card); border-color: var(--line); }
main { padding: 16px 20px 48px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
        padding: 14px 16px; margin-bottom: 16px; overflow-x: auto; }
.card h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .06em;
           color: var(--dim); font-weight: 650; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line);
         vertical-align: top; white-space: nowrap; }
th { color: var(--dim); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.wrap { white-space: normal; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; color: var(--dim);
      max-height: 9em; overflow: auto; }
.dim { color: var(--dim); }
.warn { color: var(--warn); }
.bad { color: var(--bad); font-weight: 600; }
.pill { display: inline-block; padding: 0 6px; border-radius: 10px; border: 1px solid var(--line);
        font-size: 11px; color: var(--dim); }
input[type=text], input[type=password] { font: inherit; padding: 6px 9px; border-radius: 6px;
        border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line);
        background: var(--bg); color: var(--fg); cursor: pointer; }
.login { max-width: 320px; margin: 12vh auto; }
.login label { display: block; margin-bottom: 10px; }
.login span { display: block; color: var(--dim); font-size: 12px; margin-bottom: 3px; }
.login input { width: 100%; }
.err { color: var(--bad); margin: 0 0 10px; }
.ro { color: var(--dim); font-size: 12px; margin: 0 0 14px; }
`;

/** The document, with `body` supplied. Nothing external is referenced — no script, no font,
 *  no image — which is what lets `http.ts` send `default-src 'none'`. */
export function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * The login page.
 *
 * One field pair, one button, and no "forgot your password" — there is no reset flow by
 * design (B3: rotation is an env change and a redeploy), so offering a link would be
 * offering something that does not exist. `error` is a fixed string chosen by the caller,
 * never a value from the request, and it never says WHICH half was wrong.
 */
export function loginPage(error: string | null): string {
  return document(
    'Blightbloom ops',
    `<form class="login card" method="post" action="/admin/login">
<h2>Blightbloom ops</h2>
${error === null ? '' : `<p class="err">${esc(error)}</p>`}
<p class="ro">Read-only console. Every player-data change is a CLI script on the box.</p>
<label><span>Operator</span><input type="text" name="user" autocomplete="username" autofocus></label>
<label><span>Password</span><input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>`,
  );
}

export type Tab = 'players' | 'commerce' | 'retention' | 'flags';
/** Tab order, which is also reading order: three read-only views first, then the one tab
 *  that changes something (design/21 §4). `flags` is last for the same reason Phase C is
 *  last — it is the only write in the whole design. */
export const TABS: readonly Tab[] = ['players', 'commerce', 'retention', 'flags'];

/** Whether a query-string value names a tab. Anything else falls back to `players` rather
 *  than 404ing — a mistyped tab in a bookmark should open the console, not break it. */
export function tabFrom(value: string | null): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'players';
}

/**
 * The shell around a signed-in page: the header (with the logout form), the tab strip, and
 * the read-only notice.
 *
 * The notice is not decoration. B2 makes the console read-only over player data and B1
 * makes that a capability it does not hold; an operator looking for a ban button needs to
 * be told where the writes live rather than concluding the page is broken.
 */
export function shell(tab: Tab, body: string, notes: string[] = []): string {
  const nav = TABS.map(
    (t) => `<a href="/admin/?tab=${t}"${t === tab ? ' class="on"' : ''}>${t[0]!.toUpperCase()}${t.slice(1)}</a>`,
  ).join('');
  const noteHtml = notes.map((n) => `<p class="ro warn">${esc(n)}</p>`).join('');
  return document(
    `Blightbloom ops — ${tab}`,
    `<header><h1>Blightbloom ops</h1>
<span class="meta">read-only · all times UTC</span>
<form method="post" action="/admin/logout"><button type="submit">Sign out</button></form></header>
<nav>${nav}</nav>
<main><p class="ro">This console cannot write player data — it holds read-only handles on
accounts, billing and analytics (design/21 B1). Password resets, grants and bans are CLI
scripts run on the box. The one thing it can change is a feature flag, in its own tab and its
own database.</p>${noteHtml}${body}</main>`,
  );
}

/** The per-section "this database is not available" card, with the reason. Shown instead of
 *  an empty table, because an empty table is indistinguishable from a working section with
 *  nothing in it — which is how "the commerce tab shows nothing" becomes a half-hour. */
export function unavailable(what: string, reason: string): string {
  return `<div class="card"><h2>${esc(what)}</h2>
<p class="dim">Unavailable. ${esc(reason.length > 0 ? reason : 'no reason recorded')}</p></div>`;
}
