/**
 * The pack table's own rules, read from the SHIPPED `assetPacks.json` rather than a fixture.
 *
 * A fixture would defeat the point: what can actually go wrong here is a rule that stops
 * matching a real shipped path (a renamed texture), a rule naming a pack that does not exist,
 * or a deferral that is wrong about the content — none of which a hand-written table would
 * ever reproduce. `build/wechatAssetSync.mjs` reimplements `packOf` in plain Node for the
 * build and the byte gate, so the two are checked against each other at the bottom.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKS, SUBPACKS, DEFAULT_PACK, MAIN_PACK, TOTAL_LIMIT_BYTES,
  packOf, packDef, packedPathFor, packsForPhase, type PackPhase,
} from './assetManifest';
// The build's own copy of these rules, in plain Node — imported rather than re-implemented, so
// the bottom case below compares two SHIPPED implementations. There is no `.d.mts` beside it
// (unlike tools/png-pipeline/pngCodec.mjs), hence the suppression; the shapes are declared at the
// call site instead.
// @ts-expect-error — untyped .mjs, deliberately: build/ is plain Node with no declarations.
import { loadAssetPacks, packOf as rawPackOf } from '../../../build/wechatAssetSync.mjs';
import { BIOME_TILE_ASSETS } from './biomeTiles';
import { UI_ASSETS } from './uiSkins';
import { ENV_SPRITE_ASSETS } from './environmentSprites';
import { WEAPON_DEFS, KIND_DEFAULTS } from './weaponSkins';
import { CHAR_BUNDLES } from './preloadArt';
import { MUSIC_CATALOGUE } from '../audio/musicCatalogue';
import { allSfxPaths } from '../audio/cueCatalogue';

describe('the pack table', () => {
  it('has a main pack at the project root and gives every pack a distinct name and root', () => {
    expect(MAIN_PACK).toBe('main');
    expect(packDef(MAIN_PACK).root).toBe('');
    expect(new Set(PACKS.map((p) => p.name)).size).toBe(PACKS.length);
    expect(new Set(PACKS.map((p) => p.root)).size).toBe(PACKS.length);
  });

  it('throws for a pack that does not exist rather than defaulting to main', () => {
    // Silently defaulting would put a rule's assets in the main package while the gate
    // reported the subpackage as empty — a budget that lies is worse than no budget.
    expect(() => packDef('not-a-pack')).toThrow(/no pack named/);
  });

  it("keeps every subpackage's root under one top-level directory", () => {
    // build/wechatAssetSync.mjs prunes by first path segment, so a subpackage rooted at a
    // top-level name would put the prune sweep over a directory it does not own.
    for (const p of SUBPACKS) expect(p.root.startsWith('packs/')).toBe(true);
  });

  it('fits every pack limit inside the whole-game ceiling', () => {
    expect(PACKS.reduce((n, p) => n + p.limitBytes, 0)).toBeLessThanOrEqual(TOTAL_LIMIT_BYTES);
  });

  it('sends an unmatched path to a SUBPACKAGE, not to the first download', () => {
    // The safety property of the 2026-09-01 split (design/12): `mainPack` and `defaultPack`
    // used to be the same field and the same value, so a new asset added with no rule silently
    // enlarged the package WeChat downloads before the first frame. Now a rule is required to
    // opt into `main`, and the fallback is a background pack.
    expect(DEFAULT_PACK).not.toBe(MAIN_PACK);
    expect(SUBPACKS.map((p) => p.name)).toContain(DEFAULT_PACK);
    expect(packOf('/something/nobody/has/written/a/rule/for.png')).toBe(DEFAULT_PACK);
  });
});

describe('the load phases', () => {
  it('gives every pack a declared phase, and only the main pack the main phase', () => {
    const PHASES: readonly PackPhase[] = ['main', 'lobby', 'background', 'run'];
    for (const p of PACKS) expect(PHASES, `${p.name}`).toContain(p.phase);
    expect(PACKS.filter((p) => p.phase === 'main').map((p) => p.name)).toEqual([MAIN_PACK]);
  });

  it('has exactly one pack in the one phase a player waits for', () => {
    // `preloadLobbyArt` awaits this phase before `new Game(...)`, so every pack added to it is
    // added to the boot wait. One is the shape design/12 argues for; a second needs a reason.
    expect(packsForPhase('lobby').map((p) => p.name)).toEqual(['lobby']);
  });

  it('never awaits music, and awaits everything a run draws', () => {
    // Music is the one asset class a game can start without, and the deck cannot retry a path
    // whose pack was not there — see MusicPlayer.invalidate / design/12.
    expect(packsForPhase('background').map((p) => p.name)).toEqual(['music']);
    expect(packsForPhase('run').map((p) => p.name).sort()).toEqual(
      ['biome-ice', 'biome-lightning', 'biome-poison', 'boss', 'forge', 'run'],
    );
  });

  it('accounts for every subpackage in exactly one phase', () => {
    const counted = (['lobby', 'background', 'run'] as const).flatMap((ph) => packsForPhase(ph));
    expect(counted.length).toBe(SUBPACKS.length);
    expect(new Set(counted.map((p) => p.name)).size).toBe(SUBPACKS.length);
  });
});

describe('what the first download contains', () => {
  it('puts NO shipped asset in the main package', () => {
    // The invariant of design/12's "the first download is code only": `main` holds js/game.js
    // and nothing else. Swept over the real `client/public` tree rather than the loader tables,
    // because the failure this has to catch is a file nobody remembered to add to a table —
    // which is exactly the file that would land in `main` by accident if the default flipped
    // back. `_headers` is web-only and never enters the mini-game package
    // (build/wechatAssetSync.mjs's WEB_ONLY).
    const WEB_ONLY = new Set(['_headers']);
    const root = fileURLToPath(new URL('../../public/', import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const shipped = walk(root)
      .map((abs) => relative(root, abs).split(sep).join('/'))
      .filter((rel) => !WEB_ONLY.has(rel));
    expect(shipped.length).toBeGreaterThan(150); // a sweep over an empty list proves nothing
    for (const rel of shipped) expect(packOf(`/${rel}`), rel).not.toBe(MAIN_PACK);
    // ...and the tree really is what the byte gate weighs, so this list is the same list.
    expect(shipped.every((rel) => statSync(join(root, rel)).size > 0)).toBe(true);
  });

  it('holds the whole menu-shaped UI in the one pack the boot wait covers', () => {
    // Everything `preloadUiArt` asks for has to be in `lobby`: it is loaded immediately after
    // that pack and before `new Game(...)`, so a UI file deferred anywhere else would leave a
    // menu on its flat-colour fallback for as long as the background download takes.
    for (const path of Object.values(UI_ASSETS)) expect(packOf(path), path).toBe('lobby');
  });

  it('defers every weapon to the forge pack, which the forge gate awaits', () => {
    for (const def of [...Object.values(WEAPON_DEFS), ...Object.values(KIND_DEFAULTS)]) {
      expect(packOf(def!.path), def!.path).toBe('forge');
    }
  });

  it('defers both music tracks and no SFX to the never-awaited pack', () => {
    // SFX are ~123 kB across 61 files and every cue has a procedural voice, so they ride along
    // in `run` rather than needing a phase of their own. Music is 0.84 MB and is the pack
    // nothing awaits.
    for (const def of Object.values(MUSIC_CATALOGUE)) expect(packOf(def.path), def.path).toBe('music');
    for (const path of allSfxPaths()) expect(packOf(path), path).toBe(DEFAULT_PACK);
  });

  it('keeps fire and neutral out of the element subpackages — the only elements a run can reach', () => {
    // theme.ts's BIOME_ID_TO_ELEMENT maps the one authored dungeon ('ember') to 'fire', and
    // anything without a dungeonConfig (PvP, arena) falls to 'neutral'. Both must be in the
    // pack the run gate awaits, not in one of the unreachable-element packs.
    for (const el of ['fire', 'neutral'] as const) {
      for (const kind of ['floor', 'wall', 'wallface'] as const) {
        expect(packOf(BIOME_TILE_ASSETS[`${kind}_${el}`])).toBe(DEFAULT_PACK);
      }
    }
    expect(packOf(BIOME_TILE_ASSETS.pillar_neutral)).toBe(DEFAULT_PACK);
  });

  it('defers ice, lightning and poison, each to its own subpackage', () => {
    for (const el of ['ice', 'lightning', 'poison'] as const) {
      for (const kind of ['floor', 'wall', 'wallface'] as const) {
        expect(packOf(BIOME_TILE_ASSETS[`${kind}_${el}`]), `${kind}_${el}`).toBe(`biome-${el}`);
      }
    }
  });

  it('separates the boss rig from every floor-1 enemy body', () => {
    // `brute` and `floater` spawn on floor 1; `blightlord` (boss-core) is floor 5 only. This is
    // the assertion that would catch a pack renamed "elite" quietly swallowing the wrong rigs.
    const packOfBundle = (name: string): string =>
      packOf(`${CHAR_BUNDLES.find(([n]) => n === name)![1]}/animation.json`);
    expect(packOfBundle('boss-core')).toBe('boss');
    for (const name of ['char_vanguard', 'char_skirmisher', 'char_juggernaut', 'critter-core', 'brute-core', 'floater-core']) {
      expect(packOfBundle(name), name).toBe(DEFAULT_PACK);
    }
  });

  it('has no pack named for a symptom, and defers no environment sprite on its own', () => {
    // `oversized` existed for one 606 kB file because main had 2,729 bytes of headroom, and its
    // own note said to DELETE it rather than refill it once the pressure was off. It is gone;
    // the curtain sits in the run pack by domain, with every other door and fixture.
    expect(PACKS.map((p) => p.name)).not.toContain('oversized');
    for (const path of Object.values(ENV_SPRITE_ASSETS)) {
      expect(packOf(path), path).toBe(DEFAULT_PACK);
    }
  });
});

describe('packedPathFor', () => {
  it("prepends the pack root — which since 2026-09-01 every shipped asset has", () => {
    // The bare-relative form (no root, main package) is still what this returns for main-pack
    // content and is what `wx.createImage`/`readFileSync` want; there is simply no ASSET left
    // that takes that branch, because the first download is code only. A rule that opts a file
    // back into `main` would exercise it again.
    expect(packedPathFor('/biome/floor_fire.png')).toBe('packs/run/biome/floor_fire.png');
    expect(packedPathFor('/biome/floor_ice.png')).toBe('packs/biome-ice/biome/floor_ice.png');
    expect(packedPathFor('/ui/hub_bg.png')).toBe('packs/lobby/ui/hub_bg.png');
    expect(packedPathFor('/weapons/gun_blaster.png')).toBe('packs/forge/weapons/gun_blaster.png');
  });

  it('accepts a path that already has no leading slash', () => {
    expect(packedPathFor('biome/floor_fire.png')).toBe('packs/run/biome/floor_fire.png');
  });

  it('never emits a leading slash or a "./" segment', () => {
    // WeChat's FileSystemManager documents `a/b/c` and `/a/b/c` as valid and `./a/b/c` as not;
    // the relative form is what every sample uses, so that is what this must produce.
    for (const path of [...Object.values(BIOME_TILE_ASSETS), ...Object.values(UI_ASSETS)]) {
      const packed = packedPathFor(path);
      expect(packed.startsWith('/')).toBe(false);
      expect(packed.startsWith('./')).toBe(false);
    }
  });
});

describe('the build reimplements packOf, and the two must agree', () => {
  it('assigns every shipped asset to the same pack in both implementations', () => {
    // build/wechatAssetSync.mjs is plain Node (it runs from a vite plugin and from the gate,
    // neither of which can import TypeScript), so `packOf` genuinely exists twice. Both read
    // the same JSON; this checks they read it the same WAY — the first-match-wins ordering is
    // the part that could silently diverge.
    //
    // The BUILD's real function, imported, not a hand-copy of it. Until 2026-09-01 this case
    // re-implemented those two lines inline, which pinned the SHAPE of the rule and not the
    // shipped code at all: mutating the real `packOf` (`find` → `findLast`, `startsWith` →
    // `includes`) left both this test and build/wechatAssetSync.test.mjs green. `loadAssetPacks`
    // comes along for the ride so the table is read through the build's own loader too.
    const buildPacks = loadAssetPacks(fileURLToPath(new URL('../../../', import.meta.url)));
    const buildPackOf = (webPath: string): string => rawPackOf(buildPacks, webPath);

    const everyPath = [
      ...Object.values(BIOME_TILE_ASSETS),
      ...Object.values(UI_ASSETS),
      ...Object.values(ENV_SPRITE_ASSETS),
      ...Object.values(WEAPON_DEFS).map((d) => d!.path),
      ...CHAR_BUNDLES.map(([, baseUrl]) => `${baseUrl}/animation.json`),
    ];
    expect(everyPath.length).toBeGreaterThan(60);
    for (const path of everyPath) expect(buildPackOf(path), path).toBe(packOf(path));
  });

  it('agrees on paths chosen to break "first matching PREFIX wins"', () => {
    // Every shipped path above matches at most one rule and matches it at position 0, so the
    // sweep is blind to HOW either implementation matches: `startsWith` → `includes` changes the
    // answer for none of them. These do — each carries a real rule prefix somewhere other than
    // the front, which is the shape a generated or nested asset directory would actually take.
    const buildPacks = loadAssetPacks(fileURLToPath(new URL('../../../', import.meta.url)));
    const buildPackOf = (webPath: string): string => rawPackOf(buildPacks, webPath);
    const adversarial = [
      '/skins/orb-core/ui/eye.png', // contains '/ui/', starts with it nowhere
      '/generated/weapons/gun_blaster.png', // contains '/weapons/'
      '/audio/sfx/audio/music/impact.mp3', // contains '/audio/music/'
      '/skins/critter-core/skins/boss-core/frames.json', // contains '/skins/boss-core/'
      '/nobody/has/written/a/rule/for/this.png', // and one that matches nothing at all
    ];
    for (const path of adversarial) expect(buildPackOf(path), path).toBe(packOf(path));
    // The whole set has to fall to the default, or the two could agree by both being wrong.
    for (const path of adversarial) expect(packOf(path), path).toBe(DEFAULT_PACK);
  });
});
