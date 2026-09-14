/**
 * The SHIPPED shopkeeper art itself (`client/public/environment/npc_shopkeeper.png`),
 * decoded and measured (2026-09-14). Sibling of `propArt.test.ts`/`environmentArt.test.ts`/
 * `pillarArt.test.ts`, for the same reason those exist: every other test in this directory
 * checks what the renderer does with *a* texture, and this object's whole look — it has no
 * Graphics form at all, deliberately (`ShopLayer.ts`'s header) — lives in the file.
 *
 * Two things make this the first art file in the directory that is a PERSON rather than a
 * fixture, and both are what the assertions below are shaped around:
 *
 * 1. **It must not join the environment value band.** Every assertion in `propArt.test.ts`
 *    pushes a prop DOWN into the stonework (`p50` 35-60, against the floor's own 39-49) so
 *    dressing never reads as lootable. A character is the opposite case: design/13 separates
 *    "environment desaturated, hazards saturated", and an NPC that sinks to a barrel's 42 is
 *    a smudge behind a counter. The band here is bounded on BOTH sides instead — above the
 *    stone it stands on, below the drop it must never be mistaken for.
 * 2. **Its aspect is load-bearing composition, not just size.** `ShopLayer` scales the keeper
 *    by WIDTH and lets the art set its height (the rule every sprite in this scene follows),
 *    and the keeper stands `KEEPER_BACK_PX` north of a counter whose awning is the tallest
 *    thing it draws. So a replacement file that came back wider-than-tall would file the
 *    merchant's head behind that awning — a defect with no failing test anywhere else in the
 *    repo, and one no percentage of coverage can see. The last block drives the REAL file's
 *    dimensions through the REAL layer and measures where the head lands.
 *
 * There is no `_alt` reject to re-measure here — the generation was accepted first time, so
 * the "an assertion that stops discriminating fails here rather than passing vacuously" block
 * `propArt.test.ts` gets from its rejected rubble is built from SHIPPED files instead: each
 * discriminating assertion is re-run against an existing asset that must fail it.
 *
 * Reference measurements taken on the accepted file at import (298x320): luma p05/25/50/75/95
 * = 17.5/66.2/103.2/129.9/177.6, chroma 49.8, lean R+26.9/G-6.5/B-20.4, alpha 52.0% solid /
 * 43.9% clear / 2.37% midtone. Neighbours it is placed against: `npc_forger.png` (the hub's
 * NPC) p50 99.5 chroma 68.7, `pickup_crate.png` p50 166.9, `prop_barrel.png` p50 42.2,
 * `skins/skirmisher-core/shell.png` chroma 151.5.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Container, Texture, TextureSource } from 'pixi.js';
import type { GameState, Shop } from '@dd/engine';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { KEEPER_BACK_PX, KEEPER_WIDTH_PX, ShopLayer } from './ShopLayer';

const mocks = vi.hoisted(() => ({ keeperTexture: undefined as Texture | undefined }));

vi.mock('../../render/environmentSprites', () => ({
  getShopkeeperTexture: () => mocks.keeperTexture,
}));

interface Img {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function load(rel: string): Img {
  return decodePNG(readFileSync(new URL(rel, import.meta.url))) as Img;
}

/** Alpha 25 rather than 0, for the reason `propArt.test.ts` spells out: it is the line the
 *  two plateaus `alphaClamp.mjs` snaps sit either side of, so a measurement means the same
 *  thing on a clamped file and on an unprocessed generation. */
const OPAQUE = 25;

function bbox(img: Img): { x: number; y: number; w: number; h: number } {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function aspect(img: Img): number {
  const b = bbox(img);
  return b.w / b.h;
}

function luma(img: Img): (p: number) => number {
  const v: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    v.push(0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!);
  }
  v.sort((a, b) => a - b);
  return (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))]!;
}

function chroma(img: Img): number {
  let c = 0;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    const r = img.data[i * 4]!;
    const g = img.data[i * 4 + 1]!;
    const b = img.data[i * 4 + 2]!;
    c += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  return c / n;
}

