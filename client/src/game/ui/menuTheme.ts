// The menu shell's design tokens (design/10 "One shell for every menu", 2026-09-27): the
// colours, type ramp and button presets every screen outside the lobby draws with, so the doors
// out of the lobby read as the same place the lobby is.
//
// Values are lifted from what the lobby already shipped rather than invented: the night-blue
// card fill and the chip border are `AccountCard`'s and the SETTINGS chip's, the go-green is
// every primary action's since 2026-08-02, and the crystal cyan is the dais glow's (design/13
// reserves that hue for purified-crystal light, which is what the sheet's frame is meant to
// echo).
import type { TextStyleOptions } from 'pixi.js';

export const MENU_COLORS = {
  /** The framed sheet's body, and the fill every chip and field is drawn in. */
  sheet: 0x0b1220,
  sheetAlpha: 0.86,
  /** The sheet's frame: the dais crystal's cyan, and its softer inner hairline. */
  frame: 0x7fd8ff,
  frameInner: 0x2c4a66,
  /** A field or a secondary control's body. */
  field: 0x141d2e,
  fieldBorder: 0x3a4d66,
  fieldFocus: 0x7fd8ff,
  /** The corner chips' body and border (lobby SETTINGS). */
  chip: 0x1f2532,
  chipBorder: 0x718096,
  /** Type. */
  text: 0xf7fafc,
  textSoft: 0xcbd5e0,
  textMuted: 0x8fa2b8,
  link: 0x90cdf4,
  accent: 0x90cdf4,
  error: 0xfc8181,
  success: 0x9ae6b4,
  warn: 0xfbd38d,
  /** Actions: go, secondary, destructive. */
  go: 0x2f855a,
  goBorder: 0x9ae6b4,
  second: 0x243044,
  secondBorder: 0x5a7394,
  danger: 0x742a2a,
  dangerBorder: 0xfc8181,
  /** PvP's red: the lobby's PVP card, and the one action that enters a PvP queue. */
  pvp: 0x9b2c2c,
  /** The outline every label is stroked with so it reads over the painting. */
  outline: 0x0b0e14,
} as const;

/**
 * The type ramp. Labels and headings stay monospace for the same reason every `Button` label
 * is: the layouts here fit text from `textWidth.ts`'s monospace estimate, which is only honest
 * for a monospace font. Prose (`body`, `caption`) is sans-serif and word-wrapped by Pixi.
 */
export type MenuTextRole = 'title' | 'heading' | 'label' | 'value' | 'body' | 'caption';

const ROLE_STYLES: Record<MenuTextRole, TextStyleOptions> = {
  title: { fill: MENU_COLORS.text, fontSize: 28, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 2, padding: 16, stroke: { color: MENU_COLORS.outline, width: 5 } },
  heading: { fill: MENU_COLORS.accent, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: 1, padding: 12 },
  label: { fill: MENU_COLORS.textSoft, fontSize: 13, fontFamily: 'monospace', fontWeight: 'bold', padding: 12 },
  value: { fill: MENU_COLORS.text, fontSize: 16, fontFamily: 'monospace', fontWeight: 'bold', padding: 12 },
  body: { fill: MENU_COLORS.textSoft, fontSize: 14, fontFamily: 'sans-serif', lineHeight: 20, padding: 12, wordWrap: true, breakWords: true },
  caption: { fill: MENU_COLORS.textMuted, fontSize: 11, fontFamily: 'sans-serif', lineHeight: 15, padding: 10, wordWrap: true, breakWords: true },
};

/** A fresh style object for a role, with any overrides — fresh so a caller can mutate its own
 *  `wordWrapWidth` without retuning every other text of that role. */
export function menuText(role: MenuTextRole, overrides: TextStyleOptions = {}): TextStyleOptions {
  return { ...ROLE_STYLES[role], ...overrides };
}

/** `Button` option presets: the one primary per screen, the ordinary action, the destructive
 *  one, the PvP queue's primary, and the corner chrome (BACK, SETTINGS) — spread into a
 *  `Button`'s opts. */
export const MENU_BUTTONS = {
  primary: { color: MENU_COLORS.go, borderColor: MENU_COLORS.goBorder },
  secondary: { color: MENU_COLORS.second, borderColor: MENU_COLORS.secondBorder },
  danger: { color: MENU_COLORS.danger, borderColor: MENU_COLORS.dangerBorder },
  pvp: { color: MENU_COLORS.pvp, borderColor: MENU_COLORS.dangerBorder },
  chrome: { color: MENU_COLORS.chip, borderColor: MENU_COLORS.chipBorder },
} as const;

/** How dark the painting is behind a menu sheet (`LobbyBackdrop`'s `dim`). */
export const MENU_BACKDROP_DIM = 0.5;
