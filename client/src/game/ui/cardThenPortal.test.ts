/**
 * Cards first, then the portal (2026-10-13) — the seam between what the two checkpoint
 * panels SHOW and what `ExtractionSystem` ACCEPTS.
 *
 * Each side is pinned on its own already: `floorCardCheckpoint.test.ts` holds a descend
 * with no vote behind it, `PortalPrompt.test.ts` hides Descend when told to, and
 * `checkpointOverlays.test.ts` passes the card panel's answer along with fake views. What
 * none of them can see is whether the two halves agree, which is exactly how the old
 * layout broke: a live-looking Descend button the engine silently ignored. So this runs a
 * real engine, the real panels and the real overlay pass together, wires the panels'
 * taps to real commands, and asserts the agreement every tick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import { Button } from '@dd/engine/state/commands';
import type { Brad } from '@dd/engine/math/trig';
import { fpToPx } from '../coords';
import { updateCheckpointOverlays } from '../controllers/checkpointOverlays';
import { FloorCardPrompt } from './FloorCardPrompt';
import { PortalPrompt } from './PortalPrompt';
import { resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

/** Two floors of empty waves: floor 0's checkpoint opens on tick 1 with a card offer. */
const CFG: EngineConfig = { seed: 9, worldW: 800, worldH: 600, waves: [], floors: [[]] };

interface Pending { buttons: number; cardVote: number }

function privateOf(cards: FloorCardPrompt, portal: PortalPrompt) {
  const c = cards as unknown as {
    cards: Array<{ onTap: (() => void) | null; view: { visible: boolean } }>;
    changeBtn: { onTap: (() => void) | null; view: { visible: boolean } };
  };
  const p = portal as unknown as { descendBtn: { onTap: (() => void) | null; view: { visible: boolean } } };
  return {
    cards: c.cards,
    change: c.changeBtn,
    descend: p.descendBtn,
    /** Drawn, not just flagged: a closed panel returns early and leaves its buttons' own
     *  `visible` as it was, so the flag alone reads true over a panel nobody can see. */
    descendShown: () => portal.isOpen && p.descendBtn.view.visible,
    changeShown: () => cards.isOpen && c.changeBtn.view.visible,
  };
}

/**
 * A rig: `seats` players parked at floor 0's checkpoint, seat `me` standing on the portal,
 * with the panels' taps queued into the next tick's command the way `Game` routes them.
 */
function rig(seats = 1, me = 0) {
  const eng = createGameEngine({
    ...CFG,
    players: Array.from({ length: seats }, () => ({ start: [100, 100] as [number, number] })),
  });
  const cardPrompt = new FloorCardPrompt();
  const portalPrompt = new PortalPrompt();
  const pending: Pending[] = Array.from({ length: seats }, () => ({ buttons: 0, cardVote: 0 }));
  cardPrompt.onVote = (slot) => { pending[me]!.cardVote = slot; };
  portalPrompt.onDescend = () => { pending[me]!.buttons |= Button.CONFIRM_DESCEND; };
  const self = eng.state.players[me]!;
  const deps = {
    roomBuilder: { setPortalOpen: () => {}, portalPx: { x: fpToPx(self.gx), y: fpToPx(self.gy) } },
    portalPrompt,
    floorCardPrompt: cardPrompt,
    suppressFire: () => {},
  } as never;

  /** One tick: send what was queued, then run the overlay pass on the result. */
  const step = () => {
    const tick = eng.state.tick + 1;
    eng.step(pending.map((q, owner) => makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, ...q })));
    for (const q of pending) { q.buttons = 0; q.cardVote = 0; }
    updateCheckpointOverlays(eng.state, me, deps);
    // The invariant the whole change is for: a Descend button on screen is one the
    // engine will take. (The converse is deliberately NOT asserted: in co-op a
    // teammate's vote is enough for the engine, but this seat still picks first.)
    if (ui.descendShown()) expect(eng.state.players.some((p) => p.cardVote > 0)).toBe(true);
  };
  const ui = privateOf(cardPrompt, portalPrompt);
  step();
  return { eng, cardPrompt, portalPrompt, pending, ui, step };
}

describe('the button on screen is the press the engine takes', () => {
  it('shows the cards alone until a vote, and the engine holds a descend meanwhile', () => {
    const r = rig();
    expect(r.cardPrompt.isPicking).toBe(true);
    expect(r.portalPrompt.isOpen).toBe(false);
    expect(r.ui.descendShown()).toBe(false);
    // The press the old layout offered: sent anyway, it still goes nowhere.
    r.pending[0]!.buttons = Button.CONFIRM_DESCEND;
    for (let i = 0; i < 5; i++) r.step();
    expect(r.eng.state.floorIndex).toBe(0);
  });

  it('a card tap brings up Descend, and tapping it descends with that card', () => {
    const r = rig();
    const chosen = r.eng.state.floorCardOffer[1]!;
    r.ui.cards[1]!.onTap!();
    r.step();
    expect(r.cardPrompt.isPicking).toBe(false);
    expect(r.ui.changeShown()).toBe(true);
    expect(r.ui.descendShown()).toBe(true);
    r.ui.descend.onTap!();
    r.step();
    expect(r.eng.state.floorIndex).toBe(1);
    expect(r.eng.state.floorCards).toEqual([chosen]);
  });

  it('Change hides Descend again, and the second pick is the card that lands', () => {
    const r = rig();
    const second = r.eng.state.floorCardOffer[2]!;
    r.ui.cards[0]!.onTap!();
    r.step();
    r.ui.change.onTap!();
    r.step();
    expect(r.cardPrompt.isPicking).toBe(true);
    expect(r.ui.descendShown()).toBe(false);
    r.ui.cards[2]!.onTap!();
    r.step();
    expect(r.ui.descendShown()).toBe(true);
    r.ui.descend.onTap!();
    r.step();
    expect(r.eng.state.floorCards).toEqual([second]);
  });

  it('closes both panels once the descend is taken', () => {
    const r = rig();
    r.ui.cards[0]!.onTap!();
    r.step();
    r.ui.descend.onTap!();
    r.step();
    expect(r.cardPrompt.isOpen).toBe(false);
    expect(r.portalPrompt.isOpen).toBe(false);
  });
});

describe('co-op: a teammate’s vote does not pick for me', () => {
  it('keeps my cards up after a teammate votes, then lets me descend on my own pick', () => {
    const r = rig(2, 0);
    r.pending[1]!.cardVote = 3; // the teammate votes; I have not
    r.step();
    expect(r.eng.state.players[1]!.cardVote).toBe(3);
    expect(r.cardPrompt.isPicking).toBe(true);
    expect(r.ui.descendShown()).toBe(false);
    r.ui.cards[0]!.onTap!();
    r.step();
    expect(r.cardPrompt.isPicking).toBe(false);
    expect(r.ui.descendShown()).toBe(true);
  });
});
