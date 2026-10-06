import { describe, expect, it } from 'vitest';
import {
  biomeIdAt,
  floorOffersDescend,
  floorOffersExtract,
  floorSourceAt,
  isBossFloor,
  isEndlessDungeon,
  lapFloorCount,
  type DungeonConfig,
} from '@dd/engine/world/dungeon';
import { CHAPTERS, CHAPTER_ORDER } from '@dd/engine/world/chapters';
import { EMBER_DUNGEON } from '@dd/engine/world/rooms/ember';
import { FROST_DUNGEON } from '@dd/engine/world/rooms/frost';
import { STORM_DUNGEON } from '@dd/engine/world/rooms/storm';
import { BLIGHT_DUNGEON } from '@dd/engine/world/rooms/blight';
import { ENDLESS_DUNGEON, ENDLESS_ROOMS } from '@dd/engine/world/rooms/endless';

const FINITE = CHAPTER_ORDER.filter((id) => id !== 'endless').map((id) => CHAPTERS[id].config);

describe('a finite dungeon is its own source, exactly as before the endless one existed', () => {
  it('every floor reads the config itself at the run’s own index', () => {
    for (const config of FINITE) {
      expect(isEndlessDungeon(config)).toBe(false);
      expect(lapFloorCount(config)).toBe(config.floorCount);
      for (let f = 0; f < config.floorCount; f++) {
        const src = floorSourceAt(config, f);
        expect(src.config).toBe(config);
        expect(src.floor).toBe(f);
        expect(biomeIdAt(config, f)).toBe(config.biomeId);
      }
    }
  });

  it('the last floor alone extracts, and is the only one that does not descend', () => {
    for (const config of FINITE) {
      const last = config.floorCount - 1;
      for (let f = 0; f < config.floorCount; f++) {
        expect(floorOffersExtract(config, f), `${config.biomeId} ${f}`).toBe(f === last);
        expect(floorOffersDescend(config, f), `${config.biomeId} ${f}`).toBe(f !== last);
        expect(isBossFloor(config, f)).toBe(f === last);
      }
    }
  });

  it('an endless field with no segments is still a finite dungeon', () => {
    const empty: DungeonConfig = { ...EMBER_DUNGEON, endless: { segments: [] } };
    expect(isEndlessDungeon(empty)).toBe(false);
    expect(floorSourceAt(empty, 3)).toEqual({ config: empty, floor: 3 });
    expect(floorOffersDescend(empty, 4)).toBe(false);
  });
});

describe('the Endless Descent cycles the four chapters, for ever', () => {
  it('is the four chapters in unlock order, one lap of 20 floors', () => {
    expect(isEndlessDungeon(ENDLESS_DUNGEON)).toBe(true);
    expect(ENDLESS_DUNGEON.endless!.segments).toEqual([EMBER_DUNGEON, FROST_DUNGEON, STORM_DUNGEON, BLIGHT_DUNGEON]);
    expect(lapFloorCount(ENDLESS_DUNGEON)).toBe(20);
    expect(ENDLESS_DUNGEON.floorCount).toBe(20);
  });

  it('floors 0-4 are ember’s, 5-9 frost’s, 10-14 storm’s, 15-19 blight’s, and floor 20 is ember’s first again', () => {
    const at = (f: number) => {
      const src = floorSourceAt(ENDLESS_DUNGEON, f);
      return `${src.config.biomeId}:${src.floor}`;
    };
    expect([0, 4, 5, 9, 10, 14, 15, 19].map(at)).toEqual([
      'ember:0', 'ember:4', 'frost:0', 'frost:4', 'storm:0', 'storm:4', 'blight:0', 'blight:4',
    ]);
    expect([20, 27, 39, 40, 113].map(at)).toEqual(['ember:0', 'frost:2', 'blight:4', 'ember:0', 'storm:3']);
    expect(biomeIdAt(ENDLESS_DUNGEON, 12)).toBe('storm');
    expect(biomeIdAt(ENDLESS_DUNGEON, 36)).toBe('blight');
  });

  it('every fifth floor is a boss floor offering both ways out; every other floor only descends', () => {
    for (let f = 0; f < 45; f++) {
      const boss = f % 5 === 4;
      expect(isBossFloor(ENDLESS_DUNGEON, f), `floor ${f}`).toBe(boss);
      expect(floorOffersExtract(ENDLESS_DUNGEON, f), `floor ${f}`).toBe(boss);
      expect(floorOffersDescend(ENDLESS_DUNGEON, f), `floor ${f}`).toBe(true);
    }
  });

  it('no segment is itself endless — a nested cycle would have no lap to count', () => {
    for (const seg of ENDLESS_DUNGEON.endless!.segments) expect(isEndlessDungeon(seg)).toBe(false);
  });

  it('every segment floor is authored, and every piece it names is in the endless library, once', () => {
    const ids = ENDLESS_ROOMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const lib = new Set(ids);
    for (let f = 0; f < lapFloorCount(ENDLESS_DUNGEON); f++) {
      const src = floorSourceAt(ENDLESS_DUNGEON, f);
      const maps = [src.config.floorMaps?.[src.floor], ...(src.config.floorLayoutVariants?.[src.floor] ?? [])];
      expect(maps[0], `floor ${f}`).toBeDefined();
      for (const map of maps) for (const room of map!.rooms) expect(lib.has(room.pieceId), room.pieceId).toBe(true);
    }
  });

  it('owns a steeper start than chapter 1 and plateaus material tiers at chapter 1’s deepest', () => {
    expect(ENDLESS_DUNGEON.difficultyCurve.base).toBeGreaterThan(EMBER_DUNGEON.difficultyCurve.base);
    expect(ENDLESS_DUNGEON.materialTierByDepth).toEqual([0, 1, 2, 3, 4]);
  });
});
