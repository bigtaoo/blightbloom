/**
 * `SeatRoster` — who else is in this match, by name. Pixi `Text` constructs and mutates
 * fine under plain vitest with no renderer attached (the finding `MainMenu.test.ts` records),
 * so this asserts `.text`/`.visible`, never pixels.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SeatRoster } from './SeatRoster';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

describe('SeatRoster.set', () => {
  it('lists the named seats and marks the local one', () => {
    const r = new SeatRoster();
    expect(r.set(['Ada', 'Grace'], 0)).toBe(true);
    expect(r.text).toBe('YOU Ada  ·  Grace');
    expect(r.view.visible).toBe(true);
  });

  it('marks whichever seat is actually local', () => {
    const r = new SeatRoster();
    r.set(['Ada', 'Grace'], 1);
    expect(r.text).toBe('Ada  ·  YOU Grace');
  });

  it('OMITS unnamed seats rather than inventing a placeholder', () => {
    // A guest and a bot have no name. `P3` would be a name this game made up and then
    // showed to other people as if it were theirs.
    const r = new SeatRoster();
    r.set(['Ada', null, null, 'Grace'], 0);
    expect(r.text).toBe('YOU Ada  ·  Grace');
  });

  it('draws nothing, and says so, when no seat has a name', () => {
    // Which is every offline run and every online room of guests — most rooms. The return
    // value is what lets the HUD skip the row instead of reserving space for a blank line.
    const r = new SeatRoster();
    for (const names of [undefined, [], [null, null]]) {
      expect(r.set(names, 0)).toBe(false);
      expect(r.view.visible).toBe(false);
      expect(r.text).toBe('');
    }
  });

  it('shows a lone local player when nobody else is named', () => {
    const r = new SeatRoster();
    expect(r.set(['Ada', null], 0)).toBe(true);
    expect(r.text).toBe('YOU Ada');
  });

  it('tolerates a names array shorter or longer than the seat count', () => {
    // `SeatNames`' own contract: sparse-safe, because the server sends nothing at all for a
    // room with no logged-in players and a mixed room is the normal case.
    const r = new SeatRoster();
    r.set(['Ada'], 3);
    expect(r.text).toBe('Ada'); // localOwner 3 is not in the list; no marker, no crash
    r.set(['Ada', 'Grace', 'Hopper'], 0);
    expect(r.text).toBe('YOU Ada  ·  Grace  ·  Hopper');
  });

  it('clears itself when the names go away', () => {
    const r = new SeatRoster();
    r.set(['Ada'], 0);
    expect(r.set(undefined, 0)).toBe(false);
    expect(r.text).toBe('');
  });

  it('estimates a width that grows with the list', () => {
    const r = new SeatRoster();
    r.set(['Ada'], 0);
    const one = r.estimatedWidth();
    r.set(['Ada', 'Grace', 'Hopper'], 0);
    expect(r.estimatedWidth()).toBeGreaterThan(one);
    r.set(undefined, 0);
    expect(r.estimatedWidth()).toBe(0);
  });

  it('localises the YOU marker', () => {
    const r = new SeatRoster();
    r.set(['Ada'], 0);
    const english = r.text;
    setLocale('zh');
    r.set(['Ada'], 0);
    expect(r.text).not.toBe(english);
    expect(r.text).toContain('Ada');
  });
});
