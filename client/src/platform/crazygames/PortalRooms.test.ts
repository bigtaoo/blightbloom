/**
 * `PortalRooms.ts` — the portal's room and invite affordances, driven by the party the game
 * declares.
 *
 * The SDK is a recording stub, so what every case asserts is the exact SEQUENCE of calls a
 * live page would have received. That matters more than it looks: `updateRoom({isJoinable:
 * false})` and `leftRoom()` are different statements to whoever is being shown a join
 * button ("full" vs. "not in a room"), and a stray invite button on a party nobody can join
 * is a link the platform will refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PortalRooms, INVITE_PARAM_PARTY } from './PortalRooms';
import type { CrazyGamesSdk } from './sdk';
import { resetPartyPresence, setPartyPresence } from '../partyPresence';

function stubSdk() {
  const calls: string[] = [];
  const sdk = {
    updateRoom: (roomId: string, isJoinable: boolean, inviteParams?: Record<string, string>) =>
      void calls.push(`updateRoom:${roomId}:${isJoinable}:${JSON.stringify(inviteParams)}`),
    leftRoom: () => void calls.push('leftRoom'),
    showInviteButton: (params: Record<string, string>) => void calls.push(`showInvite:${JSON.stringify(params)}`),
    hideInviteButton: () => void calls.push('hideInvite'),
  } as unknown as CrazyGamesSdk;
  return { sdk, calls };
}

const JOINABLE = { partyId: 'p-1', code: 'ABCD', joinable: true };
const CLOSED = { partyId: 'p-1', code: 'ABCD', joinable: false };
const PARAMS = JSON.stringify({ [INVITE_PARAM_PARTY]: 'ABCD' });

beforeEach(() => resetPartyPresence());
afterEach(() => resetPartyPresence());

describe('PortalRooms', () => {
  it('announces nothing but "no room" on a start with no party', () => {
    const { sdk, calls } = stubSdk();
    new PortalRooms(sdk).start();
    // Stated rather than staying silent: a page reload inside a match leaves the portal
    // believing the previous session's room still exists.
    expect(calls).toEqual(['leftRoom', 'hideInvite']);
  });

  it('announces a joinable party as a room AND shows the invite button', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    calls.length = 0;
    setPartyPresence(JOINABLE);
    expect(calls).toEqual([`updateRoom:p-1:true:${PARAMS}`, `showInvite:${PARAMS}`]);
  });

  it('carries the join CODE as the invite param and the party ID as the room', () => {
    // The two are different strings on purpose: the portal wants an opaque room id, and a
    // joiner needs the code our own `/party/join` takes.
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    calls.length = 0;
    setPartyPresence({ partyId: 'party-uuid', code: 'WXYZ', joinable: true });
    expect(calls[0]).toContain('updateRoom:party-uuid:true');
    expect(calls[0]).toContain('"party":"WXYZ"');
  });

  it('keeps the room but HIDES the invite button once the party cannot be joined', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    setPartyPresence(JOINABLE);
    calls.length = 0;
    setPartyPresence(CLOSED);
    expect(calls).toEqual([`updateRoom:p-1:false:${PARAMS}`, 'hideInvite']);
    // ...and specifically NOT leftRoom: the player is still in that room.
    expect(calls).not.toContain('leftRoom');
  });

  it('leaves the room when the party goes away', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    setPartyPresence(JOINABLE);
    calls.length = 0;
    setPartyPresence(null);
    expect(calls).toEqual(['leftRoom', 'hideInvite']);
  });

  it('picks up a party that already existed before it started', () => {
    // The entry point installs this after `game.start()`, so a party genuinely can exist
    // first — `getPartyPresence()` is what makes that ordering a non-issue.
    setPartyPresence(JOINABLE);
    const { sdk, calls } = stubSdk();
    new PortalRooms(sdk).start();
    expect(calls).toEqual([`updateRoom:p-1:true:${PARAMS}`, `showInvite:${PARAMS}`]);
  });

  it('does not double-subscribe when started twice', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    rooms.start();
    calls.length = 0;
    setPartyPresence(JOINABLE);
    expect(calls).toEqual([`updateRoom:p-1:true:${PARAMS}`, `showInvite:${PARAMS}`]);
  });

  it('stop() leaves the room it had announced, then stops reacting', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    setPartyPresence(JOINABLE);
    calls.length = 0;
    rooms.stop();
    expect(calls).toEqual(['leftRoom', 'hideInvite']);
    calls.length = 0;
    setPartyPresence({ ...JOINABLE, code: 'ZZZZ' });
    expect(calls).toEqual([]);
  });

  it('stop() with no room announced says nothing at all', () => {
    const { sdk, calls } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    calls.length = 0;
    rooms.stop();
    expect(calls).toEqual([]);
  });

  it('reports its state for diagnostics, distinguishing all three', () => {
    const { sdk } = stubSdk();
    const rooms = new PortalRooms(sdk);
    rooms.start();
    expect(rooms.state()).toBe('no room');
    setPartyPresence(JOINABLE);
    expect(rooms.state()).toBe('room ABCD (joinable)');
    setPartyPresence(CLOSED);
    expect(rooms.state()).toBe('room ABCD (closed)');
  });
});
