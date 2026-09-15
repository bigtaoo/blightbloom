#!/usr/bin/env node
// Gate: `design/ROADMAP.md`'s two index views must agree with the work-log volumes they index.
//
// The fourth doc-consistency gate (design/18 Layer 0, beside `determinismLint.test.ts`,
// `engine/stepOrder.test.ts` and `checkDocPaths.mjs`). It exists because of what the 2026-09-15
// tidy pass found: `design/roadmap/36-2026-09-05-floor-loot-cards.md` had landed all six of its
// by-THEME entries and neither of its by-DATE ones, and had stood that way for ten days.
//
// ## Why nothing already catches that
//
// `checkDocPaths.mjs` skips `ROADMAP.md` and `roadmap/*` on purpose — they are an append-only
// historical log. No logic gate counts entries. And a link sweep is actively misleading here:
// volume 36 was linked from six places, so every reference to it resolved. The only check that
// sees the defect runs the other way round — from the VOLUME to the index: for every dated
// section in a volume, is there a by-date bullet pointing at it?
//
// ## The rules
//
//   indexed         every dated `## ` heading in a volume has a by-date bullet linking to it
//   resolves        every roadmap link in either index names a real volume and a real heading
//   total           "The same N entries, grouped" equals the by-date bullet count
//   tagCounts       each `**`tag`** … *(N)*` equals the bullets under that header
//   bareTheme       a by-theme bullet is a BARE link — the summary lives in the by-date entry
//   blankBeforeTag  a blank line precedes every tag header
//
// The last two are not tidiness. An append that eats a block's trailing blank line is what makes
// the NEXT append land inside the wrong tag section (2026-09-09, four drifted counters and no
// error), and the summary-in-both-halves shape put ~40 KB of the by-date index inside the
// by-theme index before it was noticed.
//
// A dated heading is one carrying `(20NN-NN-NN` — that filter is what keeps a volume's
// structural sections (`Numbers`, `After`, `Still open`) out of the `indexed` rule exactly,
// with no allowlist.
//
// Usage (cwd = repo root):
//   node build/checkRoadmapIndex.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** GitHub's heading slug: lowercase, drop all but word/`-`/space, spaces to `-`. */
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
}

const BY_DATE = /^- \*\*\d\d-\d\d\*\* \[/;
const BY_THEME = /^- \d\d-\d\d \[/;
const TAG_HEADER = /^\*\*`([^`]+)`\*\*/;
const LINK = /\[[^\]]*\]\(roadmap\/([^)#\s]+)(?:#([^)\s]*))?\)/;

/** Split ROADMAP.md into its two log-index sections, by `## ` heading. */
function sections(lines) {
  const find = (needle) => {
    const at = lines.findIndex((l) => l.startsWith('## ') && l.includes(needle));
    if (at < 0) return null;
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break; }
    return { start: at, end };
  };
  return { byDate: find('by date'), byTheme: find('by theme') };
}

/**
 * @param roadmap  contents of design/ROADMAP.md
 * @param volumes  Map of `NN-….md` (basename) -> contents
 */
