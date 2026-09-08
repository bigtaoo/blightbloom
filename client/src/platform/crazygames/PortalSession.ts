// One object that turns the game's phase stream into everything the portal wants to hear.
//
// `sdk.ts` is transport, `AdController` is ad policy, `BannerHost` is a DOM element,
// `GameplayBracket` is one pair of calls. This is the piece that decides WHEN each of them
// happens, and it does so from a single input: the phase, once per frame.
//
// ## Why the phase stream is the whole input
//
// Because the alternative is editing the game to tell the portal things, and the game is the
// wrong place for that knowledge. `Game.ts` sits at exactly its 500-line limit
// (`scripts/file-length-baseline.json`); `GameLoop.ts` has 20 lines of headroom; and every
// hook added to `RunLifecycle`/`ScreenNav` would be a line of portal policy in a file whose
// job is the game. More importantly it would be five separate hooks whose correctness is
// "nobody forgot one" — the shape `GameplayBracket`'s own doc comment argues against, citing
// `musicDirector.ts`'s per-frame derivation as the precedent this codebase already chose.
//
// So this installs itself from the ENTRY POINT, on its own ticker callback, the way
// `src/perf/` does ("installed after `start()` so its two ticker brackets sit outside every
// listener the game added"). The game does not know it exists. Nothing in `src/game/` imports
// it. Removing the portal target is deleting one entry point and this directory.
//
// One thing is NOT derivable from the phase, and it arrived later (2026-09-07): the
// rewarded-ad OFFER. Everything above is something the portal wants to be TOLD; an offer is
// something the player has to be SHOWN, on the results screen, and its reward lands in the
// meta layer. That cannot be observed from out here. It is also the only such case, and it
// does not weaken the rule above — `main.crazygames.ts` installs an adapter
// (`portalRewardedAd.ts`) into a capability the game declares for itself
// (`platform/rewardedAd.ts`), so `src/game/` still imports nothing from this directory and
// deleting the portal target still costs one entry point and one directory.
//
// Everything else it needs turns out to be derivable from the phase:
//
//   gameplay bracket   `playing` vs not (plus "an ad is up", which is not a phase)
//   midgame ad         a transition OUT of a run into a menu phase = "between runs"
//   happytime          a transition INTO `victory`
//   banner             `menu` and only `menu` (the one screen that reliably stays open
//                      the 5+ seconds the platform's banner rule asks for)
import type { Phase } from '../../game/phase';
import { AdController, type AdContext, type AdSuspension } from './AdController';
import { BannerHost, browserBannerDom, type BannerDom } from './BannerHost';
import { GameplayBracket, isGameplayPhase } from './GameplayBracket';
import { CrazyGamesSdk } from './sdk';

/** The phase this session shows a banner on. Deliberately a set of one — see the file
 *  header, and `BannerHost`'s note on the 5-second rule. */
const BANNER_PHASES: ReadonlySet<Phase> = new Set<Phase>(['menu']);

/** What this needs from the game. Two getters, both already public on `Game` for
 *  `main.ts`'s own auto-reload guard, so nothing is added to the game for this. */
export interface PortalGameView {
  getPhase(): Phase;
  isOnline(): boolean;
}

export interface PortalSessionOptions {
  /** Injected in tests; defaults to the real SDK wrapper. */
  sdk?: CrazyGamesSdk;
  /** Mute + freeze for the length of an ad. */
  suspension: AdSuspension;
  /** Injected in tests; defaults to a real `<div>` over the canvas. */
  bannerDom?: BannerDom;
  now?: () => number;
  /**
   * The silent-login half of the integration, for DIAGNOSTICS ONLY — this object never asks
   * it a question that changes what the portal is told.
   *
   * It is here rather than beside it in the entry point because `__portal.diagnostics()` is
   * the only instrument this repository has for the parts of the integration it cannot test,
   * and a second instrument nobody remembers to call is worse than one line that answers
   * everything. `portalAuth.ts`'s own state is exactly the sort of thing that fails silently
   * on a live page: a token exchange that 401s leaves a perfectly playable guest.
   */
  auth?: { diagnostics(): { available: boolean; portalUser: string | null; session: string | null; lastError: string | null } };
  /** The room/invite half, for diagnostics only — same reasoning as `auth` above, and the
   *  same one-line-answers-everything reason for being here rather than beside it. */
  rooms?: { state(): string };
}

export class PortalSession {
  readonly sdk: CrazyGamesSdk;
  readonly ads: AdController;
  readonly banner: BannerHost;
  private readonly bracket: GameplayBracket;
  private previous: Phase | null = null;
  /** The last phase that was not `settings` — see `onPhaseChange`'s note on why the
   *  settings screen has to be transparent to the break derivation. */
  private lastSubstantive: Phase | null = null;
  private readonly auth: PortalSessionOptions['auth'];
  private readonly rooms: PortalSessionOptions['rooms'];

  constructor(
    private readonly game: PortalGameView,
    opts: PortalSessionOptions,
  ) {
    this.sdk = opts.sdk ?? new CrazyGamesSdk();
    this.auth = opts.auth;
    this.rooms = opts.rooms;
    const context: AdContext = {
      inGameplay: () => isGameplayPhase(this.game.getPhase()),
      online: () => this.game.isOnline(),
    };
    this.ads = new AdController(this.sdk, opts.suspension, context);
    this.banner = new BannerHost(
      {
        requestBanner: (id, w, h) => this.sdk.requestBanner(id, w, h),
        clearBanner: (id) => this.sdk.clearBanner(id),
      },
      opts.bannerDom ?? browserBannerDom(),
      opts.now,
    );
    this.bracket = new GameplayBracket(this.sdk);
  }

