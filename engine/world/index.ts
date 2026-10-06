// World data (design/09): dungeon assembly config/generator + the hand-authored
// RoomPiece library. Wired live (ROADMAP 1.3): SpawnSystem generates + traverses
// floors when a config opts into `dungeon` — see world/dungeon.ts's module doc.
export * from './dungeon';
export * from './rooms/ember';
export * from './rooms/emberLevel1';
export * from './rooms/frost';
export * from './chapters';
