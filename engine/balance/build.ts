/**
 * The build layer — the fairness wall (design/05/06/09). Two builders resolve
 * authored loadouts into the WeaponState[] a PlayerActor spawns with, and the
 * TYPES themselves enforce the PvP fairness guarantee:
 *
 *   buildRunSpecs(baseLoadout)          — PvE: the persistent meta loadout (horizontal).
 *   buildArenaSpecs(presetId, skinId)   — PvP: a preset id + which character, NOTHING else.
 *
 * buildArenaSpecs physically cannot receive meta (weapon/material/blueprint) — there
 * is no parameter for it (design/09 "compile-time impossible to leak persistent gear
 * into PvP", unit-tested by arity). `skinId` is NOT a wall violation: design/14/15
 * name character choice as the fairness wall's one deliberate exception (a player's
 * chosen skin carries into PvP same as PvE) — it is what lets buildArenaSpecs pick the
 * RIGHT character's authored arena (maxHp, maxShield) pair (design/15).
 * PvP power beyond the landing kit + character choice comes only from on-map pickups
 * (design/05). This is design/05's hybrid-gear table made executable.
 *
 * buildRunSpecs is wired into GameState construction and (via makeWeapon) the
 * in-run weapon drops. buildArenaSpecs (ROADMAP 4.2c) is ALSO wired into GameState
 * construction (buildSeat branches on config.arena, ENGINE_VERSION 19->20) — PvP
 * mode is assembled end-to-end (Phase 4 closeout, ROADMAP.md).
 */
import type { WeaponSimSpec, WeaponState } from '../state/entities';
import { makeWeapon, BLASTER_SIM, SABER_SIM } from '../content/weapons';
import { resolveSkin, type SkinId } from '../content/skins';

/**
 * PvE run builder (design/09). `baseLoadout` is the persistent-meta loadout carried
 * in at match start (horizontal — build breadth, not raw power). It reaches the run,
 * never PvP.
 */
export function buildRunSpecs(baseLoadout: readonly WeaponSimSpec[]): WeaponState[] {
  return baseLoadout.map((base) => makeWeapon(base));
}

// ── PvP arena (the wall) ────────────────────────────────────────────────────────
//
// A "small landing-kit set, not a full loadout" (ROADMAP 4.2c) — real power comes
// from the map's own loot (design/05/15), so one modest starter preset is enough
// until the map editor's loot tables exist (4.3). "Small" means MODEST NUMBERS, not
// a missing weapon kind: the kit is a gun + a melee weapon, so the swap verb and both
// sides of design/03's ranged/melee trade-off exist from the drop (see ARENA_PRESETS).
// The LOAD-BEARING part is the signature: no THIRD (meta) parameter exists, ever.

export type ArenaPresetId = string;

/**
 * A landing kit is a PAIR: one gun + one melee weapon (design/05's landing kit is
 * "opening weapon(s)", and design/03/05's ranged-vs-melee trade-off — reach and chip
 * damage against burst, AoE arc and the parry — is a choice a player makes DURING a
 * fight, via the swap control, not one the spawn makes for them). A one-weapon kit
 * also silently removed the swap verb from PvP entirely: `HudView`'s idle-slot chip
 * hides itself when `weapons.length <= 1`, so the arena had no visible second slot
 * and no parry at all.
 *
 * Consequence worth naming: parry (`MeleeSimSpec.deflect`) is now available to every
 * arena seat from the drop, where before it was reachable only by looting a melee
 * weapon off the map. That is the point — both halves of design/03's trade-off should
 * be in a player's hands — but it does move PvP's bullet-vs-body balance, and the
 * zone/TTK tuning below is still first-pass (design/15 "real play required").
 *
 * Kept explicit per preset rather than routed through PvE's `resolveLoadout`: an arena
 * kit is arena-scoped authored content (the fairness wall — it must not read
 * `PLAYER_BASE.startWeapons`, which is where the PvE meta's defaults live). The
 * both-kinds invariant is gated by a sweep over `ARENA_PRESET_IDS` in build.test.ts.
 */
