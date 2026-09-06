// design/12's asset-loading phases, as the functions both entries call.
//
// This used to be one `preloadCoreArt()` — every pack and every loader, awaited before the
// game was constructed. That satisfied WeChat's 4 MB first-download rule (the packs existed)
// while buying nothing from it (all their bytes still arrived before the first frame), and it
// held the main package at 99.93% full, where the next code change of any size failed the byte
// gate. Since 2026-09-01 it is two phases — see design/12, "the first download is code only":
//
//   LOBBY  `preloadLobbyArt()`  the `lobby` pack + the UI loader. Awaited by both entries
//                               before `new Game(...)`, behind `ui/loadingScreen.ts`.
//   RUN    `ensureRunArt()`     every `run`-phase pack + the four remaining loaders. Kicked in
//                               the background from the lobby by `beginDeferredArt()`, and
//                               awaited at the run boundary by `game/controllers/ArtGate.ts`.
//
// THE RULE THIS SHAPE EXISTS TO KEEP (design/12): the set of available textures changes only at
// a phase boundary. Not per asset, not per room. Re-running a loader once its pack has landed
// is safe and nearly free — the four sprite loaders are idempotent map-fillers over a static path
// table with a per-item try/catch, and Pixi's `Assets` memoises by URL — but a texture that
// appears halfway through a room does not fix the sprite that was built without it, and that is
// the class of bug this repo has the worst record with. (`preloadRigSkin` is the exception to the
// "free" half: it re-reads its two JSON sidecars rather than skipping a bundle it already holds,
// which is why it belongs to the run phase and is never called in the lobby one.)
//
// Every load is best-effort and per-item: a failed or slow asset leaves that consumer on its
// Graphics fallback and boot continues ("gameplay is never blocked on art", design/02/12).
// That is a stronger requirement on WeChat than on web, not a weaker one — a mini-game has no
// reload button.
import { Assets } from 'pixi.js';
import { getAssetHost } from './assetHost';
import { packOf, packsForPhase } from './assetManifest';
import { ensureAllPacks, ensurePack, ensurePacks } from './packLoader';
import { preloadRigSkin } from './skinRegistry';
import { preloadWeaponSkins } from './weaponSkins';
import { preloadUiArt } from './uiSkins';
import { preloadBiomeTiles } from './biomeTiles';
import { preloadEnvironmentSprites } from './environmentSprites';
import { invalidateMusicTrack } from '../game/musicDirector';
import { MUSIC_DIR } from '../audio/musicCatalogue';

/** Registry keys are `SkinDef.atlasKey` values (content/skins.ts) — the three launch
 *  characters (design/13), all on the shared orb-core rig — plus the enemy bodies
 *  ('critter-core' and its two variants, design/13's "one neutral-grey critter, re-tinted
 *  per variant") and the boss. */
export const CHAR_BUNDLES: ReadonlyArray<[string, string]> = [
  ['char_vanguard', '/skins/orb-core'],
  ['char_skirmisher', '/skins/skirmisher-core'],
  ['char_juggernaut', '/skins/juggernaut-core'],
  ['critter-core', '/skins/critter-core'],
  ['brute-core', '/skins/brute-core'],
  ['floater-core', '/skins/floater-core'],
  ['boss-core', '/skins/boss-core'],
];

/** Progress ticks a caller can expect from `ensureRunArt`: one per `run`-phase pack, then one
 *  per loader (each rig bundle, then weapons/biome/environment). Exported so the loading screen
 *  can size its bar before the first tick arrives rather than growing it as it goes. */
export function runArtUnitCount(): number {
  return packsForPhase('run').length + CHAR_BUNDLES.length + 3;
}

/** Told once per pack/loader as it settles, with how many of `total` are done. */
export type ArtProgress = (done: number, total: number) => void;

function ticker(total: number, onProgress?: ArtProgress): () => void {
  let done = 0;
  return () => onProgress?.(++done, total);
}

// The run phase's progress, as a BROADCAST rather than one callback owned by the first caller.
// It has to be: `beginDeferredArt` starts the download with no listener at all (nobody is
// watching a background load), and the listener that matters — the run gate's progress bar —
// only appears if a player reaches the forge before the download finishes. A single stored
// callback would mean the bar never moved, which is the entire point of the gate.
let runDone = 0;
const runListeners = new Set<ArtProgress>();

function tickRun(): void {
  runDone++;
  for (const listen of runListeners) listen(runDone, runArtUnitCount());
}

/**
 * Phase one: `Assets.init`, the `lobby` pack, the UI loader. Both entries await this before
 * constructing `Game`, so every menu-shaped screen is fully dressed on its first paint.
 *
 * `Assets.init` is explicit, and BEFORE the first load. `Assets.load` self-initialises
 * otherwise, which on WeChat throws inside the format detection and silently costs whichever
 * texture happened to race there first — see AssetHost.assetsInit for the full account.
 */
