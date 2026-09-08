/**
 * `platform/partyPresence.ts` — the squad the game declares and a host reacts to. Module
 * state, so every case resets first.
 *
 * The de-duplication cases carry the weight here. `PartyScreen.refresh()` runs on a
 * one-second poll, so a registry that notified on every call would turn one party into one
 * SDK round trip per second for as long as the player sat in it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPartyPresence,
  onPartyPresence,
  resetPartyPresence,
  setPartyPresence,
  type PartyPresence,
} from './partyPresence';

const SQUAD: PartyPresence = { partyId: 'p-1', code: 'ABCD', joinable: true };

beforeEach(() => resetPartyPresence());

describe('setPartyPresence', () => {
  it('notifies every subscriber with the new presence', () => {
    const a = vi.fn();
    const b = vi.fn();
    onPartyPresence(a);
    onPartyPresence(b);
    setPartyPresence(SQUAD);
    expect(a).toHaveBeenCalledWith(SQUAD);
    expect(b).toHaveBeenCalledWith(SQUAD);
  });

  it('notifies with null when the player leaves', () => {
    const seen = vi.fn();
    onPartyPresence(seen);
    setPartyPresence(SQUAD);
    setPartyPresence(null);
    expect(seen).toHaveBeenNthCalledWith(2, null);
  });

  it('does NOT notify for an unchanged presence, however many times it is set', () => {
    // The whole reason `same()` exists — see the file header.
    const seen = vi.fn();
    onPartyPresence(seen);
    setPartyPresence(SQUAD);
    setPartyPresence({ ...SQUAD });
    setPartyPresence({ partyId: 'p-1', code: 'ABCD', joinable: true });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('notifies when any single field changes', () => {
    // Asserted field by field, because a `same()` that compared only the id would pass a
    // test that changed the code, and the code is the half a joiner needs.
    const changes: PartyPresence[] = [
      { ...SQUAD, joinable: false },
      { ...SQUAD, code: 'WXYZ' },
      { ...SQUAD, partyId: 'p-2' },
    ];
    for (const changed of changes) {
      resetPartyPresence();
      const seen = vi.fn();
      onPartyPresence(seen);
      setPartyPresence(SQUAD);
      setPartyPresence(changed);
      expect(seen, JSON.stringify(changed)).toHaveBeenCalledTimes(2);
    }
  });

  it('does not notify for null when there was already no party', () => {
    const seen = vi.fn();
    onPartyPresence(seen);
    setPartyPresence(null);
    expect(seen).not.toHaveBeenCalled();
  });

  it('survives a listener that throws, and still reaches the next one', () => {
    const after = vi.fn();
    onPartyPresence(() => {
      throw new Error('the host blew up');
    });
    onPartyPresence(after);
    expect(() => setPartyPresence(SQUAD)).not.toThrow();
    expect(after).toHaveBeenCalledWith(SQUAD);
  });

  it('lets a listener unsubscribe during dispatch without skipping the next', () => {
    const order: string[] = [];
    const off = onPartyPresence(() => {
      order.push('first');
      off();
    });
    onPartyPresence(() => order.push('second'));
    setPartyPresence(SQUAD);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('getPartyPresence', () => {
  it('is null before anything is declared', () => {
    expect(getPartyPresence()).toBeNull();
  });

  it('answers a reader that started AFTER the party already existed', () => {
    // `PortalRooms.start()` runs from the entry point, after `game.start()`, so the party
    // can genuinely already exist by then — this is the read that makes that ordering
    // stop mattering.
    setPartyPresence(SQUAD);
    expect(getPartyPresence()).toEqual(SQUAD);
  });
});

describe('onPartyPresence', () => {
  it('does not deliver the current value on subscribe', () => {
    // Deliberately unlike `sessionEvents.ts`, which is sticky. A room announcement is
    // idempotent and cheap to re-apply, so the caller reads `getPartyPresence()` explicitly
    // instead of a first call arriving from inside the subscription.
    setPartyPresence(SQUAD);
    const seen = vi.fn();
    onPartyPresence(seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it('stops calling an unsubscribed listener', () => {
    const seen = vi.fn();
    onPartyPresence(seen)();
    setPartyPresence(SQUAD);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('resetPartyPresence', () => {
  it('drops listeners and the current presence', () => {
    const seen = vi.fn();
    onPartyPresence(seen);
    setPartyPresence(SQUAD);
    resetPartyPresence();
    expect(getPartyPresence()).toBeNull();
    setPartyPresence(SQUAD);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
