// The frame-rate acceptance run (see README.md here): play a real run for N seconds, descend a floor
// halfway, and report frames per wall-clock second. The target it checks is the one the 2026-09-28
// passes were held to: every second within 3 frames of every other.
//
//   node tools/perf/accept.mjs [--throttle 4] [--secs 60] [--descend-at 30] [--warmup 60]
//                              [--port 9333] [--page localhost:5173] [--max-spread 3] [--reload]
//
// `--reload` reloads the tab under the throttle before anything else, so `--warmup 0 --reload`
// measures the cold start a player gets rather than whatever state the tab was left in.
//
// Exit code 1 when the spread is over `--max-spread`, so it can gate a script — but read the README's
// "noise" section before treating a single red run as a regression.
import { connectPage, parseArgs } from './cdp.mjs';

const opts = parseArgs(process.argv.slice(2), {
  port: 9333,
  page: 'localhost:5173',
  throttle: 4,
  secs: 60,
  descendAt: 30,
  warmup: 60,
  maxSpread: 3,
  reload: false,
});

/**
 * Runs IN THE PAGE (serialised by `cdp.evaluate`), so it may only use what the page has:
 * `window.__game`, which every client entry point exposes for exactly this.
 */
async function measure({ secs, descendAt }) {
  // A freshly opened dev page spends several seconds transforming modules before the game exists.
  for (let i = 0; !window.__game && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game;
  if (!g) throw new Error('window.__game never appeared in 60 s — is this the game page?');
  const tk = g.app.ticker;
  const engine = () => g.gameLoop.host.getEngine();
  const covered = () => g.layers.overlay.children.some((c) => !c.destroyed) || g.roomBuilder.building;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Frame brackets: first and last ticker listener, so `work` is the whole scripted frame.
  const frames = [];
  let frameStart = 0;
  const open = () => { frameStart = performance.now(); };
  const close = () => frames.push({ t: tk.lastTime, work: performance.now() - frameStart, covered: covered() });
  tk.add(open, null, 1000);
  tk.add(close, null, -1000);
  // Unkillable, so a long run measures the game and not the death screen.
  const god = () => { const p = engine()?.state?.players?.[0]; if (p) { p.maxHp = 1e5; p.hp = 1e5; } };
  tk.add(god, null, 2000);

  try {
    if (g.gameLoop.host.getPhase() !== 'playing') g.runs.beginQuickRun();
    const deadline = performance.now() + 30000;
    while (covered() || g.gameLoop.host.getPhase() !== 'playing') {
      if (performance.now() > deadline) throw new Error('the run never became playable');
      await sleep(5);
    }
    const t0 = performance.now();
    // Walk a square with a pause in it, so the camera pans, the culling moves and enemies follow.
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code }));
    const pattern = ['KeyD', 'KeyS', 'KeyA', 'KeyW', null];
    let step = 0;
    let descended = false;
    while (performance.now() - t0 < secs * 1000) {
      if (!descended && descendAt > 0 && performance.now() - t0 > descendAt * 1000) {
        descended = true;
        const e = engine();
        e.extraction.resolveDescend(e.state, e.state.floorCardOffer[0]);
      }
      const code = pattern[step++ % pattern.length];
      if (code) key('keydown', code);
      await sleep(1500);
      if (code) key('keyup', code);
    }

    const F = frames.slice(Math.max(0, frames.findIndex((f) => f.t >= t0 - 20)));
    if (F.length < secs * 10) {
      throw new Error(`only ${F.length} frames in ${secs} s${document.hidden ? ' — the tab is hidden, so Chrome is not drawing it (README: start Chrome with the no-backgrounding flags)' : ''}`);
    }
    const base = F[0].t;
    const perSec = [];
    for (const f of F) {
      const s = Math.floor((f.t - base) / 1000);
      perSec[s] = (perSec[s] ?? 0) + 1;
    }
    perSec.pop(); // the last second is partial
    const long = [];
    for (let j = 1; j < F.length; j++) {
      const dt = F[j].t - F[j - 1].t;
      if (dt > 20) long.push({ atMs: Math.round(F[j].t - base), dtMs: +dt.toFixed(1), workMs: +F[j - 1].work.toFixed(1), covered: F[j - 1].covered });
    }
    const work = F.map((f) => f.work).sort((a, b) => a - b);
    const pct = (p) => +work[Math.min(work.length - 1, Math.floor(work.length * p))].toFixed(1);
    return {
      seconds: perSec.length,
      perSecMin: Math.min(...perSec),
      perSecMax: Math.max(...perSec),
      spread: Math.max(...perSec) - Math.min(...perSec),
      perSec: perSec.join(','),
      workP50: pct(0.5),
      workP99: pct(0.99),
      workMax: pct(1),
      // A long frame whose own scripted work was short is the compositor, the GPU or another
      // process — not this frame's code. Split so the report says which.
      longFrames: long.length,
      longScripted: long.filter((l) => l.workMs > 12).length,
      worstLong: [...long].sort((a, b) => b.workMs - a.workMs).slice(0, 5),
    };
  } finally {
    tk.remove(open);
    tk.remove(close);
    tk.remove(god);
  }
}

const page = await connectPage(opts);
try {
  await page.front();
  await page.throttle(opts.throttle);
  console.log(`page ${page.url}, CPU throttle ${opts.throttle}x`);
  if (opts.reload) {
    // Reloaded AFTER the throttle is on, so the page's own load and first JIT pass run on the slow
    // CPU too. The old execution context dies with the page, so poll until the new one answers.
    // `Page.reload` returns before the old page is gone, so a marker on the old window is what
    // tells the two apart: the new page is ready once the marker is absent and `__game` is present.
    await page.evaluate(() => { window.__perfBeforeReload = true; });
    await page.send('Page.reload', { ignoreCache: true });
    const t = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      const ready = await page.evaluate(() => !window.__perfBeforeReload && !!window.__game).catch(() => false);
      if (ready) break;
      if (Date.now() - t > 120000) throw new Error('the reloaded page never exposed window.__game');
    }
    console.log(`reloaded: window.__game after ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  if (opts.warmup > 0) {
    // A cold page is slow for its first few seconds at 4x, on dev and production alike: 0-4 slow
    // seconds on dev over 7 runs, 1-8 on production (README "cold start", volumes 108 and 112).
    // The ~30 s JIT tail this default was first chosen for did not reproduce. It stays at 60 s
    // because it absorbs those seconds for the price of one minute.
    console.log(`warm-up: ${opts.warmup} s, discarded`);
    await page.evaluate(measure, { secs: opts.warmup, descendAt: 0 });
  }
  console.log(`measuring: ${opts.secs} s${opts.descendAt > 0 ? `, descend at ${opts.descendAt} s` : ''}`);
  const r = await page.evaluate(measure, { secs: opts.secs, descendAt: opts.descendAt });
  console.log(JSON.stringify(r, null, 1));
  const ok = r.spread <= opts.maxSpread;
  console.log(`${ok ? 'PASS' : 'FAIL'}: frames per second ${r.perSecMin}-${r.perSecMax}, spread ${r.spread} (max ${opts.maxSpread}); work p50 ${r.workP50} ms, p99 ${r.workP99} ms`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await page.throttle(1);
  page.close();
}
