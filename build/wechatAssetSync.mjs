// Bundle boundaries, build half (design/12 "Bundle boundaries", design/04).
//
// One implementation of "which shipped file goes into which WeChat package, and how big is
// each package", shared by the two things that need to agree about it:
//
//   - client/vite.wechat.config.js's copy step, which mirrors the files into
//     platforms/wechat (the project WeChat DevTools opens), and
//   - build/checkWeChatPackage.mjs, the byte-budget gate.
//
// The pack table itself is client/src/render/assetPacks.json, which the RUNTIME also reads
// (client/src/render/assetManifest.ts). Three readers, one table — that is the whole reason
// it is JSON rather than TypeScript.
//
// Layout note: a mini-game resolves a package path from the PROJECT ROOT (where game.json
// lives), not relative to the script that asks for it. So the art mirrors to
// platforms/wechat/<packRoot>/skins/... and the bundle stays at js/game.js, matching what
// `packedPathFor` hands to wx.createImage().
import { readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

/** Web-only files under client/public that must never enter the mini-game package. */
const WEB_ONLY = new Set(['_headers']);

/** Top-level entries in `platforms/wechat` that this sync never touches. Everything else there
 *  is plan-owned and is pruned to match — see `syncAssets`. `project.config.json` /
 *  `project.private.config.json` carry the real appid and DevTools' own local state; `game.js`
 *  and `js/` are the bundle, written by the vite build rather than by the asset plan. */
const RESERVED_TOP_LEVEL = new Set(['game.js', 'game.json', 'js', 'project.config.json', 'project.private.config.json']);

export function loadAssetPacks(repoRoot) {
  const path = join(repoRoot, 'client', 'src', 'render', 'assetPacks.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

/** Which pack a public-relative path ('/biome/floor_ice.jpg') belongs to. Mirrors
 *  assetManifest.ts's `packOf` exactly — first matching prefix wins, else the default. */
export function packOf(packs, webPath) {
  return packs.rules.find((r) => webPath.startsWith(r.prefix))?.pack ?? packs.defaultPack;
}

function packRoot(packs, name) {
  const def = packs.packs.find((p) => p.name === name);
  if (!def) throw new Error(`assetPacks.json: rule references unknown pack '${name}'`);
  return def.root;
}

/**
 * What the WeChat project should contain, and what each package weighs.
 *
 * `js/game.js` is counted against the main package on purpose: WeChat's 4 MB ceiling covers
 * code and assets together, so a gate that measured only the art would go green while the
 * package it describes was over budget.
 */
export function planPackage(repoRoot) {
  const packs = loadAssetPacks(repoRoot);
  const publicDir = join(repoRoot, 'client', 'public');
  const files = [];

  for (const abs of walk(publicDir)) {
    const rel = relative(publicDir, abs).split('\\').join('/');
    if (WEB_ONLY.has(rel)) continue;
    const webPath = `/${rel}`;
    const pack = packOf(packs, webPath);
    const root = packRoot(packs, pack);
    files.push({
      abs,
      webPath,
      pack,
      dest: root ? `${root}/${rel}` : rel,
      size: statSync(abs).size,
    });
  }

  // The built bundle, if there is one. Absent before the first `build:wechat`, in which case
  // the plan reports art only and says so rather than pretending the main package is small.
  const bundle = join(repoRoot, 'client', 'wechat', 'js', 'game.js');
  const hasBundle = existsSync(bundle);
  if (hasBundle) {
    files.push({
      abs: bundle,
      webPath: null,
      pack: packs.mainPack,
      dest: 'js/game.js',
      size: statSync(bundle).size,
    });
  }

  const byPack = packs.packs.map((p) => ({
    ...p,
    bytes: files.filter((f) => f.pack === p.name).reduce((n, f) => n + f.size, 0),
    count: files.filter((f) => f.pack === p.name).length,
  }));

  return {
    packs,
    files,
    byPack,
    hasBundle,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    totalLimitBytes: packs.totalLimitBytes,
  };
}

/** Non-main packs become `subpackages` entries in game.json. With a single pack this is an
 *  empty list and the file is copied through unchanged.
 *
 *  Filters on `mainPack`, NOT `defaultPack` — the two are different ideas and have been
 *  different values since 2026-09-01 (see assetPacks.json's $comment). `defaultPack` is now
 *  `run`, a real subpackage, so the old filter would have dropped it from game.json and left
 *  `wx.loadSubpackage('run')` naming nothing. */
export function subpackageEntries(packs) {
  return packs.packs
    .filter((p) => p.name !== packs.mainPack)
    .map((p) => ({ name: p.name, root: p.root.endsWith('/') ? p.root : `${p.root}/` }));
}

/**
 * Every subpackage needs a `game.js` at its root, even one that holds nothing but art.
 *
 * The 分包 docs describe `root` as "a directory, whose game.js is the entry file" and never
 * document a resource-only subpackage, so the safe reading is that the entry is required and
 * an asset-only pack is an undocumented edge case. Writing a no-op entry costs ~200 bytes per
 * pack and removes the question entirely — the same thing the engine-backed mini-game
 * templates do.
 */
const SUBPACKAGE_ENTRY = `// Generated by build/wechatAssetSync.mjs — do not edit.
//
// This subpackage carries ART ONLY (see client/src/render/assetPacks.json). A WeChat
// subpackage's \`root\` is documented as a directory whose game.js is its entry, so this
// no-op exists to satisfy that contract; the files beside it become reachable as soon as
// wx.loadSubpackage resolves, which is all the game actually wants from it.
`;

/** Remove directories left empty by the file prune, bottom-up. An empty directory costs no
 *  package bytes, but a stale `skins/boss-core/` sitting beside the real one in
 *  `packs/boss/skins/boss-core/` is exactly the kind of thing someone reads as the live copy.
 *  Never removes `dir` itself — the plan owns it and the next copy pass writes into it. */
function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    pruneEmptyDirs(child);
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true });
  }
}

