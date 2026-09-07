/**
 * `BannerHost` — the container element and the refresh floor.
 *
 * Two rules with real numbers behind them: hiding must also CLEAR (an uncleared container
 * flashes its previous creative next time it is filled), and a re-show inside 30 seconds
 * must not re-request (the platform's documented refresh floor, and a finite per-session
 * refresh budget behind it). Both are the kind of thing that looks fine in a browser and is
 * only visible in a call log.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BANNER_CONTAINER_ID,
  BANNER_REFRESH_MS,
  BANNER_SIZE,
  BannerHost,
  browserBannerDom,
  type BannerDom,
  type BannerSignal,
} from './BannerHost';

function harness(opts: { noDom?: boolean } = {}) {
  const calls: string[] = [];
  const visibility: boolean[] = [];
  const signal: BannerSignal = {
    requestBanner: async (id, w, h) => void calls.push(`request:${id}:${w}x${h}`),
    clearBanner: (id) => void calls.push(`clear:${id}`),
  };
  const dom: BannerDom = {
    createContainer: vi.fn(() =>
      opts.noDom ? null : { setVisible: (v: boolean) => void visibility.push(v) },
    ),
  };
  let clock = 0;
  const host = new BannerHost(signal, dom, () => clock);
  return { host, calls, visibility, dom, advance: (ms: number) => void (clock += ms) };
}

describe('BannerHost', () => {
  it('creates the container once and requests into it by id', async () => {
    const { host, calls, visibility, dom } = harness();
    await host.show();
    await host.show();
    expect(dom.createContainer).toHaveBeenCalledOnce();
    expect(dom.createContainer).toHaveBeenCalledWith(BANNER_CONTAINER_ID);
    expect(calls).toEqual([`request:${BANNER_CONTAINER_ID}:${BANNER_SIZE.width}x${BANNER_SIZE.height}`]);
    expect(visibility).toEqual([true, true]);
    expect(host.isVisible()).toBe(true);
  });

  it('does not re-request inside the refresh floor', async () => {
    const { host, calls, advance } = harness();
    await host.show();
    host.hide();
    advance(BANNER_REFRESH_MS - 1);
    await host.show();
    expect(calls.filter((c) => c.startsWith('request:'))).toHaveLength(1);
  });

  it('re-requests once the refresh floor has passed', async () => {
    const { host, calls, advance } = harness();
    await host.show();
    advance(BANNER_REFRESH_MS);
    await host.show();
    expect(calls.filter((c) => c.startsWith('request:'))).toHaveLength(2);
  });

  it('hides AND clears', async () => {
    const { host, calls, visibility } = harness();
    await host.show();
    host.hide();
    expect(visibility).toEqual([true, false]);
    expect(calls).toEqual([
      `request:${BANNER_CONTAINER_ID}:${BANNER_SIZE.width}x${BANNER_SIZE.height}`,
      `clear:${BANNER_CONTAINER_ID}`,
    ]);
    expect(host.isVisible()).toBe(false);
  });

  it('does not clear a banner it never showed', async () => {
    // `PortalSession` calls `hide()` on every phase that is not the menu, which is most of
    // them; a clear per phase change would burn SDK calls for nothing.
    const { host, calls } = harness();
    host.hide();
    host.hide();
    expect(calls).toEqual([]);
  });

  it('is inert with no DOM to place a container in', async () => {
    // WeChat and every unit test. `show()` has to be safe rather than conditional at the
    // call site, the same way every other absence in this package is handled.
    const { host, calls } = harness({ noDom: true });
    await host.show();
    host.hide();
    expect(calls).toEqual([]);
    expect(host.isVisible()).toBe(false);
  });
});

describe('browserBannerDom', () => {
  /** A minimal `Document` stand-in — enough for the two branches, no jsdom (design/18). */
  function fakeDoc() {
    const created: Array<{ id: string; style: Record<string, string> }> = [];
    const byId = new Map<string, unknown>();
    const doc = {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: () => {
        const el = { id: '', style: {} as Record<string, string> };
        created.push(el);
        return el;
      },
      body: { appendChild: (el: { id: string }) => void byId.set(el.id, el) },
    };
    return { doc: doc as unknown as Document, created, byId };
  }

  it('creates a fixed, bottom-centred container and appends it', () => {
    const { doc, created, byId } = fakeDoc();
    const el = browserBannerDom(doc).createContainer('cg-banner');
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe('cg-banner');
    // The placement rule, asserted rather than described: fixed and pinned to the bottom
    // centre is what keeps it off this game's own UI at every viewport size.
    expect(created[0]?.style.position).toBe('fixed');
    expect(created[0]?.style.bottom).toBe('0');
    expect(created[0]?.style.display).toBe('none'); // hidden until shown
    // ...and it has a SIZE. Not cosmetic: a responsive banner picks a creative that fits its
    // container, so a container sized to its own empty content is zero pixels wide and there
    // is nothing to pick. The first live run of this integration failed exactly there, with
    // everything else working — "no available banner size has been found for container".
    expect(created[0]?.style.width).toBe(`${BANNER_SIZE.width}px`);
    expect(created[0]?.style.height).toBe(`${BANNER_SIZE.height}px`);
    expect(byId.get('cg-banner')).toBeDefined();
    el?.setVisible(true);
    expect(created[0]?.style.display).toBe('block');
  });

  it('reuses an existing container rather than stacking a second one', () => {
    // Reachable for real: a reload with a surviving element, or a second `PortalSession` in
    // a dev session. Two containers with the same id is a banner the SDK can no longer
    // address unambiguously.
    const { doc, created } = fakeDoc();
    browserBannerDom(doc).createContainer('cg-banner');
    browserBannerDom(doc).createContainer('cg-banner');
    expect(created).toHaveLength(1);
  });
});
