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
//                               awaited at the run boundary by `game/controllers/TransitionGate.ts`.
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
import { preloadUiArt, preloadUiTier, setBootLocale } from './uiSkins';
import { preloadBiomeTiles } from './biomeTiles';
import { preloadEnvironmentSprites } from './environmentSprites';
import { invalidateMusicTrack } from '../game/musicDirector';
import { MUSIC_DIR } from '../audio/musicCatalogue';

/**
 * The rig bundles, in three tiers — keys are `SkinDef.atlasKey` values (content/skins.ts).
 *
 * WHY THIS IS THREE LISTS AND NOT ONE (2026-11-12). On web there are no subpackages:
 * `AssetHost.loadPack` is absent, every file is simply served, and `ensurePacks` resolves
 * without fetching a byte. So on the Playgama portal a pack's `phase` moves nothing, and THESE
 * LOADERS are the whole of what the run gate waits for. The sandbox measured the bill:
 * `run_wait{art}` came back `pending` in 117 of 118 sessions at p90 6.6 s, with
 * `firstRunAutostart.ts` opening the gate within a frame of `beginDeferredArt()` (design/22).
 * Which tier a rig sits in is therefore a byte decision about that wait.
 *
 * The rule a tier must not break is design/12's: the set of available textures changes only at
 * a phase boundary, so a rig the FIRST ROOM draws cannot be deferred past the gate.
 */

/** CORE — the enemy bodies, all three inside the gate. Chapter 1 floor 1 garrisons its rooms
 *  with `basic` (critter-core) in room 1, `floater`/`stalker` (floater-core) in room 2 and
 *  `brute`/`ravager` (brute-core) in room 4 (`world/dungeons/ember/pieces`), which is far too
 *  early to defer any of them. 83 kB together, so there is little to win by trying. */
export const CORE_RIGS: ReadonlyArray<[string, string]> = [
  ['critter-core', '/skins/critter-core'],
  ['brute-core', '/skins/brute-core'],
  ['floater-core', '/skins/floater-core'],
];

/** CHARACTER — one per playable character (design/13). A run draws exactly ONE of them, so the
 *  gate waits for the selected rig alone (`setRunCharacterRig`) and the other two ride the
 *  background tier: 369 kB shipped, at most 163 kB of it ever on screen in a given run. */
export const CHARACTER_RIGS: ReadonlyArray<[string, string]> = [
  ['char_vanguard', '/skins/orb-core'],
  ['char_skirmisher', '/skins/skirmisher-core'],
  ['char_juggernaut', '/skins/juggernaut-core'],
];

/** LATE — drawn on floor 5 and never before it (`engine/content/bosses.ts`: all six bosses
 *  share this one rig), so 55 kB a first-room gate has no reason to hold. */
export const LATE_RIGS: ReadonlyArray<[string, string]> = [['boss-core', '/skins/boss-core']];

/** Every rig this game ships, in the order the single pre-2026-11-12 list had them. The
 *  manifest and packaging tests walk THIS; the tiers above decide only when each one loads. */
export const CHAR_BUNDLES: ReadonlyArray<[string, string]> = [...CHARACTER_RIGS, ...CORE_RIGS, ...LATE_RIGS];

/** What a first-ever visit plays, and the same key `game/scene/Actor.ts` already falls back to
 *  for a player whose `atlasKey` it does not recognise. */
export const DEFAULT_CHARACTER_RIG = 'char_vanguard';

let characterRig: string = DEFAULT_CHARACTER_RIG;

/**
 * Which playable character's rig the run gate must wait for.
 *
 * PUSHED IN by `Game` from `MetaState.selectedSkin`, not pulled from it, because
 * `beginDeferredArt()` runs BEFORE `new Game(...)` on every entry point — the background
 * download has to start before the answer exists, and a player who cycles character in the
 * forge changes it again afterwards. Setting it starts that rig at once when the art phases are
 * armed, so by the time a gate asks, it is normally paying for something already in flight.
 */
export function setRunCharacterRig(atlasKey: string): void {
  if (atlasKey === characterRig) return;
  characterRig = atlasKey;
  if (deferred) void ensureRig(atlasKey);
}

/** Memoised per rig. `preloadRigSkin` re-reads its two JSON sidecars rather than skipping a
 *  bundle it already holds (this file's header), so a rig both the gate and the background tier
 *  want must not be asked for twice. Best-effort per rig, like every other loader here: a rig
 *  that fails — or a key this build ships no bundle for — still counts as settled, because a
 *  `rigDone` that never fills would leave `isRunArtReady()` false for the rest of the session. */
