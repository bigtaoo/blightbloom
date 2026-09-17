/**
 * "Is there a saved run this build can still resume?" — asked by two screens, answered once.
 *
 * ## Why this is not just `savedRunSummary()`
 *
 * Until 2026-09-17 the Forge drew CONTINUE RUN off `savedRunSummary() !== null`, i.e. off
 * **a save exists**, while `RunLifecycle.resumeSavedRun` decided whether to honour it off
 * `checkResumable`, i.e. off **a save this build can reconstruct**. Those are different
 * questions and the gap between them is a button that can only ever apologise: a save from
 * a previous `ENGINE_VERSION`, or one whose floor library moved under it, drew a full-size
 * primary CONTINUE that dropped the save and toasted a refusal when pressed.
 *
 * That gap was survivable while the button lived one screen deep behind SOLO PvE. Putting the
 * same offer on the lobby's front door (design/10, 2026-09-17) is what made it unacceptable —
 * the first thing a returning player sees cannot be a control that fails. So both screens ask
 * this module instead, and there is exactly one answer on the screen at a time.
 *
 * ## The config it checks against is rebuilt from TODAY's content, on purpose
 *
 * `checkResumable` needs the run config as this build would construct it now, because the
 * content half is precisely what it is fingerprinting (`runSave.ts`'s header). So the config
 * comes from the same `buildDungeonRunConfig` the resume itself calls, with the save's own
 * seed and loadout — not a hand-rolled stand-in that could drift from it. A stand-in would
 * make this module answer a question `resumeSavedRun` is not asking, which is the failure it
 * exists to close.
 *
 * `allySkinId` is passed empty because `coop: false` discards it (`savableRun` admits
 * single-player runs only, so there is no second seat and no ally skin to name), and
 * `contentHashOf` reads `config.dungeon` alone.
 *
 * ## Memoised on the save's identity, and here is the number
 *
 * `contentHashOf` is `JSON.stringify(config.dungeon)` plus an FNV pass over the result, and
 * that string is **20,724 characters** for today's `EMBER_DUNGEON` + `EMBER_L1_ROOMS`
 * (measured 2026-09-17) — about 0.08 ms for the stringify alone. The Forge asks twice per
 * `render()` and re-renders on every keystroke, so the answer is cached against the save
 * OBJECT the process-wide slot hands back (`runSaveStore.ts`'s own cache), which changes
 * identity exactly when the save does. Same reasoning as that cache, one layer up.
 *
 * ## Mutation battery — 2026-09-17, 21 mutants, and the two that got away
 *
 * Run over this module, `LobbyRoutes`, `MainMenu`, `RunLifecycle.resumeSavedRun` and the
 * assembly, against the ~1,600 tests in `src/game/{match,ui,screens,controllers}`. **19 killed,
 * 2 controls survived as designed** (building the check config as co-op, and with an empty
 * seat — both are invisible to `contentHashOf`, which reads `config.dungeon` alone, so a
 * battery that killed them would have been a broken harness rather than a good suite).
 *
 * The two real survivors were BOTH in `gameAssembly.ts`, and they were one hole:
 *
 *   SURVIVED  `p.mainMenu.resumableRun = () => null`   — the lobby wired to nothing
 *   SURVIVED  `p.forge.savedRun = () => null`          — the Forge never offering CONTINUE
 *
 * `MainMenu.test.ts` and `Forge.test.ts` each drive their screen from an INJECTED provider,
 * which is the right way to test a screen and exactly why neither can see the provider the
 * product installs. The screens were covered; *"both fields are assigned the same function"* —
 * the sentence this whole module exists to make true — was a claim in a comment. Closed by
 * `gameAssembly.test.ts`, which was the file's first test of any kind; re-running the two
 * mutants against it turns both red and turns **nothing else** red.
 *
 * The rest of the kills are worth knowing for what they say about the suite's reach: the
 * resumability gate itself, the memo going sticky, the caption's 1-based floor, both
 * visibility flags, the block's reserved height, both arms of the primary-button ladder, the
 * rows failing to move down, a stale caption under a withdrawn offer, the portal drawing PLAY
 * *and* CONTINUE, the provider read once instead of per show, and both halves of the resume's
 * screen handling (which screen is hidden, which is re-rendered on a refusal).
 *
 * A NON-resumable save is deliberately left in storage rather than cleared here: this is a
 * read called from a render path, and a provider that mutates storage while a screen is
 * laying itself out is how a refresh becomes a side effect. `RunLifecycle.beginRun` reclaims
 * the slot on the next run, and `resumeSavedRun` still clears on its own refusal — which is
 * now belt and braces rather than the live path.
 */
import type { SavedRun, SavedRunSummary } from './runSave';
import { checkResumable } from './runSave';
import { loadSavedRun } from './runSaveStore';
import { buildDungeonRunConfig } from './offlineConfig';

let memoSave: SavedRun | null = null;
let memoRefusal: ReturnType<typeof checkResumable> = null;
let memoValid = false;

/** The refusal for this save under today's build, or null if it can be resumed. */
export function refuseResume(save: SavedRun): ReturnType<typeof checkResumable> {
  if (memoValid && memoSave === save) return memoRefusal;
  const config = buildDungeonRunConfig({
    seed: save.seed,
    coop: false, // see the header — single-player only, so the ally skin is never read
    localSeat: { skinId: save.skinId, loadout: save.loadout },
    allySkinId: '',
  });
  memoRefusal = checkResumable(save, config);
  memoSave = save;
  memoValid = true;
  return memoRefusal;
}

/**
 * What a screen needs to OFFER a resume, or null when there is nothing to offer — including
 * the case where a save exists but this build cannot reconstruct it.
 */
export function resumableRunSummary(): SavedRunSummary | null {
  const save = loadSavedRun();
  if (!save) return null;
  if (refuseResume(save) !== null) return null;
  return { floorIndex: save.floorIndex, ticks: save.ticks, savedAtMs: save.savedAtMs };
}

/** Test-only: forget the memo so a different save (or a mocked content library) is re-checked. */
export function resetResumableCacheForTests(): void {
  memoSave = null;
  memoRefusal = null;
  memoValid = false;
}
