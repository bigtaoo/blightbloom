import { RARITY_TIERS, type DamageType, type WeaponSimSpec } from '@dd/engine';

// The palette everything on screen is drawn with.
//
// NOT gameplay tuning. Every simulated number — speeds, radii, HP, fire cadence, the
// drop table, the wave cadence — is owned by the engine (engine/config.ts,
// engine/sim.config.ts, engine/content/) and only ever read from there. This file was
// called `config.ts` and carried px copies of a dozen of them left over from the
// pre-engine Stage-B loop; they had no readers left by the time the engine took
// ownership, and a stale duplicate nobody reads is exactly how a "why did tuning this
// do nothing" afternoon starts. Both the dead numbers and the misleading name are gone.
export const THEME = {
  colors: {
    ground: 0x161a24,
    gridLine: 0x1f2532,
    player: 0x4fd1c5,
    playerFront: 0xe6fffa,
    enemy: 0xf56565,
    pillar: 0x3b4252,
    pillarTop: 0x4c566a,
    wall: 0x2a3140, // AABB solid tiles (design/07/09 ROADMAP 1.2) — flat room walls
    wallEdge: 0x4c566a, // wall outline, matches the pillar top for a consistent read
    extractGlow: 0x68d391, // extraction checkpoint prompt tint (design/05)
    shadow: 0x000000,
    bulletEnemy: 0xf6ad55,
    bulletPlayer: 0x63b3ed,
    gun: 0xcbd5e0,
    sword: 0xe2e8f0,
    swordGlow: 0x90cdf4,
    shield: 0x76e4f7, // cyan — the shield pool + its shatter burst (design/07 two-pool)
    deflect: 0x63b3ed, // parry/deflect flash (a melee swing batting a bullet back)
    clash: 0xffd27f, // two opposing bullets meeting and cancelling — a mid-air spark
    muzzle: 0xffe08a,
    pickupHeal: 0x68d391,
    pickupMaterial: 0xf6e05e, // the run's carry-out currency (design/05/14)
    pickupWeapon: 0xf6ad55, // amber — a new gun to swap in
    pickupBuff: 0xd6bcfa, // violet — a run buff (design/14 in-run power)
    pickupCrate: 0xa0aec0, // slate — an unresolved arena crate (design/15), contents unknown until revealed
    // Teal — a weapon-energy refill (design/03/05, ENGINE_VERSION 59). Deliberately the
    // one cool hue in the set: every other drop here is warm (amber/yellow) or the two
    // established "restore"/"power" hues (green heal, violet buff), and a fifth warm
    // colour on a floor full of loot would read as another material at a glance.
    pickupEnergy: 0x4fd1c5,
    // Coins (design/05 "Shops", 2026-09-14) — the in-run currency. Warm gold, and yes that
    // puts it in the same family as `pickupMaterial`'s yellow crystal, which is why the two
    // are separated by FORM rather than by hue (design/13's dual-channel rule): a coin is
    // drawn as a struck disc with a rim, a material as a faceted crystal. Making it a sixth
    // distinct hue was the alternative and it is the worse one — a currency that does not
    // look like money is a tutorial nobody gets.
    pickupCoin: 0xffc94a,
    // A boss's one-time blueprint schematic (design/14, ENGINE_VERSION 68) — rose, the one
    // hue in the set that reads as "rare find" rather than "resource," since at most one of
    // these exists in an entire run (unlike every other pickup here, which is routine loot).
    pickupSchematic: 0xf687b3,
    armorBreak: 0x90a4ae, // steel grey — IRONWARDEN's own tint (Task 2), a boss's armored phase breaking
    // Elemental status fx (design/03/07) — flashed on the 'status' event, and now
    // also the bullet-trail + lingering-aura colours (per-element render polish).
    statusBurn: 0xff7043, // fire — orange flame
    statusChill: 0x81d4fa, // ice — pale blue frost
    statusShock: 0xfff176, // lightning — bright yellow arc
    statusPoison: 0x9ccc65, // poison — sickly green
  },
} as const;

// Element → fx colour. `physical` is intentionally absent (falls back to the
// faction colour); the four elements reuse their status-fx hues so a fire bullet,
// its trail, and the burn aura it leaves all read as the same orange (design/03/07).
export const ELEMENT_COLORS: Partial<Record<DamageType, number>> = {
  fire: THEME.colors.statusBurn,
  ice: THEME.colors.statusChill,
  lightning: THEME.colors.statusShock,
  poison: THEME.colors.statusPoison,
};