const SHOPKEEPER = '../../../public/environment/npc_shopkeeper.png';
const LOOT = '../../../public/environment/pickup_crate.png';
const STONE = '../../../public/environment/prop_barrel.png';
const ELEMENTAL = '../../../public/skins/skirmisher-core/shell.png';
const FORGER = '../../../public/ui/npc_forger.png';

describe('the shipped shopkeeper art — what the import pipeline has to have done to it', () => {
  it('is trimmed tight, so a bottom-anchored sprite stands ON its ground point', () => {
    // The veil bug, stated as the thing that would have been visible. The generation arrived
    // with a body at 253 inside a halo of alpha 1-10 reaching ~200 px past it; `compress.mjs`
    // trims on `alpha !== 0`, so unclamped it would have trimmed to 1058x1393 (aspect 0.760)
    // instead of 864x928 (0.931) — 22% wrong — and kept a band of empty rows underneath that a
    // bottom-anchored sprite turns into clearance between the merchant and the floor.
    const img = load(SHOPKEEPER);
    const b = bbox(img);
    expect({ x: b.x, y: b.y }).toEqual({ x: 0, y: 0 });
    expect({ w: b.w, h: b.h }).toEqual({ w: img.width, h: img.height });
  });

  it('has genuinely opaque pixels rather than a 99%-opaque plateau', () => {
    // `alpha-audit.mjs` classifies on `alpha == 255`; a body left at 253 reports 0% opaque on
    // a file that is actually clean, which retires the audit as a signal for everything after.
    const img = load(SHOPKEEPER);
    let solid = 0;
    let clear = 0;
    let midtone = 0;
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] === 255) solid++;
      else if (img.data[i] === 0) clear++;
      else if (img.data[i]! >= 10 && img.data[i]! <= 245) midtone++;
    }
    const total = img.width * img.height;
    expect(solid / total).toBeGreaterThan(0.25);
    expect(clear / total).toBeGreaterThan(0.1);
    expect(midtone / total).toBeLessThan(0.1); // antialiasing only — a real haze sits far above
  });
});

/**
 * The two bands, written as PREDICATES rather than inline expectations, so the control block
 * below can run the identical rule over files that must fail it. An assertion spelled out
 * twice — once for the subject, once negated for a control — drifts apart the first time a
 * threshold is retuned, and the control quietly stops controlling anything.
 */
/** Between the stonework it stands on and the drops it must never be mistaken for. This is
 *  the one place an NPC's rule differs from a prop's: `propArt.test.ts` pushes dressing DOWN
 *  into the floor's own 39-49 band, and a character down there is a smudge behind a counter. */
function inPersonValueBand(img: Img): boolean {
  const p50 = luma(img)(0.5);
  return p50 - STONE_P50 > 40 && LOOT_P50 - p50 > 40;
}

/** Out of the saturation range design/13 reserves for the five combat elements, which every
 *  enemy body wears at runtime through `rigTint`. */
function underElementalChroma(img: Img): boolean {
  return chroma(img) < 80;
}

const STONE_P50 = luma(load(STONE))(0.5);
const LOOT_P50 = luma(load(LOOT))(0.5);

describe('the shipped shopkeeper art — tone, against the room it has to stand in', () => {
  it('has real contrast partners either side of it', () => {
    // The guard the two bands rest on: if the reference files ever drifted together, every
    // band assertion below would go slack without failing.
    expect(LOOT_P50).toBeGreaterThan(150);
    expect(STONE_P50).toBeLessThan(60);
  });

  it('reads as a person, not as stonework and not as a drop', () => {
    // The floor and every prop on it median 42-53; a pickup medians 167, and anything near
    // that is something a player walks over to collect. The keeper sits between, at 103.
    expect(inPersonValueBand(load(SHOPKEEPER))).toBe(true);
  });

  it('keeps a lit plane and a shadow side rather than reading flat', () => {
    // The art brief's key light is upper-left, which at a 28 px display width is most of what
    // carries the form — a flat fill would read as a coloured blob behind the counter.
    const q = luma(load(SHOPKEEPER));
    expect(q(0.75)).toBeGreaterThan(q(0.25) * 1.5);
  });

  it('stays below the elemental-character chroma band, so it is never read as an enemy', () => {
    // It measures 49.8 against a skirmisher's 151.5, with the hub's own Forger NPC at 68.7
    // marking where an already-accepted NPC sits.
    expect(underElementalChroma(load(SHOPKEEPER))).toBe(true);
  });
});

