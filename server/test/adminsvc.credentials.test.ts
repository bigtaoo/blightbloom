/**
 * The console's credential guard (design/21 §3.3, decision B3).
 *
 * This is the file that has to be right for the whole phase to be proportionate: adminsvc
 * is a login page on the public internet, and B2's "there is nothing to write" is what
 * makes that acceptable — but only if the login itself cannot be walked past. So every
 * refusal has its own case, and the two that would be invisible in production (a short
 * password, the dev cookie relaxation) are pinned from both sides.
 */
import { describe, it, expect } from 'vitest';
import {
  ADMIN_SESSION_TTL_MS,
  AdminStartupError,
  DEFAULT_ADMIN_USER,
  MIN_ADMIN_PASSWORD,
  adminCookieSecure,
  assertAdminStartupSafety,
  credentialMatches,
} from '../src/adminsvc/credentials';

const good = 'x'.repeat(MIN_ADMIN_PASSWORD);

describe('assertAdminStartupSafety', () => {
  it('accepts a password at the floor and returns the default operator name', () => {
    expect(assertAdminStartupSafety({ BB_ADMIN_PASSWORD: good })).toEqual({
      user: DEFAULT_ADMIN_USER,
      password: good,
    });
  });

  it('takes BB_ADMIN_USER when one is set, trimmed', () => {
    expect(assertAdminStartupSafety({ BB_ADMIN_USER: '  ops  ', BB_ADMIN_PASSWORD: good }).user).toBe('ops');
  });

  it('falls back to the default operator for a user that trims to nothing', () => {
    // A `BB_ADMIN_USER=` line in `.env` is the shape this covers: an empty value beats a
    // `??` fallback, and design/19 §9 records that this project has already paid for that
    // once. Without this branch the login would want an empty username nobody could guess
    // and nobody could be told.
    expect(assertAdminStartupSafety({ BB_ADMIN_USER: '   ', BB_ADMIN_PASSWORD: good }).user).toBe(DEFAULT_ADMIN_USER);
  });

  it('THROWS when the password is unset, and names the fix', () => {
    expect(() => assertAdminStartupSafety({})).toThrow(AdminStartupError);
    expect(() => assertAdminStartupSafety({})).toThrow(/openssl rand -hex 16/);
  });

  it('THROWS for a password that is only whitespace', () => {
    // `BB_ADMIN_PASSWORD=" "` in an `.env` is a real accident and it is the worst kind: it
    // is set, so a truthiness check passes, and it is one keystroke to guess.
    expect(() => assertAdminStartupSafety({ BB_ADMIN_PASSWORD: '    ' })).toThrow(AdminStartupError);
  });

  it('THROWS one character below the floor and accepts it AT the floor', () => {
    // Both sides, because a length check with only the failing case pinned passes just as
    // happily against `length < 1000`.
    expect(() => assertAdminStartupSafety({ BB_ADMIN_PASSWORD: 'x'.repeat(MIN_ADMIN_PASSWORD - 1) })).toThrow(
      /minimum is 16/,
    );
    expect(() => assertAdminStartupSafety({ BB_ADMIN_PASSWORD: good })).not.toThrow();
  });

  it('THROWS for the dev cookie relaxation under production, and allows it below', () => {
    const env = { BB_ADMIN_PASSWORD: good, BB_ADMIN_INSECURE_COOKIE: '1' };
    expect(() => assertAdminStartupSafety({ ...env, NODE_ENV: 'production' })).toThrow(AdminStartupError);
    expect(() => assertAdminStartupSafety({ ...env, NODE_ENV: 'development' })).not.toThrow();
  });

  it('ignores any value of the dev flag other than exactly "1"', () => {
    // The flag is an equality against `'1'`, not a truthiness test, so `=true` and `=0` are
    // both "not set". Asserted because a truthy check here would make `BB_ADMIN_INSECURE_COOKIE=0`
    // — which reads as "off" to every operator alive — turn the control off.
    expect(() =>
      assertAdminStartupSafety({ BB_ADMIN_PASSWORD: good, BB_ADMIN_INSECURE_COOKIE: '0', NODE_ENV: 'production' }),
    ).not.toThrow();
    expect(adminCookieSecure({ BB_ADMIN_INSECURE_COOKIE: '0', NODE_ENV: 'development' })).toBe(true);
    expect(adminCookieSecure({ BB_ADMIN_INSECURE_COOKIE: 'true', NODE_ENV: 'development' })).toBe(true);
  });

  it('trims the password before measuring and before storing it', () => {
    // The trim is what makes the whitespace case above a refusal; here it is the other
    // consequence — a value with a stray trailing newline (which is what
    // `printf '%s\\n' ... >> .env` produces) still logs in with what the operator pasted.
    expect(assertAdminStartupSafety({ BB_ADMIN_PASSWORD: `  ${good}\n` }).password).toBe(good);
  });
});

describe('adminCookieSecure', () => {
  it('is true by default', () => {
    expect(adminCookieSecure({})).toBe(true);
  });

  it('is true in production even with the dev flag set', () => {
    // Unreachable through `main` (the guard above throws first) and asserted anyway: this
    // function is the one a future call site would reach for, and "the guard would have
    // caught it" is a property of today's caller, not of this function.
    expect(adminCookieSecure({ BB_ADMIN_INSECURE_COOKIE: '1', NODE_ENV: 'production' })).toBe(true);
  });

  it('is false only for the dev flag below production', () => {
    expect(adminCookieSecure({ BB_ADMIN_INSECURE_COOKIE: '1' })).toBe(false);
    expect(adminCookieSecure({ BB_ADMIN_INSECURE_COOKIE: '1', NODE_ENV: 'development' })).toBe(false);
  });
});

describe('credentialMatches', () => {
  const expected = { user: 'admin', password: 'correct-horse-battery-staple' };

  it('accepts the exact pair', () => {
    expect(credentialMatches({ ...expected }, expected)).toBe(true);
  });

  it('refuses a wrong password, a wrong user, and both', () => {
    expect(credentialMatches({ user: 'admin', password: 'nope' }, expected)).toBe(false);
    expect(credentialMatches({ user: 'root', password: expected.password }, expected)).toBe(false);
    expect(credentialMatches({ user: 'root', password: 'nope' }, expected)).toBe(false);
  });

  it('refuses a password of a DIFFERENT length without throwing', () => {
    // The reason both sides are hashed before `timingSafeEqual`: that function throws on a
    // length mismatch, so the naive fix is an early `length !==` return — which turns the
    // real password's length into something measurable one request at a time. A single
    // character and a thousand both have to come back `false`, not an exception.
    expect(() => credentialMatches({ user: 'admin', password: 'x' }, expected)).not.toThrow();
    expect(credentialMatches({ user: 'admin', password: 'x' }, expected)).toBe(false);
    expect(credentialMatches({ user: 'admin', password: 'y'.repeat(1000) }, expected)).toBe(false);
    expect(credentialMatches({ user: '', password: '' }, expected)).toBe(false);
  });

  it('is case- and whitespace-sensitive on both halves', () => {
    expect(credentialMatches({ user: 'Admin', password: expected.password }, expected)).toBe(false);
    expect(credentialMatches({ user: 'admin', password: ` ${expected.password}` }, expected)).toBe(false);
  });
});

describe('the session TTL', () => {
  it('is eight hours', () => {
    // Pinned as a number rather than left to the constant, because "short TTL" is the
    // design's word (§3.3) and a refactor that quietly made this thirty days would look
    // exactly like this file passing.
    expect(ADMIN_SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
  });
});