/** design/13's locked element palette, including the `physical` entry ELEMENT_COLORS
 * deliberately omits. That omission is right for world FX — a physical bullet takes the
 * faction colour so it reads as "yours"/"theirs" — but a HUD chip has no faction to
 * fall back on, so physical gets its own locked neutral (#E2E8F0) here. */
export function elementColor(damageType: DamageType): number {
  return ELEMENT_COLORS[damageType] ?? 0xe2e8f0;
}

// Per-biome ground/wall palette (design/13 "per-biome background palettes" — the
// element hex table is locked, so these are DERIVED from it, not hand-picked hexes).
// Rule (design/13 "environment desaturated, hazards saturated"): the room itself stays
// close to the existing neutral dark palette, with only a SMALL mix of the biome's
// element hue — the raw saturated hex is reserved for bullets/status FX/loot, so a
// wall painted full ember-orange would fight bullets/auras for attention instead of
// making them pop. `BIOME_ID_TO_ELEMENT` maps a `DungeonConfig.biomeId` (today only
// 'ember' exists, content/world/rooms/ember.ts) to the stable element vocabulary
// ELEMENT_COLORS already uses, so a future biome only needs one new entry there, not a
// parallel colour table. No new art — this is what "per-biome palette" asks for.
export function mixHex(base: number, tint: number, amount: number): number {
  const br = (base >> 16) & 0xff, bg = (base >> 8) & 0xff, bb = base & 0xff;
  const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
  const mix = (b: number, t: number) => Math.round(b + (t - b) * amount);
  return (mix(br, tr) << 16) | (mix(bg, tg) << 8) | mix(bb, tb);
}

export type BiomeElement = 'fire' | 'ice' | 'lightning' | 'poison' | 'neutral';

// 'neutral' has no element hue to hint at — it's not in this table, so it stays
// EXACTLY today's existing palette (below), byte-identical, never run through
// mixHex (mixing toward the bright #E2E8F0 neutral hex would visibly LIGHTEN it —
// that hex is meant for FX/icons, not as a wall tint amount).
const BIOME_ELEMENT_HEX: Record<Exclude<BiomeElement, 'neutral'>, number> = {
  fire: THEME.colors.statusBurn,
  ice: THEME.colors.statusChill,
  lightning: THEME.colors.statusShock,
  poison: THEME.colors.statusPoison,
};

export interface BiomePalette {
  ground: number;
  gridLine: number;
  pillar: number;
  pillarTop: number;
  wall: number;
  wallEdge: number;
  // The full-viewport backdrop behind the room (Backdrop.ts, design/10 legibility fix
  // 2026-08-02: a room smaller than the viewport left a plain black void around it).
  // Deliberately darker than `ground`, not just the same fill, so the room itself
  // still reads as a distinct rect rather than bleeding into "more floor".
  void: number;
  // The void's far side (Terrain.ts, 2026-08-28) — the ground BEYOND the wall, tiled by
  // `terrainSwatch`. Deliberately between `void` and `ground`: it must be far enough under the
  // lit floor that it can never be mistaken for somewhere the player can stand, and far enough
  // over the backdrop that it reads as a surface rather than as more hole.
  terrain: number;
}

const NEUTRAL_VOID = mixHex(THEME.colors.ground, 0x000000, 0.45);

/**
 * Where `terrain` sits between a palette's own `void` and its own `ground`.
 *
 * Derived from the pair rather than tinted from the neutral terrain like every other biome
 * colour, and that is a fix rather than a stylistic choice. Tinting a dark base toward a BRIGHT
 * element hex lifts it more in relative terms than it lifts an already-lighter one, so
 * `mixHex(NEUTRAL_PALETTE.terrain, hex, 0.1)` pushed fire's terrain to 84% of its own ground's
 * luma while neutral's sat at 74% — i.e. the "never approaches the floor" bound held on the
 * biome it was measured against and quietly failed on the only biome that ships ('ember' is the
 * sole entry in `BIOME_ID_TO_ELEMENT`). Deriving from each palette's own two ends makes the
 * ratio invariant by construction instead of something a future hue can break.
 *
 * Note what the invariant is NOT: a ratio of terrain's luma to `ground`'s. Every biome colour is
 * `mixHex(neutral, hex, 0.1)`, which adds the SAME absolute amount of a bright hue to both terms,
 * and adding a constant to a numerator and denominator drags any such ratio toward 1 — fire's hex
 * has luma ~151, enough to move terrain/ground from 0.75 on neutral to 0.85 on ember while
 * nothing about the design changed. The bound that survives a hue is positional: terrain sits
 * `TERRAIN_MIX` of the way from a palette's own void to its own ground, on the VOID side of the
 * midpoint. `scene/terrainSwatch.test.ts` sweeps every reachable biome id for that.
 */
