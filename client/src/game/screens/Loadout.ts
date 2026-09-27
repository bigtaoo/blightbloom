import { Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  PLAYER_BASE, RARITY_TIERS, SKIN_DEFS, TICK_RATE, WEAPON_SPECS,
  resolveLoadout,
} from '@dd/engine';
import type { SavedRunSummary } from '../match/runSave';
import type { MetaState } from '../../meta';
import { Button } from '../ui/widgets';
import { MenuShell } from '../ui/MenuShell';
import { MaterialBank } from '../ui/MaterialBank';
import type { LobbyBackdrop } from '../ui/LobbyBackdrop';
import { MENU_BUTTONS, MENU_COLORS, menuText } from '../ui/menuTheme';
import { BlueprintCard } from '../ui/BlueprintCard';
import { RARITY_COLORS } from '../theme';
import { getRigSkin } from '../../render/skinRegistry';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';
import {
  ACTION_H, ARROW_H, ARROW_W, PORTRAIT, SHEET_W, layoutLoadoutSheet,
} from './loadoutSheet';

/** The bone slot a rig bundle binds its main body art to — the same one `PlayerCard`
 *  reuses as a portrait rather than commissioning a separate headshot, so a new
 *  character needs no extra art to show its face on this screen. */
const PORTRAIT_SLOT = 'shell';
/**
 * The LOADOUT screen — what you take into the next run, and the last thing between the
 * lobby and a run (design/10 screen flow, design/14).
 *
 * ## What it is, and what it is not
 *
 * Until 2026-09-21 this screen and the forge were ONE screen: `Forge.ts` drew the
 * character picker, the materials bank, the START RUN bar *and* a paged grid of every
 * blueprint in the catalog, craftable or not. That screen answered two different
 * questions at once — "who am I taking in, with what?" and "what should I spend my
 * materials on?" — and the second one took four fifths of the pixels. So the crafting
 * half stayed in `Forge.ts` as a page of its own (reached from the lobby, or from the
 * FORGE card at the end of this screen's weapon row), and what is left here is only the
 * first question.
 *
 * Concretely, the weapon row below shows the loadout a run would ACTUALLY spawn with
 * (`resolveLoadout`) — the weapons already forged, plus the starter that fills a free
 * slot — and nothing else. A blueprint you could craft is not a thing you are carrying,
 * and this screen no longer claims otherwise.
 *
 * ## The sheet (design/10 "One shell for every menu", 2026-09-27)
 *
 * BACK is the shell's corner chip, and everything else is one framed sheet — the character
 * (portrait, pools, the ‹ › pair) beside the material bank, the weapon row under a heading that
 * carries the forged count, and an action bar closing the sheet. Before, the same widgets
 * floated on the backdrop with the action bar pinned to the viewport's bottom edge, a
 * screen-height away from the row it acts on. `loadoutSheet.ts` holds the geometry.
 *
 * Pure presentation, the same shape as `Forge`/`PauseMenu`/`Settings`: it reads a
 * `MetaState` and renders it, and every mutation goes out through the `onX` callbacks
 * that `gameWiring.ts` points at `ForgeActions`. The keyboard path (`ForgeInput`) drives
 * those same methods, so both input paths stay in sync by construction.
 */
export class Loadout {
  readonly view = new Container();
  private readonly shell: MenuShell;
  /** The dimmed lobby painting. Named `panel` for `menuCoversWorld.test.ts`. */
  private readonly panel: LobbyBackdrop;
  private rules = new Graphics();
  private hint: Text;
  private weaponsHeading: Text;
  /** The five element cells — the same widget the forge shows. */
  private bank: MaterialBank;
  private prevCharBtn: Button;
  private nextCharBtn: Button;
  /** The character's own art, at portrait size. Best-effort like every other art read in
   *  this codebase (design/02/12 "gameplay is never blocked on art"): an unloaded bundle
   *  leaves the tinted disc below in the frame rather than an empty hole. */
  private portraitFrame = new Graphics();
  private portraitFallback = new Graphics();
  private portrait: Sprite | null = null;
  private charName: Text;
  private charStats: Text;
  private charOwned: Text;
  private savedText: Text;
  /** One card per loadout slot, reused across renders — the same fixed-pool shape the
   *  forge's own grid uses. */
  private weaponCards: BlueprintCard[];
  /** The jump into the forge, drawn as the last card of the weapon row rather than as a
   *  button off to one side: it is the answer to the question the row itself raises
   *  ("this is what I am carrying — how do I carry something better?"), so it belongs at
   *  the end of the row and not in a different part of the screen. */
  private forgeCard = new BlueprintCard();
  private clearBtn: Button;
  private startBtn: Button;
  private continueBtn: Button;