  /**
   * Announce the game to the portal and read back what it can do here.
   *
   * `loadingStart` is called by the entry point BEFORE this (it has to bracket the art
   * preload, which happens before there is a `Game` to hand us), so this only stops it.
   */
  async start(): Promise<void> {
    await this.sdk.init();
    this.sdk.loadingStop();
    await this.ads.probe();
    // RE-RUN the current phase's side effects, now that we know what the SDK can do.
    //
    // This is not tidiness — without it the banner never appears at all, which is how it was
    // found: `update()` acts on phase CHANGES, the first change (nothing → `menu`) happens on
    // the first frame, and `init()` is still in flight then, so the SDK-enabled gate was
    // closed when the only `menu` transition of the session went past. Clearing `previous`
    // makes the next frame treat the current phase as new again.
    //
    // Safe to re-run: `onPhaseChange` derives a break from `lastSubstantive`, which is left
    // alone here, so re-entering `menu` cannot look like leaving a run and cannot request an
    // ad. Re-entering `victory` would re-fire `happytime`, which is why this is only done
    // once, at start-up, rather than on every SDK state change.
    this.previous = null;
  }

  /**
   * One frame. Emits only on change, so this is cheap enough to run unconditionally and
   * correct enough that no caller has to detect a transition.
   */
  update(): void {
    const phase = this.game.getPhase();
    this.bracket.update(phase, this.ads.isShowing());
    if (phase !== this.previous) this.onPhaseChange(phase);
    this.previous = phase;
  }

  private onPhaseChange(to: Phase): void {
    // A win is the game's one genuine achievement — an extraction survived, or a PvP match
    // taken. `victory` is reached from `playing` only, so this cannot double-fire.
    if (to === 'victory') this.sdk.happytime();

    // BANNER: shown on the main menu, hidden and cleared everywhere else — the settings
    // screen included, which is why this reads the raw phase rather than the tracked one
    // below.
    //
    // Gated on the SDK being ENABLED, not merely present. Requesting a banner on a
    // `disabled` page logs an SDK console error, and the first live run of this integration
    // produced exactly that ("no available banner size has been found for container
    // cg-banner-crazygames-inner") — a clean console is worth more here than a request that
    // cannot succeed.
    if (BANNER_PHASES.has(to) && this.sdk.isEnabled()) void this.banner.show();
    else if (this.banner.isVisible()) this.banner.hide();

    // MIDGAME AD: the player has just come out of a run and landed on a menu screen.
    //
    // The previous phase was a run, this one is not — which is exactly the platform's "at a
    // logical point for the user" and is the only moment in this game that qualifies. Two
    // things it deliberately is NOT:
    //
    //  - the result screens (`victory`/`defeat`). The player is still reading their own
    //    run's numbers there, and an ad over that is the "comes as a surprise" case the
    //    requirements page rules out. The break is the click AFTER that.
    //  - `settings`. It is a full phase in this game (`game/phase.ts`) but it is an OVERLAY
    //    in behaviour: opened from a pause it returns to that pause, so the run is still
    //    live behind it. Comparing against the raw previous phase read `paused → settings`
    //    as a break and put an ad over a run the player was coming straight back to —
    //    caught by this file's own test, not by inspection. So the settings screen is
    //    transparent here: `lastSubstantive` skips it, and a break is never derived while
    //    entering it.
    if (to === 'settings') return;
    const from = this.lastSubstantive;
    this.lastSubstantive = to;
    if (from !== null && this.inRun(from) && !this.inRun(to)) void this.ads.midgame();
  }

  /** Everything that counts as "inside a run", result screens included: the run's own
   *  numbers are still on screen and the player has not chosen to leave yet. */
  private inRun(p: Phase): boolean {
    return isGameplayPhase(p) || p === 'paused' || p === 'victory' || p === 'defeat';
  }

  /**
   * One line describing the whole integration, readable from a browser console on a live
   * portal page via `__portal.diagnostics()` (`main.crazygames.ts` exposes it).
   *
   * This is the ONE thing this repository cannot test for itself — whether the documented
   * SDK method names are the shipped ones — so it is deliberately a single string that
   * answers all of it at once: did the script load, what environment does it report, did
   * the adblock probe run, and are the brackets actually flipping.
   */
  diagnostics(): string {
    return `portal ${this.sdk.environment()} · ads ${this.ads.adblockState()}` +
      `${this.bracket.isLive() ? ' · gameplay' : ''}${this.banner.isVisible() ? ' · banner' : ''}` +
      ` · ${this.authState()}` +
      `${this.rooms ? ` · ${this.rooms.state()}` : ''}`;
  }

  /** The account half of the line above. Four states, and they are four different bugs: no
   *  user module at all, a guest, a signed-in portal player we hold a session for, and — the
   *  one worth having an instrument for — a signed-in portal player we do NOT. */
  private authState(): string {
    const a = this.auth?.diagnostics();
    if (!a) return 'auth n/a';
    if (!a.available) return 'auth unavailable';
    if (!a.portalUser) return 'guest';
    if (a.session) return `signed in ${a.session}`;
    return `NOT signed in (${a.lastError ?? 'no reason recorded'})`;
  }
}
