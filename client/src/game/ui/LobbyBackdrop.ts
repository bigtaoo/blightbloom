// The lobby's painted backdrop (design/10 "The lobby, redesigned", 2026-09-27): the floating
// outpost at full value, cover-cropped rather than stretched, with the dais crystal breathing
// and a single soft vignette behind the action column — and no full-screen scrim.
//
// ## Why no scrim
//
// Every menu screen used to put `Panel`'s 55% near-black scrim over the shared 384x288 hub
// art, and the lobby report was that the whole screen read as too dark. Contrast is now
// bought locally instead: the route cards carry their own art and frames, the corner chips
// carry their own backing, and the only darkening on the painting is `setFocus`'s vignette
// behind the column.
//
// ## The dimmed mode every other menu uses (2026-09-27)
//
// The other menu screens used to put `Panel`'s scrim over the old 384x288 hub art, which made
// every door out of the lobby read as a different, darker game. They now draw this same
// painting with `{ dim }`: one flat night-blue wash over the painting and its rocks, under the
// crystal's glow and motes, so the place is the lobby's and the screen's own framed sheet
// (`MenuSheet`) still reads on top of it. The wash is a single layer on purpose — contrast for
// the text is the sheet's job, not the backdrop's.
//
// ## Cover, cropped around the dais
//
// Stretching a 16:9 painting to a phone's 844x390 or a portrait window squashes it, and a
// centred crop can push the dais off screen entirely (on a portrait window it lands at
// x = -103). The crop is instead chosen to put the dais where the shell asks for it, then
// clamped to the painting, and it is taken through the texture's FRAME so the sprite is
// exactly the viewport — nothing sticks out past the design space a layout sweep measures,
// and `menuCoversWorld.test.ts` still finds one opaque sprite covering the world.
//
// ## The drifting rocks
//
// The painting's three sky rocks are not in the shipped painting: they were lifted out into
// their own sprites (`lobby_rock_*`) and the sky painted back under them, so they can bob in
// place instead of a code-drawn rock being floated over a painted one. Each sits at its
// measured home in the painting and drifts a fraction of the painting's height around it —
// less for the far, haze-faded one, which is what makes it read as far. A missing rock texture
// just leaves that rock out; the sky under it is whole.
//
// At 16:9 all three homes land under the lobby's own UI (the logo, the hero, the column), which
// is where the painting's composition brief asked for calm sky and where the UI then went. So
// the same three sprites are also placed, smaller and sometimes mirrored, in the open sky the
// UI leaves: the painting's own rock art, never magnified past the size it was cut at.
import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import { getUiTexture } from '../../render/uiSkins';
import { ArtFade } from './artFade';

/** The dais crystal's centre in `lobby_bg`, as fractions of the image — MEASURED off the
 *  shipped file. The prompt asked for 38%/68%; the painting put it at 33%/72%, and the code
 *  follows the painting (the art pipeline's standing rule: move the code to the art). */
export const DAIS_U = 0.334;
export const DAIS_V = 0.719;
/** The crystal's glowing core, as fractions of the image's width and height. */
const CORE_RU = 0.074;
const CORE_RV = 0.037;
/** Where the backdrop falls back to when the lobby painting is missing: the shared hub art
 *  every other menu uses, then a flat fill. Art never blocks the lobby. */
const FALLBACK_KEY = 'hub';
const FALLBACK_FILL = 0x1b2433;
/** The breathing period of the crystal, and how many motes rise off it. */
const PULSE_MS = 3200;
const MOTES = 14;
const MOTE_RISE_MS = 4200;
/** The vignette: stacked bands, each this alpha, expanding this far — stacked on purpose,
 *  so the centre compounds to ~0.3 and the edge fades to nothing. */
const VIGNETTE_BANDS = 8;
const VIGNETTE_BAND_ALPHA = 0.045;
const VIGNETTE_STEP = 8;
/** The dimmed mode's wash colour: the night-blue the sheets and chips are drawn in. */
const DIM_COLOR = 0x0a1020;

export interface LobbyBackdropOptions {
  /** Alpha of a full-screen wash over the painting and its rocks; 0 (the lobby) draws none. */
  dim?: number;
  /** Where the dais lands, as a fraction of the width, until `setDaisTarget` says otherwise. */
  daisU?: number;
}

/** The sky rocks, at their home in the painting — MEASURED off `lobby_bg_raw.png` by the
 *  script that lifted them out (`art/ui/prompts.md`, "The drifting rocks"): centre as
 *  fractions of the image, height as a fraction of its height. `drift` is the bob's amplitude
 *  as a fraction of the painting's height, and `periodMs` its period — all three different,
 *  so the rocks never move in step. */
