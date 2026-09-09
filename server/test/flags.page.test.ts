/**
 * The flags tab's renderer (design/21 §4) and the remaining store helpers — the cases a
 * live console produces only rarely, so they are produced directly here instead.
 *
 * `page/flags.ts` is pure, like its three siblings in `sections.ts`, and the interesting
 * branches in it are all the SECOND side of a per-flag conditional: a string flag with a
 * value rather than empty, a boolean flag on rather than off, an override whose row is not
 * being applied. A test driven only through HTTP hits whichever side the current defaults
 * happen to produce.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAG_DEFS, FLAG_NAMES, type FlagValue } from '../src/flags/defs';
import { flagsSection, flagsUnavailable, type FlagsView } from '../src/adminsvc/page/flags';
import { defaultOpsDbPath, listOverrides, openOpsDb, setFlag } from '../src/flags/store';
import { parseFormValue } from '../src/adminsvc/flagRoutes';

const T0 = 1_757_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function view(over: Partial<FlagsView> = {}): FlagsView {
  const effective: Record<string, FlagValue> = {};
  for (const name of FLAG_NAMES) effective[name] = FLAG_DEFS[name].default;
  const undelivered = FLAG_NAMES.filter((name) => !(FLAG_DEFS[name] as { delivered: boolean }).delivered);
  return { effective, overrides: [], invalid: [], undelivered, ...over };
}

describe('flagsSection', () => {
  it('renders every flag with its help line, its consumer and its shipped default', () => {
    const html = flagsSection(view());
    for (const name of FLAG_NAMES) {
      expect(html, name).toContain(name);
      expect(html, name).toContain((FLAG_DEFS[name] as { help: string }).help);
    }
    expect(html).toContain('as shipped');
  });

  it('marks an override, names who set it and when, and offers a Clear', () => {
    const html = flagsSection(
      view({
        effective: { ...view().effective, 'match.queueTimeoutMs': 45_000 },
        overrides: [{ name: 'match.queueTimeoutMs', value: 45_000, updatedAtMs: T0, setBy: 'admin' }],
      }),
    );
    expect(html).toContain('overridden');
    expect(html).toContain('admin');
    expect(html).toContain('>Clear<');
    // ...and the three flags with no row still say "as shipped", so a reader can tell which
    // is which at a glance.
    expect([...html.matchAll(/as shipped/g)]).toHaveLength(FLAG_NAMES.length - 1);
  });

  it('marks an override that HAPPENS to equal the shipped default as overridden anyway', () => {
    // The case a reader would otherwise misread as "nothing set here". A row that matches
    // today's default will NOT follow the default when a deploy changes it, so the state
    // that matters is "there is a row", not "the values differ".
    const name = 'match.queueTimeoutMs';
    const html = flagsSection(
      view({ overrides: [{ name, value: FLAG_DEFS[name].default, updatedAtMs: T0, setBy: 'admin' }] }),
    );
    expect(html).toContain('overridden');
  });

  it('renders a non-empty string flag as its text, and an empty one as "(empty)"', () => {
    // Both sides, because the default is `''` and a live console shows only that one until
    // somebody sets a banner. A bare empty cell reads as broken rather than as "no banner".
    expect(flagsSection(view())).toContain('(empty)');
    const withBanner = flagsSection(view({ effective: { ...view().effective, 'ui.maintenanceBanner': 'back at 14:00' } }));
    expect(withBanner).toContain('back at 14:00');
  });

  it('preselects the boolean flag\'s CURRENT value in the select, both ways', () => {
    // A select that always preselected `true` would silently offer to turn a disabled flag
    // back on with one click, and the page would look right.
    const on = flagsSection(view());
    expect(on).toMatch(/<option value="true" selected>/);
    const off = flagsSection(view({ effective: { ...view().effective, 'ads.rewardedOfferEnabled': false } }));
    expect(off).toMatch(/<option value="false" selected>/);
    expect(off).not.toMatch(/<option value="true" selected>/);
  });

  it('puts each number flag\'s declared range on its input as min/max', () => {
    // A browser hint, not a control — `coerceFlag` validates regardless — but a form that
    // offers a value the store refuses is a form that wastes somebody's time.
    const html = flagsSection(view());
    const range = FLAG_DEFS['match.queueTimeoutMs'].range;
    expect(html).toContain(`min="${range.min}" max="${range.max}"`);
  });

  it('is loud about a stored row that is NOT being applied', () => {
    const html = flagsSection(view({ invalid: ['removed.oldFlag', 'match.queueTimeoutMs'] }));
    expect(html).toContain('NOT being applied');
    expect(html).toContain('removed.oldFlag');
    expect(html).toContain('2 stored override(s)');
    // ...and silent when there are none, which is the control for the note.
    expect(flagsSection(view())).not.toContain('NOT being applied');
  });

  it('names the flags with no consumer, since setting one changes nothing', () => {
    // The gap building Phase C found. `delivered: false` is in the type; this is where a
    // person actually sees it.
    const html = flagsSection(view());
    expect(html).toContain('NO consumer yet');
    expect(html).toContain('not delivered');
  });

  it('drops the warning entirely once every flag HAS a consumer', () => {
    // The state this project should be in once a client delivery path exists. It is
    // reachable only because the list is passed in rather than derived inside the renderer
    // — a renderer that computed it from `FLAG_DEFS` could never be tested for the day the
    // gap closes, so the note would quietly outlive its own reason.
    const html = flagsSection(view({ undelivered: [] }));
    expect(html).not.toContain('NO consumer yet');
    expect(html).not.toContain('not delivered');
    // ...and the table is still there, so this is not just an empty page.
    for (const name of FLAG_NAMES) expect(html, name).toContain(name);
  });

  it('escapes a hostile banner value and a hostile invalid-row name', () => {
    const html = flagsSection(
      view({
        effective: { ...view().effective, 'ui.maintenanceBanner': '<script>alert(1)</script>' },
        invalid: ['<script>alert(2)</script>'],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to the shipped default for a flag the effective map is MISSING', () => {
    // `effectiveFlags` is total by construction, so this is the arm that only opens if the
    // store and the allowlist ever disagree — a flag added to `defs.ts` and served by an
    // older adminsvc, say. Rendering `undefined` in that cell would be the worst outcome:
    // it looks like a value.
    const partial = view();
    delete (partial.effective as Record<string, unknown>)['match.queueTimeoutMs'];
    const html = flagsSection(partial);
    expect(html).not.toContain('undefined');
    expect(html).toContain(String(FLAG_DEFS['match.queueTimeoutMs'].default));
  });
});

describe('flagsUnavailable', () => {
  it('says which variable is unset and that the defaults are the shipped behaviour', () => {
    const html = flagsUnavailable();
    expect(html).toContain('BB_OPS_DB_PATH');
    expect(html).toContain('compiled-in defaults');
  });
});

describe('parseFormValue', () => {
  it('turns the two boolean strings into booleans', () => {
    expect(parseFormValue('ads.rewardedOfferEnabled', 'true')).toBe(true);
    expect(parseFormValue('ads.rewardedOfferEnabled', 'false')).toBe(false);
  });

  it('returns anything ELSE verbatim for a boolean flag, so coerceFlag refuses it', () => {
    // The parse is a convenience; the validation is the control. A hand-made POST with
    // `value=1` must not become `true` — guessing is how `"false"` becomes `true`.
    for (const raw of ['1', '0', 'yes', 'TRUE', '']) {
      expect(parseFormValue('ads.rewardedOfferEnabled', raw), raw).toBe(raw);
    }
  });

  it('parses a number, and does NOT turn an empty field into zero', () => {
    expect(parseFormValue('match.queueTimeoutMs', '45000')).toBe(45_000);
    expect(parseFormValue('match.queueTimeoutMs', ' 45000 ')).toBe(45_000);
    // `Number('')` is 0, and a cleared number input would otherwise set a queue timeout to
    // zero — a value inside no declared range and a queue that expires instantly.
    expect(parseFormValue('match.queueTimeoutMs', '')).toBe('');
    expect(parseFormValue('match.queueTimeoutMs', '   ')).toBe('   ');
  });

  it('passes a string flag through untouched', () => {
    expect(parseFormValue('ui.maintenanceBanner', ' back soon ')).toBe(' back soon ');
  });
});

describe('defaultOpsDbPath', () => {
  it('takes BB_OPS_DB_PATH when it is set', () => {
    vi.stubEnv('BB_OPS_DB_PATH', '/data/ops.db');
    expect(defaultOpsDbPath()).toBe('/data/ops.db');
  });

  it('falls back to a data/ops.db sibling when it is unset', () => {
    vi.stubEnv('BB_OPS_DB_PATH', '');
    expect(defaultOpsDbPath()).toMatch(/[\\/]data[\\/]ops\.db$/);
    // Never one of the other three files. Pointing this at `accounts.db` would hand adminsvc
    // the write handle B1 exists to deny it, which is why it is a distinct variable with a
    // distinct default.
    expect(defaultOpsDbPath()).not.toMatch(/accounts|billing|analytics/);
  });
});

describe('openOpsDb', () => {
  it('creates the directory and the file, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-ops-open-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'ops.db');
    const first = openOpsDb(path);
    setFlag(first, 'match.queueTimeoutMs', 45_000, T0, 'admin');
    first.close();
    // Second open over an existing file: `CREATE TABLE IF NOT EXISTS` must not wipe it.
    const second = openOpsDb(path);
    expect(listOverrides(second).rows).toHaveLength(1);
    second.close();
  });

  it('accepts :memory: without trying to make a directory for it', () => {
    // `mkdirSync(dirname(':memory:'))` would create a literal `.` — harmless here and a
    // real mess on a path like `file::memory:?cache=shared`. Every other opener in this
    // repo carries the same special case, so it is asserted the same way.
    const db = openOpsDb(':memory:');
    expect(db.prepare('SELECT COUNT(*) AS n FROM flags').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('listOverrides — the unparsable row', () => {
  it('reports a row whose value is not JSON as invalid rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-ops-bad-'));
    dirs.push(dir);
    const db = openOpsDb(join(dir, 'ops.db'));
    db.prepare('INSERT INTO flags (name, value, updated_at, set_by) VALUES (?,?,?,?)').run(
      'ui.maintenanceBanner',
      'not json at all',
      T0,
      'sqlite3',
    );
    const { rows, invalid } = listOverrides(db);
    expect(rows).toEqual([]);
    expect(invalid).toEqual(['ui.maintenanceBanner']);
    db.close();
  });
});
