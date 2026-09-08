/**
 * Fail-closed defence #2 (design/19-server-platform.md §5): the process refuses to START
 * with a dev-only billing flag set in production.
 *
 * These cases assert the DUPLICATE predicate in `startupGuard.ts`, not the shared one in
 * `iap/factory.ts`. That duplication is deliberate — see that file's header — and testing
 * the two independently is the only way the "twice over" claim means anything. A test that
 * imported `devStubEnabled` here would pass just as happily with one defence deleted.
 */
import { describe, it, expect } from 'vitest';
import { assertBillingStartupSafety, BillingStartupError } from '../src/billsvc/startupGuard';

describe('assertBillingStartupSafety', () => {
  it('lets a production process with nothing dev-only set start', () => {
    expect(() => assertBillingStartupSafety({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertBillingStartupSafety({ NODE_ENV: 'production', BB_INTERNAL_KEY: 'k', BB_APPLE_SHARED_SECRET: 's' }),
    ).not.toThrow();
  });

  it('DEFENCE 2: refuses to start with the dev stub flag set in production', () => {
    expect(() => assertBillingStartupSafety({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: '1' })).toThrow(
      BillingStartupError,
    );
  });

  it('names the offending variable and the doc, so the operator can act on the message alone', () => {
    let caught: unknown;
    try {
      assertBillingStartupSafety({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: 'true' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillingStartupError);
    const message = (caught as Error).message;
    expect(message).toContain('BB_BILLING_DEV_STUB');
    expect(message).toContain('NODE_ENV=production');
    expect(message).toContain('design/19-server-platform.md');
    expect((caught as Error).name).toBe('BillingStartupError');
  });

  it.each([['1'], ['true'], ['yes'], ['on'], ['anything']])(
    'treats %j as "set" — the guard is not a truthiness parser',
    (flag) => {
      // Unlike `devStubEnabled`, which only honours '1'/'true', this guard refuses on ANY
      // non-empty non-zero value. Deliberately wider: a flag set to 'yes' would not enable
      // the stub, but it is still a misconfigured production deploy and the operator
      // should be told rather than left with a variable that silently does nothing.
      expect(() => assertBillingStartupSafety({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: flag })).toThrow(
        BillingStartupError,
      );
    },
  );

  it.each([['0'], ['false'], ['']])('treats %j as unset, so an explicit opt-out still starts', (flag) => {
    expect(() => assertBillingStartupSafety({ NODE_ENV: 'production', BB_BILLING_DEV_STUB: flag })).not.toThrow();
  });

  it('says nothing about non-production environments, whatever is set', () => {
    // The guard is about deploys, not about dev boxes: the whole point of the stub is that
    // it works locally with the flag on.
    expect(() => assertBillingStartupSafety({ BB_BILLING_DEV_STUB: '1' })).not.toThrow();
    expect(() => assertBillingStartupSafety({ NODE_ENV: 'test', BB_BILLING_DEV_STUB: '1' })).not.toThrow();
    expect(() => assertBillingStartupSafety({ NODE_ENV: 'development', BB_BILLING_DEV_STUB: '1' })).not.toThrow();
  });

  it('matches NODE_ENV=production exactly — a near-miss is not production', () => {
    // The mirror of `isProductionEnv`'s own case list. Worth pinning separately: if these
    // two ever disagree about what "production" means, one defence covers a deploy the
    // other does not, which is the exact hole two defences are supposed to close.
    for (const env of ['prod', 'Production', 'PRODUCTION', 'production ']) {
      expect(() => assertBillingStartupSafety({ NODE_ENV: env, BB_BILLING_DEV_STUB: '1' })).not.toThrow();
    }
  });
});