export interface SkyRock {
  key: string;
  u: number;
  v: number;
  hFrac: number;
  drift: number;
  periodMs: number;
  /** A rock the painting itself had here, lifted out: its `hFrac` is the sprite's own size. */
  lifted?: boolean;
  /** Drawn mirrored, so a reused sprite does not read as a copy. */
  flip?: boolean;
}
export const SKY_ROCKS: ReadonlyArray<SkyRock> = [
  { key: 'lobby_rock_a', u: 0.2156, v: 0.1712, hFrac: 69 / 1440, drift: 0.009, periodMs: 5200, lifted: true },
  { key: 'lobby_rock_b', u: 0.3896, v: 0.4653, hFrac: 60 / 1440, drift: 0.008, periodMs: 6300, lifted: true },
  { key: 'lobby_rock_c', u: 0.7379, v: 0.7594, hFrac: 117 / 1440, drift: 0.004, periodMs: 8100, lifted: true },
  // In the open sky: between the logo and the corner chips, and between the hero and the column.
  { key: 'lobby_rock_b', u: 0.505, v: 0.135, hFrac: 0.032, drift: 0.007, periodMs: 5800, flip: true },
  { key: 'lobby_rock_a', u: 0.585, v: 0.385, hFrac: 0.040, drift: 0.009, periodMs: 4700 },
  { key: 'lobby_rock_b', u: 0.625, v: 0.555, hFrac: 0.024, drift: 0.006, periodMs: 7000 },
];

export interface DaisPoint {
  /** The dais crystal's centre, in screen (design-space) px. */
  x: number;
  y: number;
  /** The painting's drawn height — what the hero is sized against, so it stays in
   *  proportion to the stone it stands on at every viewport. */
  paintingH: number;
}

export interface FocusRect { x: number; y: number; w: number; h: number }

export class LobbyBackdrop {
  readonly view = new Container();
  /** Child 0 — the opaque cover. `menuCoversWorld.test.ts` reads it by that position. */
  private cover = new Sprite(Texture.WHITE);
  private rocks = new Container();
  /** Each rock's home in screen px, and its drift amplitude — set by `layout`. */
  private rockHomes: Array<{ x: number; y: number; amp: number }> = [];
  /** Per rock: its fade-in, and whether it was drawn missing (so its arrival fades). */
  private rockFades: ArtFade[] = [];
  private rockPending: boolean[] = [];
  private vignette = new Graphics();
  private wash = new Graphics();
  private readonly dim: number;
  private glow = new Graphics();
  private motes = new Graphics();
  private w = 0;
  private h = 0;
  /** Whether the lobby painting itself is up — the glow and motes belong to ITS dais. */
  private painted = false;
  private point: DaisPoint = { x: 0, y: 0, paintingH: 0 };
  private clockMs = 0;
  /** Where the shell wants the dais, as a fraction of the width. */
  private daisTargetU = 0.3;

