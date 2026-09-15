/**
 * `checkRoadmapIndex`' six rules, each against a synthetic index that violates it, plus the real
 * repo as the control.
 *
 * The real-tree assertion alone would be worthless — one `expect([]).toEqual([])` that passes just
 * as happily if the bullet regexes match nothing and the volume walk finds no files
 * (`daydayup-test-assertion-craft`: a sweep's zero with no evidence the case arose). So the
 * control also asserts the scope is non-empty, and every rule below is fed something that breaks
 * it.
 *
 * Not asserted here, but worth recording because it is the strongest evidence the gate works:
 * run `checkRoadmapIndex` over the tree at `563d25b` (the commit before the 2026-09-15 tidy) and
 * it reports **14** violations — volume 36's two missing by-date entries, the total that was one
 * behind, nine by-theme entries carrying their whole by-date paragraph, and two tag headers that
 * had lost the blank line above them. Every one of those was found by hand first. It is not a
 * test because CI checks out shallow, and `git show` of an old commit is not available there.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkRoadmapIndex, readVolumes, slug } from './checkRoadmapIndex.mjs';

const ROOT = join(import.meta.dirname, '..');

function realInputs() {
  return { roadmap: readFileSync(join(ROOT, 'design', 'ROADMAP.md'), 'utf8'), volumes: readVolumes(ROOT) };
}

/** A minimal, VALID index over one volume — every rule's fixture starts from this. */
function fixture() {
  const volumes = new Map([
    ['01-2026-09-01-a.md', '# Work log\n\n## A pass that shipped (2026-09-01, engine)\n\nBody.\n\n## Still open\n\nA structural section, deliberately undated.\n'],
  ]);
  const anchor = slug('A pass that shipped (2026-09-01, engine)');
  const roadmap = [
    '# ROADMAP',
    '',
    '## The work log — by date',
    '',
    `- **09-01** [A pass that shipped](roadmap/01-2026-09-01-a.md#${anchor}) — summary. \`engine\``,
    '',
    '## The work log — by theme',
    '',
    'The same 1 entries, grouped.',
    '',
    '**`engine`** — the sim *(1)*',
    '',
    `- 09-01 [A pass that shipped](roadmap/01-2026-09-01-a.md#${anchor})`,
    '',
  ].join('\n');
  return { roadmap, volumes, anchor };
}

describe('the real repo', () => {
  it('has every dated pass indexed by date, every link resolving, every counter derived', () => {
    const { roadmap, volumes } = realInputs();
    expect(checkRoadmapIndex(roadmap, volumes).violations).toEqual([]);
  });

  it('actually had something to check (the scope is not empty)', () => {
    const { roadmap, volumes } = realInputs();
    const { stats } = checkRoadmapIndex(roadmap, volumes);
    expect(stats.volumes).toBeGreaterThan(30);
    expect(stats.datedSections).toBeGreaterThan(100);
    expect(stats.dateBullets).toBeGreaterThan(100);
    expect(stats.themeBullets).toBeGreaterThan(stats.dateBullets);
    expect(stats.tags).toBeGreaterThan(10);
  });
});

describe('the fixture itself', () => {
  it('is clean, so every failure below is the rule under test and not the fixture', () => {
    const { roadmap, volumes } = fixture();
    expect(checkRoadmapIndex(roadmap, volumes).violations).toEqual([]);
  });

  it('counts the undated section as structural, not as an unindexed pass', () => {
    const { roadmap, volumes } = fixture();
    expect(checkRoadmapIndex(roadmap, volumes).stats.datedSections).toBe(1);
  });
});

