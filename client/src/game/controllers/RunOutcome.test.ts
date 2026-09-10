/**
 * RunOutcome (design/10 result-screen content, ROADMAP 2026-07-29) — pure reaction
 * logic driven off a real `GameState` fixture (via the engine's own `createGameState`,
 * same convention as `engine/systems/placement.test.ts`'s `pvpState`
 * helper) and a mock `RunOutcomeHost` that records every call instead of touching
 * Pixi/Game.ts (which this file, by design, never imports).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { setRewardedAd, type RewardedAd } from '../../platform/rewardedAd';
import { setPublicFlags } from '../../net/clientFlags';
import { PUBLIC_FLAG_DEFAULTS } from '../../net/publicFlags';
import type { ResultOffer } from '../screens/Screens';
import { setLocale, resetLocaleForTests } from '../../i18n';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { EMBER_DUNGEON, TICK_RATE } from '@dd/engine';
import { buildDungeonRunConfig } from '../match/offlineConfig';
import { packRunSave } from '../match/runSave';
import { loadSavedRun, resetRunSaveCacheForTests, writeSavedRun } from '../match/runSaveStore';
import { RunOutcome, type RunOutcomeHost } from './RunOutcome';
import { SCORE } from '../score';

const MINI_MAP: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function pveState(): GameState {
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [] });
}

function pvpState(seatCount: number): GameState {
  const players = Array.from({ length: seatCount }, (_, i) => ({ teamId: i }));
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: MINI_MAP, players });
}

interface RecordedHost extends RunOutcomeHost {
  readonly phaseSet: ('victory' | 'defeat')[];
  readonly hudHidden: boolean;
  readonly banked: GameState[];
  readonly shown: { won: boolean; title: string; lines: readonly string[] } | undefined;
  /** The rewarded-ad offer the last `showOutcomeScreen` was handed. `undefined` when the
   *  call site passed none at all (every arm but the PvE win), `null` when it passed one
   *  and decided against it — two different facts, so they stay distinguishable. */
  readonly offer: ResultOffer | null | undefined;
  online: boolean;
}

function mockHost(localOwner = 0): RecordedHost {
  let score = 0;
  const phaseSet: ('victory' | 'defeat')[] = [];
  const banked: GameState[] = [];
  let hudHidden = false;
  let shown: { won: boolean; title: string; lines: readonly string[] } | undefined;
  let offer: ResultOffer | null | undefined;
  return {
    localOwner,
    online: false,
    addScore: (delta) => { score += delta; },
    currentScore: () => score,
    setPhase: (p) => { phaseSet.push(p); },
    hideHud: () => { hudHidden = true; },
    bankRunMaterials: (s) => { banked.push(s); },
    isOnline() { return this.online; },
    showOutcomeScreen: (won, title, lines, o) => { shown = { won, title, lines }; offer = o; },
    get phaseSet() { return phaseSet; },
    get hudHidden() { return hudHidden; },
    get banked() { return banked; },
    get shown() { return shown; },
    get offer() { return offer; },
  };
}

afterEach(() => resetLocaleForTests());