export function checkRoadmapIndex(roadmap, volumes) {
  const violations = [];
  const lines = roadmap.replace(/\r\n/g, '\n').split('\n');
  const { byDate, byTheme } = sections(lines);
  if (!byDate || !byTheme) {
    return { violations: ['ROADMAP.md is missing a "by date" or "by theme" `## ` section.'], stats: {} };
  }

  const dateBullets = [];
  for (let i = byDate.start; i < byDate.end; i++) if (BY_DATE.test(lines[i])) dateBullets.push({ i, line: lines[i] });
  const themeBullets = [];
  for (let i = byTheme.start; i < byTheme.end; i++) if (BY_THEME.test(lines[i])) themeBullets.push({ i, line: lines[i] });

  // --- resolves: every roadmap link in either index names a real volume and a real heading ---
  const headingsOf = new Map();
  for (const [name, text] of volumes) {
    const set = new Set();
    for (const m of text.replace(/\r\n/g, '\n').matchAll(/^#{1,6} (.+)$/gm)) set.add(slug(m[1]));
    headingsOf.set(name, set);
  }
  const linkTargets = new Set();
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(new RegExp(LINK, 'g'))) {
      const [, file, anchor] = m;
      if (!volumes.has(file)) { violations.push(`resolves: ROADMAP.md:${i + 1} links roadmap/${file}, which does not exist.`); continue; }
      if (anchor && !headingsOf.get(file).has(anchor)) {
        violations.push(`resolves: ROADMAP.md:${i + 1} links roadmap/${file}#${anchor}, and that volume has no such heading.`);
        continue;
      }
      if (anchor) linkTargets.add(`${file}#${anchor}`);
    }
  }

  // --- indexed: every DATED volume section has a by-date bullet pointing at it ---
  const dateTargets = new Set();
  for (const { line } of dateBullets) {
    const m = line.match(LINK);
    if (m && m[2]) dateTargets.add(`${m[1]}#${m[2]}`);
  }
  let datedSections = 0;
  for (const [name, text] of [...volumes].sort()) {
    if (!/^\d+-/.test(name)) continue; // only the numbered volumes carry dated passes
    for (const m of text.replace(/\r\n/g, '\n').matchAll(/^## (.+)$/gm)) {
      if (!/\(20\d\d-\d\d-\d\d/.test(m[1])) continue; // structural section, not a pass
      datedSections++;
      if (!dateTargets.has(`${name}#${slug(m[1])}`)) {
        violations.push(
          `indexed: roadmap/${name} "${m[1].slice(0, 70)}" has no entry in ROADMAP.md's by-date log.\n` +
          `          Add: - **MM-DD** [Title](roadmap/${name}#${slug(m[1])}) — summary. \`tags\``,
        );
      }
    }
  }

  // --- total: the stated count equals the real by-date bullet count ---
  const totalAt = lines.findIndex((l) => /[Tt]he same \d+ entries/.test(l));
  if (totalAt < 0) violations.push('total: ROADMAP.md has no "The same N entries" line to check.');
  else {
    const stated = Number(lines[totalAt].match(/[Tt]he same (\d+) entries/)[1]);
    if (stated !== dateBullets.length) {
      violations.push(`total: ROADMAP.md:${totalAt + 1} says "${stated} entries"; the by-date log holds ${dateBullets.length}. Re-derive it, never increment.`);
    }
  }

  // --- tagCounts + blankBeforeTag + bareTheme ---
  let tag = null; let tagLine = 0; let tagStated = 0; let seen = 0; const tags = [];
  const flush = () => { if (tag) tags.push({ tag, tagLine, tagStated, seen }); };
  for (let i = byTheme.start; i < byTheme.end; i++) {
    const h = lines[i].match(TAG_HEADER);
    if (h) {
      flush();
      tag = h[1]; tagLine = i; seen = 0;
      const n = lines[i].match(/\*\((\d+)\)\*/);
      tagStated = n ? Number(n[1]) : null;
      if (lines[i - 1] !== undefined && lines[i - 1].trim() !== '') {
        violations.push(`blankBeforeTag: ROADMAP.md:${i + 1} — the \`${tag}\` header has no blank line above it. An append that eats the separator makes the NEXT append land in the wrong section.`);
      }
      continue;
    }
    if (BY_THEME.test(lines[i])) {
      seen++;
      const bare = lines[i].match(/^- \d\d-\d\d \[[^\]]*\]\([^)]*\)\s*$/);
      if (!bare) violations.push(`bareTheme: ROADMAP.md:${i + 1} — a by-theme entry carries a summary. The summary lives in the by-date entry; theme entries are bare links.`);
    }
  }
  flush();
  for (const t of tags) {
    if (t.tagStated === null) violations.push(`tagCounts: ROADMAP.md:${t.tagLine + 1} — the \`${t.tag}\` header carries no *(N)* count.`);
    else if (t.tagStated !== t.seen) violations.push(`tagCounts: ROADMAP.md:${t.tagLine + 1} — \`${t.tag}\` says *(${t.tagStated})* over ${t.seen} entries. Re-derive every counter, not just the one you touched.`);
  }

  return {
    violations,
    stats: { dateBullets: dateBullets.length, themeBullets: themeBullets.length, volumes: volumes.size, datedSections, tags: tags.length, linkTargets: linkTargets.size },
  };
}

/** Read `design/roadmap/NN-*.md` into a Map keyed by basename. */
export function readVolumes(root) {
  const dir = join(root, 'design', 'roadmap');
  const out = new Map();
  // Every .md in the log directory, so `resolves` can see `current-state.md` too; the
  // `indexed` rule filters to the NUMBERED volumes, which are the ones holding dated passes.
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.md')) out.set(f, readFileSync(join(dir, f), 'utf8'));
  }
  return out;
}

function main() {
  const root = process.cwd();
  const roadmap = readFileSync(join(root, 'design', 'ROADMAP.md'), 'utf8');
  const volumes = readVolumes(root);
  const { violations, stats } = checkRoadmapIndex(roadmap, volumes);

  console.log(
    `checkRoadmapIndex: ${stats.dateBullets} by-date entries, ${stats.themeBullets} by-theme entries, ` +
    `${stats.datedSections} dated sections across ${stats.volumes} volumes, ${stats.tags} tag counters.`,
  );
  if (violations.length) {
    console.log("\nFAILED — ROADMAP.md's index disagrees with the work log:\n");
    for (const v of violations) console.log('  - ' + v + '\n');
    process.exit(1);
  }
  console.log('OK — every dated pass is indexed by date, every link resolves, and every counter is derived.');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build/checkRoadmapIndex.mjs')) main();
