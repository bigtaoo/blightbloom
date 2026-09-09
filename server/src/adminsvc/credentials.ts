/**
 * adminsvc's one credential, and the guard that refuses to boot without it
 * (design/21-ops-analytics.md §3.3, decision B3).
 *
 * One operator, one credential, no roles, no self-registration and no password reset —
 * rotation is "change the env value and redeploy". That is B3, and it is proportionate for
 * exactly one reason, which is B2: there is no player-data write behind this login for a
 * stolen credential to reach. Everything here is defence in depth behind that fact rather
 * than the thing standing between an attacker and the accounts table.
 *
 * ## Why this THROWS rather than defaulting
 *
 * Same shape as `billsvc/startupGuard.ts`, and for the same reason design/19 §5 gives: a
 * login page on the public internet whose credential has a compiled-in default is an open
 * door with a doorbell. Grafana beside it makes the same choice from the other side —
 * `docker-compose.yml` writes `${BB_GRAFANA_ADMIN_PASSWORD:?…}` so a missing value fails
 * `compose up`. adminsvc cannot rely on compose's `:?` alone (it is also run from `npm`
 * locally and from a test), so the process asserts it itself.
 *
 * There is no dev fallback of the `ticketSecret()` / `internalKeys()` kind, and the
 * asymmetry is deliberate: those two exist so the ONLINE GAME works out of the box for a
 * developer with no configuration, and the cost of their well-known dev value is bounded by
 * `NODE_ENV=production` refusing it. A console does not need to work out of the box — it
 * needs a person to have decided what its password is — and one line in a local `.env` is a
 * smaller price than a published default that a deploy could inherit.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** The env var names, in one place — `deploy.manifests.test.ts` reads these. */
export const ADMIN_USER_VAR = 'BB_ADMIN_USER';
export const ADMIN_PASSWORD_VAR = 'BB_ADMIN_PASSWORD';
export const ADMIN_INSECURE_COOKIE_VAR = 'BB_ADMIN_INSECURE_COOKIE';

/** What `BB_ADMIN_USER` defaults to. A username is not a secret and Grafana's own default
 *  is the same word; the password is the whole credential. */
export const DEFAULT_ADMIN_USER = 'admin';

/**
 * The floor on `BB_ADMIN_PASSWORD`.
 *
 * 16 rather than `AuthService`'s 8 for players, because this is not a password a human
 * chooses and remembers: `server/deploy/README.md` provisions it with `openssl rand -hex 16`
 * (32 characters), it is stored in a password manager, and it is typed once per session. A
 * floor a generated value clears by 2× costs nothing, and the case it refuses — an operator
 * setting `admin` in a hurry on a public login page — is the one that actually happens.
 */
export const MIN_ADMIN_PASSWORD = 16;

/** How long a console session lives. One working day: long enough not to interrupt an
 *  investigation, short enough that a browser left open on a laptop is not a standing
 *  credential. There is no refresh — the TTL is absolute, from the login. */
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60_000;

/** Only the two fields this module reads, so a test passes an object rather than mutating
 *  `process.env` — the same shape `billsvc/startupGuard.ts`'s `StartupEnv` uses. */
export interface AdminEnv {
  BB_ADMIN_USER?: string;
  BB_ADMIN_PASSWORD?: string;
  BB_ADMIN_INSECURE_COOKIE?: string;
  NODE_ENV?: string;
}

/** Thrown by {@link assertAdminStartupSafety}. Its own class so `main` can report it as a
 *  configuration problem rather than a crash, exactly as billsvc does. */
export class AdminStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminStartupError';
  }
}

export interface AdminCredential {
  user: string;
  password: string;
}

/**
 * Throws unless the environment carries a usable operator credential.
 *
 * Called by `main` BEFORE anything is opened or bound — no port, no SQLite handle, nothing
 * to clean up — which is the property that makes "this process cannot come up misconfigured"
 * a fact about the process rather than about the order its startup happens to run in.
 */
export function assertAdminStartupSafety(env: AdminEnv = process.env): AdminCredential {
  const password = env[ADMIN_PASSWORD_VAR]?.trim() ?? '';
  if (password.length === 0) {
    throw new AdminStartupError(
      `${ADMIN_PASSWORD_VAR} is unset. The admin console is a login page on the public ` +
        `internet and has no default credential by design (design/21 §3.3). Set it to a ` +
        `generated value: openssl rand -hex 16`,
    );
  }
  if (password.length < MIN_ADMIN_PASSWORD) {
    throw new AdminStartupError(
      `${ADMIN_PASSWORD_VAR} is ${password.length} characters; the minimum is ${MIN_ADMIN_PASSWORD}. ` +
        `Generate one rather than choosing one: openssl rand -hex 16`,
    );
  }
  // The dev-only cookie relaxation, refused under production for the same reason
  // billsvc refuses its receipt stub there: a flag that makes a security control weaker
  // must not be reachable in the environment the control exists for.
  if (env[ADMIN_INSECURE_COOKIE_VAR] === '1' && env.NODE_ENV === 'production') {
    throw new AdminStartupError(
      `${ADMIN_INSECURE_COOKIE_VAR}=1 under NODE_ENV=production. That flag drops \`Secure\` ` +
        `from the session cookie so the console works over plain http locally; in production ` +
        `it would let the cookie travel unencrypted. Unset it.`,
    );
  }
  const user = env[ADMIN_USER_VAR]?.trim();
  return { user: user !== undefined && user.length > 0 ? user : DEFAULT_ADMIN_USER, password };
}

/**
 * Whether the session cookie gets `Secure`.
 *
 * True by default and true always in production — the false arm needs `BB_ADMIN_INSECURE_COOKIE=1`
 * AND a non-production `NODE_ENV`, and {@link assertAdminStartupSafety} has already refused
 * to boot the combination that would matter. It exists because a `Secure` cookie is not sent
 * over `http://localhost`, so without it the console cannot be developed against at all —
 * and "turn the security control off in the source while I work on this" is the alternative
 * that ships by accident.
 */
export function adminCookieSecure(env: AdminEnv = process.env): boolean {
  return !(env[ADMIN_INSECURE_COOKIE_VAR] === '1' && env.NODE_ENV !== 'production');
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time credential check.
 *
 * Both halves are hashed before comparison, which is `internalAuth.ts`'s reasoning applied
 * to an operator-chosen secret: `timingSafeEqual` throws on a length mismatch, so guarding
 * with `a.length !== b.length` would turn the real password's LENGTH into something
 * measurable one request at a time. Hashing makes every comparison 32 bytes against 32.
 *
 * The username is compared the same way rather than with `===`. It is not a secret, so this
 * buys little — but the cost is one line and the alternative is a function where one of two
 * comparisons is timing-safe and a reader has to work out which.
 *
 * Both comparisons are always performed: no `&&` short circuit, so a wrong username and a
 * wrong password take the same time and a prober cannot learn which half it got right.
 */
export function credentialMatches(
  presented: { user: string; password: string },
  expected: AdminCredential,
): boolean {
  const userOk = timingSafeEqual(sha256(presented.user), sha256(expected.user));
  const passwordOk = timingSafeEqual(sha256(presented.password), sha256(expected.password));
  return userOk && passwordOk;
}