/**
 * Mirror the planned art into `platforms/wechat`, pruning anything left over from a previous
 * build. Pruning matters more here than in a normal copy step: a renamed or deleted texture
 * that stays behind is invisible on web (nothing requests it) but keeps costing package
 * bytes, which is exactly the drift this whole pass exists to stop. Everything in the target is
 * pruned to match the plan EXCEPT `RESERVED_TOP_LEVEL` — the bundle and the appid config.
 */
export function syncAssets(repoRoot, log = console.log) {
  const plan = planPackage(repoRoot);
  const target = join(repoRoot, 'platforms', 'wechat');
  const artFiles = plan.files.filter((f) => f.webPath !== null);
  const owned = new Set(artFiles.map((f) => f.dest));
  // The generated per-subpackage entry files, added to `owned` before the prune sweep so it
  // does not delete them on the next build.
  const entries = subpackageEntries(plan.packs).map((e) => `${e.root}game.js`);
  for (const e of entries) owned.add(e);

  // Prune every top-level entry in the target EXCEPT the reserved ones. Derived by exclusion,
  // not from the plan, and that is the whole point: a set built from what the plan owns TODAY
  // cannot clean up a directory the plan used to own. Moving all the art out of the main package
  // (2026-09-01, design/12) does exactly that — `biome/`, `ui/`, `skins/`, `weapons/` and
  // `environment/` stop appearing in any `dest`, so a plan-derived sweep skips them and leaves a
  // full stale copy of the old main package sitting in the FIRST download, invisible to the byte
  // gate (which weighs `client/public` through the rules, never the built tree).
  const ownedTopLevel = new Set([
    // `existsSync` first: on a fresh checkout this is the build that CREATES the directory, and
    // a bare readdir there is an ENOENT out of the first `npm run build:wechat` anyone runs.
    ...(existsSync(target)
      ? readdirSync(target, { withFileTypes: true })
        .filter((e) => !RESERVED_TOP_LEVEL.has(e.name))
        .map((e) => e.name)
      : []),
    // Every subpackage root, even one with no files today, so emptying a pack removes its old
    // contents rather than leaving them to be downloaded forever.
    ...plan.packs.packs.filter((p) => p.root).map((p) => p.root.split('/')[0]),
  ]);

  for (const top of ownedTopLevel) {
    const dir = join(target, top);
    if (!existsSync(dir)) continue;
    // A top-level entry derived by exclusion can be a plain FILE, not just a directory — and
    // `walk` readdirs whatever it is given, so a stray note dropped into `platforms/wechat`
    // used to abort the whole build with ENOTDIR. Unreserved and unplanned makes it stale by
    // the same rule as a stale texture, so prune it and move on. (`RESERVED_TOP_LEVEL` is
    // filtered out above, which is what keeps `game.js` — also a file — off this path.)
    if (!statSync(dir).isDirectory()) {
      rmSync(dir);
      continue;
    }
    for (const abs of walk(dir)) {
      const rel = relative(target, abs).split('\\').join('/');
      if (!owned.has(rel)) rmSync(abs);
    }
    pruneEmptyDirs(dir);
    // ...and the top-level directory itself once it holds nothing, which the sweep alone cannot
    // do (`pruneEmptyDirs` never removes its own argument). This is the visible half of the
    // 2026-09-01 move: with every asset now under `packs/`, `ui/` and `skins/` would otherwise
    // sit there empty beside `packs/lobby/ui/` — no package bytes, but exactly the "which of
    // these two is the live copy" question this pruning exists to prevent. Safe because the copy
    // pass below re-creates whatever it needs with `mkdirSync(..., { recursive: true })`.
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }

  let copied = 0;
  for (const f of artFiles) {
    const dest = join(target, f.dest);
    if (existsSync(dest) && statSync(dest).size === f.size) continue; // unchanged
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
    copied += 1;
  }

  for (const e of entries) {
    const dest = join(target, e);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, SUBPACKAGE_ENTRY, 'utf8');
  }

  // project.config.json is seeded ONLY if absent. `platforms/` is git-ignored local scratch,
  // and whoever has a real appid keeps it in that file — overwriting it every build would
  // throw that away. Seeding it at all is what makes a fresh checkout's `platforms/wechat`
  // openable in DevTools (tourist appid) instead of erroring on a missing config, which is
  // what design/04 always assumed was there and never was.
  const projectConfig = join(target, 'project.config.json');
  if (!existsSync(projectConfig)) {
    copyFileSync(join(repoRoot, 'client', 'wechat', 'project.config.json'), projectConfig);
    log('    seeded project.config.json (tourist appid — replace with a real one to publish)');
  }

  // game.json carries the subpackage declaration, so it is generated rather than copied
  // straight through the moment a second pack exists.
  const shell = JSON.parse(readFileSync(join(repoRoot, 'client', 'wechat', 'game.json'), 'utf8'));
  const subs = subpackageEntries(plan.packs);
  if (subs.length > 0) shell.subpackages = subs;
  else delete shell.subpackages;
  writeFileSync(join(target, 'game.json'), `${JSON.stringify(shell, null, 2)}\n`, 'utf8');

  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  log(`  synced ${artFiles.length} asset files (${copied} changed) → platforms/wechat`);
  if (subs.length > 0) log(`    game.json declares ${subs.length} subpackage(s): ${subs.map((x) => x.name).join(', ')}`);
  for (const p of plan.byPack) log(`    pack '${p.name}': ${p.count} files, ${mb(p.bytes)} / ${mb(p.limitBytes)}`);
  return plan;
}
