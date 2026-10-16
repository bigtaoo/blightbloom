// build/checkBundleSize.mjs — the shipped-size gate over the built web client. A gate nobody has
// seen fail is not a gate, so most of this points it at fixture trees and watches it go red.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeFiles, judge, measure } from './checkBundleSize.mjs';

const SCRIPT = fileURLToPath(new URL('./checkBundleSize.mjs', import.meta.url));

// A pack table shaped like assetPacks.json, small enough to read at a glance.
const PACKS = {
  defaultPack: 'run',
  packs: [
    { name: 'main', root: '', phase: 'main' },
    { name: 'lobby', root: 'packs/lobby', phase: 'lobby' },
    { name: 'music', root: 'packs/music', phase: 'background' },
    { name: 'run', root: 'packs/run', phase: 'run' },
  ],
  rules: [
    { prefix: '/ui/', pack: 'lobby' },
    { prefix: '/audio/music/', pack: 'music' },
  ],
};

const HTML = `<!doctype html><script src="https://sdk.example/sdk.js"></script>
<script type="module" crossorigin src="./assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="./assets/chunk-def.js">`;

let dist;
const put = (rel, bytes) => {
  mkdirSync(dirname(join(dist, rel)), { recursive: true });
  writeFileSync(join(dist, rel), bytes);
};

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'bundle-size-'));
  put('index.html', HTML);
  put('assets/index-abc.js', 'console.log(1);'.repeat(50));
  put('assets/chunk-def.js', 'export const x = 1;');
  put('ui/lobby_bg.jpg', Buffer.alloc(1000));
  put('ui/icon.png', Buffer.alloc(200));
  put('environment/chest.png', Buffer.alloc(3000));
  put('audio/music/menu.mp3', Buffer.alloc(5000));
});

afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('codeFiles', () => {
  it('reads the module entry and its modulepreloads, and not a classic third-party script', () => {
    expect(codeFiles(HTML)).toEqual(['assets/index-abc.js', 'assets/chunk-def.js']);
  });

  it('throws on a page with no module entry rather than measuring nothing', () => {
    expect(() => codeFiles('<script src="x.js"></script>')).toThrow(/no <script type="module"/);
  });
});

describe('measure', () => {
  it('buckets each file by its pack phase, and counts everything in the total', () => {
    const m = measure(dist, PACKS);
    expect(m['lobby.wait'].bytes).toBe(1200);
    expect(m['run.wait'].bytes).toBe(3000); // the default pack; music is `background`, in neither wait
    const html = Buffer.byteLength(HTML);
    expect(m['dist.total'].bytes).toBe(html + 750 + 19 + 1200 + 3000 + 5000);
  });

  it('measures the code compressed — less than its raw bytes, more than nothing', () => {
    const { bytes } = measure(dist, PACKS)['entry.brotli'];
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(750 + 19);
  });

  it('throws when index.html is missing — an unbuilt tree is not a passing one', () => {
    rmSync(join(dist, 'index.html'));
    expect(() => measure(dist, PACKS)).toThrow(/build the client first/);
  });

  it('throws when index.html names a chunk the build did not emit', () => {
    rmSync(join(dist, 'assets/chunk-def.js'));
    expect(() => measure(dist, PACKS)).toThrow(/chunk-def\.js is referenced by index.html but missing/);
  });

  it('throws on a pack whose phase it does not know, rather than dropping its bytes', () => {
    const odd = { ...PACKS, packs: PACKS.packs.map((p) => (p.name === 'run' ? { ...p, phase: 'someday' } : p)) };
    expect(() => measure(dist, odd)).toThrow(/phase 'someday'/);
  });
});

describe('judge', () => {
  const measured = { 'a.b': { bytes: 100, what: 'thing' } };

  it('passes at the budget and fails one byte over it', () => {
    expect(judge(measured, { 'a.b': { maxBytes: 100, reason: 'r' } }).failed).toBe(false);
    const over = judge(measured, { 'a.b': { maxBytes: 99, reason: 'because' } });
    expect(over.failed).toBe(true);
    expect(over.lines.join('\n')).toMatch(/OVER BUDGET.*because/);
  });

  it('fails a measured number with no budget, so nothing ships unbudgeted', () => {
    expect(judge(measured, {}).failed).toBe(true);
  });
});

describe('the CLI', () => {
  const run = (budget) => {
    const path = join(dist, '..', `${dist.split(/[\\/]/).pop()}-budget.json`);
    writeFileSync(path, JSON.stringify(budget));
    try {
      return spawnSync(process.execPath, [SCRIPT, `--dist=${dist}`, `--budget=${path}`], { encoding: 'utf8' });
    } finally {
      rmSync(path);
    }
  };
  const roomy = { maxBytes: 1e9, reason: 'r' };
  const all = (b) => ({ 'entry.brotli': b, 'lobby.wait': b, 'run.wait': b, 'dist.total': b });

  it('exits 0 when every budget holds', () => {
    // The real assetPacks.json routes this fixture's files too: /ui/ is lobby, the rest run/background.
    const r = run(all(roomy));
    expect(r.stdout).toMatch(/all shipped-size budgets met/);
    expect(r.status).toBe(0);
  });

  it('exits 1 when one budget is blown', () => {
    const r = run({ ...all(roomy), 'run.wait': { maxBytes: 10, reason: 'tight' } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✖ run\.wait/);
  });

  it('exits 1 on an unbuilt tree', () => {
    rmSync(join(dist, 'index.html'));
    const r = run(all(roomy));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/build the client first/);
  });
});

describe('the committed budget file', () => {
  const budgets = JSON.parse(readFileSync(new URL('./bundle-size-budget.json', import.meta.url), 'utf8'));

  it('budgets exactly what the gate measures, each with a written reason', () => {
    const keys = Object.keys(budgets).filter((k) => !k.startsWith('_')).sort();
    expect(keys).toEqual(Object.keys(measure(dist, PACKS)).sort());
    for (const k of keys) {
      expect(budgets[k].maxBytes, k).toBeGreaterThan(0);
      expect(budgets[k].reason.length, k).toBeGreaterThan(80);
    }
  });
});
