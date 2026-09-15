// Standalone environment fixtures (design/05 "Room & door model", 2026-08-04) — the door
// pair, the five in-run drop sprites, the extraction portal's arch (2026-08-20 pickup/
// portal art pass), the room props (2026-08-24) and the shop's shopkeeper (2026-09-14, the
// first PERSON in this registry rather than a fixture). Same non-blocking best-effort
// preload pattern as biomeTiles.ts/weaponSkins.ts: a missing/not-yet-generated sprite just
// leaves its caller on the existing Graphics fallback, never blocks boot.
import { Assets, Texture } from 'pixi.js';
import { resolveAssetUrl } from './assetHost';

/** Exported so the WeChat package checks can enumerate the real FILES this loader asks
 *  for — see biomeTiles.ts's BIOME_TILE_ASSETS for the full note. */
export const ENV_SPRITE_ASSETS: Readonly<Record<string, string>> = {
  door_locked: '/environment/door_locked_raw.png',
  door_open: '/environment/door_open_raw.png',
  // The open state's own "this is loud too" signal (2026-08-30, live report: the hazard
  // flame reads instantly, the passable state didn't come close at a glance). A vertical
  // curtain of warm-gold energy filling the opening, additive — see `doorRender.ts`'s
  // `drawOpenRecessShade`/curtain wiring for why it needed to be a whole illustrated asset
  // rather than another procedural gradient: the hazard leaf IS a full illustrated panel,
  // and nothing procedural was ever going to match that weight.
  door_curtain: '/environment/door_curtain_raw.png',
  // In-run drops (design/09's pickup vocabulary). `weapon` has no file here on purpose —
  // a weapon drop draws the mounted weapon's OWN business-end art (render/weaponSkins.ts),
  // so that it reads as "that specific gun", not as a generic loot icon.
  pickup_material: '/environment/pickup_material.png',
  pickup_heal: '/environment/pickup_heal.png',
  pickup_buff: '/environment/pickup_buff.png',
  pickup_crate: '/environment/pickup_crate.png',
  pickup_bandage: '/environment/pickup_bandage.png',
  // The extraction checkpoint's standing stone arch. Only the STRUCTURE is art — the
  // vortex rings, core, infalling motes and ground bloom stay program-drawn in Portal.ts
  // (they animate every frame, which a sprite cannot do).
  portal_arch: '/environment/portal_arch.png',
  // Room dressing (`RoomPiece.props`), 2026-08-24. Keyed `prop_<kind>` to match
  // `getPropTexture`, whose lookup is built from `propRender.ts`'s own `PropKind` union —
  // add a kind there and its art slots in here under the same name with no other change.
  prop_crate: '/environment/prop_crate.png',
  prop_barrel: '/environment/prop_barrel.png',
  prop_rubble: '/environment/prop_rubble.png',
  // Chests (design/05 "Chest rooms"), 2026-09-15 — four files, because a chest has two kinds
  // and each kind has two states and `ChestLayer` swaps the sprite in place. Keyed
  // `chest_<kind>[_open]` to match `getChestTexture`, the same "add a row, nothing else
  // changes on the render side" shape `prop_<kind>` already has. Sized off `ChestLayer`'s own
  // drawn widths at the 8x rule the props batch set (`art/props/prompts.md`), which is why the
  // two OPEN files are taller than wide: the lid is thrown back and the art's own aspect sets
  // the drawn height.
  chest_small: '/environment/chest_small.png',
  chest_small_open: '/environment/chest_small_open.png',
  chest_big: '/environment/chest_big.png',
  chest_big_open: '/environment/chest_big_open.png',
  // The shop's shopkeeper (2026-09-14, design/05 "Shops"). Filed under `environment/`
  // rather than `ui/` where `npc_forger.png` sits, because this one stands IN a room and
  // is Y-sorted against the actors — the hub Forger is a corner-anchored UI sprite. It is
  // art ONLY: nothing about the purchase verb changed, the panel still opens on
  // `SHOP_INTERACT_RANGE_GRID` proximity, so a missing file costs the room a person and
  // costs the run nothing.
  npc_shopkeeper: '/environment/npc_shopkeeper.png',
};

/** Every key the getters below can resolve once preloaded — exposed so tests can assert a
 *  key is actually registered, since the getters return `undefined` identically for both a
 *  missing key and a registered key whose file hasn't loaded (network-independent by
 *  design, same shape as biomeTiles.ts/uiSkins.ts). */
