/**
 * The source tag and device split — `visitContext.ts`. Real user-agent strings, because the
 * ordering rules exist for the UAs that nest inside each other (every Chromium says Safari,
 * Edge and WeChat say Chrome, Android says Linux, an iPad says Macintosh).
 */
import { describe, it, expect } from 'vitest';
import { aspectOf, browserOf, deviceOf, deviceSplit, osOf, trafficSource } from './visitContext';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1',
  iPadOld: 'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
  wechat: 'Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  bot: 'curl/8.4.0',
};

describe('deviceSplit', () => {
  it.each([
    ['winChrome', 0, { device: 'desktop', os: 'windows', browser: 'chrome' }],
    ['winEdge', 0, { device: 'desktop', os: 'windows', browser: 'edge' }],
    ['macSafari', 0, { device: 'desktop', os: 'macos', browser: 'safari' }],
    // iPadOS 13+: a desktop Safari UA that gives itself away only by touch.
    ['macSafari', 5, { device: 'tablet', os: 'ios', browser: 'safari' }],
    ['macFirefox', 0, { device: 'desktop', os: 'macos', browser: 'firefox' }],
    ['iPhone', 5, { device: 'phone', os: 'ios', browser: 'safari' }],
    ['iPhoneChrome', 5, { device: 'phone', os: 'ios', browser: 'chrome' }],
    ['iPadOld', 5, { device: 'tablet', os: 'ios', browser: 'safari' }],
    ['androidPhone', 5, { device: 'phone', os: 'android', browser: 'chrome' }],
    ['androidTablet', 5, { device: 'tablet', os: 'android', browser: 'chrome' }],
    ['samsung', 5, { device: 'phone', os: 'android', browser: 'samsung' }],
    ['opera', 0, { device: 'desktop', os: 'windows', browser: 'opera' }],
    ['wechat', 5, { device: 'phone', os: 'android', browser: 'wechat' }],
    ['chromebook', 0, { device: 'desktop', os: 'chromeos', browser: 'chrome' }],
    ['linuxFirefox', 0, { device: 'desktop', os: 'linux', browser: 'firefox' }],
    ['bot', 0, { device: 'desktop', os: 'other', browser: 'other' }],
  ] as const)('%s (touch %d)', (name, touch, want) => {
    expect(deviceSplit(UA[name], touch)).toEqual(want);
  });

  it('exposes each family on its own', () => {
    expect(osOf(UA.iPhone, 0)).toBe('ios');
    expect(browserOf('Mozilla/5.0 (Android) EdgA/129.0')).toBe('edge');
    expect(browserOf('Opera/9.80 (Windows NT 6.1)')).toBe('opera');
    expect(browserOf('Mozilla/5.0 (iPhone) FxiOS/130.0 Mobile/15E148 Safari/605.1.15')).toBe('firefox');
    expect(deviceOf('Mozilla/5.0 (iPod touch; CPU iPhone OS 12_0)', 0)).toBe('phone');
    expect(deviceOf('Mozilla/5.0 (Mobile; rv:48.0) Gecko/48.0 Firefox/48.0', 0)).toBe('phone');
  });
});

describe('trafficSource', () => {
  it('prefers a campaign tag, src before utm_source, lower-cased', () => {
    expect(trafficSource('?src=Reddit&utm_source=x', 'https://www.google.com/', 'b.gamestao.com')).toBe('reddit');
    expect(trafficSource('?utm_source=itch.io', '', 'b.gamestao.com')).toBe('itch.io');
    expect(trafficSource('?src=%20poki%20', '', '')).toBe('poki');
  });

  it('ignores a malformed tag and falls back to the referrer, never truncating', () => {
    expect(trafficSource('?src=<script>', 'https://news.ycombinator.com/item?id=1', '')).toBe('ref:news.ycombinator.com');
    expect(trafficSource(`?src=${'a'.repeat(33)}`, '', '')).toBeUndefined();
    expect(trafficSource('?src=', '', '')).toBeUndefined();
  });

  it('keeps the referrer\'s host only, without www.', () => {
    expect(trafficSource('', 'https://www.reddit.com/r/IndieGaming/comments/abc/my_post', 'b.gamestao.com')).toBe('ref:reddit.com');
  });

  it('treats a missing, unparseable or own-site referrer as direct', () => {
    expect(trafficSource('', '', 'b.gamestao.com')).toBeUndefined();
    expect(trafficSource('', 'not a url', 'b.gamestao.com')).toBeUndefined();
    expect(trafficSource('', 'https://b.gamestao.com/?x', 'B.gamestao.com')).toBeUndefined();
    expect(trafficSource('', 'https://www.b.gamestao.com/', 'b.gamestao.com')).toBeUndefined();
    expect(trafficSource('', 'file:///C:/game/index.html', '')).toBeUndefined();
  });

  it('folds a host the id alphabet cannot hold into ref:other', () => {
    expect(trafficSource('', `https://${'x'.repeat(50)}.com/`, '')).toBe('ref:other');
    expect(trafficSource('', 'https://xn--bcher-kva.example/', '')).toBe('ref:xn--bcher-kva.example');
  });
});

describe('aspectOf', () => {
  // The threshold is 5:4 and its reciprocal (design/21 §2.12): wide enough that a 4:3 tablet
  // held flat reads `wide` and held upright reads `tall`, while a frame that is genuinely
  // close to square — the shape this game's layout has the least room for — reads `square`.
  it.each([
    ['a 16:9 desktop frame', 1920, 1080, 'wide'],
    ['exactly 5:4, the wide edge of the band', 1250, 1000, 'wide'],
    ['a 4:3 tablet laid flat', 1024, 768, 'wide'],
    ['a true square', 800, 800, 'square'],
    ['just inside square on the wide side', 1249, 1000, 'square'],
    ['just inside square on the tall side', 1000, 1249, 'square'],
    ['exactly 4:5, the tall edge of the band', 1000, 1250, 'tall'],
    ['a phone held upright', 390, 844, 'tall'],
  ])('reads %s as %s', (_label, w, h, want) => {
    expect(aspectOf(w, h)).toBe(want);
  });

  it('labels a transposed frame as the opposite band, never the same one', () => {
    // Why the tall threshold is 1/1.25 and not 0.75: with 0.75 a 1000x1100 frame and a
    // 1100x1000 frame would BOTH report `square`, and the split could not see a rotation.
    for (const [w, h] of [[1920, 1080], [1250, 1000], [1024, 768], [1249, 1000]] as const) {
      const a = aspectOf(w, h);
      const flipped = a === 'square' ? 'square' : a === 'wide' ? 'tall' : 'wide';
      expect(aspectOf(h, w), `${w}x${h}`).toBe(flipped);
    }
  });

  it('calls a frame with no area unsized rather than guessing a shape', () => {
    // The Playgama sandbox's own case: the iframe exists and is measured before it is laid
    // out. A ratio of 0/0 is NaN, which every comparison below answers `false` to — so this
    // guard is what stops a 0x0 frame from quietly reporting `square`.
    for (const [w, h] of [[0, 0], [0, 812], [375, 0], [-1, 800], [800, Number.NaN], [Number.POSITIVE_INFINITY, 0]] as const) {
      expect(aspectOf(w, h), `${w}x${h}`).toBe('unsized');
    }
    expect(aspectOf(Number.POSITIVE_INFINITY, 1080)).toBe('wide');
  });
});
