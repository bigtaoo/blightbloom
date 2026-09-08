// The hosted privacy policy and terms, and the rule about linking to them (design/20).
//
// These are ABSOLUTE URLs on purpose, and `isUsablePolicyUrl` refuses anything else. On a
// game portal this bundle is served from the portal's own host, so a relative `/privacy`
// would resolve against `crazygames.com` and 404 — the one target that most needs the link
// is the one a relative path silently breaks on, and it breaks in a way no test on our own
// domain would ever see.
//
// design/20's rule was "nothing renders a link until one exists — an empty placeholder link
// is worse than none". That is why `policyUrl` returns `string | null` rather than a bare
// constant: a screen has to handle the absent case, and blanking an entry below is a
// supported way to turn the link off everywhere at once.
const URLS = {
  privacy: 'https://b.gamestao.com/privacy',
  terms: 'https://b.gamestao.com/terms',
} as const;

export type PolicyKind = keyof typeof URLS;

/** The table shape, so a test can supply its own without reaching into this module. */
export type PolicyUrls = Readonly<Record<PolicyKind, string>>;

export interface OpenPolicyDeps {
  /** Injected in tests; defaults to the real `window.open`. */
  open?: typeof window.open;
  /** Injected in tests; defaults to the shipped table. */
  urls?: PolicyUrls;
}

/**
 * Whether a configured policy URL can actually be linked to.
 *
 * Absent (blank) and RELATIVE are the two ways this can be wrong, and they are rejected for
 * different reasons: a blank entry means this build has no policy page, while a relative
 * one means it has a page that only resolves on our own domain. Both must produce "render
 * no link" rather than "render a link that 404s for every portal player".
 */
export function isUsablePolicyUrl(raw: string): boolean {
  const url = raw.trim();
  if (url.length === 0) return false;
  return /^https?:\/\/.+/.test(url);
}

/** The URL for a policy page, or `null` if this build has none it can use. */
export function policyUrl(kind: PolicyKind, urls: PolicyUrls = URLS): string | null {
  const raw = urls[kind].trim();
  return isUsablePolicyUrl(raw) ? raw : null;
}

/**
 * Open a policy page in a new tab.
 *
 * Wrapped because this is the only place in the client that reaches for `window.open`, and
 * on a portal it runs inside a third-party iframe where the call can be blocked outright or
 * throw on a sandboxed frame. A blocked link is a link that did nothing; it is never an
 * exception in the middle of a menu tap — the same rule `platform/crazygames/settle.ts`
 * applies to every SDK call.
 *
 * `noopener` is not optional: without it the opened page gets a `window.opener` handle back
 * into the game frame.
 */
export function openPolicy(kind: PolicyKind, deps: OpenPolicyDeps = {}): void {
  const url = policyUrl(kind, deps.urls ?? URLS);
  if (!url) return;
  const open = deps.open ?? globalThis.open;
  try {
    open?.(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* a blocked popup is not the menu's problem */
  }
}
