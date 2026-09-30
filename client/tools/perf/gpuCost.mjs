// GPU cost by feature (see README.md here): what each render pass and each floor layer costs the
// GPU, measured by switching it off in a frozen frame of a real run and timing the frame with a
// GPU timer query.
//
//   node tools/perf/gpuCost.mjs [--rounds 7] [--n 8] [--reps 5] [--settle 4] [--viewport 844x390@3]
//                               [--port 9333] [--page localhost:4173]
//
// `--viewport WxH@DPR` emulates a screen (844x390@3 is a phone in landscape) and reloads the page
// under it, since the renderer picks its resolution once, at boot. The page is reloaded again
// without it afterwards: clearing the emulation alone leaves the renderer at the emulated
// resolution, and the next run would measure that without saying so.
//
// Open the page with `?perf=1`, or the draw / program / framebuffer columns stay empty.
//
// What this answers and what it does not: it ranks the costs on THIS GPU. A phone's GPU is a tiler
// with a fraction of the fill rate, so the absolute numbers do not transfer, and the ranking may not
// either: a tiler resolves MSAA on chip and charges for each render-target pass instead, which is
// why the framebuffer column is printed beside the times. Read the README before quoting it.
import { connectPage, parseArgs } from './cdp.mjs';

const opts = parseArgs(process.argv.slice(2), {
  port: 9333,
  page: 'localhost:4173',
  rounds: 7,
  n: 8,
  reps: 5,
  settle: 4,
  viewport: '',
});

/**
 * Runs IN THE PAGE (serialised by `cdp.evaluate`), so it may only use what the page has. A
 * production bundle has no importable modules and minified class names, so the Pixi classes it
 * needs are taken off live objects.
 */