export const ENV_SPRITE_ASSET_KEYS: readonly string[] = Object.keys(ENV_SPRITE_ASSETS);

const textures = new Map<string, Texture>();

export async function preloadEnvironmentSprites(): Promise<void> {
  await Promise.all(
    Object.entries(ENV_SPRITE_ASSETS).map(async ([key, path]) => {
      try {
        // Every file here is a LONE OBJECT drawn far smaller than its source (a 192 px
        // pickup lands at ~18 px on screen, a 10:1 minification; the doors and the arch
        // are ~2.4:1 and ~8.5:1), so each one needs a mip chain — and the chain has to be
        // requested at LOAD time, since setting the flag on an already-uploaded GPU
        // texture does nothing (the 2026-08-12 rig-art colour-noise bug, design/12).
        // No `addressMode: 'repeat'` for the same reason biomeTiles.ts withholds it from
        // its sprite keys: wrapping a lone object's edge samples its own far side.
        const tex = await Assets.load<Texture>({ src: resolveAssetUrl(path), data: { autoGenerateMipmaps: true } });
        textures.set(key, tex);
      } catch {
        // Not generated yet (or failed to fetch) — fine, the caller's Graphics fallback
        // covers it.
      }
    }),
  );
}

/** A dungeon door's fixture texture (design/05: "always-present, exactly two visual
 *  states, locked/open — never a bare gap"). Undefined until preloaded — RoomBuilder
 *  falls back to a flat tinted rect. */
export function getDoorTexture(locked: boolean): Texture | undefined {
  return textures.get(locked ? 'door_locked' : 'door_open');
}

/** The open state's curtain-of-light overlay (`doorRender.ts`). Undefined until preloaded —
 *  the door falls back to the plain floor-tile recess it drew before this art existed. */
export function getDoorCurtainTexture(): Texture | undefined {
  return textures.get('door_curtain');
}

/** An in-run drop's sprite, by `PickupKind`. Undefined for `weapon` (which draws the real
 *  weapon art instead) and for anything not yet loaded — `Pickup` falls back to the flat
 *  Graphics silhouette it drew before this art existed. */
export function getPickupTexture(kind: string): Texture | undefined {
  return textures.get(`pickup_${kind}`);
}

/** The extraction portal's standing arch. Undefined until preloaded — `Portal` falls back
 *  to the two stroked ellipses it drew before this art existed. */
export function getPortalArchTexture(): Texture | undefined {
  return textures.get('portal_arch');
}

/** A room prop's real-art sprite, by its resolved kind (`propRender.resolvePropKind`). All
 *  three of today's kinds shipped 2026-08-24; the getter still returns `undefined` for an
 *  unregistered kind, which is what keeps `buildPropBody`'s Graphics branch reachable for
 *  the next kind added before its art exists. The prediction the previous version of this
 *  comment made held exactly: landing the art was three rows in `ENV_SPRITE_ASSETS` and
 *  nothing else on the render side. */
export function getPropTexture(kind: string): Texture | undefined {
  return textures.get(`prop_${kind}`);
}

/** A chest's sprite, by kind and open state (`scene/ChestLayer.ts`). Undefined until
 *  preloaded — `buildChestBody` falls back to the Graphics form the chest shipped with, which
 *  is still the only form for any state whose file has not arrived. Re-asked every frame until
 *  it resolves (`ChestLayer.sync`), so a floor built while `preloadEnvironmentSprites()` was in
 *  flight still picks the art up. */
export function getChestTexture(kind: string, opened: boolean): Texture | undefined {
  return textures.get(`chest_${kind}${opened ? '_open' : ''}`);
}

/** The shop counter's shopkeeper (`scene/ShopLayer.ts`). Undefined until preloaded — and a
 *  shop whose keeper texture never arrives simply draws no keeper, which is exactly the
 *  room design/05 described before this art existed. Unlike every other getter here there
 *  is no Graphics fallback behind it on purpose: a procedural blob standing behind the
 *  counter would be a SECOND authored form of a character, and the counter's own Graphics
 *  form is already "the current form" rather than a stand-in (see `ShopLayer.ts`'s header).
 *  `ShopLayer` re-asks every frame until it resolves, so a late-arriving texture still
 *  lands on a counter that was built before it. */
export function getShopkeeperTexture(): Texture | undefined {
  return textures.get('npc_shopkeeper');
}
