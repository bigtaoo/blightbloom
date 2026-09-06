// Universal-mount weapon business-end textures (design/03/12/13): the socket base is
// identical for every weapon, so historically the render layer used ONE sprite per
// weapon KIND (ranged/melee) — a "fire rifle" and an "ice rifle" shared the same
// neutral gun_default art (element is a crystal-colour tint, applied separately).
//
// ROADMAP 5.3 follow-up: per-FRAME business-end art. `scattergun`/`seeker`/`mortar`/
// `lasercutter`/`tomahawk`/`novaburst`/`gyre`/`hammer`/`spear`/`blaster`/`repeater`/
// `cannon`/`carom`/`enemygun`/`saber`/`emberblade`/`frostbrand`/`stormglaive`/`leech`
// plus `enemyclaw`/`enemymaul`, the mob melee pair, which got their own art on 2026-09-06
// (see their note below) — each get a distinct silhouette (a shotgun muzzle reads differently from a beam
// emitter). Looked up by `WeaponSimSpec.name` (the weapon id), falling back to the
// KIND default for anything else.
//
// Preloaded like skinRegistry's character bundles: best-effort, never blocks gameplay
// if a fetch fails.
import { Assets, Texture } from 'pixi.js';
import { resolveAssetUrl } from './assetHost';

export type WeaponVisualKind = 'ranged' | 'melee';

export interface WeaponVisualDef {
  path: string;
  // Anchor = the socket-connector point in THIS texture's own bounding box (0..1
  // fraction of its width/height) — where the sprite pivots and where it's placed onto
  // the socket bone's world position (RigSkin.updateWeaponSprite).
  anchor: { x: number; y: number };
  // Normalizes this texture's own pixel dimensions down to the rig's authoring-px
  // convention (mirrors a rig bone's SpriteBinding.scaleX/Y, design/12).
  scale: number;
  // Most of the new business-end art was drawn "socket on the right, business end
  // trailing to the left" (a GPT Image 2 composition habit, not something requested) —
  // the OPPOSITE of gun_default/sword_default's own "socket upper-left, tip lower-right"
  // convention that `RigSkin`'s aim-tracking rotation assumes (rotation=0 already
  // points the authored art the way a 0-radian aim should look). Rather than pixel-
  // flip the source art, this offset (radians, added on top of the live aim rotation)
  // cancels each texture's own baked pointing direction so the mounted sprite still
  // reads as pointing at the reticle. Omitted = 0 (already-canonical art).
  rotationOffsetRad?: number;
}

const deg = (d: number): number => (d * Math.PI) / 180;

// Every `scale` below is that texture's own pixel-size normalization into rig authoring-px
// (measured per texture, see the table's comments). This factor is the separate, deliberate
// PROPORTION decision on top of it: how big a mounted module reads against the core it
// orbits. The measured scales put a gun at ~90 authoring-px against an 80-px core — about
// 2x the ratio in the concept art (`art/concept/02_weapon_mount_ranged.png`, where a module
// is roughly half the core's diameter), which at a 40-px on-screen body left the gun
// covering the hero's eye entirely (user report, 2026-08-17). Set to 0.75 rather than the
// concept's ~0.5: chosen by the user as the explicit middle of "match the concept" vs "keep
// every weapon frame's silhouette readable at gameplay scale" — it clears the face without
// shrinking the frames to indistinguishable nubs. Tune HERE, not in the table, so the
// per-texture measurements stay untouched.
export const MODULE_SCALE = 0.75;

// KIND_DEFAULTS' anchors are still the original first-pass eyeball (not yet
// re-measured live). WEAPON_DEFS' `rotationOffsetRad` values ARE measured, not
// eyeballed: a page-side script loaded each PNG into a canvas, took the alpha-
// farthest pixel from the (eyeballed) anchor as the tip, and computed the real
// baked angle from actual pixel data — see the session that added this table.
// Anchor fractions themselves are still first-pass eyeball, good enough since the
// rotation offset is what actually determines pointing direction.
// `scale`'s divisor is the SOURCE TEXTURE's own width, so it has to be re-derived whenever
// that art is resized — which is exactly what happened again on 2026-08-25, when every file
// here went 320 px -> 160 px for the WeChat package budget and all 27 divisors moved with
// them (`rigComposition.test.ts`'s module-proportion band caught the two bundles where they
// had not yet, before the change left the working tree). Both of these were left at `/1536`
// after their PNGs were downsampled to 320px — so the fallback
// silhouette rendered at ~22 authoring-px against an 80-px core, ~0.2x the body, a nub
// instead of a weapon. Found 2026-08-17 by `rigComposition.test.ts`'s module-proportion
// band, not by eye: this is the never-invisible FALLBACK path (`resolve()` below), so it
// only shows up for a weapon id with no entry of its own or after a texture load fails —
// rare enough to have gone unnoticed, and exactly what that fallback exists to prevent.
// 90/160 matches `repeater`/`cannon`'s generic housing, mid-range among the real entries.
const KIND_DEFAULTS: Record<WeaponVisualKind, WeaponVisualDef> = {
  ranged: { path: '/weapons/gun_default.png', anchor: { x: 0.25, y: 0.44 }, scale: 90 / 160 },
  melee: { path: '/weapons/sword_default.png', anchor: { x: 0.2, y: 0.455 }, scale: 90 / 160 },
};

