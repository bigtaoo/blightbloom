/**
 * Floating damage numbers, the Pixi half (design/10 "Damage numbers"). Every digit is a plain
 * `Sprite` cut from ONE generated atlas (`render/damageDigitAtlas.ts`) and coloured by `tint`, so
 * a screen full of numbers in five colours is still one texture and one batch. No `Text` (a
 * re-rasterised canvas per change, which a number that ticks up on every merged hit would pay
 * constantly) and no `BitmapText` (its chunk is deliberately unloaded, design/12).
 *
 * Merging, the cap and the animation curve live in `damageNumberModel.ts`; this file only turns
 * the book's live set into sprites and hands finished ones back to a pool.
 */
import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { DAMAGE_DIGIT_ATLAS as ATLAS } from '../../render/damageDigitAtlas';
import { getUiTexture } from '../../render/uiSkins';
import { activeQuality } from '../../render/quality';
import { DamageNumberBook, digitOffsets, digitsOf, magnitudeScale, poseAt, NUMBER_PX, type DamageNumber } from './damageNumberModel';

/** The `UI_ASSETS` key the atlas loads under. */
export const DAMAGE_DIGITS_KEY = 'damage_digits';

/** One number's view: a container of digit sprites, grown on demand and never shrunk — a pooled
 *  view that once showed "1204" keeps four sprites and hides the ones a "38" does not use. */
type NumberView = Container<Sprite>;

export class DamageNumbers {
  /** Mounted on `layers.numbers` by `FxController.attach`. */
  readonly view = new Container();
  private readonly book = new DamageNumberBook<NumberView>();
  private readonly pool: NumberView[] = [];
  private glyphs: Texture[] | undefined;

  /** @param atlas where the sheet comes from — the UI art cache by default, a stub in tests. */
  constructor(private readonly atlas: () => Texture | undefined = () => getUiTexture(DAMAGE_DIGITS_KEY)) {}

  /** How many numbers are up — read by tests and the perf handle. */
  get count(): number {
    return this.book.live.length;
  }

  /**
   * Show `value` over `target`, anchored at world px (`x`, `y`). Draws nothing until the atlas
   * has loaded: like every other piece of UI art, a missing file leaves the game as it was.
   */
  spawn(target: number, value: number, tint: number, x: number, y: number): void {
    if (!this.ensureGlyphs()) return;
    const n = this.book.add(target, tint, value, x, y, activeQuality().damageNumbers, () => this.acquire());
    if (n) this.view.addChild(n.view);
  }

  /** Advance every number by `dt` ms and place it for a world drawn at `zoom`. */
  update(dt: number, zoom: number): void {
    for (const n of this.book.step(dt)) this.release(n.view);
    for (const n of this.book.trimTo(activeQuality().damageNumbers)) this.release(n.view);
    const z = zoom > 0 ? zoom : 1;
    for (const n of this.book.live) this.place(n, z);
  }

  /** Clear the screen for a new run. */
  clear(): void {
    for (const n of this.book.clear()) this.release(n.view);
  }

  private place(n: DamageNumber<NumberView>, zoom: number): void {
    if (n.dirty) this.layout(n);
    const pose = poseAt(n.age, n.popAge);
    const v = n.view;
    v.position.set(n.x + n.drift / zoom, n.y - pose.rise / zoom);
    v.scale.set((NUMBER_PX / ATLAS.cellH) * magnitudeScale(n.value) * pose.pop / zoom);
    v.alpha = pose.alpha;
  }

  /** Re-cut the digits of a number whose value changed (a new one, or a merge). */
  private layout(n: DamageNumber<NumberView>): void {
    const digits = digitsOf(n.value);
    const offsets = digitOffsets(digits.length);
    const v = n.view;
    while (v.children.length < digits.length) {
      const s = new Sprite(this.glyphs![0]);
      s.anchor.set(0.5);
      v.addChild(s);
    }
    v.children.forEach((s, i) => {
      s.visible = i < digits.length;
      if (!s.visible) return;
      s.texture = this.glyphs![digits[i]!]!;
      s.tint = n.tint;
      s.x = offsets[i]! * ATLAS.advance;
    });
    n.dirty = false;
  }

  private acquire(): NumberView {
    return this.pool.pop() ?? new Container<Sprite>();
  }

  private release(v: NumberView): void {
    this.view.removeChild(v);
    this.pool.push(v);
  }

  /** Cut the ten digit frames out of the sheet, once it exists. */
  private ensureGlyphs(): boolean {
    if (this.glyphs) return true;
    const sheet = this.atlas();
    if (!sheet) return false;
    this.glyphs = ATLAS.frameX.map(
      (fx) => new Texture({ source: sheet.source, frame: new Rectangle(fx, ATLAS.frameY, ATLAS.cellW, ATLAS.cellH) }),
    );
    return true;
  }
}