  constructor(opts: LobbyBackdropOptions = {}) {
    this.dim = opts.dim ?? 0;
    this.daisTargetU = opts.daisU ?? this.daisTargetU;
    this.wash.visible = this.dim > 0;
    this.glow.blendMode = 'add';
    this.motes.blendMode = 'add';
    for (const rock of SKY_ROCKS) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(0.5);
      sprite.label = rock.key;
      this.rocks.addChild(sprite);
      this.rockFades.push(new ArtFade(sprite));
      this.rockPending.push(false);
    }
    // Under the vignette, so a rock behind the column is darkened with the sky around it.
    // The wash over the rocks and under the glow: the crystal stays lit in the dimmed mode.
    this.view.addChild(this.cover, this.rocks, this.vignette, this.wash, this.glow, this.motes);
  }

  get dais(): DaisPoint {
    return this.point;
  }

  /** Ask for the dais to land at this fraction of the width (the crop is clamped to the
   *  painting, so this is where it lands when there is room to move it). */
  setDaisTarget(u: number): void {
    this.daisTargetU = u;
  }

  layout(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.wash.clear();
    if (this.dim > 0) this.wash.rect(0, 0, w, h).fill({ color: DIM_COLOR, alpha: this.dim });
    const art = getUiTexture('lobby_bg');
    const texture = art ?? getUiTexture(FALLBACK_KEY);
    this.painted = !!art;
    if (!texture) {
      this.cover.texture = Texture.WHITE;
      this.cover.tint = FALLBACK_FILL;
      this.cover.position.set(0, 0);
      this.cover.width = w;
      this.cover.height = h;
      this.point = { x: w * this.daisTargetU, y: h * 0.72, paintingH: h };
      this.placeRocks(0, 0, 0, 0);
      this.drawGlow();
      return;
    }
    const src = texture.frame;
    const scale = Math.max(w / src.width, h / src.height);
    const drawnW = src.width * scale;
    const drawnH = src.height * scale;
    const cropX = clamp(DAIS_U * drawnW - w * this.daisTargetU, 0, drawnW - w);
    const cropY = clamp(DAIS_V * drawnH - h * 0.74, 0, drawnH - h);
    this.cover.texture = new Texture({
      source: texture.source,
      frame: new Rectangle(src.x + cropX / scale, src.y + cropY / scale, w / scale, h / scale),
    });
    this.cover.tint = 0xffffff;
    this.cover.position.set(0, 0);
    this.cover.width = w;
    this.cover.height = h;
    this.point = { x: DAIS_U * drawnW - cropX, y: DAIS_V * drawnH - cropY, paintingH: drawnH };
    this.placeRocks(drawnW, drawnH, cropX, cropY);
    this.drawGlow();
  }

  /** Put each rock at its home in the cropped painting — or hide them all when the painting
   *  drawn is not the lobby's (the fallback hub art has its own rocks, painted in). */
  private placeRocks(drawnW: number, drawnH: number, cropX: number, cropY: number): void {
    this.rocks.visible = this.painted;
    this.rockHomes = SKY_ROCKS.map((rock, i) => {
      const sprite = this.rocks.children[i] as Sprite;
      const texture = this.painted ? getUiTexture(rock.key) : undefined;
      sprite.visible = !!texture;
      if (texture && this.rockPending[i]) this.rockFades[i].start();
      this.rockPending[i] = this.painted && !texture;
      if (texture) {
        sprite.texture = texture;
        const height = rock.hFrac * drawnH;
        const scale = height / texture.height;
        sprite.scale.set(rock.flip ? -scale : scale, scale);
      }
      const home = { x: rock.u * drawnW - cropX, y: rock.v * drawnH - cropY, amp: rock.drift * drawnH };
      sprite.position.set(home.x, home.y);
      return home;
    });
    this.driftRocks();
  }

  private driftRocks(): void {
    SKY_ROCKS.forEach((rock, i) => {
      const home = this.rockHomes[i];
      if (!home) return;
      const phase = (this.clockMs / rock.periodMs) * Math.PI * 2 + i * 2.1;
      const sprite = this.rocks.children[i] as Sprite;
      sprite.position.set(home.x + Math.cos(phase * 0.5) * home.amp * 0.35, home.y + Math.sin(phase) * home.amp);
    });
  }

  /** The one darkened area on the painting: a soft plate behind the action column. `null`
   *  clears it. */
  setFocus(rect: FocusRect | null): void {
    this.vignette.clear();
    if (!rect) return;
    for (let i = VIGNETTE_BANDS; i >= 1; i--) {
      const pad = i * VIGNETTE_STEP;
      this.vignette
        .roundRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2, 18 + pad)
        .fill({ color: 0x0a0f1a, alpha: VIGNETTE_BAND_ALPHA });
    }
  }

  update(dtMs: number): void {
    if (!this.painted) return;
    for (const fade of this.rockFades) fade.update(dtMs);
    this.clockMs = (this.clockMs + dtMs) % (PULSE_MS * MOTE_RISE_MS);
    this.glow.alpha = 0.7 + 0.3 * Math.sin((this.clockMs / PULSE_MS) * Math.PI * 2);
    this.drawMotes();
    this.driftRocks();
  }

  /** The crystal's glow: annuli on a squared falloff (the `roomLight` band idiom), additive,
   *  in the purified-crystal cyan design/13 reserves for exactly this kind of light. */
  private drawGlow(): void {
    this.glow.clear();
    this.motes.clear();
    if (!this.painted) return;
    const { x, y, paintingH } = this.point;
    const rx = CORE_RU * paintingH * (16 / 9);
    const ry = CORE_RV * paintingH;
    const bands = 7;
    for (let i = bands; i >= 1; i--) {
      const f = i / bands;
      this.glow.ellipse(x, y, rx * (0.6 + f * 1.1), ry * (0.6 + f * 1.1)).fill({ color: 0x8ff3ff, alpha: 0.07 * (1 - f) * (1 - f) + 0.02 });
    }
    this.drawMotes();
  }

  /** Small crystal motes drifting up off the dais — deterministic per index, so the same
   *  frame always draws the same picture (and a test can reason about it). */
  private drawMotes(): void {
    this.motes.clear();
    const { x, y, paintingH } = this.point;
    const rx = CORE_RU * paintingH * (16 / 9);
    const rise = paintingH * 0.22;
    for (let i = 0; i < MOTES; i++) {
      const p = frac(this.clockMs / MOTE_RISE_MS + i * 0.618034);
      const jitter = frac(Math.sin(i * 12.9898) * 43758.5453) - 0.5;
      const mx = x + jitter * rx * 1.6 + Math.sin(p * Math.PI * 2 + i) * rx * 0.08;
      const my = y - p * rise;
      if (my < 0 || my > this.h || mx < 0 || mx > this.w) continue;
      const s = paintingH * (0.0028 + 0.0018 * frac(i * 0.37));
      const a = Math.sin(p * Math.PI) * 0.85;
      this.motes.poly([mx, my - s * 1.6, mx + s, my, mx, my + s * 1.6, mx - s, my]).fill({ color: 0xc8fbff, alpha: a });
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function frac(v: number): number {
  return v - Math.floor(v);
}