// Both tables are exported for `rigComposition.test.ts`, which multiplies each `scale` by
// its texture's REAL on-disk pixel width to check the module actually reads as a module
// against the core it mounts on (the check that caught KIND_DEFAULTS' stale divisor above).
export { KIND_DEFAULTS };
export const WEAPON_DEFS: Partial<Record<string, WeaponVisualDef>> = {
  scattergun: { path: '/weapons/gun_scattergun.png', anchor: { x: 0.875, y: 0.245 }, scale: 80 / 160, rotationOffsetRad: deg(-156.8) },
  seeker: { path: '/weapons/gun_seeker.png', anchor: { x: 0.922, y: 0.278 }, scale: 78 / 160, rotationOffsetRad: deg(-161.3) },
  mortar: { path: '/weapons/gun_mortar.png', anchor: { x: 0.938, y: 0.628 }, scale: 85 / 160, rotationOffsetRad: deg(165.5) },
  lasercutter: { path: '/weapons/gun_lasercutter.png', anchor: { x: 0.922, y: 0.382 }, scale: 95 / 160, rotationOffsetRad: deg(-165) },
  tomahawk: { path: '/weapons/gun_tomahawk.png', anchor: { x: 0.906, y: 0.241 }, scale: 78 / 160, rotationOffsetRad: deg(-162.8) },
  novaburst: { path: '/weapons/gun_novaburst.png', anchor: { x: 0.875, y: 0.704 }, scale: 80 / 160, rotationOffsetRad: deg(178.4) },
  // Drawn the opposite way round from the other 8 (housing/socket on the LEFT, the
  // spinning disc business-end on the RIGHT) — close to gun_default's own convention,
  // so only a small offset.
  gyre: { path: '/weapons/gun_gyre.png', anchor: { x: 0.219, y: 0.448 }, scale: 85 / 160, rotationOffsetRad: deg(-7.8) },
  hammer: { path: '/weapons/sword_hammer.png', anchor: { x: 0.906, y: 0.508 }, scale: 75 / 160, rotationOffsetRad: deg(173.7) },
  spear: { path: '/weapons/sword_spear.png', anchor: { x: 0.906, y: 0.346 }, scale: 100 / 160, rotationOffsetRad: deg(-161.1) },
  // 2026-07-29 batch: prompted this time for the gun_default/sword_default convention
  // directly (socket upper-left, tip lower-right) instead of leaving it to chance — it
  // worked, all 10 landed within ~25 deg of their KIND_DEFAULTS reference, so offsets
  // are small this time instead of the near-180 deg flips the previous batch needed.
  // Anchors are first-pass eyeball (per the note above); rotationOffsetRad IS measured
  // by the same farthest-alpha-pixel-from-anchor method as the batch above.
  blaster: { path: '/weapons/gun_blaster.png', anchor: { x: 0.22, y: 0.42 }, scale: 80 / 160, rotationOffsetRad: deg(-1.2) },
  repeater: { path: '/weapons/gun_repeater.png', anchor: { x: 0.2, y: 0.44 }, scale: 90 / 160, rotationOffsetRad: deg(-0.1) },
  cannon: { path: '/weapons/gun_cannon.png', anchor: { x: 0.22, y: 0.35 }, scale: 90 / 160, rotationOffsetRad: deg(-5.7) },
  carom: { path: '/weapons/gun_carom.png', anchor: { x: 0.28, y: 0.35 }, scale: 85 / 160, rotationOffsetRad: deg(-13.5) },
  enemygun: { path: '/weapons/gun_enemygun.png', anchor: { x: 0.35, y: 0.35 }, scale: 80 / 160, rotationOffsetRad: deg(-14.4) },
  saber: { path: '/weapons/sword_saber.png', anchor: { x: 0.22, y: 0.42 }, scale: 100 / 160, rotationOffsetRad: deg(-12.1) },
  emberblade: { path: '/weapons/sword_emberblade.png', anchor: { x: 0.22, y: 0.4 }, scale: 100 / 160, rotationOffsetRad: deg(-9.8) },
  frostbrand: { path: '/weapons/sword_frostbrand.png', anchor: { x: 0.22, y: 0.32 }, scale: 100 / 160, rotationOffsetRad: deg(-15.1) },
  stormglaive: { path: '/weapons/sword_stormglaive.png', anchor: { x: 0.14, y: 0.32 }, scale: 100 / 160, rotationOffsetRad: deg(-5.8) },
  leech: { path: '/weapons/sword_leech.png', anchor: { x: 0.28, y: 0.35 }, scale: 90 / 160, rotationOffsetRad: deg(-12.9) },

  // Mob melee loadouts (ENGINE_VERSION 59, engine/content/weaponSpecs/dropOnly.ts). Real art
  // as of 2026-09-06 — until then these were the only two entries in this table pointing at
  // ANOTHER weapon's texture (the player spear's and hammer's), which made a raider's claw
  // read on screen as player gear, i.e. as loot you could pick up. What carries that signal
  // at a ~40 px on-screen body is the PALETTE rather than the silhouette, so the new art is
  // the mob one `gun_enemygun.png` established: dark blue-grey housing with a violet crystal,
  // against the player roster's white-and-gold. Prompts + workflow in `art/weapon/prompts.md`.
  //
  // Three things about this batch's calibration, none of which carried over from the
  // placeholder values it replaced:
  //
  //   - `rotationOffsetRad` is ~-47/-54 deg rather than the ~-160 the borrowed spear/hammer
  //     entries used. Those were cancelling THAT art's baked pointing direction, which is a
  //     property of the file and not of the weapon; re-measured here by the same
  //     alpha-farthest-pixel-from-anchor method the table's header documents (validated on
  //     the same pass against five shipped entries, which it reproduced within a few
  //     degrees — the residual being their own eyeballed anchors).
  //   - `anchor` is measured too, not eyeballed: the centroid of the alpha mass in the first
  //     12% of the object's own long axis from the socket end, i.e. the middle of the
  //     connector nub rather than the extreme pixel off the end of it.
  //   - `scale` is chosen so the weapon's ALONG-AXIS length in authoring px matches what the
  //     placeholder rendered (55.7 vs 55.6, and 65.6 vs 65.5), which is deliberately not the
  //     same thing as matching its `scale` divisor. This art is composed on a diagonal and
  //     the placeholders' were composed as flat strips, so equal divisors would have made
  //     these read ~40% longer. `rigComposition.test.ts`'s module-proportion band measures
  //     texture WIDTH, so it cannot see that difference — it is why this note exists.
  //
  // Both stay slightly smaller than the player originals for the reason the placeholders
  // already did: a mob's module hangs off the 'held' path (`rigWeaponMount`), which has no
  // socket tether to give a big blade somewhere to sit, so a full-size head reads as bigger
  // than the body carrying it.
  enemyclaw: { path: '/weapons/sword_enemyclaw.png', anchor: { x: 0.09, y: 0.088 }, scale: 60 / 160, rotationOffsetRad: deg(-47.1) },
  enemymaul: { path: '/weapons/sword_enemymaul.png', anchor: { x: 0.079, y: 0.07 }, scale: 80 / 160, rotationOffsetRad: deg(-53.8) },

  // 2026-08-03 batch: the 6 starter-frame elemental variants that never got their own
  // silhouette (flamer/cryobolt/teslagun/venomspit all fell back to gun_default) plus
  // cinderscatter/frostseeker (the scattergun/seeker frames' fire/ice variants). Anchors
  // are first-pass eyeball, rotationOffsetRad measured by the same farthest-alpha-pixel-
  // from-anchor method as every entry above. cryobolt/frostseeker took two rounds of
  // generation — the first attempt for both came back as a handheld raygun with a grip/
  // trigger guard (art/weapon/leftover/*ice_weapon_icon*/*crystal_tech_rifle_icon*),
  // which broke this game's no-hands fiction; the prompt was rewritten to forbid that
  // explicitly (art/weapon/prompts.md) and the second attempt landed clean.
  flamer: { path: '/weapons/gun_flamer.png', anchor: { x: 0.14, y: 0.16 }, scale: 80 / 160, rotationOffsetRad: deg(-40.6) },
  teslagun: { path: '/weapons/gun_teslagun.png', anchor: { x: 0.08, y: 0.14 }, scale: 80 / 160, rotationOffsetRad: deg(-25.8) },
  venomspit: { path: '/weapons/gun_venomspit.png', anchor: { x: 0.14, y: 0.16 }, scale: 78 / 160, rotationOffsetRad: deg(-43.2) },
  cinderscatter: { path: '/weapons/gun_cinderscatter.png', anchor: { x: 0.11, y: 0.10 }, scale: 80 / 160, rotationOffsetRad: deg(-43.8) },
  cryobolt: { path: '/weapons/gun_cryobolt.png', anchor: { x: 0.08, y: 0.12 }, scale: 80 / 160, rotationOffsetRad: deg(-38.6) },
  frostseeker: { path: '/weapons/gun_frostseeker.png', anchor: { x: 0.084, y: 0.078 }, scale: 72.9 / 150, rotationOffsetRad: deg(-42.4) },
};

