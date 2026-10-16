/**
 * What a visit's first event says about where it came from and what it runs on (design/21
 * §2.9): the traffic source, and a coarse device split. Pure — strings in, strings out — so
 * every rule below is testable without a browser; `analyticsInstall.ts` reads the globals.
 *
 * ## Why these and nothing finer
 *
 * The question is "which players stop, and is it the game or the device", which three
 * families answer: phone / tablet / desktop, the OS, the browser. A version number, a model
 * name or a screen size would answer nothing more at this traffic and would start to look
 * like a fingerprint, which a game with no consent banner has no business sending. Every
 * value here is a member of a closed enum in `analyticsEvents.ts`, so the server cannot store
 * anything finer even from a client that tried.
 *
 * ## The source
 *
 * An explicit tag wins: `?src=reddit` (or `?utm_source=`) on the link we posted, so a paid or
 * community test can be told apart from everyone else. Without one, the REFERRER's hostname —
 * never its path, which can carry a search query or a post title — prefixed `ref:`. Neither
 * present is "direct", and the server writes that label rather than the client sending it.
 */
import { ID_RE, type DeviceClass, type OsFamily, type BrowserFamily } from './analyticsEvents';

export interface DeviceSplit {
  device: DeviceClass;
  os: OsFamily;
  browser: BrowserFamily;
}

/** The OS family. Android before Linux (its UA contains both) and the iPad-as-Mac case
 *  last-but-one: iPadOS 13+ sends a desktop Safari UA and gives itself away only by touch. */
export function osOf(ua: string, maxTouchPoints: number): OsFamily {
  if (/Windows/.test(ua)) return 'windows';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Macintosh|Mac OS X/.test(ua)) return maxTouchPoints > 1 ? 'ios' : 'macos';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

/** The browser family. Ordered because UAs nest: Edge, Opera, Samsung and the in-app WeChat
 *  browser all say `Chrome/`, and every Chromium says `Safari/`. */
export function browserOf(ua: string): BrowserFamily {
  if (/MicroMessenger/.test(ua)) return 'wechat';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\/|FxiOS/.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS/.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** Phone, tablet or desktop. An Android UA without `Mobile` is a tablet by Google's own
 *  convention; an iPad, or a Mac UA with a touch screen, is a tablet. */
export function deviceOf(ua: string, maxTouchPoints: number): DeviceClass {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'tablet';
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/.test(ua)) return 'phone';
  return 'desktop';
}

export function deviceSplit(ua: string, maxTouchPoints: number): DeviceSplit {
  return { device: deviceOf(ua, maxTouchPoints), os: osOf(ua, maxTouchPoints), browser: browserOf(ua) };
}

/** A campaign tag's charset and length. Narrower than `ID_RE` on purpose: a tag is something
 *  we typed into a link, so anything outside it is somebody else's text. */
const TAG_RE = /^[a-z0-9_.-]{1,32}$/;

/** Room for the `ref:` prefix inside `ID_RE`'s 48. */
const REF_PREFIX = 'ref:';

/**
 * The visit's traffic source, or `undefined` for a direct visit.
 *
 * `search` is `location.search`, `referrer` is `document.referrer`, `ownHost` is
 * `location.hostname` — a referrer from our own site is a reload or an internal link, not a
 * source. A tag that fails {@link TAG_RE} is ignored rather than truncated, and the referrer
 * is used instead: a mangled tag is not the campaign it was meant to name.
 */
export function trafficSource(search: string, referrer: string, ownHost: string): string | undefined {
  const params = new URLSearchParams(search);
  for (const key of ['src', 'utm_source']) {
    const tag = params.get(key)?.trim().toLowerCase();
    if (tag !== undefined && TAG_RE.test(tag)) return tag;
  }
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./, '');
  if (host === '' || host === ownHost.toLowerCase().replace(/^www\./, '')) return undefined;
  const source = `${REF_PREFIX}${host}`;
  return ID_RE.test(source) ? source : `${REF_PREFIX}other`;
}
