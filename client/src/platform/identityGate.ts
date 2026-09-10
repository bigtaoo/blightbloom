// The identity gate: boot waits for the host's silent login to have an ANSWER before the
// first screen is drawn (design/10's screen flow, design/16's "login is never a gate").
//
// ## What this is for
//
// A host that signs a player in without asking (a game portal; `crazygames/portalAuth.ts`)
// answers ASYNCHRONOUSLY, and until it does the game does not know who is playing. Before
// this module the portal entry started the game first and the login second, which is two
// bugs rather than a style: the account label paints as a guest and then flips, and — because
// that host's menu is in one-click mode (design/20) — the first click starts a RUN, so the
// login can land mid-run, where `OnlineMatch.syncMetaWithSession` writes the account's
// server-side meta over a run that has already spent its staged loadout.
//
// So the wait is the fix, and this module is only the wait. What the answer WAS is not its
// business: by the time it resolves, `getSession()` is either an account or null, and both
// are legitimate — a guest is a first-class player here and always has been.
//
// ## Why a budget, and not just `await`
//
// The login this gates is a chain of calls that are each allowed to fail and one of which is
// allowed to never settle at all: `sdk.init()` polls for a script an adblocker may have
// blocked (bounded, `SDK_WAIT_MS`), and `portalLogin` is a plain `fetch` to our own control
// plane with no timeout of its own. A boot that waits for that unconditionally is a black
// spinner over a game that would have been playable, which is precisely the failure
// `CrazyGamesSdk.init` documents having found on a live page.
//
// A budget makes the worst case a known number instead of an open question, and it can be
// short because the timeout path is not a degraded mode — it is "guest", which is the state
// the game already runs completely in.
//
// ## Not wired on every entry, and that is not an oversight
//
// `main.crazygames.ts` is the only caller, because it is the only target with an
// asynchronous login to wait for. The other two settle synchronously: `main.ts` reads a
// stored session out of `localStorage`, and on WeChat every player is a guest — there is no
// `wx.login` in this client and no `POST /auth/wechat` on the server (design/16's own
// correction). Calling this with an already-resolved promise there would be ceremony that
// reads as coverage.

/** How a wait ended. `timedOut` and `failed` are both "guest for now", and are separated
 *  only so a diagnostics line can say which — one means the host is slow, the other that it
 *  refused, and a page full of guests looks identical either way. */
export type IdentityOutcome = 'settled' | 'timedOut' | 'failed';

export interface IdentitySettled {
  outcome: IdentityOutcome;
  /** Present only for `failed`: the rejection, flattened to a string for a log line. */
  error?: string;
}

/** The timer, injected so a test can fire the budget deterministically instead of sleeping.
 *  Production is `setTimeout`/`clearTimeout`, typed loosely because the handle is a `number`
 *  in a browser and a `Timeout` in Node and this module has no opinion on either. */
export interface IdentityGateTimer {
  start(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface IdentityGateOpts {
  /** The host's auto-login, already constructed. Called once, and its rejection is an
   *  outcome rather than an error — see the header. */
  login: () => Promise<unknown>;
  /** How long boot may wait. Clamped at 0, so a nonsense budget degrades to "do not wait". */
  budgetMs?: number;
  timer?: IdentityGateTimer;
}

/**
 * The budget the portal entry uses, and the reason it is 2000 rather than something larger.
 *
 * `CrazyGamesSdk.SDK_WAIT_MS` is 3000, and that 3 seconds is spent in exactly one case: the
 * SDK script never arrives (blocked, offline), which is a case whose answer is "guest" no
 * matter how long anybody waits. A present SDK is found on the first 50 ms poll, so a real
 * portal player spends one poll plus a login round trip here — a fraction of this number.
 * Sitting BELOW the SDK's own deadline is therefore deliberate: it means a blocked visitor
 * gets their menu without waiting out a poll loop whose answer cannot help them.
 */
export const DEFAULT_IDENTITY_BUDGET_MS = 2000;

const REAL_TIMER: IdentityGateTimer = {
  start: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Wait for `login()` to settle, or for the budget to run out, whichever happens first.
 * Never throws and never rejects: every path here is a legitimate state of the game.
 */
export async function settleIdentity(opts: IdentityGateOpts): Promise<IdentitySettled> {
  const timer = opts.timer ?? REAL_TIMER;
  const budgetMs = Math.max(0, opts.budgetMs ?? DEFAULT_IDENTITY_BUDGET_MS);
  let handle: unknown = null;
  const expired = new Promise<IdentitySettled>((resolve) => {
    handle = timer.start(() => resolve({ outcome: 'timedOut' }), budgetMs);
  });
  // The rejection is mapped HERE rather than caught around the race, so `answered` never
  // rejects and the race stays a plain "first answer wins" over one outcome type.
  //
  // What this is NOT is protection against an unhandled rejection, which is what it looks
  // like and what an earlier version of this comment claimed. `Promise.race` subscribes to
  // every input, so a login that fails after the budget expired is handled either way — the
  // race's own reject call is a no-op on an already-settled promise. Measured with a mutation
  // run (moving the `.catch` onto the race), which stayed green: the two shapes are
  // behaviourally equivalent, and this one is only the clearer of the two.
  const answered = opts
    .login()
    .then<IdentitySettled>(() => ({ outcome: 'settled' }))
    .catch<IdentitySettled>((e: unknown) => ({ outcome: 'failed', error: describe(e) }));
  try {
    return await Promise.race([answered, expired]);
  } finally {
    timer.cancel(handle);
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}