describe('RunOutcome — PvE extraction/death', () => {
  it('win (extract): banks materials, victory phase, shows floor/materials/time/score', () => {
    const s = pveState();
    s.floorIndex = 2; // floor 3
    s.bankedMaterials = { fire: 3, ice: 2 };
    s.tick = TICK_RATE * 97 + 15; // 1:37, ticks past the minute boundary ignored

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['victory']);
    expect(host.hudHidden).toBe(true);
    expect(host.banked).toEqual([s]);
    expect(host.currentScore()).toBe(SCORE.victory);
    expect(host.shown).toEqual({
      won: true,
      title: 'EXTRACTED',
      lines: [
        `Floor 3/${EMBER_DUNGEON.floorCount}`,
        'Materials banked: 5',
        'Time 1:37',
        `Score ${SCORE.victory}`,
      ],
    });
  });

  it('lose (death): no banking, no score, shows floor/loss/time/score', () => {
    const s = pveState();
    s.floorIndex = 0; // floor 1
    s.bankedMaterials = { fire: 9 }; // forfeited — never reaches bankRunMaterials
    s.winner = 'enemies';
    s.tick = 0;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['defeat']);
    expect(host.hudHidden).toBe(true);
    expect(host.banked).toEqual([]);
    expect(host.currentScore()).toBe(0);
    expect(host.shown).toEqual({
      won: false,
      title: 'DEFEAT',
      lines: [
        `Fell on floor 1/${EMBER_DUNGEON.floorCount}`,
        'All 9 carried materials were lost',
        'Time 0:00',
        'Score 0',
      ],
    });
  });

  // design/05's locked wipe rule: a death forfeits the ENTIRE un-extracted carry-out —
  // this floor's buffer AND everything descending already folded into the bag. The defeat
  // line used to say "The floor's materials were lost", which named only the smaller pool
  // and matched a claim design/05/09/ROADMAP had all been carrying past its own
  // supersession; this asserts the counted total spans both tiers, so the copy can never
  // drift back to naming one of them.
  it('lose (death): the reported loss counts BOTH the floor buffer and the banked bag', () => {
    const s = pveState();
    s.bankedMaterials = { fire: 4, ice: 2 }; // descended past two floors with these
    s.floorMaterials = { poison: 3 }; // picked up on the floor they died on
    s.winner = 'enemies';

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.banked).toEqual([]); // neither tier reaches the account
    expect(host.shown?.lines).toContain('All 9 carried materials were lost');
  });

  it('lose (death) with an empty run still reports 0, not a blank or NaN', () => {
    const s = pveState();
    s.winner = 'enemies';

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.lines).toContain('All 0 carried materials were lost');
  });

  it('a zero-material extraction still shows "Materials banked: 0", not blank', () => {
    const s = pveState();
    const host = mockHost();
    new RunOutcome(host).handle(s);
    expect(host.shown?.lines).toContain('Materials banked: 0');
  });
});

describe('RunOutcome — PvP arena victory/elimination', () => {
  it('winArena: local seat is the recorded winner — victory phase, placement text, no banking', () => {
    const s = pvpState(4);
    s.winner = 0; // localOwner's seat
    s.tick = TICK_RATE * 65; // 1:05

    const host = mockHost(0);
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['victory']);
    expect(host.banked).toEqual([]); // no materials/floor concept in arena mode
    expect(host.currentScore()).toBe(SCORE.victory);
    expect(host.shown).toEqual({
      won: true,
      title: 'VICTORY ROYALE',
      lines: ['1st place of 4', 'Time 1:05', `Score ${SCORE.victory}`],
    });
  });

  it('winArena: local seat is a squad-mate of the named winner (shared teamId), not the seat itself — still victory, not defeat', () => {
    const s = pvpState(4);
    s.players[2]!.teamId = s.players[3]!.teamId; // seats 2 and 3 share a squad
    s.winner = 2; // WinConditionSystem names the squad's lowest seat as the representative
    s.tick = TICK_RATE * 65;

    const host = mockHost(3); // local seat is the OTHER member of the winning squad
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['victory']);
    expect(host.shown?.won).toBe(true);
  });

  it('loseArena: placement computed from worst-to-best `placements`, winner never in it', () => {
    const s = pvpState(4);
    s.winner = 3; // seat 3 won, not the local seat
    s.placements.push(1, 2, 0); // worst-first: seat 1 eliminated first, local seat (0) last of the losers
    s.tick = 0;

    const host = mockHost(0);
    new RunOutcome(host).handle(s);

    expect(host.phaseSet).toEqual(['defeat']);
    // placements.indexOf(0) === 2 (third listed) → place = players.length(4) - 2 = 2nd
    expect(host.shown?.lines[0]).toBe('Placed 2/4');
  });

  it('loseArena: a seat missing from `placements` (should not happen, but defends the read) falls back to last place', () => {
    const s = pvpState(3);
    s.winner = 1;
    s.placements.push(2); // local seat (0) absent
    const host = mockHost(0);
    new RunOutcome(host).handle(s);
    expect(host.shown?.lines[0]).toBe('Placed 3/3');
  });
});