const textures = new Map<string, Texture>();

function allDefs(): Array<[string, WeaponVisualDef]> {
  return [...Object.entries(KIND_DEFAULTS), ...Object.entries(WEAPON_DEFS)] as Array<[string, WeaponVisualDef]>;
}

export async function preloadWeaponSkins(): Promise<void> {
  await Promise.all(
    allDefs().map(async ([key, def]) => {
      try {
        // A mounted weapon is a LONE OBJECT drawn far smaller than its source: every def
        // here scales a 160 px file to ~78-80, and measured live in a real room the sprite
        // lands at 60 px on screen for a 2.7:1 minification (3.1:1 on a smaller actor —
        // it was 5.3:1 before the 2026-08-25 WeChat downsampling pass took these files
        // from 320 px, and a mip chain is still what keeps it readable). 160 rather than a
        // rounder-looking 192 because 320 -> 160 is an EXACT 2:1 box step: every output
        // texel is the mean of exactly four inputs, with no resampling phase error at all.
        // Any other target lands output texels between input texels and smears detail that
        // the resolution alone would have kept.
        // Worse than the 4:1 that made the pillar need this, on the object the player looks
        // at most, and it sits right on top of the character's eye — the exact spot the
        // 2026-08-12 rig-art colour-noise bug was diagnosed at. Found by an audit of every
        // loader while shipping the room props, not by a report. `repeat` stays off (a lone
        // object's edge would sample its own far side).
        textures.set(key, await Assets.load<Texture>({ src: resolveAssetUrl(def.path), data: { autoGenerateMipmaps: true } }));
      } catch {
        // Best-effort, like every sibling preloader (uiSkins.ts/biomeTiles.ts) — a
        // per-item try/catch so one bad fetch can't abort every OTHER still-in-flight
        // weapon texture via Promise.all's fail-fast rejection. getWeaponTexture()'s own
        // kind-default fallback below covers the gap until a retry/redeploy fixes it.
      }
    }),
  );
}