export const TERRAIN_MIX = 0.4;

const NEUTRAL_PALETTE: BiomePalette = {
  ground: THEME.colors.ground,
  gridLine: THEME.colors.gridLine,
  pillar: THEME.colors.pillar,
  pillarTop: THEME.colors.pillarTop,
  wall: THEME.colors.wall,
  wallEdge: THEME.colors.wallEdge,
  void: NEUTRAL_VOID,
  terrain: mixHex(NEUTRAL_VOID, THEME.colors.ground, TERRAIN_MIX),
};

const BIOME_PALETTES: Record<BiomeElement, BiomePalette> = {
  neutral: NEUTRAL_PALETTE,
  ...(Object.fromEntries(
    (Object.entries(BIOME_ELEMENT_HEX) as Array<[Exclude<BiomeElement, 'neutral'>, number]>).map(([element, hex]) => [
      element,
      {
        ground: mixHex(NEUTRAL_PALETTE.ground, hex, 0.1),
        gridLine: mixHex(NEUTRAL_PALETTE.gridLine, hex, 0.14),
        pillar: mixHex(NEUTRAL_PALETTE.pillar, hex, 0.14),
        pillarTop: mixHex(NEUTRAL_PALETTE.pillarTop, hex, 0.18),
        wall: mixHex(NEUTRAL_PALETTE.wall, hex, 0.14),
        wallEdge: mixHex(NEUTRAL_PALETTE.wallEdge, hex, 0.22),
        void: mixHex(NEUTRAL_PALETTE.void, hex, 0.1),
        terrain: mixHex(
          mixHex(NEUTRAL_PALETTE.void, hex, 0.1),
          mixHex(NEUTRAL_PALETTE.ground, hex, 0.1),
          TERRAIN_MIX,
        ),
      },
    ]),
  ) as Record<Exclude<BiomeElement, 'neutral'>, BiomePalette>),
};

// `biomeId` = `GameState.dungeonConfig?.biomeId` (undefined outside dungeon mode, e.g.
// the flat EngineConfig.floors path or a PvP arena — both fall back to 'neutral',
// i.e. today's existing palette unchanged).
const BIOME_ID_TO_ELEMENT: Record<string, BiomeElement> = {
  ember: 'fire',
};

export function biomePalette(biomeId: string | undefined): BiomePalette {
  return BIOME_PALETTES[biomeId ? (BIOME_ID_TO_ELEMENT[biomeId] ?? 'neutral') : 'neutral'];
}

/** Same `biomeId` → element resolution as `biomePalette`, exposed on its own so
 * `render/biomeTiles.ts` can pick a `floor_${element}`/`wall_${element}` texture key
 * without RoomBuilder needing its own copy of `BIOME_ID_TO_ELEMENT`. */
export function biomeElementOf(biomeId: string | undefined): BiomeElement {
  return biomeId ? (BIOME_ID_TO_ELEMENT[biomeId] ?? 'neutral') : 'neutral';
}

// Rarity → border/ornament colour (design/14 white/blue/purple/orange/gold). The engine
// owns only the stable `colorKey` (RARITY_TIERS[tier].colorKey); the render layer maps
// it to a hue here. Kept a channel apart from ELEMENT_COLORS: rarity lives on the
// border/sprite ornament, element hues stay reserved for combat FX, so the two never
// fight (14).
export const RARITY_COLORS: Record<
  (typeof RARITY_TIERS)[keyof typeof RARITY_TIERS]['colorKey'],
  number
> = {
  white: 0xe2e8f0, // common
  blue: 0x63b3ed, // fine
  purple: 0xb794f4, // epic
  orange: 0xf6ad55, // legend
  gold: 0xf6e05e, // legendary
};

/** Border/ornament hue for a weapon's intrinsic tier (design/14 compare-card read). */
export function rarityColor(spec: WeaponSimSpec): number {
  return RARITY_COLORS[RARITY_TIERS[spec.rarity].colorKey];
}
