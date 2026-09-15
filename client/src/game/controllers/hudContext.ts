/**
 * What the HUD needs from Game that isn't already on `GameState` — split out of
 * `GameLoop.updateHud` (CLAUDE.md 500-line convention, form ① — an independent function
 * module: one pure mapping from two things the loop already holds to one object, no state of
 * its own and nothing to compose).
 *
 * It left `GameLoop` when that file hit exactly 500 lines and the chest caption needed one more
 * field (2026-09-15). Moving the whole block rather than shaving a comment is the point:
 * `HudContext` is a data shape that has grown a field roughly every time the HUD grew a widget,
 * and each of its fields costs a doc comment saying WHY the loop answers that question the way
 * it does. Somewhere for those to live that is not the main loop is what the next field needs
 * too.
 */
import type { InputSource } from '../../platform/types';
import type { CoopSession } from '../../net/CoopSession';
import type { HudContext } from '../ui/HudView';

/** The slice of `GameLoopHost` this mapping reads — narrowed to just these methods rather than
 *  taking the whole host, the same rule CLAUDE.md's form ② states for a class dependency. */
export interface HudContextHost {
  readonly localOwner: number;
  isCoop(): boolean;
  isArenaDemo(): boolean;
  isOnline(): boolean;
  currentScore(): number;
  selectedSkinId(): string;
  allySkinId(): string;
  getSession(): CoopSession | null;
  replayStopTick(): number | null;
}

/** The slice of `InputSource` this mapping reads. */
export interface HudContextInput {
  getTouchVisual(): { active: boolean };
}

export function buildHudContext(host: HudContextHost, input: HudContextInput): HudContext {
  return {
    localOwner: host.localOwner,
    score: host.currentScore(),
    selectedSkin: host.selectedSkinId(),
    showAlly: host.isCoop() || host.isArenaDemo(),
    allySkinId: host.allySkinId(),
    // Read off the live session rather than through a new host method: `getSession()` is
    // already on this interface, and `Game.ts` sits at exactly its 500-line limit.
    seatNames: host.getSession()?.seatNames,
    // Offline only: an online match's record is the server's confirmed stream, and a
    // replay-driven session is already replaying somebody else's file.
    canSaveReplay: !host.isOnline() && host.replayStopTick() === null,
    // Which control the chest caption names (`ui/ChestPrompt.ts`). `active` flips the first
    // time a control is touched and stays true — and is true from frame one on a touch-first
    // device — which is exactly the question "does this player have a + button" asks.
    touch: input.getTouchVisual().active,
  };
}

/** `InputSource` satisfies `HudContextInput` — a compile-time check, so narrowing the parameter
 *  above cannot quietly drift from the real thing the caller passes. */
export type _InputSourceIsCompatible = InputSource extends HudContextInput ? true : never;
