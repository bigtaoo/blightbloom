/**
 * Every shipped PNG is an 8-bit palette PNG unless it is named below with a reason.
 *
 * Palette quantisation (tools/png-pipeline/quantize.py, 2026-10-15) cut the shipped art from
 * ~3.4 MB of RGBA to ~1.5 MB, and nothing about the bytes says so: `compress.mjs` re-encodes any
 * file it touches back to RGBA, and freshly exported art lands as RGBA, each at roughly three
 * times the bytes, with every other test still green. This is what turns that red. The fix is a
 * run of quantize.py (which measures the file against the accepted bar), not a new entry here,
 * unless the file fails the bar.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

/** Files that stay RGBA, each with why. quantize.py's numbers are mean / p99 against a bar of
 *  2.93 / 14 — fine gradients and thin glints that band visibly in 256 colours. */
const RGBA_ALLOWED: Readonly<Record<string, string>> = {
  'environment/door_curtain_raw.png': 'owner call: the curtain keeps its source pixels (design/12 2026-09-01b)',
  'skins/skirmisher-core/belly.png': 'fails the bar: p99 14.3',
  'skins/skirmisher-core/shell.png': 'fails the bar: p99 16.0',
  'ui/icon_party_create.png': 'fails the bar: mean 3.66, p99 15.0',
  'ui/icon_result_extract.png': 'fails the bar: mean 4.89, p99 20.0',
  'weapons/sword_emberblade.png': 'fails the bar: mean 3.31',
  'weapons/sword_frostbrand.png': 'fails the bar: mean 3.91, p99 16.0',
  'weapons/sword_leech.png': 'fails the bar: mean 3.35',
  'weapons/sword_stormglaive.png': 'fails the bar: mean 3.36',
};

function shippedPngs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? shippedPngs(join(dir, e.name)) : e.name.endsWith('.png') ? [join(dir, e.name)] : [],
  );
}

/** IHDR colour type: 2 RGB, 3 palette, 6 RGBA. */
function colourType(path: string): number {
  const bytes = readFileSync(path);
  expect(bytes.subarray(12, 16).toString('latin1'), `${path} IHDR offset`).toBe('IHDR');
  return bytes[25]!;
}

const FILES = shippedPngs(PUBLIC).map((p) => relative(PUBLIC, p).split('\\').join('/')).sort();

describe('shipped PNG format', () => {
  it('finds the shipped art at all', () => {
    expect(FILES.length).toBeGreaterThan(100); // 126 on 2026-10-15
  });

  it('every PNG outside the allowlist is palette-quantised', () => {
    const rgba = FILES.filter((f) => !(f in RGBA_ALLOWED) && colourType(join(PUBLIC, f)) !== 3);
    expect(rgba, 'run tools/png-pipeline/quantize.py --apply over client/public').toEqual([]);
  });

  it.each(Object.keys(RGBA_ALLOWED))('%s is still shipped and still RGBA (no stale entry)', (file) => {
    expect(FILES).toContain(file);
    expect(colourType(join(PUBLIC, file))).toBe(6);
  });
});
