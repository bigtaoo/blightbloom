// The DOM element a portal banner needs, and the rules about when it may exist.
//
// This is the one piece of the portal integration that has to touch the DOM directly: the
// game is a full-viewport Pixi canvas, and a banner is an iframe the SDK injects into a
// container element of ours. So there is a `<div>`, and it is positioned over the canvas.
//
// The placement rules (`docs.crazygames.com/requirements/ads`) are the whole design here:
//
//  - **Never during gameplay.** `PortalSession` only ever asks for a banner on the main
//     menu, and `hide()` is called on every other phase. The container is `display:none`
//     AND cleared, because the docs warn that an uncleared banner flashes its previous
//     creative the next time the container is filled.
//  - **Only on a screen that stays open for 5+ seconds.** The main menu qualifies; a result
//     screen the player clicks straight through does not, which is why this is wired to one
//     phase and not to "any menu".
//  - **It must not cover the game's own UI on any screen size.** Bottom-centre is the one
//     band that is empty in every layout this game has: the main menu's buttons are
//     centred on a card, its title sits above them, and `menuLayer.ts`'s fit-scale keeps
//     both inside a landscape phone's viewport rather than letting them reach the edges.
//     `pointer-events` is left alone — a banner has to be clickable to be a banner — but the
//     container is `position: fixed` at exactly `BANNER_SIZE`, so it cannot swallow a press
//     that misses it.
//  - **The container must have a SIZE, and the request must NAME it.** Not a style detail.
//     The first live run of this integration failed here with everything else working: the
//     container was sized to its own (empty) content, i.e. zero pixels wide, and
//     `requestResponsiveBanner` answered "no available banner size has been found for
//     container cg-banner-crazygames-inner" — it has to pick a creative that fits, and
//     nothing fits nothing. So the container is sized explicitly AND the request is the
//     explicit `requestBanner({id, width, height})` form the documentation's own example
//     uses, which asks no such question. 320x50 is the size, because it is the one standard
//     banner that fits at the bottom of every viewport this game supports, including a
//     390px-wide phone in landscape.
//
//     What remains unverified is whether a real portal page fills it: that cannot be
//     exercised from this repository, and the local SDK renders only a placeholder. The
//     posture is the one `server/src/billsvc/iap/`'s adapters take — the real call, written
//     and tested against the documented shape, failing closed — and `__portal.diagnostics()`
//     reports whether a banner is up, so one look at a live page settles it.
//  - **At most one refresh per 30 seconds.** Enforced here rather than trusted to the
//     caller: a player toggling between the menu and the mode-select screen would otherwise
//     re-request on every toggle.

/** The container's element id. The SDK addresses the container by id, so this string is the
 *  contract between the two halves and must match the element actually created. */
export const BANNER_CONTAINER_ID = 'cg-banner';

/** The refresh floor the platform documents. Requesting sooner is not an error, but it is
 *  wasted against the per-session refresh budget. */
export const BANNER_REFRESH_MS = 30_000;

/** The container's size in CSS pixels, and therefore the creative size the responsive
 *  request can fill it with. See the file header for why it is both explicit and small. */
export const BANNER_SIZE = { width: 320, height: 50 } as const;

/** The two SDK calls this needs, narrowed (CLAUDE.md form ②) so a test drives two spies. */
export interface BannerSignal {
  requestBanner(containerId: string, width: number, height: number): Promise<void>;
  clearBanner(containerId: string): void;
}

/** The DOM surface this needs, as an interface — every test in this package runs without a
 *  browser (design/18), and this is the whole of what a fake has to provide. */
export interface BannerDom {
  createContainer(id: string): BannerElement | null;
}

export interface BannerElement {
  setVisible(visible: boolean): void;
}

/** The real implementation. Kept beside the class rather than in `platform/web/` because it
 *  exists only for this host, and its styling IS the placement rule above. */
export function browserBannerDom(doc: Document = document): BannerDom {
  return {
    createContainer(id) {
      const existing = doc.getElementById(id);
      const el = existing ?? doc.createElement('div');
      if (!existing) {
        el.id = id;
        el.style.position = 'fixed';
        el.style.left = '50%';
        el.style.bottom = '0';
        el.style.transform = 'translateX(-50%)';
        el.style.zIndex = '10';
        el.style.display = 'none';
        // Explicit, because a responsive banner has nothing to fit into otherwise — see the
        // file header's fourth rule and the live failure that produced it.
        el.style.width = `${BANNER_SIZE.width}px`;
        el.style.height = `${BANNER_SIZE.height}px`;
        doc.body.appendChild(el);
      }
      return {
        setVisible: (visible) => {
          el.style.display = visible ? 'block' : 'none';
        },
      };
    },
  };
}

export class BannerHost {
  private element: BannerElement | null = null;
  private visible = false;
  private lastRequestAt = -Infinity;

  constructor(
    private readonly signal: BannerSignal,
    private readonly dom: BannerDom,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Show a banner, requesting a fresh one if the refresh floor has passed.
   *
   * Idempotent per screen visit: calling it again while already visible only re-requests
   * once `BANNER_REFRESH_MS` has elapsed, so a caller may drive it from a phase change
   * without counting.
   */
  async show(): Promise<void> {
    this.element ??= this.dom.createContainer(BANNER_CONTAINER_ID);
    if (!this.element) return; // no DOM (WeChat, a test): nothing to place a banner in
    this.element.setVisible(true);
    this.visible = true;
    const t = this.now();
    if (t - this.lastRequestAt < BANNER_REFRESH_MS) return;
    this.lastRequestAt = t;
    await this.signal.requestBanner(BANNER_CONTAINER_ID, BANNER_SIZE.width, BANNER_SIZE.height);
  }

  /** Hide AND clear. Both, always — see the note above on the stale-creative flash. */
  hide(): void {
    if (!this.element) return;
    this.element.setVisible(false);
    if (this.visible) this.signal.clearBanner(BANNER_CONTAINER_ID);
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }
}
