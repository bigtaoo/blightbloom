/**
 * Chapter trials — the chapter-vs-chapter half of the PvE level sim (2026-10-06, added with
 * chapter 2). Builds single-floor dungeons out of a chapter's own content so one floor, or one
 * boss, can be measured on equal footing in two chapters.
 *
 * Why the full-run sweep is not enough on its own: the careful bot reaches floor 1 in ~20% of
 * chapter-1 runs and the boss floor in none, so "is chapter 2's floor 3 harder than chapter 1's"
 * and "is Glacimaw a fight like Pyrefang" cannot be read off it at any seed count. A trial
 * starts a FRESH bot (full HP, starter kit, no buffs) on floor `k` at floor `k`'s own difficulty
 * scale, which is a different question from a run's — it says how hard the floor is, not how
 * hard it is to arrive there — and is labelled as such wherever it is printed.
 *
 * What a trial does NOT reproduce, on purpose or by cost: a real run's carried HP, buffs, floor
 * cards and looted guns; floor `k`'s loot rarity (every trial is floor index 0 to the engine, so
 * drops roll floor-0 tables — loot is not what a trial measures); and the branch layouts (a
 * trial plays each floor's main layout, the roster is identical across variants by contract).
 */
import {
  CHAPTERS,
  curveAt,
  ENEMY_BLUEPRINTS,
  type ChapterContent,
  type ChapterId,
  type DungeonFloorMap,
  type GameState,
  type RoomPiece,
} from '@dd/engine';
import { runLevel, type RunMetrics } from './levelSim';
import type { BOT_PROFILES } from './PveBotController';

/** The scale floor `floorIndex` of `chapter` spawns its mobs at (`buildEnemyActor`). */
export function floorScale(chapter: ChapterId, floorIndex: number): number {
  return curveAt(CHAPTERS[chapter].config.difficultyCurve, floorIndex);
}

/** A one-floor dungeon that is `chapter`'s floor `floorIndex`, main layout, at that floor's
 *  scale — or at `scale`, the control that separates a chapter's CONTENT from its curve. */
export function floorTrial(chapter: ChapterId, floorIndex: number, scale = floorScale(chapter, floorIndex)): ChapterContent {
  const { config, library } = CHAPTERS[chapter];
  const map = config.floorMaps?.[floorIndex];
  if (!map) throw new Error(`floorTrial: ${chapter} has no authored floor ${floorIndex}`);
  return singleFloor(chapter, map, library, scale);
}

export interface BossTrialSpec {
  /** Whose boss ROOM (geometry, garrison) the fight is staged in. */
  room: ChapterId;
  /** Blueprint id of the boss placed on the room's boss spawn (replaces `boss_random` too). */
  boss: string;
  /** Whose boss-floor difficulty scale the room spawns at. Defaults to `room`'s. */
  scaleOf?: ChapterId;
  /** Keep the room's garrison of adds (the real fight) or strip it (the boss alone — the
   *  only way every point of damage taken is attributable to the boss). */
  adds: boolean;
}

/**
 * The boss room of a chapter's last floor, entered the way a run enters it: through its real
 * door from the room before it, which is kept but EMPTIED (no enemies, no chests, no shop), so
 * the bot walks in, the door locks behind it and the fight starts at the same doorway a player
 * starts it at. The boss room must be the floor's LAST room — `ExtractionSystem` reads the
 * capstone as `dungeonRoomRuntime[last]`, and it is the last in both chapters' JSON.
 */
export function bossTrial(spec: BossTrialSpec): ChapterContent {
  const { config, library } = CHAPTERS[spec.room];
  const lastFloor = config.floorCount - 1;
  const floor = config.floorMaps?.[lastFloor];
  if (!floor) throw new Error(`bossTrial: ${spec.room} has no authored boss floor`);
  const bossRoom = floor.rooms[floor.rooms.length - 1]!;
  const door = floor.doors.find((d) => d.roomA === bossRoom.id || d.roomB === bossRoom.id);
  if (!door) throw new Error(`bossTrial: ${spec.room}'s boss room has no door`);
  const anteId = door.roomA === bossRoom.id ? door.roomB : door.roomA;
  const ante = floor.rooms.find((r) => r.id === anteId)!;

  const piece = (id: string) => library.find((p) => p.id === id)!;
  const anteSrc = piece(ante.pieceId);
  const bossSrc = piece(bossRoom.pieceId);
  const antePiece: RoomPiece = { ...anteSrc, id: `${anteSrc.id}__trial`, spawns: { ...anteSrc.spawns, enemy: [] } };
  delete (antePiece as { chests?: unknown }).chests;
  delete (antePiece as { shops?: unknown }).shops;
  const isBossSpawn = (type: string | undefined) => type === 'boss_random' || (type !== undefined && ENEMY_BLUEPRINTS[type]?.boss === true);
  const bossSpawns = bossSrc.spawns.enemy.filter((e) => isBossSpawn(e.type));
  if (bossSpawns.length !== 1) throw new Error(`bossTrial: ${bossSrc.id} has ${bossSpawns.length} boss spawns, expected 1`);
  const enemy = bossSrc.spawns.enemy
    .filter((e) => spec.adds || isBossSpawn(e.type))
    .map((e) => (isBossSpawn(e.type) ? { ...e, type: spec.boss } : e));
  const bossPiece: RoomPiece = { ...bossSrc, id: `${bossSrc.id}__trial`, spawns: { ...bossSrc.spawns, enemy } };

  const map: DungeonFloorMap = {
    id: `${floor.id}__boss_trial`,
    rooms: [
      { ...ante, pieceId: antePiece.id },
      { ...bossRoom, pieceId: bossPiece.id },
    ],
    doors: [door],
  };
  const scale = floorScale(spec.scaleOf ?? spec.room, lastFloor);
  return singleFloor(spec.room, map, [...library, antePiece, bossPiece], scale);
}

