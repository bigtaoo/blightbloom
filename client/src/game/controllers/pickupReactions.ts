/**
 * The pickup-kind reaction table, split out of `EventReactor.ts` (CLAUDE.md "500-line
 * file convention", form ①: an independent function called once per `pickup` event,
 * no shared private state) — this switch has repeatedly pushed that file over the
 * limit as new pickup kinds landed (`schematic` in the blueprint two-tier pass,
 * `shield`/`emp` in Task 4's instant items), so it moves out rather than being
 * trimmed around again.
 *
 * `PickupHost` is deliberately NOT `EventReactorHost` (the full interface `EventReactor`
 * itself takes) — only two of its methods are needed here, and importing the whole
 * interface from `EventReactor.ts` would make this file import the shell that imports
 * it, exactly the cycle CLAUDE.md's split rules forbid.
 */
import { BLUEPRINT_CATALOG, MATERIAL_DEFS, RUN_BUFFS, SKIN_DEFS, WEAPON_SIM_BY_ID, type GameEvent } from '@dd/engine';
import { THEME, rarityColor } from '../theme';
import { SCORE } from '../score';
import { fpToPx } from '../coords';
import { t, tName } from '../../i18n';
import type { FxController } from '../fx/FxController';
import type { HudView } from '../ui/HudView';
import type { AudioCue } from '../../platform/types';

export interface PickupHost {
  addScore(delta: number): void;
  onWeaponPickup(weaponId: string): void;
}

type PickupEvent = Extract<GameEvent, { type: 'pickup' }>;

export function reactToPickup(e: PickupEvent, fx: FxController, hud: HudView, host: PickupHost, cue: (id: AudioCue) => void): void {
  switch (e.kind) {
    case 'heal':
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupHeal, 20);
      cue('pickup.heal');
      hud.toast(t('toast.heal'), THEME.colors.pickupHeal);
      break;
    case 'weapon': {
      // Flash in the dropped weapon's rarity colour (design/14) — the tier
      // reads at a glance. Falls back to the generic amber if unresolved.
      const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
      const c = spec ? rarityColor(spec) : THEME.colors.pickupWeapon;
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), c, 24);
      cue('pickup.weapon');
      hud.toast(spec ? tName(spec.nameKey) : t('toast.newWeapon'), c);
      // A catalogued weapon found grants its blueprint too — permanent, or a
      // stacked schematic for the earnable pool (`Game.onWeaponPickup`, ENGINE_VERSION 68).
      if (e.weaponId && BLUEPRINT_CATALOG[e.weaponId]) host.onWeaponPickup(e.weaponId);
      break;
    }
    case 'buff':
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupBuff, 22);
      cue('pickup.buff');
      {
        const buff = e.buffId ? RUN_BUFFS[e.buffId] : undefined;
        // Falls back to the raw id only if `buffId` names something outside the
        // catalogue (shouldn't happen for a real drop) — same defensive shape as
        // the material/weapon lookups below.
        const label = buff ? tName(buff.nameKey) : e.buffId;
        hud.toast(label ? t('toast.buffNamed', { id: label }) : t('toast.buffGeneric'), THEME.colors.pickupBuff);
      }
      break;
    case 'schematic': { // a boss's one-time drop (ENGINE_VERSION 68) — cosmetic only
      const spec = e.weaponId ? WEAPON_SIM_BY_ID[e.weaponId] : undefined;
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupSchematic, 26);
      cue('pickup.buff'); // reuses buff's cue — no recorded asset for a new one
      hud.toast(t('toast.schematicFound', { weapon: spec ? tName(spec.nameKey) : (e.weaponId ?? '') }), THEME.colors.pickupSchematic);
      break;
    }
    case 'character': { // a boss's rare character unlock (design/14, 2026-09-26)
      const skin = e.skinId ? SKIN_DEFS[e.skinId] : undefined;
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupCharacter, 28);
      cue('pickup.buff'); // reuses buff's cue — no recorded asset for a new one
      hud.toast(t('toast.characterFound', { character: skin ? tName(skin.nameKey) : (e.skinId ?? '') }), THEME.colors.pickupCharacter);
      break;
    }
    case 'shield': // shield-battery instant item (Task 4) — same shape as heal, own hue
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupShield, 20);
      cue('pickup.heal'); // reuses heal's cue — no recorded asset for a new one
      hud.toast(t('toast.shield'), THEME.colors.pickupShield);
      break;
    case 'emp': // EMP grenade instant item (Task 4) — the fx here is the pickup toast
      // only; the actual burst's own hit/shield_break events fire their own fx per
      // target through the ordinary 'hit' case below, so this stays a plain pickup cue.
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupEmp, 22);
      cue('pickup.buff'); // reuses buff's cue — no recorded asset for a new one
      hud.toast(t('toast.emp'), THEME.colors.pickupEmp);
      break;
    default: { // material
      host.addScore(SCORE.material);
      fx.flash(fpToPx(e.gx), fpToPx(e.gy), THEME.colors.pickupMaterial, 16);
      cue('pickup.material');
      const mat = e.materialId ? MATERIAL_DEFS[e.materialId] : undefined;
      // Translated fallback only triggers when `materialId` itself is absent —
      // an id present but uncatalogued falls back to the raw id, same shape as
      // the buff toast above.
      const materialName = mat ? tName(mat.nameKey) : e.materialId ?? t('toast.materialFallback');
      hud.toast(t('toast.materialQty', { qty: e.qty ?? 1, material: materialName }), THEME.colors.pickupMaterial);
    }
  }
}
