/**
 * `buildIntegrityReportBody` (design/15, "PvP integrity", decided 2026-09-26): which settled
 * matches produce a record, who is named in it, and what happens to the input log.
 */
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, type FrameCmds } from '@dd/engine';
import { buildIntegrityReportBody } from '../src/integrityReport';
import type { MatchIntegrity, SettledMatch } from '../src/MatchRoom';

const LOG = [{ frame: 3, cmds: [] }, { frame: 9, cmds: [] }] as unknown as FrameCmds[];

function match(integrity: Partial<MatchIntegrity>, over: Partial<SettledMatch> = {}): SettledMatch {
  return {
    roomId: 'room-1',
    mode: 'pvp',
    winner: 0,
    placements: [3, 2, 1],
    playerCount: 4,
    hashOk: true,
    integrity: { verdict: 'dissent', dissenters: [], kicked: [], settleFrame: 900, seed: 77, log: LOG, ...integrity },
    ...over,
  };
}

describe('buildIntegrityReportBody — whether there is a record', () => {
  it('is null for a clean match', () => {
    expect(buildIntegrityReportBody(match({ verdict: 'clean', log: undefined }))).toBeNull();
  });

  it('is null for a co-op room, whatever its verdict', () => {
    expect(buildIntegrityReportBody(match({ verdict: 'no_consensus' }, { mode: 'coop' }))).toBeNull();
  });

  it.each(['dissent', 'no_consensus', 'bounds'] as const)('is a record for a PvP %s', (verdict) => {
    expect(buildIntegrityReportBody(match({ verdict }))?.verdict).toBe(verdict);
  });
});

describe('buildIntegrityReportBody — who is named', () => {
  it('merges dissenters and kicked seats into one sorted list, flagging each reason', () => {
    const body = buildIntegrityReportBody(
      match({ dissenters: [3, 1], kicked: [1, 0] }, { seatAccounts: { 0: 'acct-0', 1: 'acct-1', 2: 'acct-2' } }),
    )!;
    expect(body.suspects).toEqual([
      { seat: 0, accountId: 'acct-0', dissented: false, kicked: true },
      { seat: 1, accountId: 'acct-1', dissented: true, kicked: true },
      { seat: 3, dissented: true, kicked: false }, // a guest: named, with no account to count against
    ]);
    // Every logged-in seat is carried, suspect or not.
    expect(body.seatAccounts).toEqual({ 0: 'acct-0', 1: 'acct-1', 2: 'acct-2' });
  });

  it('carries an empty seat map for a guest-only room rather than omitting it', () => {
    expect(buildIntegrityReportBody(match({ dissenters: [2] }))!.seatAccounts).toEqual({});
  });
});

describe('buildIntegrityReportBody — the rest of the record', () => {
  it('copies what a later replay needs: seed, player count, settle frame, engine version', () => {
    const body = buildIntegrityReportBody(match({ verdict: 'bounds', bounds: 'too_short', settleFrame: 12 }))!;
    expect(body).toMatchObject({
      roomId: 'room-1',
      bounds: 'too_short',
      playerCount: 4,
      seed: 77,
      settleFrame: 12,
      engineVersion: ENGINE_VERSION,
    });
  });

  it('omits bounds when the verdict is not a bounds failure', () => {
    expect(buildIntegrityReportBody(match({}))).not.toHaveProperty('bounds');
  });

  it('gzips the log, and it round-trips to the same frames', () => {
    const body = buildIntegrityReportBody(match({}))!;
    expect(body.logDropped).toBeUndefined();
    const back = JSON.parse(gunzipSync(Buffer.from(body.logGzipB64!, 'base64')).toString('utf8'));
    expect(back).toEqual(LOG);
  });

  it('archives an empty log when the room carried none', () => {
    const body = buildIntegrityReportBody(match({ log: undefined }))!;
    expect(JSON.parse(gunzipSync(Buffer.from(body.logGzipB64!, 'base64')).toString('utf8'))).toEqual([]);
  });

  it('drops a log over the cap and says so, keeping the rest of the record', () => {
    const body = buildIntegrityReportBody(match({ dissenters: [1] }), 8)!;
    expect(body.logGzipB64).toBeUndefined();
    expect(body.logDropped).toBe(true);
    expect(body.suspects).toHaveLength(1);
  });
});