function singleFloor(chapter: ChapterId, map: DungeonFloorMap, library: readonly RoomPiece[], scale: number): ChapterContent {
  // Spread then drop the variant table: a trial floor is index 0, and a variant entry for
  // index 0 would replace the map with one of the chapter's own.
  const { floorLayoutVariants: _variants, ...config } = CHAPTERS[chapter].config;
  void _variants;
  return {
    library,
    config: { ...config, floorCount: 1, floorMaps: { 0: map }, difficultyCurve: { base: scale, perFloor: 0 } },
  };
}

// ── Running a boss trial ─────────────────────────────────────────────────────────

export interface BossTrialRun {
  seed: number;
  boss: string;
  /** The run as the level sim saw it — outcome `extracted` means the room was cleared. */
  run: RunMetrics;
  /** The boss's spawned max HP (blueprint × scale, rounded — what the player has to chew). */
  bossMaxHp: number;
  /** Ticks from the boss room's activation to the boss's death; null if it never died. */
  ttkTicks: number | null;
  /** Damage the player took from activation until the boss died (or the run ended). */
  fightDamage: number;
  /** The player's effective pool, for reading `fightDamage` against. */
  effectiveHp: number;
  /** Boss HP left when the run ended, as a fraction — 0 when killed. */
  bossHpLeftFrac: number;
  /** Share of fight ticks the player spent chilled — Glacimaw's whole mechanic. */
  chilledFrac: number;
  /** Share of fight ticks the player carried at least one poison stack — Rotbloom's. */
  poisonedFrac: number;
  playerDied: boolean;
}

export function runBossTrial(seed: number, spec: BossTrialSpec, profileName: keyof typeof BOT_PROFILES = 'careful'): BossTrialRun {
  const dungeon = bossTrial(spec);
  let bossId: number | null = null;
  let bossMaxHp = 0;
  let bossHp = 0;
  let start: number | null = null;
  let killedAt: number | null = null;
  let fightDamage = 0;
  let fightTicks = 0;
  let chilledTicks = 0;
  let poisonedTicks = 0;
  const onTick = (s: GameState): void => {
    const roomIdx = s.dungeonRooms.length - 1;
    if (start === null && s.dungeonRoomRuntime[roomIdx]?.activated) start = s.tick;
    if (bossId === null) {
      const b = s.enemies.find((e) => e.boss && e.alive);
      if (b) {
        bossId = b.id;
        bossMaxHp = b.maxHp;
        bossHp = b.hp;
      }
    }
    if (start === null || killedAt !== null) return;
    const b = s.enemies.find((e) => e.id === bossId);
    bossHp = b && b.alive ? b.hp : 0;
    const p = s.players[0]!;
    for (const ev of s.events) if (ev.type === 'hit' && ev.target === p.id) fightDamage += ev.damage;
    if (p.alive) {
      fightTicks++;
      if (p.status.chillTicks > 0) chilledTicks++;
      if (p.status.poison.length > 0) poisonedTicks++;
    }
    if (bossId !== null && bossHp <= 0) killedAt = s.tick;
  };
  const run = runLevel({ seed, profileName, dungeon, onTick });
  return {
    seed,
    boss: spec.boss,
    run,
    bossMaxHp,
    ttkTicks: killedAt !== null && start !== null ? killedAt - start : null,
    fightDamage,
    effectiveHp: run.effectiveHp,
    bossHpLeftFrac: bossMaxHp > 0 ? Math.max(0, bossHp) / bossMaxHp : 1,
    chilledFrac: fightTicks > 0 ? chilledTicks / fightTicks : 0,
    poisonedFrac: fightTicks > 0 ? poisonedTicks / fightTicks : 0,
    playerDied: run.outcome === 'died',
  };
}
