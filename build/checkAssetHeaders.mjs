// Every shipped asset directory must have a `Cache-Control` rule in `client/public/_headers`.
//
// The drift this catches is the one that produced the rule in the first place. Cloudflare's
// static-assets default for anything the file does not name is
// `public, max-age=0, must-revalidate` — the browser may keep the bytes but must ask before
// using them. So a directory with no rule costs a returning player one conditional request
// per file in it, every visit, in front of whatever screen needs it. Measured on the live
// deploy 2026-09-21: all ~200 art and audio files were in exactly that state.
//
// Nothing about that is visible. The requests come back 304 with no body, so a
// bytes-transferred view shows nothing, the game works perfectly, and the only symptom is a
// slower start that looks like the network. A new art directory added tomorrow would land in
// the same place in the same silence — hence a gate rather than a note.
//
// It checks only that a rule EXISTS and is not `max-age=0`. Which policy each directory gets
// is a judgement (`/assets/*` is content-hashed and immutable; the art is not and takes an
// hour of freshness plus a week of stale-while-revalidate — see the file's own comments), and
// a gate that pinned the exact string would fail on every deliberate change to it.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'client', 'public');
const HEADERS_FILE = path.join(PUBLIC_DIR, '_headers');

/**
 * Parse `_headers` into `{ pattern, directives }`. The format is a path pattern on a column-0
 * line, followed by indented `Name: value` lines; `#` comments and blank lines are skipped.
 *
 * @param {string} text
 * @returns {{ pattern: string, headers: Record<string, string> }[]}
 */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: {} });
      continue;
    }
    const at = raw.indexOf(':');
    const current = rules[rules.length - 1];
    if (at === -1 || !current) continue;
    current.headers[raw.slice(0, at).trim().toLowerCase()] = raw.slice(at + 1).trim();
  }
  return rules;
}

/**
 * Which top-level directories under `client/public/` are shipped as assets. `_headers` itself
 * is configuration rather than an asset, and the loose `.html` policy pages are served by name.
 *
 * @param {string} [dir]
 * @returns {string[]}
 */
export function assetDirectories(dir = PUBLIC_DIR) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * @param {string[]} dirs
 * @param {{ pattern: string, headers: Record<string, string> }[]} rules
 * @returns {string[]} one line per problem; empty means the file covers everything
 */
export function findUncachedDirs(dirs, rules) {
  const problems = [];
  for (const dir of dirs) {
    const rule = rules.find((r) => r.pattern === `/${dir}/*`);
    if (!rule) {
      problems.push(`/${dir}/* has no rule — it falls to the platform default (max-age=0)`);
      continue;
    }
    const cc = rule.headers['cache-control'];
    if (!cc) {
      problems.push(`/${dir}/* has a rule but no Cache-Control in it`);
    } else if (/max-age\s*=\s*0(\D|$)/.test(cc) || /\bno-store\b/.test(cc)) {
      problems.push(`/${dir}/* is cached for zero seconds (${cc}) — a round trip per file, per visit`);
    }
  }
  return problems;
}

export function checkAssetHeaders() {
  return findUncachedDirs(assetDirectories(), parseHeaders(readFileSync(HEADERS_FILE, 'utf8')));
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build/checkAssetHeaders.mjs')) {
  const problems = checkAssetHeaders();
  if (problems.length > 0) {
    console.error('FAILED — client/public/_headers does not cover every shipped asset directory:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nAdd a rule to client/public/_headers. See that file for what the policies mean.');
    process.exit(1);
  }
  console.log(`checkAssetHeaders: ${assetDirectories().length} asset directories, all cached.`);
}
