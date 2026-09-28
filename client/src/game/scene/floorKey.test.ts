import { describe, it, expect } from 'vitest';
import type { GameState } from '@dd/engine';
import { floorKeyOf, isSameFloor } from './floorKey';

function state(rooms: object[], floorIndex = 0): GameState {
  return { floorIndex, dungeonRooms: rooms } as unknown as GameState;
}

describe('floorKey', () => {
  it('matches the state, floor and first room it was taken from', () => {
    const s = state([{}, {}]);
    expect(isSameFloor(floorKeyOf(s), s)).toBe(true);
  });

  it('a room entered later on the same floor is still the same floor', () => {
    const s = state([{}, {}]);
    const key = floorKeyOf(s);
    s.dungeonRooms.push({} as never); // unrelated growth does not matter; the first room does
    expect(isSameFloor(key, s)).toBe(true);
  });

  it('no key is never the same floor', () => {
    expect(isSameFloor(null, state([{}]))).toBe(false);
  });

  it('a floor with no placed rooms is never the same floor', () => {
    const s = state([]);
    expect(isSameFloor(floorKeyOf(s), s)).toBe(false);
  });

  it('each of the three parts can tell floors apart on its own', () => {
    const first = {};
    const s = state([first]);
    const key = floorKeyOf(s);
    expect(isSameFloor(key, state([first]))).toBe(false); // another state
    s.floorIndex = 1;
    expect(isSameFloor(key, s)).toBe(false); // another floor index
    s.floorIndex = 0;
    (s.dungeonRooms as object[])[0] = {};
    expect(isSameFloor(key, s)).toBe(false); // another first room
  });
});