describe('indexed — the rule volume 36 needed', () => {
  it('fails when a dated pass has no by-date bullet', () => {
    const { roadmap, volumes, anchor } = fixture();
    // The by-theme half stays: this is exactly how volume 36 stood for ten days.
    const withoutByDate = roadmap.replace(`- **09-01** [A pass that shipped](roadmap/01-2026-09-01-a.md#${anchor}) — summary. \`engine\`\n`, '')
      .replace('The same 1 entries', 'The same 0 entries');
    const { violations } = checkRoadmapIndex(withoutByDate, volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('has no entry in ROADMAP.md\'s by-date log');
    expect(violations[0]).toContain(anchor); // the message hands over the line to paste
  });

  it('passes when a volume gains an undated structural section', () => {
    const { roadmap, volumes } = fixture();
    volumes.set('01-2026-09-01-a.md', volumes.get('01-2026-09-01-a.md') + '\n## Numbers\n\nA table.\n');
    expect(checkRoadmapIndex(roadmap, volumes).violations).toEqual([]);
  });
});

describe('resolves', () => {
  it('fails on a link to a volume that does not exist', () => {
    const { roadmap, volumes } = fixture();
    const broken = roadmap.replace(/roadmap\/01-2026-09-01-a\.md/g, 'roadmap/99-nope.md');
    const { violations } = checkRoadmapIndex(broken, volumes);
    expect(violations.some((v) => v.startsWith('resolves:') && v.includes('99-nope.md'))).toBe(true);
  });

  it('fails on a link whose anchor is not a heading in that volume', () => {
    const { roadmap, volumes, anchor } = fixture();
    const broken = roadmap.replace(new RegExp(anchor, 'g'), `${anchor}-client-only`);
    const { violations } = checkRoadmapIndex(broken, volumes);
    expect(violations.some((v) => v.startsWith('resolves:') && v.includes('no such heading'))).toBe(true);
  });
});

describe('total', () => {
  it('fails when the stated count is behind the by-date list', () => {
    const { roadmap, volumes } = fixture();
    const { violations } = checkRoadmapIndex(roadmap.replace('The same 1 entries', 'The same 7 entries'), volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Re-derive it, never increment');
  });
});

describe('tagCounts', () => {
  it('fails when a tag counter disagrees with the bullets under it', () => {
    const { roadmap, volumes } = fixture();
    const { violations } = checkRoadmapIndex(roadmap.replace('*(1)*', '*(4)*'), volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('`engine` says *(4)* over 1 entries');
  });

  it('fails when a tag header carries no count at all', () => {
    const { roadmap, volumes } = fixture();
    const { violations } = checkRoadmapIndex(roadmap.replace(' *(1)*', ''), volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('carries no *(N)* count');
  });
});

describe('bareTheme', () => {
  it('fails when a by-theme entry carries the by-date summary too', () => {
    const { roadmap, volumes, anchor } = fixture();
    const fat = roadmap.replace(
      `- 09-01 [A pass that shipped](roadmap/01-2026-09-01-a.md#${anchor})`,
      `- 09-01 [A pass that shipped](roadmap/01-2026-09-01-a.md#${anchor}) — the whole paragraph again. \`engine\``,
    );
    const { violations } = checkRoadmapIndex(fat, volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('The summary lives in the by-date entry; theme entries are bare links.');
  });
});

describe('blankBeforeTag', () => {
  it('fails when an append has eaten the blank line above a tag header', () => {
    const { roadmap, volumes } = fixture();
    const squashed = roadmap.replace('\n\n**`engine`**', '\n**`engine`**');
    const { violations } = checkRoadmapIndex(squashed, volumes);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('makes the NEXT append land in the wrong section');
  });
});

describe('slug', () => {
  it('matches GitHub: lowercase, drop punctuation, spaces to hyphens', () => {
    expect(slug('A door\'s halo runs the way the door does (2026-09-11, client only)'))
      .toBe('a-doors-halo-runs-the-way-the-door-does-2026-09-11-client-only');
  });

  it('leaves a doubled hyphen where an em dash or a tick was dropped', () => {
    expect(slug('Chests ✅ (2026-09-14, `ENGINE_VERSION` 63)')).toBe('chests--2026-09-14-engine_version-63');
  });

  it('keeps non-Latin letters, which this log uses in headings', () => {
    expect(slug('What "打完地图空空如也" actually was')).toBe('what-打完地图空空如也-actually-was');
  });
});
