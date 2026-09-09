/**
 * The flags tab (design/21 §4) — the one page in this console with a form that changes
 * something.
 *
 * Pure, like its three siblings in `sections.ts`: it takes the effective values, the
 * override rows and the definitions, and returns HTML. Every value goes through `esc`.
 *
 * ## What the table has to make unmistakable
 *
 * Three states per flag, and conflating any two of them is how somebody flips the wrong
 * switch:
 *
 *  - **As shipped.** No row in `ops.db`; the value is the compiled-in default. Shown plainly.
 *  - **Overridden.** A row exists, and the effective value differs from — or equals — the
 *    default. Both cases are marked as overridden, including the second: an override that
 *    happens to match today's default is still a row that will NOT follow the default when a
 *    deploy changes it, and that is exactly the case somebody would otherwise misread as
 *    "nothing set here".
 *  - **A row that is not being applied.** A hand-edited value the definition refuses, or a
 *    name a deploy removed. This is the state worth being loud about: the table says the
 *    flag is set and the services are ignoring it.
 *
 * The input control is typed per flag — a select for a boolean, a number input with the
 * declared range as `min`/`max`, a text input with the declared `maxlength`. The bounds are
 * generated from `FLAG_DEFS`, so the page cannot offer a value the store would refuse; the
 * store validates anyway, because a browser hint is not a control.
 */
import { esc, fmtTime } from './layout';
import { FLAG_DEFS, FLAG_NAMES, type FlagName, type FlagValue } from '../../flags/defs';
import type { FlagOverride } from '../../flags/store';

/** How a flag's current value is rendered: never a bare empty string, which would read as a
 *  broken cell rather than as "no banner". */
function showValue(value: FlagValue): string {
  if (typeof value === 'string') return value.length === 0 ? '<span class="dim">(empty)</span>' : esc(value);
  return `<code>${esc(String(value))}</code>`;
}

/** The typed input for one flag, with its declared bounds as browser hints. */
function inputFor(name: FlagName, current: FlagValue): string {
  const def = FLAG_DEFS[name] as { default: FlagValue; range?: { min: number; max: number }; maxLength?: number };
  if (typeof def.default === 'boolean') {
    const on = current === true;
    return `<select name="value">
<option value="true"${on ? ' selected' : ''}>true</option>
<option value="false"${on ? '' : ' selected'}>false</option>
</select>`;
  }
  if (typeof def.default === 'number') {
    const range = def.range!;
    return `<input type="number" name="value" value="${esc(String(current))}" min="${range.min}" max="${range.max}" step="1">`;
  }
  // `maxLength!`: every string flag declares a cap, asserted over the whole allowlist by
  // `flags.defs.test.ts`. A `?? 0` here would render `maxlength="0"` — an input nobody can
  // type into — for a case that cannot arise, and would be a dead branch besides.
  return `<input type="text" name="value" value="${esc(String(current))}" maxlength="${def.maxLength!}">`;
}

export interface FlagsView {
  /** The effective value per flag — defaults merged with the overrides that validated. */
  effective: Record<string, FlagValue>;
  /** The override rows that validated, so the table can say who set what and when. */
  overrides: readonly FlagOverride[];
  /** Names with a row that is NOT being applied. See the file header. */
  invalid: readonly string[];
  /**
   * Flags nothing reads yet (`FlagDef.delivered === false`).
   *
   * Passed IN rather than derived from `FLAG_DEFS` inside the renderer, which keeps this
   * module pure over its input — and, concretely, makes the empty case reachable: today two
   * flags are undelivered, so a renderer that computed this itself could never be tested
   * for the state it will be in once the client delivery path exists.
   */
  undelivered: readonly string[];
}

/**
 * The flags section.
 *
 * One `<form>` per row rather than one for the whole table, and that is not a style choice:
 * a single form would submit every field on every save, so a stale tab left open in another
 * window would silently re-assert whatever it was showing when it loaded. Per-row means a
 * save touches exactly the flag whose button was pressed.
 */
export function flagsSection(view: FlagsView): string {
  const overridden = new Map(view.overrides.map((o) => [o.name as string, o]));

  const invalidNote =
    view.invalid.length === 0
      ? ''
      : `<p class="ro bad">${view.invalid.length} stored override(s) are NOT being applied — the value fails
its definition, or the flag no longer exists in this build: ${view.invalid.map((n) => `<code>${esc(n)}</code>`).join(', ')}.
Every service is using the compiled-in default for these. Clear the row, or ship the flag.</p>`;

  const undelivered = view.undelivered;
  const undeliveredNote =
    undelivered.length === 0
      ? ''
      : `<p class="ro warn">${undelivered.length} flag(s) below have NO consumer yet: setting them changes
nothing. A switch that looks live and does nothing is the worst thing an ops panel can contain, so it is
said here rather than discovered — see <code>FlagDef.consumer</code> in server/src/flags/defs.ts.</p>`;

  const rows = FLAG_NAMES.map((name) => {
    const def = FLAG_DEFS[name] as { default: FlagValue; help: string; consumer: string };
    const current = view.effective[name] ?? def.default;
    const row = overridden.get(name);
    const state =
      row === undefined
        ? '<span class="pill">as shipped</span>'
        : `<span class="pill warn">overridden</span><br><span class="dim">${esc(row.setBy)} · ${fmtTime(row.updatedAtMs)}</span>`;
    const clear =
      row === undefined
        ? ''
        : `<form method="post" action="/admin/flags/clear" style="display:inline">
<input type="hidden" name="name" value="${esc(name)}"><button type="submit">Clear</button></form>`;
    // The row badge reads the VIEW's list, not `def.delivered`, so the page has ONE source
    // for this state rather than two that could disagree — and so the "everything is
    // delivered" case is reachable in a test (see `FlagsView.undelivered`).
    const consumer = undelivered.includes(name)
      ? `<span class="bad">not delivered</span> <span class="dim">${esc(def.consumer)}</span>`
      : `<span class="dim">${esc(def.consumer)}</span>`;
    return `<tr>
<td><code>${esc(name)}</code><br><span class="dim">${esc(def.help)}</span><br>${consumer}</td>
<td>${showValue(current)}</td>
<td>${showValue(def.default)}</td>
<td>${state}</td>
<td><form method="post" action="/admin/flags/set" style="display:inline">
<input type="hidden" name="name" value="${esc(name)}">${inputFor(name, current)}
<button type="submit">Save</button></form> ${clear}</td>
</tr>`;
  }).join('');

  return `<div class="card"><h2>Feature flags</h2>
<p class="ro">Operational switches only (design/21 C1). Nothing that changes an authentication
decision, nothing that could reach billsvc's dev-stub mode, nothing that disables a check at a
trust boundary — those are deploys, permanently. Services poll every 60s and fall back to the
compiled-in default whenever this console is unreachable.</p>${undeliveredNote}${invalidNote}
<table><thead><tr><th>Flag</th><th>Effective</th><th>Shipped default</th><th>State</th><th>Change</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

/** The card shown when this deployment has no `ops.db` at all. Not an error: a deployment
 *  that never wants a remote switch simply does not set `BB_OPS_DB_PATH`, and every service
 *  then runs on its compiled-in defaults — which is Phase C's fail-safe state, reached
 *  through configuration rather than through a failure. */
export function flagsUnavailable(): string {
  return `<div class="card"><h2>Feature flags</h2>
<p class="dim">No flag store on this deployment (<code>BB_OPS_DB_PATH</code> is unset). Every
service is running on its compiled-in defaults, which is the shipped behaviour.</p></div>`;
}
