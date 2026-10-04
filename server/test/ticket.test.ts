/**
 * Match ticket sign/verify (ROADMAP 3.3). The tamper-proof handshake the control plane
 * issues and the gameserver trusts — so its rejection surface (bad sig, wrong secret,
 * expiry, malformed) is the security boundary and gets pinned here.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signTicket, verifyTicket, type TicketPayload } from '../src/ticket';

const SECRET = 'test-secret';
const payload: TicketPayload = { roomId: 'r1', owner: 1, seed: 42, playerCount: 2, teamId: 1, exp: 10_000 };

describe('ticket — round-trip', () => {
  it('verifies a freshly-signed ticket before expiry and returns the exact payload', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, SECRET, 9_999)).toEqual(payload);
  });

  it('round-trips every field including negative/large seeds', () => {
    const p: TicketPayload = { roomId: 'room-xyz', owner: 3, seed: -2_000_000_000, playerCount: 4, teamId: 0, exp: 1 };
    expect(verifyTicket(signTicket(p, SECRET), SECRET, 0)).toEqual(p);
  });

  it('round-trips an explicit mode (design/15) and stays valid with mode omitted entirely', () => {
    const pvp: TicketPayload = { ...payload, mode: 'pvp' };
    expect(verifyTicket(signTicket(pvp, SECRET), SECRET, 0)).toEqual(pvp);
    // `payload` itself (no `mode` field) is the pre-PvP shape — still verifies clean.
    expect(verifyTicket(signTicket(payload, SECRET), SECRET, 0)).toEqual(payload);
  });

  it('round-trips a bot seat’s claim (ENGINE_VERSION 88)', () => {
    const bot: TicketPayload = { ...payload, bot: true };
    expect(verifyTicket(signTicket(bot, SECRET), SECRET, 0)).toEqual(bot);
  });
});

describe('ticket — rejection surface', () => {
  it('rejects a wrong secret', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, 'other-secret', 0)).toBeNull();
  });

  it('rejects a tampered body (owner escalation)', () => {
    const token = signTicket(payload, SECRET);
    const sig = token.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ ...payload, owner: 0 }), 'utf8').toString('base64url');
    expect(verifyTicket(`${forged}.${sig}`, SECRET, 0)).toBeNull();
  });

  it('rejects an expired ticket even with a valid signature', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, SECRET, payload.exp + 1)).toBeNull();
    expect(verifyTicket(token, SECRET, payload.exp)).toEqual(payload); // exp is inclusive
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nodot', '.sigonly', 'bodyonly.', 'a.b.c', 'not-base64!.x']) {
      expect(verifyTicket(bad, SECRET, 0)).toBeNull();
    }
  });

  it('rejects a truncated / wrong-length signature without throwing', () => {
    const token = signTicket(payload, SECRET);
    const body = token.split('.')[0];
    expect(verifyTicket(`${body}.short`, SECRET, 0)).toBeNull();
  });

  it('rejects a forged mode value that is neither coop nor pvp', () => {
    const token = signTicket(payload, SECRET);
    const sig = token.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ ...payload, mode: 'admin' }), 'utf8').toString('base64url');
    expect(verifyTicket(`${forged}.${sig}`, SECRET, 0)).toBeNull();
  });

  it('ignoreExpiry accepts an expired-but-validly-signed ticket (matchsvc /resume, ROADMAP reconnect)', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, SECRET, payload.exp + 1)).toBeNull(); // still rejects by default
    expect(verifyTicket(token, SECRET, payload.exp + 1, { ignoreExpiry: true })).toEqual(payload);
  });

  it('ignoreExpiry still rejects a bad signature — proof-of-prior-grant, not a blank cheque', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, 'other-secret', payload.exp + 1, { ignoreExpiry: true })).toBeNull();
  });

  it('rejects a missing or non-integer teamId (design/05/15 — unlike mode, never optional)', () => {
    const sig = signTicket(payload, SECRET).split('.')[1];
    const withoutTeamId = { ...payload } as Partial<TicketPayload>;
    delete withoutTeamId.teamId;
    const forgedMissing = Buffer.from(JSON.stringify(withoutTeamId), 'utf8').toString('base64url');
    expect(verifyTicket(`${forgedMissing}.${sig}`, SECRET, 0)).toBeNull();

    const forgedFloat = Buffer.from(JSON.stringify({ ...payload, teamId: 1.5 }), 'utf8').toString('base64url');
    expect(verifyTicket(`${forgedFloat}.${sig}`, SECRET, 0)).toBeNull();
  });
});

describe('verifyTicket — a correctly signed body that is not a ticket', () => {
  it('rejects a validly-signed token whose body is not JSON', () => {
    // The `JSON.parse` catch, and the only arm of this file that a forged token cannot reach:
    // it needs the RIGHT secret and a wrong body, i.e. an issuer bug (a payload built from a
    // string, a truncated write) rather than an attacker. Without the catch, one malformed
    // ticket is an uncaught throw inside the gameserver's connection handler.
    const body = Buffer.from('not json at all', 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(verifyTicket(`${body}.${sig}`, SECRET, 0)).toBeNull();
  });

  it('rejects a validly-signed body that is JSON but the wrong SHAPE', () => {
    // Each field check is a separate arm; what matters is that a well-formed envelope
    // carrying a nonsense payload never becomes a seat grant.
    const cases: unknown[] = [
      { ...payload, roomId: 7 },
      { ...payload, owner: 1.5 },
      { ...payload, seed: 'x' },
      { ...payload, playerCount: null },
      { ...payload, teamId: undefined },
      { ...payload, exp: 'soon' },
      { ...payload, mode: 'solo' },
      { ...payload, accountId: 42 },
      { ...payload, bot: false },
      { ...payload, bot: 'yes' },
      null,
      [],
    ];
    for (const shape of cases) {
      const body = Buffer.from(JSON.stringify(shape), 'utf8').toString('base64url');
      const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
      expect(verifyTicket(`${body}.${sig}`, SECRET, 0), JSON.stringify(shape)).toBeNull();
    }
  });

  it('accepts the same envelope when the shape IS valid — the control', () => {
    // Without this, every assertion above would pass just as happily if `verifyTicket`
    // rejected everything signed this way.
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(verifyTicket(`${body}.${sig}`, SECRET, 0)).toMatchObject({ roomId: 'r1' });
  });
});
