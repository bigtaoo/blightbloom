/**
 * The per-mode party cap (2026-09-26, co-op room codes). The server enforces it through
 * `server/src/config.ts`'s re-export; these pin the numbers both sides read.
 */
import { describe, it, expect } from 'vitest';
import { COOP_SEATS, partyCapacity, parsePartyMode } from './partyShape';
import { SQUAD_SIZE } from './pvpConfig';

describe('partyCapacity', () => {
  it('is a whole co-op room for a co-op party and one squad for a PvP party', () => {
    expect(COOP_SEATS).toBe(2);
    expect(partyCapacity('coop')).toBe(COOP_SEATS);
    expect(partyCapacity('pvp')).toBe(SQUAD_SIZE);
  });
});

describe('parsePartyMode', () => {
  it("reads only 'coop' as co-op — absent, unknown or mistyped is the squad that predates the field", () => {
    expect(parsePartyMode('coop')).toBe('coop');
    expect(parsePartyMode('pvp')).toBe('pvp');
    for (const raw of [undefined, null, '', 'COOP', 'duel', 2]) expect(parsePartyMode(raw)).toBe('pvp');
  });
});
