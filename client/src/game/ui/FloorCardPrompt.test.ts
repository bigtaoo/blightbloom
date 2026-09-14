/**
 * `FloorCardPrompt` — the checkpoint's three-card offer (design/05/10,
 * ENGINE_VERSION 58).
 *
 * Headless: the panel is built and driven directly, with a synthetic `GameState`-shaped
 * object, so no browser and no real engine run are needed (the same convention
 * `WeaponPickupPrompt.test.ts`/`PortalPrompt.test.ts` use). What is worth pinning here is
 * everything a player READS off the panel — the card text, whose vote is whose, and which
 * card is drawn as chosen — because all of it is derived from state rather than stored,
 * and none of it would go red on its own if the derivation drifted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { GameState } from '@dd/engine';
import { FLOOR_CARDS, RUN_BUFFS } from '@dd/engine';
import { FloorCardPrompt } from './FloorCardPrompt';
import { setLocale, resetLocaleForTests, t } from '../../i18n';

afterEach(() => resetLocaleForTests());

/** The slice of GameState this panel actually reads. */
function state(offer: string[], votes: number[]): GameState {
  return {
    floorCardOffer: offer,
    players: votes.map((cardVote) => ({ cardVote })),
  } as unknown as GameState;
}

function privateOf(p: FloorCardPrompt) {
  return p as unknown as {
    titleText: { text: string };
    cards: Array<{ view: { visible: boolean }; onTap: (() => void) | null; setText(s: string): void }>;
    tallies: Array<{ text: string; visible: boolean }>;
  };
}

/** The label text currently on each visible card. */
function labels(p: FloorCardPrompt): string[] {
  const inner = p as unknown as { cards: Array<{ view: { visible: boolean }; label?: { text: string } }> };
  return inner.cards
    .filter((c) => c.view.visible)
    .map((c) => (c as unknown as { label: { text: string } }).label.text);
}

describe('visibility follows the offer, not just the checkpoint', () => {
  it('is hidden when the caller says the floor is not finished', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [0]), false, 0);
    expect(p.isOpen).toBe(false);
    expect(p.view.visible).toBe(false);
  });

  it('is hidden at a checkpoint with an EMPTY offer — the last floor has no card', () => {
    // The last floor reaches a checkpoint and opens a portal, but never rolls an offer.
    // Drawing three dead slots there would promise a choice that does not exist.
    const p = new FloorCardPrompt();
    p.update(state([], [0]), true, 0);
    expect(p.isOpen).toBe(false);
  });

  it('opens with one card per offered id', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [0]), true, 0);
    expect(p.isOpen).toBe(true);
    expect(labels(p)).toHaveLength(3);
  });

  it('hides the spare slots for a short offer instead of drawing blanks', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence'], [0]), true, 0);
    expect(labels(p)).toHaveLength(2);
    expect(privateOf(p).cards[2]!.view.visible).toBe(false);
    expect(privateOf(p).tallies[2]!.visible).toBe(false);
  });
});

describe('what the cards say', () => {
  it('shows each card’s translated name and description', () => {
    const p = new FloorCardPrompt();
    p.update(state(['potion_flow', 'windfall', 'edge'], [0]), true, 0);
    const text = labels(p).join('|');
    expect(text).toContain(t(FLOOR_CARDS.potion_flow!.nameKey as never));
    expect(text).toContain(t(FLOOR_CARDS.windfall!.nameKey as never));
  });

  it('interpolates the REAL catalogue numbers, not hardcoded copies of them', () => {
    // The drift guard: `dmg_up` is +50% today. If it is retuned, the card has to say the
    // new figure — a literal "50" baked into eight locale files would not.
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'precision'], [0]), true, 0);
    const text = labels(p).join('|');
    expect(text).toContain(String(RUN_BUFFS.dmg_up!.value / 10));
    expect(text).toContain(String(RUN_BUFFS.rof_up!.value / 10));
    expect(text).toContain(String(RUN_BUFFS.crit_up!.value / 10));
    expect(text).not.toContain(String(RUN_BUFFS.dmg_up!.value)); // the raw per-mille never leaks
  });

  it('shows a max-HP card in absolute points, not as a percentage of anything', () => {
    const p = new FloorCardPrompt();
    p.update(state(['bulwark', 'edge', 'cadence'], [0]), true, 0);
    expect(labels(p)[0]).toContain(String(RUN_BUFFS.vit_up!.value));
  });

  it('falls back to the raw id for a card this client does not know', () => {
    // Only reachable against a sim newer than the client. An empty card would be worse:
    // the player can still pick this one, and the sim still applies it correctly.
    const p = new FloorCardPrompt();
    p.update(state(['card_from_the_future', 'edge', 'cadence'], [0]), true, 0);
    expect(labels(p)[0]).toBe('card_from_the_future');
  });

  it('re-renders on a locale change even though the offer did not move', () => {
    const p = new FloorCardPrompt();
    const s = state(['edge', 'cadence', 'bulwark'], [0]);
    p.update(s, true, 0);
    const en = labels(p).join('|');
    setLocale('zh');
    p.update(s, true, 0);
    expect(labels(p).join('|')).not.toBe(en);
  });
});

