// The culling pixel A/B (see README.md here): does skipping off-screen floor and standing pieces
// change a single pixel? At a grid of camera positions over the current floor it renders the frame
// with the game's own cull (`FxController.syncCamera`) and again with every piece un-culled, and
// diffs the two.
//
//   node tools/perf/cullAB.mjs [--grid 4] [--port 9333] [--page localhost:5173]
//
// Three controls are part of the result, not decoration: the same frame rendered twice must diff
// to zero (else the frame is not deterministic and a zero diff means nothing), the positions must
// differ from each other (else the camera never moved), and culling EVERY piece must change a
// frame that had one on screen (else the diff cannot see a piece at all).
import { connectPage, parseArgs } from './cdp.mjs';

const opts = parseArgs(process.argv.slice(2), { port: 9333, page: 'localhost:5173', grid: 4 });

/** Runs IN THE PAGE — see `accept.mjs`'s `measure` for the rules. */
async function abCull({ grid }) {
  // A freshly opened dev page spends several seconds transforming modules before the game exists.
  for (let i = 0; !window.__game && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
  const g = window.__game;
  if (!g) throw new Error('window.__game never appeared in 60 s — is this the game page?');
  const R = g.app.renderer;
  const gl = R.gl;
  const L = g.layers;
  const tk = g.app.ticker;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (g.gameLoop.host.getPhase() !== 'playing') g.runs.beginQuickRun();
  const deadline = performance.now() + 30000;
  while (g.layers.overlay.children.some((c) => !c.destroyed) || g.roomBuilder.building || g.gameLoop.host.getPhase() !== 'playing') {
    if (performance.now() > deadline) throw new Error('the run never became playable');
    await sleep(5);
  }
  await sleep(1000);

  const grab = () => {
    R.render({ container: g.app.stage });
    const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const diff = (a, b) => {
    let n = 0;
    let max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 2) n++;
      if (d > max) max = d;
    }
    return { n, max };
  };
  const pieces = () => [...L.ground.children, ...L.entities.children].filter((c) => c.ddGroundBounds);

  tk.stop();
  const saved = { x: L.world.x, y: L.world.y };
  const viewport = { vw: g.app.screen.width, vh: g.app.screen.height };
  const zoom = L.world.scale.x;
  const floor = L.ground.getLocalBounds();
  const rows = [];
  let first = null;
  try {
    for (let iy = 0; iy < grid; iy++) {
      for (let ix = 0; ix < grid; ix++) {
        const cx = floor.minX + (floor.maxX - floor.minX - viewport.vw / zoom) * (ix / (grid - 1));
        const cy = floor.minY + (floor.maxY - floor.minY - viewport.vh / zoom) * (iy / (grid - 1));
        L.world.x = -cx * zoom;
        L.world.y = -cy * zoom;
        g.fx.syncCamera(viewport); // the shipped cull, for this camera
        const culled = pieces().filter((c) => c.culled).length;
        // Kept pieces that are really ON the screen, not just inside the cull's margin.
        const onScreen = pieces().filter((c) => {
          if (c.culled || !c.visible) return false;
          const b = c.getBounds();
          return b.maxX > 0 && b.minX < viewport.vw && b.maxY > 0 && b.minY < viewport.vh;
        }).length;
        const a = grab();
        const again = grab();
        for (const c of pieces()) c.culled = true;
        const none = grab();
        for (const c of pieces()) c.culled = false;
        const b = grab();
        first ??= a;
        rows.push({
          at: [Math.round(cx), Math.round(cy)], culled, of: pieces().length,
          repeat: diff(a, again).n, vsFirst: diff(a, first).n, cullDiff: diff(a, b),
          // With every piece culled the frame must LOSE something wherever a piece was on screen,
          // or this diff is blind to pieces and its zero above proves nothing.
          onScreen,
          blind: onScreen > 0 && diff(a, none).n === 0,
        });
      }
    }
  } finally {
    L.world.x = saved.x;
    L.world.y = saved.y;
    tk.start();
  }
  return { zoom, viewport, rows };
}

const page = await connectPage(opts);
try {
  await page.front();
  const r = await page.evaluate(abCull, { grid: opts.grid });
  for (const row of r.rows) {
    console.log(`camera ${String(row.at).padEnd(12)} culled ${String(row.culled).padStart(3)}/${row.of}, ${String(row.onScreen).padStart(2)} on screen  diff ${row.cullDiff.n} px (max ${row.cullDiff.max})  repeat ${row.repeat}${row.blind ? "  BLIND" : ""}`);
  }
  const deterministic = r.rows.every((row) => row.repeat === 0);
  const moved = r.rows.slice(1).some((row) => row.vsFirst > 0);
  const culledAny = r.rows.some((row) => row.culled > 0);
  const clean = r.rows.every((row) => row.cullDiff.n === 0);
  const sighted = r.rows.every((row) => !row.blind);
  if (!deterministic) console.log('INVALID: the same frame rendered twice differs — the zero-diff result means nothing');
  if (!moved) console.log('INVALID: every camera position rendered the same frame');
  if (!sighted) console.log('INVALID: culling every piece changed nothing on screen — the diff cannot see a piece');
  if (!culledAny) console.log('INVALID: nothing was culled at any position — the floor fits the view, try a bigger floor or a higher zoom');
  const ok = deterministic && moved && culledAny && sighted && clean;
  console.log(ok ? 'PASS: culling changes no pixel' : clean ? 'FAIL: controls did not hold' : 'FAIL: culling changes pixels');
  process.exitCode = ok ? 0 : 1;
} finally {
  page.close();
}