async function measure({ rounds, n, reps, settle }) {
  for (let i = 0; !window.__game && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game;
  if (!g) throw new Error('window.__game never appeared in 60 s — is this the game page?');
  const app = g.app;
  const R = app.renderer;
  const gl = R.gl;
  const ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) throw new Error(`no EXT_disjoint_timer_query_webgl2 on ${gl?.getParameter(gl.VERSION)} — this surface cannot time the GPU`);
  const L = g.layers;
  const tk = app.ticker;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const engine = () => g.gameLoop.host.getEngine();
  const covered = () => L.overlay.children.some((c) => !c.destroyed) || g.roomBuilder.building;
  const god = () => { const p = engine()?.state?.players?.[0]; if (p) { p.maxHp = 1e5; p.hp = 1e5; } };

  // A frozen frame of a real run: start one, let enemies come on screen, then stop the ticker so
  // every sample renders the same scene.
  tk.add(god, null, 2000);
  if (g.gameLoop.host.getPhase() !== 'playing') g.runs.beginQuickRun();
  const deadline = performance.now() + 30000;
  while (covered() || g.gameLoop.host.getPhase() !== 'playing') {
    if (performance.now() > deadline) throw new Error('the run never became playable');
    await sleep(10);
  }
  await sleep(settle * 1000);
  tk.stop();
  tk.remove(god);

  const render = () => app.render();
  // One query around `n` renders. WebGL only makes a query result available after control has
  // gone back to the event loop, so the poll yields: a synchronous poll here spins forever.
  const query = async (draw) => {
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i++) draw();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    gl.finish();
    for (let i = 0; i < 2000; i++) {
      await sleep(0);
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        // Read once: reading GPU_DISJOINT_EXT clears it.
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        gl.deleteQuery(q);
        return disjoint ? null : ns / 1e6 / n;
      }
    }
    gl.deleteQuery(q);
    return null;
  };
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
  let discarded = 0;
  const timed = async (draw = render) => {
    // Two untimed renders first, so a render-group rebuild caused by the arm never lands inside
    // the query.
    draw(); draw(); gl.finish();
    const kept = [];
    for (let i = 0; i < reps; i++) {
      const v = await query(draw);
      if (v === null) discarded++;
      else kept.push(v);
    }
    return kept.length ? median(kept) : null;
  };

  // The fill calibration: ten full-screen 50%-alpha rects in their own render group, above the
  // world. Its cost divided by ten is what one full-screen blended layer costs on this GPU, the
  // unit the other rows are converted into.
  const GraphicsCtor = (() => {
    const stack = [app.stage];
    while (stack.length) {
      const node = stack.pop();
      if (node.context && typeof node.rect === 'function') return node.constructor;
      stack.push(...(node.children ?? []));
    }
    return null;
  })();
  const ContainerCtor = L.root.constructor;
  const fillLayer = new ContainerCtor();
  fillLayer.enableRenderGroup();
  const { width: sw, height: sh } = R.screen;
  // The same ten quads again, inside `world`, so they land in the screen-fx pass's target instead
  // of the canvas. The two differ when the canvas is multisampled and a filter target is not,
  // which is how the ratio between them reads MSAA's cost on this GPU. The inverse of `world`'s
  // transform puts them back in screen space.
  const fillLayerWorld = new ContainerCtor();
  fillLayerWorld.enableRenderGroup();
  for (const layer of [fillLayer, fillLayerWorld]) {
    for (let i = 0; i < 10 && GraphicsCtor; i++) {
      const quad = new GraphicsCtor();
      quad.rect(0, 0, sw, sh).fill({ color: 0xffffff, alpha: 0.5 });
      layer.addChild(quad);
    }
  }
  fillLayerWorld.setFromMatrix(L.world.worldTransform.clone().invert());

  const setting = g.settings.quality;
  const hide = (node) => () => { const was = node.visible; node.visible = false; return () => { node.visible = was; }; };
  const swapFilters = (changes) => () => {
    const saved = changes.map(([node]) => [node, node.filters]);
    for (const [node, filters] of changes) node.filters = filters;
    return () => { for (const [node, filters] of saved) node.filters = filters; };
  };
  const fx = g.fx;
  const arms = [
    // The twin control: an arm that changes nothing. Its delta is the noise floor of the run.
    { name: 'noop', apply: () => () => {} },
    { name: 'standMsaa', what: 'one unantialiased light pass instead of the split pair', apply: swapFilters([[L.lit, [fx.sceneLight]], [L.litFloor, []], [L.litStand, []]]) },
    { name: 'light', what: 'no scene-light pass at all', apply: swapFilters([[L.lit, []], [L.litFloor, []], [L.litStand, []]]) },
    { name: 'screenFx', what: 'no vignette + chromatic pass on world', apply: swapFilters([[L.world, []]]) },
    { name: 'bloom', what: 'no blur on fx', apply: swapFilters([[L.fx, []]]) },
    { name: 'ground', what: 'floor hidden', apply: hide(L.ground) },
    { name: 'shadow', what: 'ground shadows hidden', apply: hide(L.shadow) },
    { name: 'entities', what: 'walls, props, actors hidden', apply: hide(L.entities) },
    { name: 'terrain', what: 'the far-side plane hidden', apply: hide(L.terrain) },
    { name: 'tierMedium', what: 'the whole medium tier', apply: () => { g.quality.pin('medium'); return () => g.quality.pin(setting); } },
    { name: 'tierLow', what: 'the whole low tier', apply: () => { g.quality.pin('low'); return () => g.quality.pin(setting); } },
    // Paired with `noPasses`: the only difference between the two is whether the scene lands in
    // world's pass target (1x, no MSAA) or straight in the canvas.
    { name: 'worldPassOnly', what: 'light and bloom off, the world pass kept', apply: swapFilters([[L.lit, []], [L.litFloor, []], [L.litStand, []], [L.fx, []]]) },
    { name: 'noPasses', what: 'every filter pass off, resolution unchanged', apply: swapFilters([[L.lit, []], [L.litFloor, []], [L.litStand, []], [L.world, []], [L.fx, []]]) },
    { name: 'fill10', what: '+10 full-screen 50% layers on the canvas (calibration)', apply: () => { L.root.addChild(fillLayer); return () => L.root.removeChild(fillLayer); } },
    { name: 'fill10World', what: 'the same 10 layers inside the world pass', apply: () => { L.world.addChild(fillLayerWorld); return () => L.world.removeChild(fillLayerWorld); } },
  ];

  const counts = () => window.__perf?.attribute?.({})?.attribution?.total ?? null;
  const baseCounts = counts();
  const armCounts = {};
  for (const arm of arms) {
    const restore = arm.apply();
    render();
    armCounts[arm.name] = counts();
    restore();
  }

  // The empty-target control: rendering nothing must cost ~nothing, or the harness is timing
  // itself.
  const empty = new ContainerCtor();
  const emptyMs = await timed(() => R.render({ container: empty }));

  // Paired, interleaved: base, arm, base, arm, ... so each arm's delta is against the base samples
  // either side of it. The first round is a throwaway (the first arm after a build reads high), and
  // the arm order alternates direction per round so clock drift cannot line up with one arm.
  const deltas = Object.fromEntries(arms.map((a) => [a.name, []]));
  const bases = [];
  for (let round = 0; round <= rounds; round++) {
    const order = round % 2 ? [...arms].reverse() : arms;
    let before = await timed();
    for (const arm of order) {
      const restore = arm.apply();
      const v = await timed();
      restore();
      const after = await timed();
      if (round > 0 && v !== null && before !== null && after !== null) {
        deltas[arm.name].push(v - (before + after) / 2);
        bases.push(before);
      }
      before = after;
    }
  }
  tk.start();

  const stats = (xs) => (xs.length ? { med: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length } : null);
  return {
    gl: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
    screen: `${sw}x${sh} css, renderer resolution ${R.resolution}, canvas antialias ${gl.getContextAttributes().antialias}`,
    setting,
    enemies: engine()?.state?.enemies?.length ?? null,
    base: stats(bases),
    emptyMs,
    discarded,
    baseCounts,
    arms: arms.map((a) => ({ name: a.name, what: a.what ?? 'control', delta: stats(deltas[a.name]), counts: armCounts[a.name] })),
  };
}

