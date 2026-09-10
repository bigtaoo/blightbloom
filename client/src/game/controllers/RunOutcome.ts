import { TICK_RATE, type GameState } from '@dd/engine';
import { SCORE } from '../score';
import { t } from '../../i18n';
import { totalFloorCount } from '../match/floorCount';
import { clearSavedRun } from '../match/runSaveStore';
import { localSeatWon } from './localOutcome';
import { rewardedAd } from '../../platform/rewardedAd';
import { track } from '../../net/analytics';
import { publicFlag } from '../../net/clientFlags';
import type { ResultOffer } from '../screens/Screens';

/** The bits of Game a run-outcome reaction needs — score/meta/phase/screen are all
 *  Game-owned state, so this stays a callback interface (same EventReactor-style
 *  decoupling: this file never imports Game.ts). */
export interface RunOutcomeHost {
  readonly localOwner: number;
  addScore(delta: number): void;
  currentScore(): number;
  setPhase(phase: 'victory' | 'defeat'): void;
  hideHud(): void;
  /** Bank the run's carry-out into the persistent account (design/05/14). Called a SECOND
   *  time, with the same state, to pay the rewarded-ad bonus — see `doubleOffer`. */
  bankRunMaterials(s: GameState): void;
  /** Whether this run is a networked match. Read only to suppress the ad offer: an ad
   *  freezes this client, which a lockstep session cannot survive (design/06), so
   *  `AdController` refuses one outright and a button that cannot work must not be drawn. */
  isOnline(): boolean;
  /** `won` drives the result icon (Screens.ts) — kept as an explicit flag rather than
   * inferred from `title` text now that `title` is a translated, locale-dependent
   * string (design/17-i18n.md) instead of a fixed English literal. */
  showOutcomeScreen(won: boolean, title: string, lines: readonly string[], offer?: ResultOffer | null): void;
}

/** Total materials safely banked so far this run (design/05 carry-out bag). */
function totalBanked(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}

/**
 * Everything a run-ending death costs (design/05's locked wipe rule): BOTH tiers — this
 * floor's un-banked buffer AND the carry-out bag descending folded it into. The bag is not
 * the safe half: it only ever leaves the sim when `bankRunMaterials` hands it to the meta
 * layer, and `lose()` below deliberately never calls that.
 *
 * Worth a named function rather than reusing `totalBanked`: the defeat line used to read
 * "The floor's materials were lost", which named the smaller of the two pools and matched a
 * claim design/05 had already superseded (corrected 2026-09-03, together with the docs).
 */
function totalForfeited(s: GameState): number {
  let n = totalBanked(s);
  for (const v of Object.values(s.floorMaterials)) n += v ?? 0;
  return n;
}

/** `Time M:SS`, from the sim's own tick counter (GameEngine.ts increments `s.tick`
 *  every step) — free: no new state, already part of the hashed/serialized state, so
 *  this is a zero-risk render-only addition (design/06 determinism untouched). */
function timeText(s: GameState): string {
  const totalSec = Math.floor(s.tick / TICK_RATE);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return t('results.timeLine', { m, ss: String(sec).padStart(2, '0') });
}

/**
 * Decides + shows a run's outcome from the sim's own gameover state (design/15's
 * placement model for an arena run, the PvE extract/wipe model otherwise). Shared by
 * the offline sim (stepSim) and the online/matchmade path (advanceOnline) — both just
 * detect `s.phase === 'gameover'` and hand the state to `handle()`. Extracted out of
 * Game.ts 2026-07-28.
 */
export class RunOutcome {
  constructor(private readonly host: RunOutcomeHost) {}

  handle(s: GameState): void {
    // A run that REACHED an outcome can never be continued, so its save goes now (ENGINE_
    // VERSION 61, `match/runSave.ts`). This is the third and last of the three exits that
    // have to drop it — `beginRun` and `quitRun` are the other two — and it is the one that
    // cannot be folded into either: nothing routes a victory or a defeat through
    // `RunLifecycle` at all, so without this line closing the tab on a result screen would
    // leave the Forge offering CONTINUE for a run that was already won.
    //
    // Before the branches, not inside them, and before `bankRunMaterials`: all four
    // outcomes (PvE win/lose, arena win/lose) end the run equally, and a store failure must
    // not be able to leave a banked-and-finished run resumable.
    clearSavedRun();
    // WHETHER the local seat won and WHICH screen says so are two separate questions: the
    // first is `localSeatWon` (split out of this file 2026-09-02, once the `win` audio cue
    // needed the same answer and had been guessing), the second is the arena/PvE split
    // below, which only picks the copy — placement text or floor/materials text.
    const won = localSeatWon(s, this.host.localOwner, s.winner);
    // `run_end` for a run that actually ENDED, reported here rather than in the four
    // branches below because this is the one place that knows `won` before the arena/PvE
    // split picks which copy to show — and one call cannot disagree with itself about the
    // outcome the way four could. The abandon case is NOT here: it has no gameover state to
    // reach this method with, and is detected from the phase change instead
    // (`analyticsTracking.ts`).
    track('run_end', {
      outcome: won ? 'win' : 'loss',
      floor: s.floorIndex + 1,
      duration_s: Math.max(0, Math.floor(s.tick / TICK_RATE)),
    });
    if (s.zoneEnabled) {
      if (won) this.winArena(s);
      else this.loseArena(s);
    } else {
      if (won) this.win(s);
      else this.lose(s);
    }
  }

