/**
 * The signed-in player's picture as a round disc — the portal avatar beside the "Hi, {name}"
 * label (design/20 "account integration": the platform names username AND avatar).
 *
 * The picture is a REMOTE image on a CDN this page does not control, so everything about it
 * is allowed to fail: the URL may 404, the host may stop sending CORS headers (a WebGL texture
 * from a cross-origin image needs them — `images.crazygames.com` sends
 * `Access-Control-Allow-Origin: *`, checked 2026-10-16), or the load may land after the
 * player signed out or switched accounts. Every one of those ends in the disc being hidden,
 * which leaves the label exactly as it was before this existed.
 */
import { Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js';

/** Fetch a texture for `url`, or `null`. The parser is named because a portal avatar URL is
 *  not guaranteed an image extension (and the shipped ones are JPEG bytes behind `.png`). */
export type PictureLoader = (url: string) => Promise<Texture | null>;

export const loadRemotePicture: PictureLoader = async (url) => {
  try {
    return await Assets.load<Texture>({ src: url, loadParser: 'loadTextures' });
  } catch {
    return null;
  }
};

export class PlayerPicture {
  readonly view = new Container();
  private readonly sprite = new Sprite();
  private readonly ring = new Graphics();
  private readonly mask = new Graphics();
  /** The URL the visible (or in-flight) picture belongs to — what makes a late load stale. */
  private want: string | null = null;

  constructor(
    private readonly size: number,
    private readonly load: PictureLoader = loadRemotePicture,
  ) {
    const r = size / 2;
    this.mask.circle(r, r, r).fill({ color: 0xffffff });
    this.ring.circle(r, r, r).stroke({ color: 0xffffff, width: 1.5, alpha: 0.35 });
    this.sprite.mask = this.mask;
    this.view.addChild(this.sprite, this.mask, this.ring);
    this.view.visible = false;
  }

  /** True once a picture is actually on screen — the caller lays the label out around it. */
  get shown(): boolean {
    return this.view.visible;
  }

  /**
   * Show the picture at `url`, or hide the disc with `null`. Resolves once the outcome is on
   * screen, so `onSettled` can re-lay the row out.
   */
  async setUrl(url: string | null, onSettled?: () => void): Promise<void> {
    if (url === this.want) return;
    this.want = url;
    this.view.visible = false;
    if (url === null) {
      onSettled?.();
      return;
    }
    const tex = await this.load(url);
    if (this.want !== url) return; // signed out or switched while it loaded
    if (!tex || tex.width <= 0 || tex.height <= 0) {
      onSettled?.();
      return;
    }
    this.sprite.texture = tex;
    // Cover, not fit: a non-square picture fills the disc and its overflow is masked away.
    const s = this.size / Math.min(tex.width, tex.height);
    this.sprite.scale.set(s);
    this.sprite.position.set((this.size - tex.width * s) / 2, (this.size - tex.height * s) / 2);
    this.view.visible = true;
    onSettled?.();
  }
}
