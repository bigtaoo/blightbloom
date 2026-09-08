/**
 * CrazyGames user-token verification (`src/portalToken.ts`, design/20 "account
 * integration"). Every case mints its OWN token with its own RSA keypair — there is no
 * fixture token and no network — because the interesting half of this module is what it
 * REFUSES, and a refusal is only proof of anything if the same helper can also produce
 * something it accepts.
 *
 * `signRs256` below is therefore deliberately a real signer rather than a stub: a stub
 * would let the algorithm-confusion cases pass without the module ever having had a valid
 * signature to be confused about.
 */
import { describe, it, expect } from 'vitest';
import { createSign, createHmac, generateKeyPairSync } from 'node:crypto';
import { verifyPortalToken, type PortalTokenClaims } from '../src/portalToken';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** PKCS#1 (`BEGIN RSA PUBLIC KEY`) — the exact shape `sdk.crazygames.com/publicKey.json`
 *  publishes, rather than the SPKI form Node exports by default. `createPublicKey` detects
 *  it from the header, and asserting against this form is the point: an SPKI-only
 *  implementation would pass a test that used SPKI and fail in production. */
const PUBLIC_PEM_PKCS1 = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PUBLIC_PEM_SPKI = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function claims(over: Partial<PortalTokenClaims> = {}): Record<string, unknown> {
  return {
    userId: 'cg-user-1',
    gameId: 'blightbloom',
    username: 'PortalPlayer',
    profilePictureUrl: 'https://images.crazygames.com/u/1.png',
    iat: NOW_SEC - 10,
    exp: NOW_SEC + 3600,
    ...over,
  };
}

function signRs256(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  const body = `${b64url(header)}.${b64url(payload)}`;
  const sig = createSign('sha256').update(body).sign(privateKey).toString('base64url');
  return `${body}.${sig}`;
}

