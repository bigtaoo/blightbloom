import { Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  DAMAGE_TYPES, PLAYER_BASE, RARITY_TIERS, SKIN_DEFS, TICK_RATE, WEAPON_SPECS,
  resolveLoadout,
} from '@dd/engine';
import type { SavedRunSummary } from '../match/runSave';
import type { MetaState } from '../../meta';
import { bankTotal } from '../../meta';
import { Panel, Button } from '../ui/widgets';
import { BlueprintCard } from '../ui/BlueprintCard';
import { RARITY_COLORS } from '../theme';
import { getRigSkin } from '../../render/skinRegistry';
import { getWeaponTexture } from '../../render/weaponSkins';
import { getUiTexture } from '../../render/uiSkins';
import { t, tName } from '../../i18n';
import { ELEMENT_SHORT_KEY } from '../../i18n/contentKeys';

/** The bone slot a rig bundle binds its main body art to — the same one `PlayerCard`
 *  reuses as a portrait rather than commissioning a separate headshot, so a new
 *  character needs no extra art to show its face on this screen. */
const PORTRAIT_SLOT = 'shell';
/** The portrait's square box, and the character card that holds it. The card is a fixed
 *  size rather than one measured off its own text: every position on these screens is
 *  arithmetic on constants precisely so that laying one out needs no canvas (see
 *  `screens/fakeTextCanvas.ts`). */
const PORTRAIT = 104;
const CHAR_CARD_W = 424;
const CHAR_CARD_H = PORTRAIT + 28;
/** The weapon row: one card per loadout slot, plus the forge card at the end. */
const WEAPON_GAP = 14;
const WEAPON_ROW_SLOTS = PLAYER_BASE.weaponSlots + 1;
const WEAPON_ROW_W = WEAPON_ROW_SLOTS * BlueprintCard.W + (WEAPON_ROW_SLOTS - 1) * WEAPON_GAP;
/** Two lines of monospace info at 20px line height, plus the gap under them. A COUNT of
 *  lines rather than a `Text.height` read, for the same no-canvas reason as above — and
 *  unlike the forge's own info block this one is a fixed two lines in every locale. */
const INFO_BLOCK_H = 2 * 20 + 14;

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
 * Pure presentation, the same shape as `Forge`/`PauseMenu`/`Settings`: it reads a
 * `MetaState` and renders it, and every mutation goes out through the `onX` callbacks
 * that `gameWiring.ts` points at `ForgeActions`. The keyboard path (`ForgeInput`) drives
 * those same methods, so both input paths stay in sync by construction.
 */