export async function preloadLobbyArt(onProgress?: ArtProgress): Promise<void> {
  await Assets.init(getAssetHost().assetsInit);
  const lobby = packsForPhase('lobby');
  const tick = ticker(lobby.length + 1, onProgress);
  // Subpackages BEFORE the loads that read out of them: on WeChat a path inside a pack that
  // has not been fetched names no file, and the loader would take that for "not generated yet"
  // and fall back silently. See packLoader.ts.
  await ensurePacks(lobby, tick);
  await preloadUiArt();
  tick();
}

// Whether anything has actually been deferred this session. UNSET IS "EVERYTHING IS HERE":
// with no `beginDeferredArt()` call, `isRunArtReady()` answers true and the run gate is inert,
// so every unit test that drives `Game` — and `preloadCoreArt`'s all-at-once path — behaves
// exactly as it did before the phases existed. Only the two real entry points opt in.
let deferred = false;
let runArt: Promise<void> | null = null;
let runArtDone = false;

/**
 * Phase two, kicked and not awaited: start the background download the moment the lobby is up.
 *
 * The `background` packs go first and are never awaited by anything (`music` — 0.84 MB, and the
 * one asset class a game can start without). Its completion is the single push
 * `musicDirector`'s per-frame derivation needs: a deck handed a path inside an unfetched pack
 * plays nothing and records the track as current anyway, so without this the menu bed would be
 * silent for the session. See design/12, "Music is loaded but never awaited".
 */
export function beginDeferredArt(): void {
  deferred = true;
  // WHICH pack holds the music is asked of the rules, not written here: `packOf` is the same
  // function every loader's path goes through, so renaming or re-splitting the music pack in
  // `assetPacks.json` keeps this working and no pack name is spelled in TypeScript.
  const musicPack = packOf(`${MUSIC_DIR}/`);
  for (const pack of packsForPhase('background')) {
    void ensurePack(pack.name).then(() => {
      if (pack.name === musicPack) invalidateMusicTrack();
    });
  }
  void ensureRunArt();
}

/**
 * Is the run-phase art in? `true` until something defers, which is what keeps the gate out of
 * every caller that never deferred (see `deferred` above). A gate asks this first so a
 * transition whose art is already loaded stays exactly as synchronous as it was.
 */
export function isRunArtReady(): boolean {
  return !deferred || runArtDone;
}

/**
 * Phase two, awaited: every `run`-phase pack, then the four remaining loaders.
 *
 * Memoised on the PROMISE, so the background kick and a gate that arrives mid-download share
 * one download and one loader pass. `onProgress` is registered as a LISTENER on that shared
 * download rather than owned by it, and is immediately called back with where the download
 * already is — a gate that opens when 12 of 16 units are in should draw a bar at 12, not start
 * at zero and jump.
 */
export function ensureRunArt(onProgress?: ArtProgress): Promise<void> {
  // Not registered once the load has finished: nothing more will ever be reported, and a
  // listener closes over a `LoadingScreen` that would then never be released. It still gets its
  // one replay, so a caller that asks anyway draws a full bar rather than an empty one.
  if (onProgress) {
    if (!runArtDone) runListeners.add(onProgress);
    onProgress(runDone, runArtUnitCount());
  }
  runArt ??= loadRunArt().then(() => {
    runArtDone = true;
    // Nothing more will ever be reported, and a gate's callback closes over its `LoadingScreen`.
    runListeners.clear();
  });
  return runArt;
}

async function loadRunArt(): Promise<void> {
  await ensurePacks(packsForPhase('run'), tickRun);
  await Promise.all([
    ...CHAR_BUNDLES.map(async ([name, baseUrl]) => {
      try {
        await preloadRigSkin(name, baseUrl);
      } catch (err) {
        console.warn(`${name} skin preload failed, falling back to placeholder`, err);
      }
      tickRun();
    }),
    preloadWeaponSkins()
      .catch((err) => {
        console.warn('weapon skins preload failed, socket stays unarmed-looking', err);
      })
      .then(tickRun),
    preloadBiomeTiles().then(tickRun),
    preloadEnvironmentSprites().then(tickRun),
  ]);
}

/**
 * Everything, now — the pre-phase shape, kept for callers that do not want to think about
 * phases (the loader tests, and any future entry point that has no progress screen to show).
 * Loads the `background` packs too, which `beginDeferredArt` deliberately does not await.
 */
export async function preloadCoreArt(): Promise<void> {
  await Assets.init(getAssetHost().assetsInit);
  await ensureAllPacks();
  // Through `ensureRunArt` rather than `loadRunArt` so the memo is shared: a caller that took
  // this path and then hit a gate anyway must not run every loader a second time.
  await Promise.all([preloadUiArt(), ensureRunArt()]);
}

/** Drops the phase memo. Tests only — module state outlives a single test file, and a resolved
 *  `runArt` promise from one test would make the next one's gate inert. */
export function resetPreloadArt(): void {
  deferred = false;
  runArt = null;
  runArtDone = false;
  runDone = 0;
  runListeners.clear();
}