describe('the vote tally is what makes the majority rule visible', () => {
  it('reports a tap as a 1-based slot into the offer', () => {
    const p = new FloorCardPrompt();
    const votes: number[] = [];
    p.onVote = (slot) => votes.push(slot);
    p.update(state(['edge', 'cadence', 'bulwark'], [0]), true, 0);
    privateOf(p).cards[0]!.onTap?.();
    privateOf(p).cards[2]!.onTap?.();
    expect(votes).toEqual([1, 3]);
  });

  it('counts each seat’s vote under the card it went to', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [2, 2, 3]), true, 0);
    const tallies = privateOf(p).tallies.map((x) => x.text);
    expect(tallies[0]).toBe(''); // nobody chose the first card
    expect(tallies[1]).toContain('2');
    expect(tallies[2]).toContain('1');
  });

  it('hides the counts in solo play, where there is no majority to resolve', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [1]), true, 0);
    expect(privateOf(p).tallies.map((x) => x.text)).toEqual(['', '', '']);
  });

  it('does not count an abstaining seat under any card', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [0, 0, 1]), true, 0);
    expect(privateOf(p).tallies[0]!).toMatchObject({ text: expect.stringContaining('1') });
    expect(privateOf(p).tallies[1]!.text).toBe('');
  });

  it('redraws when a teammate changes their vote and nothing else moved', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [1, 1]), true, 0);
    const before = privateOf(p).tallies.map((x) => x.text);
    p.update(state(['edge', 'cadence', 'bulwark'], [1, 2]), true, 0);
    expect(privateOf(p).tallies.map((x) => x.text)).not.toEqual(before);
  });
});

describe('the local seat’s own pick reads as selected', () => {
  /** Border colour of each card box, which is what marks the selected one. */
  const borders = (p: FloorCardPrompt) =>
    (p as unknown as { cards: Array<{ borderColor: number }> }).cards.map((c) => c.borderColor);

  it('highlights exactly the card this seat voted for', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [2]), true, 0);
    const [a, b, c] = borders(p);
    expect(b).not.toBe(a);
    expect(c).toBe(a);
  });

  it('reads the LOCAL seat, not seat 0 — a client is not always the host', () => {
    const p = new FloorCardPrompt();
    // Seat 0 voted for card 1, seat 1 (the local one here) for card 3.
    p.update(state(['edge', 'cadence', 'bulwark'], [1, 3]), true, 1);
    const [a, b, c] = borders(p);
    expect(c).not.toBe(a);
    expect(b).toBe(a);
  });

  it('highlights nothing before this seat has chosen', () => {
    const p = new FloorCardPrompt();
    p.update(state(['edge', 'cadence', 'bulwark'], [0, 2]), true, 0);
    expect(new Set(borders(p)).size).toBe(1);
  });
});

describe('layout and press handling', () => {
  it('repositions without a resize throwing, at a narrow viewport too', () => {
    const p = new FloorCardPrompt();
    p.reposition({ w: 1280, h: 720 });
    p.reposition({ w: 480, h: 320 });
    // Never off the top of a short screen: the panel is clamped rather than floated
    // above the portal popup at whatever negative offset the arithmetic produces.
    const panelY = (p as unknown as { panel: { view: { y: number } } }).panel.view.y;
    expect(panelY).toBeGreaterThanOrEqual(0);
  });

  it('reports a press on the panel so the tap cannot also fire a shot', () => {
    const p = new FloorCardPrompt();
    let presses = 0;
    p.onPressStart = () => presses++;
    // The capture-phase handler the constructor registers — `WebInput` sets `firing`
    // from a raw mousedown, so a Pixi button consuming the event is not enough.
    (p.view as unknown as { emit(e: string): void }).emit('pointerdowncapture');
    expect(presses).toBe(1);
  });
});