describe('RunOutcome — i18n (design/17-i18n.md)', () => {
  it('win (extract) under zh: translated title/lines, `won` stays a real boolean, not display text', () => {
    setLocale('zh');
    const s = pveState();
    s.floorIndex = 2;
    s.bankedMaterials = { fire: 3, ice: 2 };
    s.tick = TICK_RATE * 97 + 15;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(true);
    expect(host.shown?.title).toBe('撤离成功');
    expect(host.shown?.lines).toEqual([
      `楼层 3/${EMBER_DUNGEON.floorCount}`,
      '已存入材料：5',
      '用时 1:37',
      `分数 ${SCORE.victory}`,
    ]);
  });

  it('lose (death) under zh: translated title/lines, `won` is false', () => {
    setLocale('zh');
    const s = pveState();
    s.floorIndex = 0;
    s.winner = 'enemies';
    s.tick = 0;

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(false);
    expect(host.shown?.title).toBe('战败');
    expect(host.shown?.lines).toContain('携带的 0 个材料已全部丢失');
  });

  it('switching back to English produces the original English copy again', () => {
    const s = pveState();
    setLocale('zh');
    new RunOutcome(mockHost()).handle(s);
    setLocale('en');
    const host = mockHost();
    new RunOutcome(host).handle(s);
    expect(host.shown?.title).toBe('EXTRACTED');
  });
});

// design/10 screen-flow gap: win()/lose() used to hardcode EMBER_DUNGEON.floorCount for
// the "Floor N/M" line regardless of the run's actual config — wrong for a flat
// (non-dungeon) floors config like the tutorial level (ROADMAP totalFloorCount fix).
describe('RunOutcome — a flat (non-dungeon) floors config reports its own floor count', () => {
  function flatFloorsState(): GameState {
    return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], floors: [[[[100, 100]]]] }); // 1 extra floor → 2 total
  }

  it('win (extract): "Floor N/2", not the ember-dungeon default', () => {
    const s = flatFloorsState();
    s.floorIndex = 0; // floor 1 of 2
    expect(s.dungeonEnabled).toBe(false);

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.lines[0]).toBe('Floor 1/2');
  });

  it('lose (death): "Fell on floor N/2", not the ember-dungeon default', () => {
    const s = flatFloorsState();
    s.floorIndex = 1; // floor 2 of 2 (the last floor)
    s.winner = 'enemies';

    const host = mockHost();
    new RunOutcome(host).handle(s);

    expect(host.shown?.lines[0]).toBe('Fell on floor 2/2');
  });
});

