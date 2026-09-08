/**
 * FAIL CLOSED, SECOND OF TWO DEFENCES (design/19-server-platform.md §5): the billing
 * process refuses to START when a dev-only flag is set in a production environment.
 *
 * The first defence is `iap/factory.ts`, which makes the dev stub unreachable under
 * `NODE_ENV=production` regardless of the flag. design/19's argument for having both:
 * "One of those checks is the design; two is the design surviving a deploy." A single
 * check is one refactor away from being the wrong one.
 *
 * WHY THESE TWO FILES SHARE NO CODE. The obvious tidy-up is for this file to import
 * `devStubEnabled` from the factory. That would make both defences one defence with two
 * call sites: a bug in that predicate takes out both at once, which is exactly the failure
 * mode "twice over" is meant to survive. The three-line predicate below is duplicated on
 * purpose. Its test asserts the DUPLICATE, not the shared helper.
 *
 * Refusing to start is the right severity rather than a warning: the flag being set in
 * production means the deploy is misconfigured, and a billing process that runs anyway is
 * one where the operator's next signal is a granted entitlement nobody paid for.
 */

export type StartupEnv = Readonly<Record<string, string | undefined>>;

export class BillingStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingStartupError';
  }
}

/** The dev flags that must never be set on a production billing box. */
const DEV_ONLY_FLAGS = ['BB_BILLING_DEV_STUB'] as const;

/**
 * Throws `BillingStartupError` if this looks like a production deployment with any
 * dev-only billing flag set. Callers must NOT catch it — `main()` lets it terminate the
 * process, which is the point.
 */
export function assertBillingStartupSafety(env: StartupEnv): void {
  // Deliberately not `isProductionEnv` from iap/factory.ts. See the file header.
  if (env.NODE_ENV !== 'production') return;
  const set = DEV_ONLY_FLAGS.filter((name) => {
    const v = env[name];
    return v !== undefined && v !== '' && v !== '0' && v !== 'false';
  });
  if (set.length === 0) return;
  throw new BillingStartupError(
    `refusing to start billsvc: dev-only flag(s) ${set.join(', ')} are set with NODE_ENV=production. ` +
      'Unset them; the dev receipt stub must never be reachable on a production billing process ' +
      '(design/19-server-platform.md §5).',
  );
}