export class Loadout {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  private charCard = new Panel({ radius: 14, color: 0x05070c, alpha: 0.62, borderColor: 0x3a4a5c, borderAlpha: 0.5 });
  private title: Text;
  private hint: Text;
  private backBtn: Button;
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
  private infoText: Text;
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
    // `padding` guards against a real observed font-metrics clipping bug (see widgets.ts's
    // Button doc comment for the full explanation).
    this.title = new Text({ text: t('loadout.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.hint = new Text({ text: t('loadout.hint'), style: { fill: 0x90cdf4, fontSize: 12, fontFamily: 'monospace', padding: 10 } });
    this.hint.anchor.set(0.5, 1);

    this.backBtn = new Button(t('loadout.backButton'), { w: 90, h: 30, fontSize: 12, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();

    this.portraitFrame
      .roundRect(0, 0, PORTRAIT, PORTRAIT, 12)
      .fill({ color: 0x18202f, alpha: 0.92 })
      .roundRect(0.5, 0.5, PORTRAIT - 1, PORTRAIT - 1, 12)
      .stroke({ color: 0x63b3ed, alpha: 0.55, width: 1.5 });

    // The character's text block, LEFT-anchored so every line starts at the same x beside
    // the portrait — the layout the report asked for ("picture, then the text to its
    // right"), which a centred block cannot give.
    this.charName = new Text({ text: '', style: { fill: 0xf7fafc, fontSize: 22, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.charName.anchor.set(0, 0);
    this.charStats = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 15, fontFamily: 'monospace', padding: 14 } });
    this.charStats.anchor.set(0, 0);
    this.charOwned = new Text({ text: '', style: { fill: 0x718096, fontSize: 12, fontFamily: 'monospace', padding: 12 } });
    this.charOwned.anchor.set(0, 0);

    this.prevCharBtn = new Button('‹', { w: 32, h: 30, fontSize: 16 });
    this.prevCharBtn.onTap = () => this.onCycleCharacter?.();
    this.nextCharBtn = new Button('›', { w: 32, h: 30, fontSize: 16 });
    this.nextCharBtn.onTap = () => this.onCycleCharacter?.();

    this.infoText = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 14, fontFamily: 'monospace', lineHeight: 20, align: 'center', padding: 24 } });
    this.infoText.anchor.set(0.5, 0);
    // The saved-run line names what CONTINUE resumes and what START RUN would throw away.
    // Two buttons whose difference is only their label is not enough on its own — a player
    // who has been away a week has no way to know which run is in the slot, and the discard
    // is irreversible.
    this.savedText = new Text({ text: '', style: { fill: 0x9ae6b4, fontSize: 12, fontFamily: 'monospace', align: 'center', padding: 16, wordWrap: true, wordWrapWidth: 700, breakWords: true } });
    this.savedText.anchor.set(0.5, 0);

    this.weaponCards = Array.from({ length: PLAYER_BASE.weaponSlots }, () => new BlueprintCard());
    this.forgeCard.onTap = () => this.onForge?.();

    this.clearBtn = new Button(t('loadout.clearLoadout'), { w: 160, h: 30, fontSize: 12 });
    this.clearBtn.onTap = () => this.onClear?.();
    this.clearBtn.setIcon(getUiTexture('icon_clear'));
    this.startBtn = new Button(t('loadout.startRun'), { w: 220, h: 44, fontSize: 17, color: 0x2f855a, borderColor: 0x68d391 });
    this.startBtn.onTap = () => this.onStart?.();
    this.startBtn.setIcon(getUiTexture('icon_play'));
    this.continueBtn = new Button(t('loadout.continueRun'), { w: 220, h: 44, fontSize: 17, color: 0x2f855a, borderColor: 0x68d391 });
    this.continueBtn.onTap = () => this.onContinue?.();
    this.continueBtn.setIcon(getUiTexture('icon_play'));

    this.view.addChild(
      this.panel.view, this.title, this.backBtn.view,
      this.charCard.view, this.portraitFrame, this.portraitFallback,
      this.charName, this.charStats, this.charOwned,
      this.prevCharBtn.view, this.nextCharBtn.view,
      this.infoText,
      ...this.weaponCards.map((c) => c.view), this.forgeCard.view,
      this.savedText,
      this.clearBtn.view, this.startBtn.view, this.continueBtn.view,
      this.hint,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  render(m: MetaState, w: number, h: number) {
    this.panel.layout(w, h);
    this.retext();

    const skin = SKIN_DEFS[m.selectedSkin];
    this.charName.text = skin ? tName(skin.nameKey) : m.selectedSkin;
    this.charStats.text = skin ? t('loadout.charStats', { hp: skin.maxHp, sh: skin.maxShield }) : '';
    this.charOwned.text = t('loadout.ownedChars', { count: m.ownedCharacters.length });
    this.bindPortrait(m.selectedSkin);

    // Material bank — the five elemental kinds (design/14), summed across every rolled
    // tier. Kept on this screen even though spending happens in the forge: it is the one
    // number that decides whether a trip to the forge is worth making at all.
    const bank = DAMAGE_TYPES.map((e) => `${t(ELEMENT_SHORT_KEY[e])} ${bankTotal(m, e)}`).join('   ');
    this.infoText.text =
      t('loadout.materialsLine', { bank }) + '\n' +
      t('loadout.slotsLine', { count: this.forgedCount(m), max: PLAYER_BASE.weaponSlots });

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

    this.layout(w, h, saved !== null);
    this.view.visible = true;
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
    this.title.text = t('loadout.title');
    this.hint.text = t('loadout.hint');
    this.backBtn.setText(t('loadout.backButton'));
    this.clearBtn.setText(t('loadout.clearLoadout'));
    this.startBtn.setText(t('loadout.startRun'));
    this.continueBtn.setText(t('loadout.continueRun'));
  }

  /**
   * Where everything goes. Title at the top, the character card under it, the info block,
   * the weapon row, and a FIXED bottom action bar anchored to `h` — not flowed down from
   * the row above it, which is the layout mistake that put START RUN on top of the forge's
   * weapon cards on a landscape phone (see `screens/viewportFit.test.ts`'s header).
   */
  private layout(w: number, h: number, saved: boolean): void {
    const cx = w / 2;
    let y = Math.max(20, h * 0.05);
    this.title.position.set(cx, y);
    this.backBtn.view.position.set(16, 16);
    y += 46;

    const cardLeft = cx - CHAR_CARD_W / 2;
    this.charCard.layout(CHAR_CARD_W, CHAR_CARD_H);
    this.charCard.view.position.set(cardLeft, y);
    const portraitX = cardLeft + 14;
    const portraitY = y + 14;
    this.portraitFrame.position.set(portraitX, portraitY);
    this.portraitFallback.position.set(portraitX, portraitY);
    this.portrait?.position.set(portraitX + PORTRAIT / 2, portraitY + PORTRAIT / 2);
    const textX = portraitX + PORTRAIT + 18;
    this.charName.position.set(textX, y + 22);
    this.charStats.position.set(textX, y + 56);
    this.charOwned.position.set(textX, y + 82);
    // The cycle arrows sit OUTSIDE the card, one per side, so neither can be mistaken for
    // part of the portrait it is beside.
    this.prevCharBtn.view.position.set(cardLeft - 42, y + CHAR_CARD_H / 2 - 15);
    this.nextCharBtn.view.position.set(cardLeft + CHAR_CARD_W + 10, y + CHAR_CARD_H / 2 - 15);
    y += CHAR_CARD_H + 16;

    this.infoText.position.set(cx, y);
    y += INFO_BLOCK_H;

    const rowLeft = cx - WEAPON_ROW_W / 2;
    this.weaponCards.forEach((card, i) => {
      card.view.position.set(rowLeft + i * (BlueprintCard.W + WEAPON_GAP), y);
    });
    this.forgeCard.view.position.set(rowLeft + PLAYER_BASE.weaponSlots * (BlueprintCard.W + WEAPON_GAP), y);
    y += BlueprintCard.H + 12;

    this.savedText.style.wordWrapWidth = Math.min(700, w - 80);
    this.savedText.position.set(cx, y);

    // Action bar. With a saved run there are TWO primary buttons and they stack vertically
    // rather than sitting side by side — CONTINUE takes the footer slot START RUN normally
    // occupies (it is what the player came back for), and START RUN moves one row up as the
    // "start over instead" option. The same arrangement, and the same reason, as the forge's
    // own bar before this screen took it over.
    const footerY = h - 60;
    // CLEAR sits to the LEFT of the primary pair, not at the weapon row's own left edge:
    // that edge is `cx - 212` and START RUN's is `cx - 110`, so aligning the two would put a
    // 160px-wide button 58px underneath the one it sits beside. Measured, on the running
    // client — it shipped that way for exactly one screenshot.
    this.clearBtn.view.position.set(cx - 290, footerY + 7);
    this.continueBtn.view.visible = saved;
    this.continueBtn.view.position.set(cx - 110, footerY);
    this.startBtn.view.position.set(cx - 110, saved ? footerY - 52 : footerY);
    this.hint.position.set(cx, h - 6);
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
      this.view.addChildAt(this.portrait, this.view.getChildIndex(this.portraitFallback) + 1);
    }
    this.portrait.texture = texture;
    // Contain, not stretch — body art is square-ish but not guaranteed to be.
    const inner = PORTRAIT - 16;
    this.portrait.scale.set(Math.min(inner / texture.width, inner / texture.height));
  }
}