// ---------------------------------------------------------------------------------------
// The rewarded-ad materials bonus (design/20's "A rewarded-ad placement", 2026-09-07).
//
// What these cases are actually defending is a pair of design rules that a plausible
// implementation breaks silently: an offer on the DEFEAT screen would buy back a wipe
// (design/05's locked rule), and a reward paid before the ad plays — or a baseline that is
// only banked when the ad DOESN'T play — would make the non-ad player worse off than the
// ad player by more than the bonus. So every case below asserts on `banked`, which is the
// only observable that distinguishes those.
// ---------------------------------------------------------------------------------------
describe('RunOutcome — rewarded-ad materials bonus', () => {
  /** A stub rewarded ad. `plays` decides the outcome; `shown` counts requests, so a test
   *  can tell "refused to offer" from "offered and the ad was unfilled". */
  function stubAd(opts: { available?: boolean; plays?: boolean } = {}) {
    const { available = true, plays = true } = opts;
    let shown = 0;
    const ad: RewardedAd = {
      available: () => available,
      show: async () => { shown += 1; return plays; },
    };
    setRewardedAd(ad);
    return { requests: () => shown };
  }

  function extractedState(): GameState {
    const s = pveState();
    s.floorIndex = 0;
    s.bankedMaterials = { fire: 4 };
    return s;
  }

  afterEach(() => {
    setRewardedAd(null);
    setPublicFlags(null);
  });

  it('no ad installed (every target but the portal): no offer, and the win is unchanged', () => {
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());

    expect(host.offer).toBeNull();
    expect(host.shown?.lines[1]).toBe('Materials banked: 4');
    expect(host.banked).toHaveLength(1);
  });

  it('offers the double on a successful extraction, labelled from the locale', () => {
    stubAd();
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());

    expect(host.offer?.label).toBe('WATCH AD: MATERIALS x2');
  });

  it('the offer label follows the active locale, like every other results-screen string', () => {
    stubAd();
    setLocale('zh');
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());

    expect(host.offer?.label).toBe('看广告：材料 x2');
  });

  it('claiming a PLAYED ad banks the same carry-out a second time and says so', async () => {
    const ad = stubAd({ plays: true });
    const host = mockHost();
    const s = extractedState();
    new RunOutcome(host).handle(s);

    // Baseline first: exactly one banking before the ad is ever requested. This is the
    // ordering that makes "the non-ad player keeps everything" true by construction.
    expect(host.banked).toEqual([s]);

    const lines = await host.offer!.claim();

    expect(ad.requests()).toBe(1);
    expect(host.banked).toEqual([s, s]); // the SAME bag, banked twice = doubled
    expect(lines[1]).toBe('Materials banked: 8 (ad bonus x2)');
    // The other three rows are untouched — the bonus rewrites one line, not the block.
    expect(lines[0]).toBe(host.shown!.lines[0]);
    expect(lines[2]).toBe(host.shown!.lines[2]);
    expect(lines[3]).toBe(host.shown!.lines[3]);
  });

  it('an UNFILLED ad banks nothing more, keeps the baseline, and says the materials are safe', async () => {
    const ad = stubAd({ plays: false });
    const host = mockHost();
    const s = extractedState();
    new RunOutcome(host).handle(s);

    const lines = await host.offer!.claim();

    expect(ad.requests()).toBe(1);
    expect(host.banked).toEqual([s]); // still one — the reward is paid only on a played ad
    expect(lines[1]).toBe('No ad available - your 4 materials are safe');
  });

  it('no offer when the OPERATOR has turned it off, with an ad that would otherwise play', () => {
    // design/21 §9's delivery path, at the one call site that reads it. The whole point of
    // the flag is this case: the offer doubles an extraction payout, so if the balance turns
    // out wrong — or the platform's ad fill collapses and the button becomes a lie — it has
    // to be switchable without a client deploy.
    //
    // The ad stub is FULLY working here, which is what makes this a test of the flag rather
    // than of anything else: every other reason to refuse is absent, so `offer === null` can
    // only be the flag.
    const ad = stubAd();
    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ads.rewardedOfferEnabled': false });
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());

    expect(host.offer).toBeNull();
    // Not shown AND not requested: a refusal that still asked the SDK for an ad would burn
    // the platform's fill rate on an offer nobody can accept.
    expect(ad.requests()).toBe(0);
    // ...and the baseline payout is untouched, which is the property design/20 protects by
    // ORDERING rather than by a second code path.
    expect(host.shown?.lines[1]).toBe('Materials banked: 4');
    expect(host.banked).toHaveLength(1);
  });

  it('offers it again the moment the operator turns it back on — read per offer, not at install', () => {
    // The difference between a flag and a differently-spelled deploy (design/21 §4, "a flag
    // captured at construction is not a flag"). `main.crazygames.ts` could have declined to
    // install the rewarded ad at all when the flag was off, and that switch would only take
    // effect on a reload.
    stubAd();
    // ONE `RunOutcome`, two runs, a flip in between. That is what makes this an assertion
    // about reading per offer: a value captured in the constructor would still be `false` on
    // the second run, and a test that built a fresh `RunOutcome` after the flip could not
    // tell the two implementations apart.
    const host = mockHost();
    const outcome = new RunOutcome(host);

    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ads.rewardedOfferEnabled': false });
    outcome.handle(extractedState());
    expect(host.offer).toBeNull();

    setPublicFlags({ ...PUBLIC_FLAG_DEFAULTS, 'ads.rewardedOfferEnabled': true });
    outcome.handle(extractedState());
    expect(host.offer).not.toBeNull();
  });

  it('offers it by DEFAULT, so an unreachable flag route does not cost the offer', () => {
    // The shipped default is `true` and the store starts there, so every client that cannot
    // reach `GET /client/flags` still shows the offer. The wrong way round would mean an
    // outage silently switching off the one thing on this screen that pays.
    stubAd();
    setPublicFlags(null);
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());
    expect(host.offer).not.toBeNull();
  });

  it('no offer when the player blocks ads — a button that cannot work is not drawn', () => {
    stubAd({ available: false });
    const host = mockHost();
    new RunOutcome(host).handle(extractedState());

    expect(host.offer).toBeNull();
  });

  it('no offer in an online match: an ad freezes this client and lockstep cannot wait', () => {
    stubAd();
    const host = mockHost();
    host.online = true;
    new RunOutcome(host).handle(extractedState());

    expect(host.offer).toBeNull();
  });

  it('no offer when the run carried nothing out — doubling zero is a button that lies', () => {
    stubAd();
    const host = mockHost();
    const s = pveState();
    s.bankedMaterials = {};
    new RunOutcome(host).handle(s);

    expect(host.offer).toBeNull();
  });

  it('DEATH gets no offer at all: design/05 locks the wipe, so there is nothing to double', () => {
    stubAd();
    const host = mockHost();
    const s = extractedState();
    s.winner = 'enemies';
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(false);
    // `undefined`, not `null`: the defeat arm passes no offer argument whatsoever, so this
    // stays red if a later pass ever wires one in and merely disables it.
    expect(host.offer).toBeUndefined();
    expect(host.banked).toEqual([]);
  });

  it('a PvP arena win gets no offer either — an arena run has no carry-out bag', () => {
    stubAd();
    const host = mockHost(0);
    const s = pvpState(2);
    s.winner = 0;
    new RunOutcome(host).handle(s);

    expect(host.shown?.won).toBe(true);
    expect(host.offer).toBeUndefined();
  });
});

