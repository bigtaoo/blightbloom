import { describe, it, expect, vi } from 'vitest';
import { isUsablePolicyUrl, openPolicy, policyUrl, type PolicyUrls } from './policyLinks';

describe('isUsablePolicyUrl', () => {
  it('accepts an absolute http(s) URL with a host', () => {
    expect(isUsablePolicyUrl('https://b.gamestao.com/privacy')).toBe(true);
    expect(isUsablePolicyUrl('http://example.test/terms')).toBe(true);
    // Surrounding whitespace is a configuration typo, not a different URL.
    expect(isUsablePolicyUrl('  https://b.gamestao.com/privacy  ')).toBe(true);
  });

  it('rejects an absent URL', () => {
    expect(isUsablePolicyUrl('')).toBe(false);
    expect(isUsablePolicyUrl('   ')).toBe(false);
  });

  it('rejects a RELATIVE URL, which is the failure a portal build hits', () => {
    // The whole reason this predicate exists. A relative path works on our own domain and
    // resolves against the PORTAL's host inside an embedded frame — so a build that shipped
    // one would 404 for exactly the players the link is required for, and pass every check
    // run on b.gamestao.com.
    expect(isUsablePolicyUrl('/privacy')).toBe(false);
    expect(isUsablePolicyUrl('privacy.html')).toBe(false);
    expect(isUsablePolicyUrl('./privacy')).toBe(false);
    expect(isUsablePolicyUrl('//b.gamestao.com/privacy')).toBe(false);
  });

  it('rejects a scheme that is not http(s), and a scheme with no host', () => {
    expect(isUsablePolicyUrl('javascript:alert(1)')).toBe(false);
    expect(isUsablePolicyUrl('data:text/html,hi')).toBe(false);
    expect(isUsablePolicyUrl('https://')).toBe(false);
  });
});

describe('policyUrl', () => {
  it('returns the shipped URLs, and they are absolute', () => {
    // Pinned as absolute rather than to an exact string: the value is the owner's to change,
    // the ABSOLUTENESS is the invariant a portal build depends on.
    for (const kind of ['privacy', 'terms'] as const) {
      const url = policyUrl(kind);
      expect(url, kind).not.toBeNull();
      expect(isUsablePolicyUrl(url!), kind).toBe(true);
    }
    // Both point somewhere different — one entry copy-pasted over the other would send a
    // player reading the terms to the privacy policy, and nothing else would notice.
    expect(policyUrl('privacy')).not.toBe(policyUrl('terms'));
  });

  it('is null for a build whose entry is blank or relative', () => {
    // Reachable only through the injected table: the shipped constants are both set, so
    // without this seam the absent-URL arm could not be exercised at all — and it is the arm
    // design/20's "nothing renders a link until one exists" rule actually rests on.
    const none: PolicyUrls = { privacy: '', terms: '   ' };
    expect(policyUrl('privacy', none)).toBeNull();
    expect(policyUrl('terms', none)).toBeNull();
    const relative: PolicyUrls = { privacy: '/privacy', terms: '/terms' };
    expect(policyUrl('privacy', relative)).toBeNull();
  });
});

describe('openPolicy', () => {
  const urls: PolicyUrls = { privacy: 'https://host.test/p', terms: 'https://host.test/t' };

  it('opens the right URL in a new tab, with noopener', () => {
    const open = vi.fn();
    openPolicy('terms', { open, urls });
    // `noopener` is asserted because without it the opened page keeps a `window.opener`
    // handle back into the game frame.
    expect(open).toHaveBeenCalledWith('https://host.test/t', '_blank', 'noopener,noreferrer');
  });

  it('opens nothing when this build has no usable URL', () => {
    const open = vi.fn();
    openPolicy('privacy', { open, urls: { privacy: '', terms: '' } });
    openPolicy('privacy', { open, urls: { privacy: '/privacy', terms: '/terms' } });
    expect(open).not.toHaveBeenCalled();
  });

  it('swallows a blocked or throwing popup', () => {
    // A third-party iframe can refuse `window.open` outright. The requirement is that the
    // tap did nothing, never that it threw mid-frame.
    const open = vi.fn(() => {
      throw new Error('popup blocked');
    });
    expect(() => openPolicy('privacy', { open, urls })).not.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('survives an environment with no window.open at all', () => {
    // `globalThis.open` is absent under the headless runner these screens are tested in, so
    // the default path has to tolerate it rather than assume a browser.
    expect(() => openPolicy('privacy', { urls })).not.toThrow();
  });
});