const f = (x) => (x === null || x === undefined ? '   -  ' : x.toFixed(3).padStart(6));

/** Reload the tab and wait for the NEW page's game. `Page.reload` returns before the old page is
 *  gone, so a marker on the old window tells the two apart (same as accept.mjs --reload). */
async function reload(page) {
  await page.evaluate(() => { window.__perfBeforeReload = true; });
  await page.send('Page.reload', { ignoreCache: true });
  const t = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const ready = await page.evaluate(() => !window.__perfBeforeReload && !!window.__game).catch(() => false);
    if (ready) return;
    if (Date.now() - t > 120000) throw new Error('the reloaded page never exposed window.__game');
  }
}

const vp = opts.viewport ? /^(\d+)x(\d+)@([\d.]+)$/.exec(opts.viewport) : null;
if (opts.viewport && !vp) throw new Error(`--viewport wants WxH@DPR, e.g. 844x390@3; got "${opts.viewport}"`);
const page = await connectPage(opts);
try {
  await page.front();
  if (vp) {
    const [width, height, deviceScaleFactor] = [Number(vp[1]), Number(vp[2]), Number(vp[3])];
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: width < 1000 });
    await reload(page);
  }
  console.log(`page ${page.url}${vp ? `, viewport ${opts.viewport}` : ''}`);
  const r = await page.evaluate(measure, { rounds: opts.rounds, n: opts.n, reps: opts.reps, settle: opts.settle });
  const unit = r.arms.find((a) => a.name === 'fill10')?.delta?.med / 10;
  console.log(`${r.gl}; ${r.screen}; quality setting ${r.setting}; ${r.enemies} enemies`);
  console.log(`base frame ${f(r.base?.med)} ms GPU (min ${f(r.base?.min)}, max ${f(r.base?.max)}); empty target ${f(r.emptyMs)} ms; ${r.discarded} samples discarded as disjoint`);
  console.log(`one full-screen blended layer = ${f(unit)} ms, the unit of the "layers" column`);
  const c = (k) => (k ? `${String(k.draws).padStart(3)} ${String(k.programs).padStart(3)} ${String(k.framebuffers).padStart(3)}` : '  -   -   -');
  console.log(`\narm          saved ms  (min    max)    layers  draws prog fb   what`);
  console.log(`base                                          ${c(r.baseCounts)}`);
  for (const a of r.arms) {
    const d = a.delta;
    const saved = d ? -d.med : null;
    console.log(`${a.name.padEnd(12)} ${f(saved)}  (${f(d ? -d.max : null)} ${f(d ? -d.min : null)})  ${unit > 0 && saved !== null ? (saved / unit).toFixed(1).padStart(6) : '     -'}  ${c(a.counts)}   ${a.what}`);
  }
  const noop = r.arms.find((a) => a.name === 'noop')?.delta;
  const trusted = noop && Math.abs(noop.med) < 0.1 && unit > 0 && (r.emptyMs ?? 1) < 0.25 * (r.base?.med ?? 0) && r.discarded === 0;
  console.log(`\n${trusted ? 'TRUSTWORTHY' : 'NOT TRUSTWORTHY'}: noop delta ${f(noop?.med)} ms (must be under 0.1), fill calibration ${f(unit)} ms/layer (must be over 0), empty target under a quarter of the frame, no disjoint samples`);
  process.exitCode = trusted ? 0 : 1;
} finally {
  if (vp) {
    await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await reload(page).catch((e) => console.log(`could not reload after the viewport run: ${e.message}`));
  }
  page.close();
}
