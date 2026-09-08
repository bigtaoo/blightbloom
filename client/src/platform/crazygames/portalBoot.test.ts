/**
 * `portalBoot.ts` — what the portal meant by opening this page, and what was done about it.
 *
 * The PRECEDENCE case is the one worth writing: an accepted invite beats instant
 * multiplayer, because a player who clicked a specific friend's link wants that party and a
 * queue for strangers is a different thing, not a lesser version of the same one. A queue
 * would silently discard the only information the link carried.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyPortalBootIntent } from './portalBoot';
import type { CrazyGamesSdk } from './sdk';
import { setOnlineEntry } from '../onlineEntry';

function stubSdk(over: { party?: string | null; instant?: boolean } = {}) {
  return {
    getInviteParam: async (name: string) => (name === 'party' ? over.party ?? null : null),
    instantMultiplayer: async () => over.instant ?? false,
  } as unknown as CrazyGamesSdk;
}

function entryStub() {
  const entry = { queueCoop: vi.fn(), joinPartyByCode: vi.fn() };
  setOnlineEntry(entry);
  return entry;
}

afterEach(() => setOnlineEntry(null));

describe('applyPortalBootIntent', () => {
  it('does nothing on an ordinary page open', () => {
    // Which is every page a player opens normally, so this is the case that must not
    // navigate anywhere.
    const entry = entryStub();
    return applyPortalBootIntent(stubSdk()).then((intent) => {
      expect(intent).toEqual({ partyCode: null, instantMultiplayer: false, action: 'none' });
      expect(entry.queueCoop).not.toHaveBeenCalled();
      expect(entry.joinPartyByCode).not.toHaveBeenCalled();
    });
  });

  it('joins the party an accepted invite carried', async () => {
    const entry = entryStub();
    const intent = await applyPortalBootIntent(stubSdk({ party: 'ABCD' }));
    expect(entry.joinPartyByCode).toHaveBeenCalledWith('ABCD');
    expect(entry.queueCoop).not.toHaveBeenCalled();
    expect(intent.action).toBe('joined-party');
  });

  it('queues for co-op when the portal asked for instant multiplayer', async () => {
    const entry = entryStub();
    const intent = await applyPortalBootIntent(stubSdk({ instant: true }));
    expect(entry.queueCoop).toHaveBeenCalledTimes(1);
    expect(entry.joinPartyByCode).not.toHaveBeenCalled();
    expect(intent.action).toBe('queued-coop');
  });

  it('prefers the INVITE when both are set', async () => {
    // The precedence decision, stated as a test because it is the one thing here that
    // could reasonably have gone the other way.
    const entry = entryStub();
    const intent = await applyPortalBootIntent(stubSdk({ party: 'ABCD', instant: true }));
    expect(entry.joinPartyByCode).toHaveBeenCalledWith('ABCD');
    expect(entry.queueCoop).not.toHaveBeenCalled();
    expect(intent).toEqual({ partyCode: 'ABCD', instantMultiplayer: true, action: 'joined-party' });
  });

  it('reports a missing capability instead of silently doing nothing', async () => {
    // The registry is installed during screen assembly, long before this runs — so an
    // absent one is a wiring bug, and reporting it as `none` would hide it behind the
    // page that legitimately has no intent.
    setOnlineEntry(null);
    const intent = await applyPortalBootIntent(stubSdk({ party: 'ABCD' }));
    expect(intent.action).toBe('no-entry-installed');
  });

  it('does not report a missing capability on a page with no intent', async () => {
    setOnlineEntry(null);
    expect((await applyPortalBootIntent(stubSdk())).action).toBe('none');
  });

  it('reads the party code from the `party` invite param and no other', async () => {
    const entry = entryStub();
    const sdk = {
      getInviteParam: async (name: string) => (name === 'roomName' ? 'WRONG' : null),
      instantMultiplayer: async () => false,
    } as unknown as CrazyGamesSdk;
    await applyPortalBootIntent(sdk);
    expect(entry.joinPartyByCode).not.toHaveBeenCalled();
  });
});