  private win(s: GameState): void {
    const floor = s.floorIndex + 1;
    const carried = totalBanked(s);
    // A death (lose) never reaches here, so its floor buffer is simply forfeited, no
    // extra code — banking the carry-out is the only thing that leaves a run.
    this.host.bankRunMaterials(s);
    this.host.setPhase('victory');
    this.host.hideHud();
    this.host.addScore(SCORE.victory);
    // The stat block as a function of its materials row, because the ad bonus rewrites
    // that one row and has to leave the other three exactly as they were — re-deriving
    // them later would re-read `currentScore()` after some other screen had moved it.
    const lines = (materials: string): readonly string[] => [
      t('results.floorLine', { floor, floorCount: totalFloorCount(s) }),
      materials,
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ];
    this.host.showOutcomeScreen(
      true,
      t('results.extractedTitle'),
      lines(t('results.materialsBanked', { count: carried })),
      this.doubleOffer(s, carried, lines),
    );
  }

  /**
   * The rewarded-ad offer on a successful extraction: watch one, and the run's carry-out
   * is banked a second time (design/20 "A rewarded-ad placement", decided 2026-09-07).
   *
   * Why this reward and not another. It is the only one that fits both locked rules at
   * once: design/05's wipe rule means a DEATH may never be bought back, and this offer
   * does not exist on the defeat screen at all — `lose()` never calls this. design/14's
   * "sell breadth, not power" means the ad may not hand out power, and a material is not
   * power: it is the farmable currency, spendable only on blueprints the account already
   * owns. And the baseline is banked BEFORE the offer is drawn, so a player who ignores
   * it, blocks ads, or gets an unfilled request keeps 100% of what they carried out —
   * the requirements page's "leave them the non-ad alternative", satisfied by ordering
   * rather than by a second code path.
   *
   * FIVE independent reasons there is no offer, each one a case in the tests: the operator
   * has turned the offer off, no rewarded ad is installed (every target but the portal),
   * the player blocks ads, the run was online, or the run carried nothing out — an offer to
   * double zero is a button that lies about what it does.
   *
   * The first of those is the flag, and it is read HERE rather than at install time on
   * purpose. `main.crazygames.ts` could decline to install the rewarded ad at all when the
   * flag is off, and that would be a switch that only takes effect on a reload — i.e. a
   * differently-spelled deploy, which is the exact mistake `Matchmaker`'s two captured
   * timings made on the server side (design/21 §4, "a flag captured at construction is not
   * a flag"). Read per offer, it takes effect on the next run that ends.
   */
  private doubleOffer(
    s: GameState,
    carried: number,
    lines: (materials: string) => readonly string[],
  ): ResultOffer | null {
    const ad = rewardedAd();
    if (!publicFlag('ads.rewardedOfferEnabled')) return null;
    if (ad === null || !ad.available() || this.host.isOnline() || carried <= 0) return null;
    // AFTER the four refusals, so `ad_offer_shown` counts offers a player could actually
    // see. Reporting it before them would make the take-up rate a fraction of a denominator
    // that includes every run on a platform with no ads at all.
    track('ad_offer_shown');
    return {
      label: t('results.doubleMaterialsButton'),
      claim: async () => {
        // `ad.show()` resolves false for an unfilled ad — no inventory, or the player closed
        // it early. `ad_completed` is therefore the reward being earned, not the button being
        // pressed, which is the only version of the number worth having.
        if (!(await ad.show())) return lines(t('results.adNotFilled', { count: carried }));
        track('ad_completed');
        this.host.bankRunMaterials(s);
        return lines(t('results.materialsDoubled', { count: carried * 2 }));
      },
    };
  }

  private lose(s: GameState): void {
    const floor = s.floorIndex + 1;
    this.host.setPhase('defeat');
    this.host.hideHud();
    this.host.showOutcomeScreen(false, t('results.defeatTitle'), [
      t('results.fellOnFloor', { floor, floorCount: totalFloorCount(s) }),
      t('results.materialsLost', { count: totalForfeited(s) }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }

  /** PvP arena victory (design/15) — last seat standing. No materials/floor concept. */
  private winArena(s: GameState): void {
    this.host.setPhase('victory');
    this.host.hideHud();
    this.host.addScore(SCORE.victory);
    this.host.showOutcomeScreen(true, t('results.victoryTitle'), [
      t('results.placeOf', { total: s.players.length }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }

  /** PvP arena elimination (design/15) — `state.placements` is worst-to-best, the
   *  winner never in it, so this seat's rank from the top is (total - its index). */
  private loseArena(s: GameState): void {
    this.host.setPhase('defeat');
    this.host.hideHud();
    const idx = s.placements.indexOf(this.host.localOwner);
    const place = idx === -1 ? s.players.length : s.players.length - idx;
    this.host.showOutcomeScreen(false, t('results.eliminatedTitle'), [
      t('results.placedOfTotal', { place, total: s.players.length }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }
}