describe('the same two rules, run over files that must FAIL them', () => {
  // There is no rejected shopkeeper generation to measure, so the controls are shipped assets
  // chosen to sit on the wrong side of each band. Without this block, a threshold widened far
  // enough to admit anything would leave every test above passing and pinning nothing.
  it('the value band rejects a drop sprite', () => {
    expect(inPersonValueBand(load(LOOT))).toBe(false);
  });

  it('the value band rejects a stone prop', () => {
    expect(inPersonValueBand(load(STONE))).toBe(false);
  });

  it('the chroma bound rejects an elemental character body', () => {
    expect(underElementalChroma(load(ELEMENTAL))).toBe(false);
  });

  it('the chroma bound does NOT reject the hub NPC that already shipped', () => {
    // The other direction, and the reason the bound is 80 rather than 55: `npc_forger.png`
    // measures 68.7. A rule tightened until only this one file passes is a rule about this
    // one file, not about what an NPC may look like.
    expect(underElementalChroma(load(FORGER))).toBe(true);
  });
});

describe('the shipped shopkeeper art — driven through the REAL layer at its REAL aspect', () => {
  // `ShopLayer.test.ts` proves the arithmetic with a stand-in texture; this proves the shipped
  // FILE lands where that arithmetic assumes. Both are needed: the stand-in tests would keep
  // passing after an art replacement that broke the composition, and this one alone would not
  // say which of position, sort order or scale had moved.
  function harness(): { entities: Container; layer: ShopLayer; state: GameState } {
    const entities = new Container();
    const layer = new ShopLayer(entities, new Container());
    const shops = [
      { id: 1, roomId: 'r1', gx: 10_000, gy: 12_000, stock: [{ id: 1, kind: 'heal', price: 12, sold: false }] },
    ] as unknown as Shop[];
    return { entities, layer, state: { shops } as unknown as GameState };
  }

  function withShippedAspect<T>(run: () => T): T {
    const img = load(SHOPKEEPER);
    mocks.keeperTexture = new Texture({ source: new TextureSource({ width: img.width, height: img.height }) });
    try {
      return run();
    } finally {
      mocks.keeperTexture = undefined;
    }
  }

  it('puts the merchant HEAD above the counter awning, at the real file dimensions', () => {
    withShippedAspect(() => {
      const { entities, layer, state } = harness();
      layer.update(state);
      const counterTop = entities.children[0]!.getBounds().top;
      const keeperTop = entities.children[1]!.getBounds().top;
      // Not merely "higher" — high enough to be a head and shoulders rather than a sliver.
      // 9 px back + 28/0.931 tall puts the top 10 px clear of the awning apex.
      expect(counterTop - keeperTop).toBeGreaterThan(6);
    });
  });

  it('stays short enough to skip the occlusion x-ray the counter also skips', () => {
    // `propRender.ts` records the bound this rests on: the shortest object in the game that
    // genuinely needs the x-ray (a wall, a pillar, a door) stands 70 px, because that is the
    // reach at which art north of its own footprint starts covering the HEAD of a character
    // standing beyond it. The keeper reaches ~39 and the Y-sort alone gets it right; art that
    // doubled in height would silently start eating players standing behind the counter.
    const reach = KEEPER_BACK_PX + KEEPER_WIDTH_PX / aspect(load(SHOPKEEPER));
    expect(reach).toBeLessThan(70);
  });
});