/**
 * Resolve a weapon id to its texture KEY + calibration (anchor/scale/rotation) as ONE
 * coherent unit — never texture from one weapon's entry paired with another's anchor/
 * scale/rotationOffset, which would misplace/mis-rotate whichever texture actually
 * rendered. Falls back to the kind default (key AND def together) both when the id
 * isn't registered at all AND when it IS registered but its texture never made it into
 * `textures` (a preload failure/race, `preloadWeaponSkins` above) — otherwise a missing
 * texture left the weapon socket fully invisible instead of the neutral silhouette
 * "the socket base is identical for every weapon" (file header) promises.
 */
function resolve(name: string | undefined, kind: WeaponVisualKind): { key: string; def: WeaponVisualDef } {
  if (name && WEAPON_DEFS[name] && textures.has(name)) return { key: name, def: WEAPON_DEFS[name]! };
  return { key: kind, def: KIND_DEFAULTS[kind] };
}

export function getWeaponTexture(name: string | undefined, kind: WeaponVisualKind): Texture | undefined {
  const { key } = resolve(name, kind);
  return textures.get(key);
}

export function getWeaponAnchor(name: string | undefined, kind: WeaponVisualKind): { x: number; y: number } {
  return resolve(name, kind).def.anchor;
}

export function getWeaponScale(name: string | undefined, kind: WeaponVisualKind): number {
  return resolve(name, kind).def.scale * MODULE_SCALE;
}

export function getWeaponRotationOffset(name: string | undefined, kind: WeaponVisualKind): number {
  return resolve(name, kind).def.rotationOffsetRad ?? 0;
}
