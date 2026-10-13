// Refusal hints — the drawn half of `ui/pickupRefusal.ts`: a short label ("Energy full") that
// rises off a drop the local player just walked onto but would not take, then fades.
//
// World-space on `layers.numbers` (the damage-number layer: never blurred, above every wall and
// health bar, and the layer meant for things that come and go), so the label sits over the drop
// it explains at any camera zoom. A `Text` per label, which `DamageNumbers` avoids for its
// per-hit churn; a hint is edge-triggered with a per-drop cooldown, so there are only ever a
// handful, and a Text is what lets every locale's wording render.
import { Container, Text } from 'pixi.js';
import { fpToPx } from '../coords';
import { THEME } from '../theme';
import { t } from '../../i18n';
import type { PickupRefusal, RefusalHint } from '../ui/pickupRefusal';

/** How long one label lives, ms. */
export const HINT_MS = 1600;
/** How far it rises over that time, world px. */
const HINT_RISE_PX = 14;
/** Where it starts, px above the drop's ground point — just over the drop's own hover. */
const HINT_LIFT_PX = 26;
/** The last fraction of its life over which it fades out. */
const HINT_FADE_FRACTION = 0.35;

/** The pool each reason is about, in that pool's own colour, so the label and the bar it names
 *  read as the same thing. */
const HINT_COLOR: Record<PickupRefusal, number> = {
  hpFull: THEME.colors.pickupHeal,
  energyFull: THEME.colors.pickupEnergy,
  shieldFull: THEME.colors.pickupShield,
  noTarget: THEME.colors.pickupEmp,
};

const HINT_KEY = {
  hpFull: 'pickupHint.hpFull',
  energyFull: 'pickupHint.energyFull',
  shieldFull: 'pickupHint.shieldFull',
  noTarget: 'pickupHint.noTarget',
} as const satisfies Record<PickupRefusal, string>;

interface Label {
  text: Text;
  x: number;
  y: number;
  age: number;
}

export class PickupRefusalLayer {
  private readonly labels: Label[] = [];

  constructor(private readonly parent: Container) {}

  /** How many labels are up — read by tests. */
  get count(): number {
    return this.labels.length;
  }

  show(hints: readonly RefusalHint[]): void {
    for (const { item, reason } of hints) {
      const text = new Text({
        text: t(HINT_KEY[reason]),
        style: {
          fill: HINT_COLOR[reason],
          fontSize: 11,
          fontFamily: 'monospace',
          fontWeight: 'bold',
          stroke: { color: 0x0b0f17, width: 3 },
          padding: 4,
        },
      });
      text.anchor.set(0.5, 1);
      const label: Label = { text, x: fpToPx(item.gx), y: fpToPx(item.gy) - HINT_LIFT_PX, age: 0 };
      this.place(label);
      this.parent.addChild(text);
      this.labels.push(label);
    }
  }

  /** Advance every label by `dt` ms (render clock), dropping the ones that finished. */
  update(dt: number): void {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i]!;
      l.age += dt;
      if (l.age >= HINT_MS) {
        l.text.destroy();
        this.labels.splice(i, 1);
      } else {
        this.place(l);
      }
    }
  }

  clear(): void {
    for (const l of this.labels) l.text.destroy();
    this.labels.length = 0;
  }

  private place(l: Label): void {
    const k = l.age / HINT_MS;
    l.text.position.set(l.x, l.y - HINT_RISE_PX * k);
    const fadeFrom = 1 - HINT_FADE_FRACTION;
    l.text.alpha = k <= fadeFrom ? 1 : (1 - k) / HINT_FADE_FRACTION;
  }
}
