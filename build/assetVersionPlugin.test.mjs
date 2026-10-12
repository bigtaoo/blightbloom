import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetVersionPlugin, hashPublicDir, VERSION_LENGTH } from './assetVersionPlugin.mjs';

describe('assetVersionPlugin', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dd-asset-version-'));
    await mkdir(path.join(dir, 'biome'));
    await writeFile(path.join(dir, 'biome', 'floor_fire.jpg'), 'bright');
    await writeFile(path.join(dir, 'icon.png'), 'icon');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keys every file, nested ones included, by its public path', () => {
    const map = hashPublicDir(dir);
    expect(Object.keys(map).sort()).toEqual(['/biome/floor_fire.jpg', '/icon.png']);
    for (const v of Object.values(map)) expect(v).toMatch(new RegExp(`^[0-9a-f]{${VERSION_LENGTH}}$`));
  });

  it('changes the hash when the CONTENT changes at the same size', async () => {
    // The regrade that motivated this kept the filename; a same-size re-export must still bust.
    const before = hashPublicDir(dir)['/biome/floor_fire.jpg'];
    await writeFile(path.join(dir, 'biome', 'floor_fire.jpg'), 'calmer');
    expect('calmer'.length).toBe('bright'.length);
    expect(hashPublicDir(dir)['/biome/floor_fire.jpg']).not.toBe(before);
    expect(hashPublicDir(dir)['/icon.png']).toBe(hashPublicDir(dir)['/icon.png']);
  });

  it('defines the map for the build only', () => {
    const plugin = assetVersionPlugin({ publicDir: dir });
    expect(plugin.apply).toBe('build');
    const out = plugin.config({});
    expect(JSON.parse(out.define.__DD_ASSET_VERSIONS__)).toEqual(hashPublicDir(dir));
  });

  it('defaults to <root>/public', async () => {
    await mkdir(path.join(dir, 'public'));
    await writeFile(path.join(dir, 'public', 'a.png'), 'a');
    const out = assetVersionPlugin().config({ root: dir });
    expect(Object.keys(JSON.parse(out.define.__DD_ASSET_VERSIONS__))).toEqual(['/a.png']);
  });
});