const rigLoads = new Map<string, Promise<void>>();
const rigDone = new Set<string>();

function ensureRig(name: string): Promise<void> {
  let p = rigLoads.get(name);
  if (!p) {
    const entry = CHAR_BUNDLES.find(([n]) => n === name);
    const load = entry
      ? preloadRigSkin(entry[0], entry[1]).catch((err) => {
          console.warn(`${name} skin preload failed, falling back to placeholder`, err);
        })
      : Promise.resolve();
    p = load.then(() => {
      rigDone.add(name);
    });
    rigLoads.set(name, p);
  }
  return p;
}

/** Progress ticks a caller can expect from `ensureRunArt`: one per `run`-phase pack, then one
 *  per loader (the three core rigs and the ONE selected character, then the late UI tier and
 *  weapons/biome/environment). Exported so the loading screen can size its bar before the first
 *  tick arrives rather than growing it as it goes. */
export function runArtUnitCount(): number {
  return packsForPhase('run').length + CORE_RIGS.length + 1 + 4;
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
 * Phase one: `Assets.init`, the `lobby` pack, the UI loader's `boot` tier. Every entry awaits
 * this before constructing `Game`; the `lobby` tier (the lobby's decoration) is kicked on the
 * way out and never awaited, and `late` rides the run phase — see `uiSkins.ts`'s header for
 * which file is in which, and why.
 *
 * `Assets.init` is explicit, and BEFORE the first load. `Assets.load` self-initialises
 * otherwise, which on WeChat throws inside the format detection and silently costs whichever
 * texture happened to race there first — see AssetHost.assetsInit for the full account.
 */
export async function preloadLobbyArt(onProgress?: ArtProgress, locale?: string): Promise<void> {
  // The locale the first frame is drawn in, so `boot` fetches one logo rather than both
  // (uiSkins.ts's header). Omitted, both stay in `boot`: slower, never wrong.
  if (locale !== undefined) setBootLocale(locale);
  await Assets.init(getAssetHost().assetsInit);
  const lobby = packsForPhase('lobby');
  const tick = ticker(lobby.length + 1, onProgress);
  // Subpackages BEFORE the loads that read out of them: on WeChat a path inside a pack that
  // has not been fetched names no file, and the loader would take that for "not generated yet"
  // and fall back silently. See packLoader.ts.
  await ensurePacks(lobby, tick);
  await preloadUiTier('boot');
  tick();
  void preloadUiTier('lobby');
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
 * The run art goes FIRST, and the `background` packs wait for it (2026-11-10). They are never
 * awaited by anything (`music` — 3.41 MB, and the one asset class a game can start without),
 * but they used to start at the same moment as the run art and split the line with it. A new
 * player is dropped straight into the teaching run (`firstRunAutostart.ts`), so the run gate
 * opens within a frame of this call and that player sat on the loading screen while 3.41 MB of
 * music shared the bandwidth with the ~2.3 MB the gate was actually waiting for. In the
 * Playgama sandbox, 23 of 84 new visitors left without a `run_start` (design/22 §4.1).
 *
 * The background completion is still the single push `musicDirector`'s per-frame derivation
 * needs: a deck handed a path inside an unfetched pack plays nothing and records the track as
 * current anyway, so without it the menu bed would be silent for the session. See design/12,
 * "Music is loaded but never awaited". It runs whether or not the run art loaded cleanly —
 * every loader is best-effort, and a failure there is no reason to also lose the music.
 */
export function beginDeferredArt(): void {
  deferred = true;
  // WHICH pack holds the music is asked of the rules, not written here: `packOf` is the same
  // function every loader's path goes through, so renaming or re-splitting the music pack in
  // `assetPacks.json` keeps this working and no pack name is spelled in TypeScript.
  const musicPack = packOf(`${MUSIC_DIR}/`);
  const background = (): void => {
    // The rigs the gate deliberately did not wait for: the two characters THIS run will not
    // draw, and the boss (floor 5). They are behind the gate's art for the same reason the
    // music is — started together, they split the line with the bytes the player is sitting
    // on. Memoised by `ensureRig`, so the one already loaded as the selected character here
    // costs nothing and a later forge switch finds it in hand.
    for (const [name] of [...CHARACTER_RIGS, ...LATE_RIGS]) void ensureRig(name);
    for (const pack of packsForPhase('background')) {
      void ensurePack(pack.name).then(() => {
        if (pack.name === musicPack) invalidateMusicTrack();
      });
    }
  };
  void ensureRunArt().then(background, background);
}

/**
 * Is the run-phase art in? `true` until something defers, which is what keeps the gate out of
 * every caller that never deferred (see `deferred` above). A gate asks this first so a
 * transition whose art is already loaded stays exactly as synchronous as it was.
 */
export function isRunArtReady(): boolean {
  return !deferred || (runArtDone && rigDone.has(characterRig));
}

/**
 * Has a host armed phase two at all (`beginDeferredArt`)?
 *
 * Only the three real entry points call that, so this answers `false` in every unit test in
 * this repo that has not deliberately opted in — which is the single fact
 * `controllers/TransitionGate.ts` needs to keep a MINIMUM-display transition out of a suite
 * that drives `Game` synchronously. It is the same switch `isRunArtReady` reads, asked as
 * the different question: not "is the art in" but "is this a real boot".
 */
export function isDeferredArtArmed(): boolean {
  return deferred;
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
  const shared = (runArt ??= loadRunArt().then(() => {
    runArtDone = true;
    // Nothing more will ever be reported, and a gate's callback closes over its `LoadingScreen`.
    runListeners.clear();
  }));
  // The selected character's rig is awaited OUTSIDE that memo, and has to be: `loadRunArt`
  // waited for whichever character was selected when it ran, and a player who cycled character
  // in the forge afterwards must not cross the gate on the rig they are no longer playing.
  // Normally already settled — `setRunCharacterRig` starts it at the moment of the choice — so
  // this costs a microtask and no bytes. It is also why the bar can read full for an instant
  // before the gate opens: the count sizes the SHARED units, which is the honest thing for it
  // to report when the one outstanding unit is a rig chosen after the download began.
  return shared.then(() => ensureRig(characterRig));
}

async function loadRunArt(): Promise<void> {
  await ensurePacks(packsForPhase('run'), tickRun);
  // THE LOBBY TIER IS NOT AWAITED HERE, AND USED TO BE (2026-11-11). It sat on this line as
  // `await preloadUiTier('lobby')`, with the reasoning "a player cannot reach the run gate in
  // the time it takes". The Playgama sandbox measured that: `run_wait{art}` came back `pending`
  // in 113 of 113 sessions, because `firstRunAutostart.ts` opens the run gate within a frame of
  // `beginDeferredArt()` — the same frame `preloadLobbyArt` kicks this tier. So it was not
  // ahead of the player, it was in front of them: ~253 kB of the screen they had just left,
  // strictly serialised before the ~2.3 MB this gate is actually for, and the whole of it still
  // in flight. See design/22 §4.2.
  //
  // It is still downloading — `preloadLobbyArt` kicks it at boot and `preloadUiTier` memoises
  // per tier, so nothing here needs to start it. A key that lands after a menu is drawn reaches
  // that menu through `whenUiTexture`, which is how the `late` tier has always worked.
  await Promise.all([
    // The UI files no menu on the lobby draws — the other screens' icons, the floor-card and
    // result art, the damage digits. On WeChat they live in a `run`-phase pack (`ui-late`),
    // which is why this comes after `ensurePacks` above; either way the gate this promise
    // backs is what guarantees a run never starts without them.
    preloadUiTier('late').then(tickRun),
    // The enemy bodies the first floor fields, and the ONE character this run will draw — not
    // all seven rigs, which is what this line asked for until 2026-11-12. See `CORE_RIGS`.
    ensureRig(characterRig).then(tickRun),
    ...CORE_RIGS.map(([name]) => ensureRig(name).then(tickRun)),
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
  await Promise.all([preloadUiArt(), ensureRunArt(), ...CHAR_BUNDLES.map(([name]) => ensureRig(name))]);
}

/** Drops the phase memo. Tests only — module state outlives a single test file, and a resolved
 *  `runArt` promise from one test would make the next one's gate inert. */
export function resetPreloadArt(): void {
  deferred = false;
  runArt = null;
  runArtDone = false;
  runDone = 0;
  runListeners.clear();
  rigLoads.clear();
  rigDone.clear();
  characterRig = DEFAULT_CHARACTER_RIG;
}
