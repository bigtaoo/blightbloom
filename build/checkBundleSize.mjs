#!/usr/bin/env node
// Shipped-size budget gate over the BUILT web client (design/20 "First-download size").
// Ported from the sibling project `funny` (client/scripts/checkBundleSize.mjs), scaled to this
// repo's phases.
//
// Why it exists: checkWeChatPackage.mjs already budgets each asset pack, but it measures
// client/public, so it cannot see the two numbers a web player actually waits on: the code (the
// entry bundle, which design/12 deliberately does not split) and the art in front of the lobby.
// A portal like CrazyGames judges a game on exactly that first wait. This reads both back out of
// the real build, post-minification and post-hash, so it cannot drift from what ships.
//
// Deliberately ABSOLUTE budgets with stated headroom (build/bundle-size-budget.json), not a
// ratchet on any growth: bytes move on every dependency bump and art re-export, and a no-growth
// ratchet would be red on commits that did nothing wrong. A budget fails only when a change eats
// the headroom, and raising one needs a written reason in the JSON.
//
// What is measured:
//   entry.brotli  the module script index.html loads plus every chunk it modulepreloads, brotli
//                 q11. A STABLE RELATIVE METRIC, not the wire size: Cloudflare compresses on the
//                 fly at a lower quality (funny measured ~27% more on the wire for the same file).
//   lobby.wait    raw bytes of every file in a `main`/`lobby` phase pack (assetPacks.json): the
//                 lobby's art. Only its uiSkins `boot` tier is awaited behind the splash (sized by
//                 uiSkins.test.ts); the rest is kicked right after. PNG/JPEG do not compress further.
//   run.wait      raw bytes of every `run` phase pack: what the run gate awaits on the first Play.
//   dist.total    every emitted file: the upload, and the portal's total-size figure.
//
// Not in `npm run check` (it needs a build; build/checkScriptChain.test.mjs records the
// exemption). CI runs it in the `check` job after `build:crazygames`.
//
// Usage: node build/checkBundleSize.mjs [--dist=client/dist-crazygames] [--budget=build/bundle-size-budget.json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import { loadAssetPacks, packOf } from './wechatAssetSync.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const KIB = 1024;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The entry module and its modulepreloads, as dist-relative paths, in document order. */
export function codeFiles(html) {
  const entry = /<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/.exec(html);
  if (!entry) throw new Error('no <script type="module" src> in index.html — did the build emit an entry chunk?');
  const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
  return [entry[1], ...preloads].map((p) => p.replace(/^\.?\//, ''));
}

/** Measure a built dist. Throws (rather than reporting zero) on anything that means the
 *  build is not what this gate thinks it is. */
export function measure(dist, packs) {
  let html;
  try {
    html = readFileSync(join(dist, 'index.html'), 'utf8');
  } catch {
    throw new Error(`${join(dist, 'index.html')} not found — build the client first (this gate measures real build output)`);
  }
  const code = codeFiles(html);
  let entryBrotli = 0;
  for (const name of code) {
    let bytes;
    try {
      bytes = readFileSync(join(dist, name));
    } catch {
      throw new Error(`${name} is referenced by index.html but missing from the build output`);
    }
    entryBrotli += brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY } }).length;
  }

  const phaseOf = new Map(packs.packs.map((p) => [p.name, p.phase]));
  const byPhase = { main: 0, lobby: 0, run: 0, background: 0 };
  let total = 0;
  for (const abs of walk(dist)) {
    const rel = relative(dist, abs).split('\\').join('/');
    const size = statSync(abs).size;
    total += size;
    // Code and the HTML pages are not asset-pack members: the bundler and the host page own them.
    if (rel.startsWith('assets/') || !rel.includes('/')) continue;
    const phase = phaseOf.get(packOf(packs, `/${rel}`));
    if (!(phase in byPhase)) throw new Error(`/${rel} maps to pack phase '${phase}', which this gate does not know`);
    byPhase[phase] += size;
  }

  return {
    'entry.brotli': { bytes: entryBrotli, what: `${code.length} code files (the entry + its modulepreloads), brotli q11 — before anything can run` },
    'lobby.wait': { bytes: byPhase.main + byPhase.lobby, what: '`main` + `lobby` phase art — the lobby: its first frame (awaited) and its decoration (kicked right after)' },
    'run.wait': { bytes: byPhase.run, what: '`run` phase art — what the run gate awaits on the first Play' },
    'dist.total': { bytes: total, what: 'every emitted file — the upload' },
  };
}

/** Compare a measurement against budgets. Returns report lines and whether anything failed;
 *  a measured key with no budget fails too, so a new number cannot ship unbudgeted. */
export function judge(measured, budgets) {
  const kib = (n) => `${(n / KIB).toFixed(1)} KiB`;
  const lines = [];
  let failed = false;
  for (const [key, { bytes, what }] of Object.entries(measured)) {
    const budget = budgets[key];
    if (!budget) {
      lines.push(`  ✖ ${key}: no budget entry in bundle-size-budget.json`);
      failed = true;
      continue;
    }
    const over = bytes > budget.maxBytes;
    failed ||= over;
    const pct = ((bytes / budget.maxBytes) * 100).toFixed(1);
    lines.push(`  ${over ? '✖' : '✓'} ${key.padEnd(13)} ${kib(bytes).padStart(11)} / ${kib(budget.maxBytes).padStart(11)}  (${pct}%)`);
    lines.push(`      ${what}`);
    if (over) {
      lines.push(`      OVER BUDGET by ${kib(bytes - budget.maxBytes)}. Budget rationale: ${budget.reason}`);
      lines.push('      Cut bytes, or raise the budget *with a written reason* — the number is a decision, not a high-water mark.');
    }
  }
  return { lines, failed };
}

function main() {
  const arg = (name, dflt) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return resolve(process.cwd(), hit ? hit.slice(name.length + 3) : join(repoRoot, dflt));
  };
  const dist = arg('dist', 'client/dist-crazygames');
  const budgets = JSON.parse(readFileSync(arg('budget', 'build/bundle-size-budget.json'), 'utf8'));
  let measured;
  try {
    measured = measure(dist, loadAssetPacks(repoRoot));
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
  }
  const { lines, failed } = judge(measured, budgets);
  console.log(`Shipped-size budgets (${relative(process.cwd(), dist) || dist}):\n`);
  console.log(lines.join('\n'));
  if (failed) {
    console.error('\n❌ shipped-size budget exceeded (see above).\n');
    process.exit(1);
  }
  console.log('\n✅ all shipped-size budgets met.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