describe('verifyPortalToken — accepts a real token', () => {
  it('returns the claims for a valid RS256 token against the PKCS#1 published key', () => {
    const got = verifyPortalToken(signRs256(claims()), PUBLIC_PEM_PKCS1, NOW_MS);
    expect(got).toEqual({
      userId: 'cg-user-1',
      gameId: 'blightbloom',
      username: 'PortalPlayer',
      profilePictureUrl: 'https://images.crazygames.com/u/1.png',
      iat: NOW_SEC - 10,
      exp: NOW_SEC + 3600,
    });
  });

  it('also accepts the SPKI encoding of the same key', () => {
    // Not a requirement of the platform — a guard that the implementation reads the key
    // through `createPublicKey`'s detection rather than assuming one encoding.
    expect(verifyPortalToken(signRs256(claims()), PUBLIC_PEM_SPKI, NOW_MS)?.userId).toBe('cg-user-1');
  });

  it('drops an absent profilePictureUrl rather than carrying undefined-ish junk', () => {
    const got = verifyPortalToken(signRs256(claims({ profilePictureUrl: undefined })), PUBLIC_PEM_PKCS1, NOW_MS);
    expect(got?.profilePictureUrl).toBeUndefined();
    expect(got?.username).toBe('PortalPlayer');
  });

  it('accepts a token that expired within the clock-skew leeway, and refuses one past it', () => {
    const justExpired = signRs256(claims({ exp: NOW_SEC - 30 }));
    expect(verifyPortalToken(justExpired, PUBLIC_PEM_PKCS1, NOW_MS)).not.toBeNull();
    const longExpired = signRs256(claims({ exp: NOW_SEC - 3600 }));
    expect(verifyPortalToken(longExpired, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
    // And the leeway is a knob, not a constant baked into the accept: with none, the
    // 30-seconds-ago token above is refused too — which is what proves the case above
    // passed BECAUSE of the leeway rather than because expiry is unchecked.
    expect(verifyPortalToken(justExpired, PUBLIC_PEM_PKCS1, NOW_MS, { leewaySec: 0 })).toBeNull();
  });
});

describe('verifyPortalToken — the signature is actually checked', () => {
  it('refuses a token signed by a DIFFERENT key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims())}`;
    const sig = createSign('sha256').update(body).sign(other.privateKey).toString('base64url');
    expect(verifyPortalToken(`${body}.${sig}`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('refuses a token whose PAYLOAD was edited after signing', () => {
    const token = signRs256(claims());
    const [header, , sig] = token.split('.');
    const tampered = `${header}.${b64url(claims({ userId: 'somebody-else' }))}.${sig}`;
    expect(verifyPortalToken(tampered, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('refuses a truncated signature rather than throwing', () => {
    const token = signRs256(claims());
    expect(verifyPortalToken(`${token.slice(0, -8)}`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });
});

describe('verifyPortalToken — algorithm confusion', () => {
  it('refuses alg: none, even with the signature segment removed to match', () => {
    const body = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims())}`;
    expect(verifyPortalToken(`${body}.`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
    expect(verifyPortalToken(`${body}.AA`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('refuses alg: HS256 signed with the PUBLIC key as the HMAC secret', () => {
    // The classic attack: the public key is public, so if `alg` were honoured an attacker
    // could mint tokens with it. This asserts the refusal happens on `alg`, not by luck.
    const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims())}`;
    const sig = createHmac('sha256', PUBLIC_PEM_PKCS1).update(body).digest('base64url');
    expect(verifyPortalToken(`${body}.${sig}`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('refuses RS512 — the check is an equality, not a family match', () => {
    const body = `${b64url({ alg: 'RS512', typ: 'JWT' })}.${b64url(claims())}`;
    const sig = createSign('sha512').update(body).sign(privateKey).toString('base64url');
    expect(verifyPortalToken(`${body}.${sig}`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });
});

describe('verifyPortalToken — game id', () => {
  it('refuses a token minted for another game when the id is configured', () => {
    const token = signRs256(claims({ gameId: 'someone-elses-game' }));
    expect(verifyPortalToken(token, PUBLIC_PEM_PKCS1, NOW_MS, { gameId: 'blightbloom' })).toBeNull();
    expect(verifyPortalToken(token, PUBLIC_PEM_PKCS1, NOW_MS, { gameId: 'someone-elses-game' })).not.toBeNull();
  });

  it('accepts any gameId when none is configured — the documented, warned-about default', () => {
    const token = signRs256(claims({ gameId: 'someone-elses-game' }));
    expect(verifyPortalToken(token, PUBLIC_PEM_PKCS1, NOW_MS)?.gameId).toBe('someone-elses-game');
  });
});

describe('verifyPortalToken — malformed input', () => {
  const cases: [string, unknown][] = [
    ['not a string', 42],
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['two segments', 'aa.bb'],
    ['four segments', 'aa.bb.cc.dd'],
    ['empty header segment', '.bb.cc'],
    ['non-base64 garbage', '!!!.???.***'],
  ];
  for (const [name, value] of cases) {
    it(`refuses ${name}`, () => {
      expect(verifyPortalToken(value, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
    });
  }

  it('refuses a valid signature over claims missing a required field', () => {
    for (const missing of ['userId', 'username', 'gameId', 'exp'] as const) {
      const c = claims();
      delete c[missing];
      expect(verifyPortalToken(signRs256(c), PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
    }
  });

  it('refuses a valid signature over a non-object payload', () => {
    const body = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${Buffer.from('"a string"', 'utf8').toString('base64url')}`;
    const sig = createSign('sha256').update(body).sign(privateKey).toString('base64url');
    expect(verifyPortalToken(`${body}.${sig}`, PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('refuses a non-numeric exp', () => {
    expect(verifyPortalToken(signRs256(claims({ exp: 'soon' as unknown as number })), PUBLIC_PEM_PKCS1, NOW_MS)).toBeNull();
  });

  it('accepts a token with no iat — it is optional and unused', () => {
    const c = claims();
    delete c.iat;
    expect(verifyPortalToken(signRs256(c), PUBLIC_PEM_PKCS1, NOW_MS)?.iat).toBeUndefined();
  });

  it('refuses rather than throws when the key is the WRONG KEY TYPE for RS256', () => {
    // Two valid PEMs `createPublicKey` parses happily, reaching the verify call by two
    // different routes: an EC key makes `crypto.verify` answer FALSE, and an Ed25519 key
    // makes it THROW (`ERR_OSSL_INVALID_DIGEST` — 'sha256' is not a digest it accepts). The
    // second is the only way into the signature-check catch, and it is why that catch
    // exists: a rotated key document of the wrong type must be a refusal, not a 500 on the
    // login path.
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ed = generateKeyPairSync('ed25519');
    for (const key of [ec.publicKey, ed.publicKey]) {
      const pem = key.export({ type: 'spki', format: 'pem' }).toString();
      expect(verifyPortalToken(signRs256(claims()), pem, NOW_MS)).toBeNull();
    }
  });

  it('refuses rather than throws on a corrupt KEY document', () => {
    expect(verifyPortalToken(signRs256(claims()), 'not a pem at all', NOW_MS)).toBeNull();
    expect(verifyPortalToken(signRs256(claims()), '', NOW_MS)).toBeNull();
  });
});