const ARENA_PRESETS: Record<ArenaPresetId, { loadout: WeaponSimSpec[] }> = {
  landing_basic: { loadout: [BLASTER_SIM, SABER_SIM] },
};

/** Every authored preset id — exported so a test can sweep the real content instead of
 *  restating a hand-written list. Ids only: this leaks no meta and is not a hole in the
 *  fairness wall (buildArenaSpecs still takes no third parameter). */
export const ARENA_PRESET_IDS: readonly ArenaPresetId[] = Object.keys(ARENA_PRESETS);

/**
 * PvP WEAPON-damage scale factor (design/15) — the arena's half of the two-sided scale
 * that keeps relative time-to-kill at PvE's feel while the absolute numbers get bigger
 * (PvE's 3-10ish HP pool leaves no room for a shrinking-zone DoT curve to matter).
 * Design/15 is explicit that the EXACT value is content-tuning, not part of its locked
 * shape ("real play required") — this is a first-pass placeholder, not a tuned constant.
 *
 * The other half — a character's arena (maxHp, maxShield) — stopped being derived from
 * this factor on 2026-09-21 and is now AUTHORED per character (`SkinDef.pvp`). The
 * derivation was `Math.round(pool × 5)`, which put the rounding remainder in the wrong
 * file: to land on the 16 the balance pass had measured, vanguard's PvE shield had to be
 * authored as `3.2` — a fraction the forge then printed at the player. The pairing that
 * actually preserves TTK is "pools and weapon damage scale TOGETHER", and two authored
 * integer columns satisfy it exactly as well as one multiplication did, while letting
 * either scale be re-tuned without dragging the other with it. `skins.ts` holds the
 * numbers; `skins.test.ts` holds the two columns to one ordering.
 */
export const PVP_SCALE_FACTOR = 5;

/** A weapon's PvP-scaled copy — only `damage` moves; the authored WEAPON_SIM_BY_ID
 * constants are never mutated (PvE reads the same objects). Fire rate/handling are
 * untouched: matching PvE's time-to-kill FEEL only requires damage-vs-HP to scale
 * together (design/15), not weapon pacing. Exported so PickupSystem can re-derive the
 * SAME scaled number for an arena floor pickup/drop (design/15's loot IS the power
 * curve — it must scale exactly like the landing kit, not read the raw PvE spec). */
export function scaleWeaponDamage(spec: WeaponSimSpec, factor: number): WeaponSimSpec {
  return { ...spec, damage: Math.round(spec.damage * factor) };
}

export interface ArenaBuildResult {
  weapons: WeaponState[];
  maxHp: number;
  maxShield: number;
}

/**
 * PvP arena builder. Takes a preset id + which character — and NOTHING else. There
 * is deliberately no meta (weapon/material/blueprint) parameter, so persistent gear
 * is compile-time impossible to leak into PvP (design/05/06/09/15 fairness wall);
 * `skinId` is the wall's one named exception (design/14/15), needed here so the arena
 * pools come from the right character. Guarded by an arity test
 * (build.test.ts: exactly 2 params, never 3).
 */
export function buildArenaSpecs(presetId: ArenaPresetId, skinId?: SkinId): ArenaBuildResult {
  const preset = ARENA_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown arena preset '${presetId}' (design/09 validate-at-load).`);
  const skin = resolveSkin(skinId); // unknown/absent → default (forward-compat, same as PvE)
  return {
    weapons: preset.loadout.map((base) => makeWeapon(scaleWeaponDamage(base, PVP_SCALE_FACTOR))),
    // Authored, not scaled (see PVP_SCALE_FACTOR above): the arena pair is content on the
    // SkinDef, so this builder reads it rather than re-deriving it from the PvE pair.
    maxHp: skin.pvp.maxHp,
    maxShield: skin.pvp.maxShield,
  };
}
