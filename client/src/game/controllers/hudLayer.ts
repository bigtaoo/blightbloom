/**
 * HUD-layer assembly, split out of `Game.buildHud` (CLAUDE.md 500-line convention,
 * form (1) — an independent function module): sizing and mounting the in-match overlay
 * stack, plus the forge-phase settings button, once at boot.
 *
 * A free function rather than a method, because it needs nothing from `Game` except the
 * views it wires together and one callback — and every one of them already exists by the
 * time it runs. Adding an overlay is then one line here instead of another line on a
 * class that had already reached the length limit.
 *
 * MOUNT ORDER IS Z-ORDER. The floor-card offer goes on last so it sits above the portal
 * popup: the two open on the same condition and their panels are deliberately adjacent
 * on screen, so whichever is added last is what a press reaches where they touch.
 */
import type { Container } from 'pixi.js';
import type { Layers } from '../scene/layers';
import type { Backdrop } from '../scene/Backdrop';
import type { HudView } from '../ui/HudView';
import type { TouchControlsView } from '../ui/TouchControlsView';
import type { PortalPrompt } from '../ui/PortalPrompt';
import type { FloorCardPrompt } from '../ui/FloorCardPrompt';
import { Button } from '../ui/widgets';
import { SHELL_CHROME_H } from '../ui/MenuShell';
import { MENU_BUTTONS } from '../ui/menuTheme';
import { whenUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

export interface HudLayerViews {
  backdrop: Backdrop;
  hud: HudView;
  touch: TouchControlsView;
  portal: PortalPrompt;
  cards: FloorCardPrompt;
}

/**
 * Returns the settings button, which the CALLER mounts — deliberately not mounted here.
 * It belongs above every screen, and mounting it on this layer put it underneath the
 * forge's own full-viewport hub panel (design/10).
 */
export function buildHudLayer(
  screenPx: { w: number; h: number },
  layers: Layers,
  hudView: Container,
  v: HudLayerViews,
  onSettings: () => void,
): Button {
  v.backdrop.resize(screenPx.w, screenPx.h);
  v.hud.build(layers, screenPx);
  v.portal.reposition(screenPx);
  v.cards.reposition(screenPx);
  hudView.addChild(v.hud.view, v.touch.view, v.portal.view, v.cards.view);
  layers.hudOverlay.addChild(hudView);

  // The lobby's SETTINGS chip, in look and size: the loadout screen pins it top-right,
  // opposite its BACK chip (`MenuShell.setCorner`).
  const settingsBtn = new Button(t('settings.title'), { w: 120, h: SHELL_CHROME_H, fontSize: 13, autoWidth: true, ...MENU_BUTTONS.chrome });
  whenUiTexture('icon_settings', (tex) => settingsBtn.setIcon(tex, 0x4a5568));
  settingsBtn.onTap = onSettings;
  settingsBtn.view.visible = false;
  return settingsBtn;
}
