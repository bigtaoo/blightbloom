import { Container, Graphics, Text } from 'pixi.js';
import type { WeaponSpec } from '@dd/engine';
import { applyQuality, WEAPON_SPECS } from '@dd/engine';
import { Panel } from './widgets';
import { t } from '../../i18n';
import { ELEMENT_KEY } from '../../i18n/contentKeys';

// The compare card (design/03 "ground compare card" + design/10's open loadout-detail
// question). One widget, two call sites: the forge loadout screen passes a full stat
// table; the in-run ground card (design/03:125, locked) passes zero rows — name +
// rarity is the whole spec there. Pure presentation like every widget in this kit: it
// never reads MetaState/GameState, only the plain WeaponSpec values Forge.ts/Game.ts
// resolve for it.

export interface CompareRow {
  label: string;
  left: string;
  right: string;
}

/**
 * Kind-specific stat rows for two weapons of the SAME kind (design/03/14: rarity's
 * edge is mostly handling, not raw damage, so spread/arc/cooldown are shown alongside
 * damage rather than a bare DPS number — no such formula exists in the design docs).
 * Damage is shown POST-quality (`applyQuality`) — the real in-sim number, matching
 * what `toSimSpec` bakes in, not the raw authored constant. Returns `null` if the two
 * specs aren't the same kind (ranged vs melee has no shared stat to line up).
 */
export function buildCompareRows(a: WeaponSpec, b: WeaponSpec): CompareRow[] | null {
  if (a.kind !== b.kind) return null;
  const dmg = (s: WeaponSpec) => String(applyQuality(s.damage, s.rarity));
  const type = (s: WeaponSpec) => t(ELEMENT_KEY[s.damageType ?? 'physical']);
  const rows: CompareRow[] = [
    { label: t('compareCard.damage'), left: dmg(a), right: dmg(b) },
    { label: t('compareCard.type'), left: type(a), right: type(b) },
  ];
  if (a.kind === 'ranged' && b.kind === 'ranged') {
    rows.push(
      { label: t('compareCard.fireRate'), left: `${a.cooldownSec.toFixed(2)}s`, right: `${b.cooldownSec.toFixed(2)}s` },
      { label: t('compareCard.spread'), left: `${a.spreadDeg}°`, right: `${b.spreadDeg}°` },
      { label: t('compareCard.speed'), left: `${a.bulletSpeed}g/s`, right: `${b.bulletSpeed}g/s` },
    );
  } else if (a.kind === 'melee' && b.kind === 'melee') {
    rows.push(
      { label: t('compareCard.swing'), left: `${a.cooldownSec.toFixed(2)}s`, right: `${b.cooldownSec.toFixed(2)}s` },
      { label: t('compareCard.arc'), left: `${a.arcDeg}°`, right: `${b.arcDeg}°` },
      { label: t('compareCard.reach'), left: `${a.rangeGrid}g`, right: `${b.rangeGrid}g` },
      { label: t('compareCard.deflect'), left: a.deflect ? t('compareCard.yes') : t('compareCard.no'), right: b.deflect ? t('compareCard.yes') : t('compareCard.no') },
    );
  }
  return rows;
}

/**
 * Which loadout entry, if any, is the "currently equipped" comparator for a candidate
 * of the given kind (Forge.ts: a loadout can hold one ranged + one melee, so a ranged
 * candidate compares only against the loadout's ranged slot). `ids` should already be
 * the *effective* loadout — Forge.ts falls back to `PLAYER_BASE.startWeapons`' ids when
 * the staged loadout is empty (the same fallback the board text already shows).
 */
export function equippedSpecOfKind(ids: readonly string[], kind: WeaponSpec['kind']): WeaponSpec | undefined {
  for (const id of ids) {
    const spec = WEAPON_SPECS[id];
    if (spec && spec.kind === kind) return spec;
  }
  return undefined;
}

/** A rarity-bordered two-column card: headline name/colour each side + optional stat
 * rows as one aligned monospace block (matches Forge.ts/HUD's existing text-board
 * convention — no per-cell Graphics/Text grid, keeping this a "tiny in-house layer"
 * per widgets.ts's own header comment). Empty `rows` is the minimal design/03 ground
 * card (name + rarity colour only); a populated `rows` is the forge loadout compare. */
export class CompareCard {
  readonly view = new Container();
  private panel = new Panel({ radius: 10, color: 0x0b0e14, alpha: 0.9 });
  private leftBorder = new Graphics();
  private rightBorder = new Graphics();
  private leftName: Text;
  private rightName: Text;
  private body: Text;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (widgets.ts's
    // Button doc comment has the full explanation) — this card's own name/body Text
    // showed the same cropped-last-character symptom before this fix.
    this.leftName = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 15, fontWeight: 'bold', fontFamily: 'monospace', padding: 16 } });
    this.rightName = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 15, fontWeight: 'bold', fontFamily: 'monospace', padding: 16 } });
    this.rightName.anchor.set(1, 0);
    this.body = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 14, fontFamily: 'monospace', lineHeight: 19, padding: 16 } });
    this.view.addChild(this.panel.view, this.leftBorder, this.rightBorder, this.leftName, this.rightName, this.body);
    this.view.visible = false;
  }

  set(opts: {
    w: number;
    leftName: string;
    leftColor: number;
    rightName: string;
    rightColor: number;
    rows: readonly CompareRow[];
  }) {
    this.leftName.text = opts.leftName;
    this.leftName.style.fill = opts.leftColor;
    this.rightName.text = opts.rightName;
    this.rightName.style.fill = opts.rightColor;
    // Two names too wide for one line (a narrow card, like the forge's side column) stack:
    // the candidate drops under the equipped one, still right-aligned, instead of overlapping.
    const stacked = this.leftName.width + this.rightName.width + 16 > opts.w - 24;
    const headerH = stacked ? 50 : 30;
    this.leftName.position.set(12, 8);
    this.rightName.position.set(opts.w - 12, stacked ? 28 : 8);

    const h = headerH + (opts.rows.length ? opts.rows.length * 19 + 10 : 6);
    this.panel.layout(opts.w, h);
    this.leftBorder.clear().roundRect(0, 0, 4, h, 2).fill({ color: opts.leftColor });
    this.rightBorder.clear().roundRect(opts.w - 4, 0, 4, h, 2).fill({ color: opts.rightColor });

    const labelW = Math.max(6, ...opts.rows.map((r) => r.label.length));
    const valW = Math.max(4, ...opts.rows.map((r) => Math.max(r.left.length, r.right.length)));
    const vs = t('compareCard.vs');
    this.body.text = opts.rows
      .map((r) => `${r.label.padEnd(labelW)} ${r.left.padStart(valW)}  ${vs}  ${r.right.padStart(valW)}`)
      .join('\n');
    this.body.position.set(12, headerH);
    // A translated stat block can outgrow a narrow card (ru's `физический` twice over in the
    // forge's 300px column): shrink the block to fit rather than run past the card's edge.
    this.body.scale.set(1);
    const room = opts.w - 24;
    if (this.body.width > room) this.body.scale.set(room / this.body.width);

    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}