/**
 * A finished run is not a resumable one (design/05 "Only the boss floor ends a run",
 * ENGINE_VERSION 61).
 *
 * This is the third of the three places that drop the save slot, and the only one that does
 * not go through `RunLifecycle` — nothing routes a victory or a defeat there — so without it
 * a player who closes the tab on a result screen comes back to a Forge offering CONTINUE for
 * a run that is already over, with its materials already banked.
 *
 * All four arms are asserted, because they reach different code and only their SHARED
 * prologue clears the slot: a clear moved into `win()` alone would leave every death
 * resumable, which is exactly the wipe rule inverted.
 */
describe('RunOutcome — every outcome drops the saved run', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    resetRunSaveCacheForTests();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    };
  });

  function withSave() {
    const config = buildDungeonRunConfig({
      seed: 3, coop: false, localSeat: { skinId: 'vanguard', loadout: [] }, allySkinId: 'skirmisher',
    });
    writeSavedRun(packRunSave({ config, commands: [], ticks: 10, floorIndex: 1, score: 0, nowMs: 1 }));
    expect(loadSavedRun()).not.toBeNull();
  }

  it('a PvE extraction', () => {
    withSave();
    const s = pveState();
    s.winner = 0;
    new RunOutcome(mockHost()).handle(s);
    expect(loadSavedRun()).toBeNull();
  });

  it('a PvE wipe', () => {
    withSave();
    const s = pveState();
    s.winner = 'enemies';
    new RunOutcome(mockHost()).handle(s);
    expect(loadSavedRun()).toBeNull();
  });

  it('an arena win', () => {
    withSave();
    const s = pvpState(2);
    s.winner = 0;
    new RunOutcome(mockHost()).handle(s);
    expect(loadSavedRun()).toBeNull();
  });

  it('an arena elimination', () => {
    withSave();
    const s = pvpState(2);
    s.winner = 1; // somebody else's seat
    new RunOutcome(mockHost()).handle(s);
    expect(loadSavedRun()).toBeNull();
  });

  it('and it really leaves the store, not only the cache', () => {
    // Otherwise the run comes back on the next page load, which is the one place a
    // cache-only clear would look green here and fail for a player.
    withSave();
    const s = pveState();
    s.winner = 0;
    new RunOutcome(mockHost()).handle(s);
    resetRunSaveCacheForTests();
    expect(loadSavedRun()).toBeNull();
  });
});
