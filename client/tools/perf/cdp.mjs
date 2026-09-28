// The one Chrome DevTools Protocol connection the perf tools share (see README.md here).
//
// Talks to a Chrome started with `--remote-debugging-port`, picks the tab whose URL contains
// `page`, and runs a function inside it. No dependency: Node's own `fetch` and `WebSocket`.

/**
 * Connect to the first tab whose URL contains `page`.
 * @param {{ port: number, page: string }} opts
 */
export async function connectPage({ port, page }) {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    throw new Error(`no Chrome is listening on port ${port} — start one with --remote-debugging-port=${port} (README.md)`);
  }
  const tab = list.find((t) => t.type === 'page' && t.url.includes(page));
  if (!tab) throw new Error(`no tab matches "${page}"; open tabs: ${list.filter((t) => t.type === 'page').map((t) => t.url).join(', ') || 'none'}`);

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not open ${tab.webSocketDebuggerUrl}`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    url: tab.url,
    send,
    /** Run `fn(arg)` in the page, await it, and return its (JSON-serialisable) result. */
    async evaluate(fn, arg) {
      const res = await send('Runtime.evaluate', {
        expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 30 * 60 * 1000,
      });
      const ex = res.result?.exceptionDetails;
      if (ex) throw new Error(`in page: ${ex.exception?.description ?? ex.text}`);
      return res.result?.result?.value;
    },
    /** A background tab gets its frames throttled by Chrome itself, which is not the device being
     *  measured — so every run brings its tab to the front first. */
    front: () => send('Page.bringToFront'),
    /** CPU slowdown factor; 1 is off. Chrome keeps it until it is reset, so callers reset it in a
     *  `finally`. */
    throttle: (rate) => send('Emulation.setCPUThrottlingRate', { rate }),
    close: () => ws.close(),
  };
}

/** `--name value` / `--flag` argv parsing, against a table of defaults (numbers stay numbers). */
export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) throw new Error(`unexpected argument "${argv[i]}"`);
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in defaults)) throw new Error(`unknown option --${m[1]}; known: ${Object.keys(defaults).map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')}`);
    if (typeof defaults[key] === 'boolean') out[key] = true;
    else out[key] = typeof defaults[key] === 'number' ? Number(argv[++i]) : argv[++i];
  }
  return out;
}
