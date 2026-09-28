// The fade a piece of lobby art plays when it lands after the lobby is already on screen
// (render/uiSkins.ts's `lobby` tier, 2026-09-28). A portrait or a banner popping in at full
// opacity mid-look reads as a glitch; the same image easing in over a fifth of a second reads
// as the screen finishing. Art that is already loaded when its widget first draws does not
// fade — that is the ordinary warm-cache boot, and it should look exactly as it always did.
//
// Not gated on "reduce motion" (render/motion.ts): that setting covers whole-screen motion
// that carries no information, and an opacity ramp on one object moves nothing.

/** How long the ramp takes. */
export const ART_FADE_MS = 200;

/** Anything with an opacity — a Pixi `Container`, or a stub in a test. */
export interface Fadeable {
  alpha: number;
}

export class ArtFade {
  private elapsed = ART_FADE_MS;

  /** `target` gets the opacity written into it. Leave it out for an object whose alpha is
   *  already animated by its owner, and multiply `level` into that instead. */
  constructor(private readonly target?: Fadeable) {}

  /** Start from transparent. */
  start(): void {
    this.elapsed = 0;
    if (this.target) this.target.alpha = 0;
  }

  /** Where the ramp is, 0..1 — 1 whenever no fade is running. */
  get level(): number {
    return this.elapsed / ART_FADE_MS;
  }

  /** Is a ramp still running? */
  get active(): boolean {
    return this.elapsed < ART_FADE_MS;
  }

  update(dtMs: number): void {
    if (!this.active) return;
    this.elapsed = Math.min(ART_FADE_MS, this.elapsed + Math.max(0, dtMs));
    if (this.target) this.target.alpha = this.level;
  }
}
