import { describe, it, expect, afterEach } from 'vitest';
import { Container, Text } from 'pixi.js';
import { installFakeTextCanvas } from '../screens/fakeTextCanvas';
import { lobbyScale, lobbyColumnScale, sharpenText, LOBBY_MAX_SCALE, LOBBY_COLUMN_BOOST, LOBBY_COLUMN_MAX_SHARE } from './lobbyScale';
import { MENU_DESIGN_W, MENU_DESIGN_H } from './menuLayer';

installFakeTextCanvas();

const originalDpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
afterEach(() => {
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = originalDpr;
});

describe('lobbyScale', () => {
  it('is 1 at and under the design size, and for an unmeasured viewport', () => {
    expect(lobbyScale(MENU_DESIGN_W, MENU_DESIGN_H)).toBe(1);
    expect(lobbyScale(400, 300)).toBe(1);
    expect(lobbyScale(0, 0)).toBe(1);
    expect(lobbyScale(Number.NaN, 600)).toBe(1);
  });

  it('grows with the SHORTER fit, and stops at the cap', () => {
    expect(lobbyScale(1280, 720)).toBeCloseTo(720 / MENU_DESIGN_H, 5);
    expect(lobbyScale(3840, 2160)).toBe(LOBBY_MAX_SCALE);
  });
});

describe('sharpenText', () => {
  function tree() {
    const root = new Container();
    const inner = new Container();
    const a = new Text({ text: 'a' });
    const b = new Text({ text: 'b' });
    inner.addChild(b);
    root.addChild(a, inner);
    return { root, a, b };
  }
  const auto = (t: Text) => (t as unknown as { _autoResolution: boolean })._autoResolution;

  it('rasterises nested text at k times the device resolution, capped at 2x DPR', () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3;
    const { root, a, b } = tree();
    sharpenText(root, 1.5);
    expect(a.resolution).toBe(3);
    expect(b.resolution).toBe(3);
    expect(auto(a)).toBe(false);
    sharpenText(root, 1.5); // unchanged: no re-assignment needed
    expect(a.resolution).toBe(3);
  });

  it('hands text back to automatic resolution at k = 1', () => {
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 1;
    const { root, a } = tree();
    sharpenText(root, 1); // already automatic: left alone
    expect(auto(a)).toBe(true);
    sharpenText(root, 1.25);
    expect(a.resolution).toBe(1.25);
    sharpenText(root, 1);
    expect(auto(a)).toBe(true);
  });

  it('assumes a 1x display where there is no devicePixelRatio', () => {
    delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    const { root, a } = tree();
    sharpenText(root, 1.5);
    expect(a.resolution).toBe(1.5);
  });
});

describe('lobbyColumnScale', () => {
  it('boosts k by LOBBY_COLUMN_BOOST when the viewport has room', () => {
    expect(lobbyColumnScale(4000, 1.5, 100, 100, 4000)).toBeCloseTo(1.5 * LOBBY_COLUMN_BOOST, 9);
  });

  it('stops at its share of the width', () => {
    expect(lobbyColumnScale(1000, 1.2, 250, 10, 10000)).toBeCloseTo((1000 * LOBBY_COLUMN_MAX_SHARE) / 250, 9);
  });

  it('stops at the height it is given', () => {
    expect(lobbyColumnScale(10000, 1.4, 100, 500, 800)).toBeCloseTo(1.6, 9);
  });

  it('never goes below k, however little room there is', () => {
    expect(lobbyColumnScale(300, 1, 272, 364, 100)).toBe(1);
    expect(lobbyColumnScale(760, 1.2, 272, 364, 200)).toBe(1.2);
  });
});
