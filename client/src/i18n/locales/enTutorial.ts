// en.ts's `tutorial` table, split out so the canonical locale stays under the 500-line
// convention (2026-11-06, when the guide-arrow labels pushed it over). Part of `en`, nothing more:
// every other locale still keeps its `tutorial` table inline, typed against this one.
export const enTutorial = {
  step: 'STEP {n}/{of}',
  hintMoveKeys: 'Move with WASD.',
  hintMoveTouch: 'Drag the left side of the screen to move.',
  hintAttackKeys: 'Hold the left mouse button to attack — aiming is automatic.',
  hintAttackTouch: 'Hold the right side of the screen to attack — aiming is automatic.',
  hintSwapKeys: 'Press 1 or 2 to switch weapon.',
  hintSwapTouch: 'Tap a weapon button to switch weapon.',
  hintDeflect: 'Swing your melee weapon into incoming bullets to deflect them.',
  hintCleared: 'Nicely done — you know the basics.',
  skip: 'SKIP TUTORIAL',
  // The words under the guide arrow (`scene/NextRoomArrow.ts`): what the arrow means, and — until
  // the player has walked a little — which keys move, since a click only shoots.
  guideFoe: 'Enemies ahead — follow the red arrow',
  guideDoor: 'Room clear — follow the green arrow to the next room',
  guidePortal: "Floor clear — walk to the portal to choose what's next",
  guideMoveKeys: 'Move: WASD or arrow keys',
  guideMoveTouch: 'Move: drag the left side of the screen',
} as const;