  onBack: (() => void) | null = null;
  /** Both the ‹ and › buttons drive this — the underlying roster cycle (`ForgeActions`'s
   *  `cycleCharacter`) is forward-only today; a true reverse cycle is a follow-up, not
   *  something to invent here. */
  onCycleCharacter: (() => void) | null = null;
  onClear: (() => void) | null = null;
  onStart: (() => void) | null = null;
  /** CONTINUE RUN — resume the saved unfinished run (design/05 "Only the boss floor ends
   *  a run", ENGINE_VERSION 61). Only ever called while `savedRun()` answers non-null. */
  onContinue: (() => void) | null = null;
  /** Open the forge (the FORGE card at the end of the weapon row). */
  onForge: (() => void) | null = null;

  /**
   * The resumable saved run, or null when there is none (`match/runSaveStore.ts`).
   *
   * A PROVIDER rather than a field, and for the reason `Forge.savedRun` records: `render()`
   * has several call sites and a field would have to be re-pushed at every one of them,
   * which is that many places for a stale answer to survive. Injected by the assembly so
   * this screen still decides nothing, and defaulted to "no save" so a caller that forgets
   * to set it shows NO continue button — the fail-closed direction.
   */
  savedRun: () => SavedRunSummary | null = () => null;

  constructor() {
    this.shell = new MenuShell({ title: t('loadout.title'), back: t('loadout.backButton') });
    this.shell.onBack = () => this.onBack?.();
    this.panel = this.shell.backdrop;

    this.hint = new Text({ text: t('loadout.hint'), style: menuText('caption', { wordWrap: false, align: 'center' }) });
    this.hint.anchor.set(0.5, 0);
    this.bank = new MaterialBank(t('loadout.sectionMaterials'));
    this.weaponsHeading = new Text({ text: '', style: menuText('heading') });

    this.portraitFrame
      .roundRect(0, 0, PORTRAIT, PORTRAIT, 12)
      .fill({ color: MENU_COLORS.field, alpha: 0.95 })
      .roundRect(0.5, 0.5, PORTRAIT - 1, PORTRAIT - 1, 12)
      .stroke({ color: MENU_COLORS.frame, alpha: 0.55, width: 1.5 });

    // The character's text block, LEFT-anchored so every line starts at the same x beside
    // the portrait — "picture, then the text to its right", which a centred block cannot give.
    this.charName = new Text({ text: '', style: menuText('value', { fontSize: 22, wordWrap: true, breakWords: true }) });
    this.charStats = new Text({ text: '', style: menuText('label', { fontSize: 14, fill: MENU_COLORS.text }) });
    this.charOwned = new Text({ text: '', style: menuText('caption', { wordWrap: false }) });

    this.prevCharBtn = new Button('‹', { w: ARROW_W, h: ARROW_H, fontSize: 16, ...MENU_BUTTONS.secondary });
    this.prevCharBtn.onTap = () => this.onCycleCharacter?.();
    this.nextCharBtn = new Button('›', { w: ARROW_W, h: ARROW_H, fontSize: 16, ...MENU_BUTTONS.secondary });
    this.nextCharBtn.onTap = () => this.onCycleCharacter?.();

    // The saved-run line names what CONTINUE resumes and what START RUN would throw away.
    // Two buttons whose difference is only their label is not enough on its own — a player
    // who has been away a week has no way to know which run is in the slot, and the discard
    // is irreversible.
    this.savedText = new Text({ text: '', style: menuText('body', { fill: MENU_COLORS.success, fontSize: 13, align: 'center' }) });
    this.savedText.anchor.set(0.5, 0);

    this.weaponCards = Array.from({ length: PLAYER_BASE.weaponSlots }, () => new BlueprintCard());
    this.forgeCard.onTap = () => this.onForge?.();

    this.clearBtn = new Button(t('loadout.clearLoadout'), { w: 160, h: ACTION_H, fontSize: 13, autoWidth: true, ...MENU_BUTTONS.secondary });
    this.clearBtn.onTap = () => this.onClear?.();
    this.clearBtn.setIcon(getUiTexture('icon_clear'));
    this.startBtn = new Button(t('loadout.startRun'), { w: 200, h: ACTION_H, fontSize: 16, autoWidth: true, ...MENU_BUTTONS.primary });
    this.startBtn.onTap = () => this.onStart?.();
    this.startBtn.setIcon(getUiTexture('icon_play'));
    this.continueBtn = new Button(t('loadout.continueRun'), { w: 200, h: ACTION_H, fontSize: 16, autoWidth: true, ...MENU_BUTTONS.primary });
    this.continueBtn.onTap = () => this.onContinue?.();
    this.continueBtn.setIcon(getUiTexture('icon_play'));

    this.shell.content.addChild(
      this.rules, this.portraitFrame, this.portraitFallback,
      this.charName, this.charStats, this.charOwned,
      this.prevCharBtn.view, this.nextCharBtn.view,
      this.bank.view,
      this.weaponsHeading, ...this.weaponCards.map((c) => c.view), this.forgeCard.view,
      this.savedText,
      this.clearBtn.view, this.startBtn.view, this.continueBtn.view,
      this.hint,
    );
    this.shell.mount(this.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /**
   * Pin the shared SETTINGS chip in the corner opposite BACK. It is the assembly's button
   * (`hudLayer.ts`), floated over every screen and shown only in this phase; the shell places
   * it on each layout so it scales and insets exactly the way BACK does.
   */
  setCornerChip(btn: Button): void {
    this.shell.setCorner(btn);
  }

  render(m: MetaState, w: number, h: number) {
    this.retext();

    const skin = SKIN_DEFS[m.selectedSkin];
    this.charName.text = skin ? tName(skin.nameKey) : m.selectedSkin;
    this.charStats.text = skin ? t('loadout.charStats', { hp: skin.maxHp, sh: skin.maxShield }) : '';
    this.charOwned.text = t('loadout.ownedChars', { count: m.ownedCharacters.length });
    this.bindPortrait(m.selectedSkin);

    // Material bank — the five elemental kinds (design/14), summed across every rolled
    // tier. Kept on this screen even though spending happens in the forge: it is the one
    // number that decides whether a trip to the forge is worth making at all.
    this.bank.render(m);
    this.weaponsHeading.text = t('loadout.sectionWeapons', { count: this.forgedCount(m), max: PLAYER_BASE.weaponSlots });

    this.renderWeaponRow(m);

    const saved = this.savedRun();
    this.savedText.text = saved
      ? t('loadout.savedRunLine', {
        floor: saved.floorIndex + 1, // 1-based, matching every other floor readout
        m: Math.floor(saved.ticks / TICK_RATE / 60),
        ss: String(Math.floor(saved.ticks / TICK_RATE) % 60).padStart(2, '0'),
      })
      : '';
    this.savedText.visible = saved !== null;
    this.continueBtn.view.visible = saved !== null;
    // One primary per bar: with a save, CONTINUE is it, and START RUN — which throws that save
    // away — steps down to the ordinary action colour.
    const start = saved ? MENU_BUTTONS.secondary : MENU_BUTTONS.primary;
    this.startBtn.setFill(start.color);
    this.startBtn.setBorder(start.borderColor);

    this.shell.layout(w, h, SHEET_W, layoutLoadoutSheet(this.parts(), saved !== null));
    this.view.visible = true;
  }

  /** Per-frame: the backdrop's rocks, glow and motes. Driven from the main loop's
   *  `menuScreens`, and a no-op while this screen is hidden. */
  animate(dtMs: number): void {
    if (this.view.visible) this.panel.update(dtMs);
  }

  hide() {
    this.view.visible = false;
  }

  /**
   * How many of the run's weapon slots hold something the player actually forged.
   *
   * Counted off `m.loadout` with the SAME two rules `resolveLoadout` applies to it —
   * unknown ids dropped, the rest capped at `weaponSlots` — because the row below is
   * drawn from that function's answer and a count derived any other way would eventually
   * disagree with the cards next to it.
   */
  private forgedCount(m: MetaState): number {
    return m.loadout.filter((id) => WEAPON_SPECS[id] !== undefined).slice(0, PLAYER_BASE.weaponSlots).length;
  }

  /**
   * The weapons a run would actually spawn with, plus the jump into the forge.
   *
   * `resolveLoadout` rather than `m.loadout` on purpose: an empty loadout is not an empty
   * kit — every run carries a gun AND a melee weapon (`PLAYER_BASE.startWeapons`,
   * ENGINE_VERSION 45), so a bare read of the staged list would show a player nothing at
   * all right before handing them two weapons. The cards say which is which: a forged one
   * carries the ▸ badge and a green `forged`, a filled-in starter carries neither and reads
   * `default kit` in grey.
   */
  private renderWeaponRow(m: MetaState): void {
    const effective = resolveLoadout(m.loadout);
    this.weaponCards.forEach((card, i) => {
      const weapon = effective[i];
      if (!weapon) {
        card.view.visible = false;
        return;
      }
      card.view.visible = true;
      // `WeaponSimSpec.name` is the weapon's id (the asset key, never display text), which
      // is exactly what `m.loadout` holds — so this is an id comparison, not a name one.
      const forged = m.loadout.includes(weapon.name);
      card.set({
        key: `${i + 1}`,
        name: tName(weapon.nameKey),
        cost: '',
        status: forged ? t('loadout.craftedTag') : t('loadout.starterTag'),
        statusColor: forged ? 0x68d391 : 0x718096,
        borderColor: RARITY_COLORS[RARITY_TIERS[weapon.rarity].colorKey],
        selected: false,
        staged: forged ? 1 : 0,
        // Never `locked`: a starter filling a free slot is a weapon the run IS carrying, and
        // the card's locked styling (grey name, 40%-alpha icon) reads as "you cannot have
        // this". The `default kit` status line is what distinguishes it from a forged one.
        locked: false,
        icon: getWeaponTexture(weapon.name, weapon.kind),
      });
    });
    this.forgeCard.set({
      key: 'F',
      name: t('loadout.forgeCardName'),
      cost: '',
      status: t('loadout.forgeCardHint'),
      statusColor: 0x90cdf4,
      borderColor: 0x63b3ed,
      selected: false,
      staged: 0,
      locked: false,
      // The forger NPC's own art (design/13's outpost NPC), contained into the card's icon
      // chip: the forge already shows this character, so the card and the screen it opens
      // are recognisably the same place.
      icon: getUiTexture('npc_forger'),
    });
  }

  /** Re-apply every static label from the active locale — called on each render so a
   *  language change made in Settings (design/17-i18n.md) takes effect the next time this
   *  screen draws, without needing a global re-render hook. */
  private retext(): void {
    this.shell.setTitle(t('loadout.title'));
    this.shell.setBack(t('loadout.backButton'));
    this.hint.text = t('loadout.hint');
    this.bank.setTitle(t('loadout.sectionMaterials'));
    this.clearBtn.setText(t('loadout.clearLoadout'));
    this.startBtn.setText(t('loadout.startRun'));
    this.continueBtn.setText(t('loadout.continueRun'));
  }

  /** The widgets `layoutLoadoutSheet` places — the drawn weapon cards, then the forge card. */
  private parts() {
    return {
      portraitFrame: this.portraitFrame, portraitFallback: this.portraitFallback, portrait: this.portrait,
      charName: this.charName, charStats: this.charStats, charOwned: this.charOwned,
      prevCharBtn: this.prevCharBtn, nextCharBtn: this.nextCharBtn,
      bank: this.bank,
      weaponsHeading: this.weaponsHeading,
      cards: [...this.weaponCards.filter((c) => c.view.visible), this.forgeCard],
      savedText: this.savedText,
      clearBtn: this.clearBtn, startBtn: this.startBtn, continueBtn: this.continueBtn,
      hint: this.hint, rules: this.rules,
    };
  }

  /** Bind the selected character's body art into the portrait frame, or fall back to a
   *  tinted disc when its bundle has not loaded (or never will). Same best-effort shape as
   *  `PlayerCard.bindPortrait`, which reads the same slot of the same bundle. */
  private bindPortrait(skinId: string): void {
    const atlasKey = SKIN_DEFS[skinId]?.atlasKey;
    const texture = atlasKey ? getRigSkin(atlasKey)?.bundle.textures.get(PORTRAIT_SLOT) : undefined;
    if (!texture) {
      this.portrait?.destroy();
      this.portrait = null;
      this.portraitFallback.clear().circle(PORTRAIT / 2, PORTRAIT / 2, PORTRAIT * 0.3).fill({ color: 0x4fd1c5, alpha: 0.6 });
      return;
    }
    this.portraitFallback.clear();
    if (!this.portrait) {
      this.portrait = new Sprite();
      this.portrait.anchor.set(0.5);
      // Above the frame, below the text — the same stacking `PlayerCard` uses.
      this.shell.content.addChildAt(this.portrait, this.shell.content.getChildIndex(this.portraitFallback) + 1);
    }
    this.portrait.texture = texture;
    // Contain, not stretch — body art is square-ish but not guaranteed to be.
    const inner = PORTRAIT - 16;
    this.portrait.scale.set(Math.min(inner / texture.width, inner / texture.height));
  }
}
