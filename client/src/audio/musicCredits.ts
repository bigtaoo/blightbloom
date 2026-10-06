// The in-game music attribution (design/11 "Music & ambience"): who wrote each shipped loop, and
// the exact line the Settings screen shows for it.
//
// WHY THIS EXISTS AT ALL. Until 2026-10-06 nothing in the game needed a credit: every SFX pack
// is CC0 and the two music masters were AI-generated. The loops that replaced them are openly
// licensed music written by people, and three of the four are CC-BY, whose one condition is
// that the work is credited where the people using it can see it. A credit kept only in
// `art/audio/credits.json` is not that. Settings is the one screen every target (web, the game
// portal, WeChat) can open, and plain text needs no outbound link, which WeChat cannot follow.
//
// The lines are NOT translated: a title, a name and a licence are proper nouns, and the licence
// asks for them as written. Only the section label above them is (`settings.musicCredits`).
//
// `musicAssets.test.ts` holds every field here equal to the provenance record in
// `art/audio/credits.json`, so the credit cannot drift from the file that actually ships.
import type { MusicTrack } from '../platform/types';
import { ALL_TRACKS } from './musicCatalogue';

/** The licences a shipped loop may carry. CC0 and CC-BY only: both allow commercial use and an
 *  edited loop. NC is excluded because the game earns from ads, ND because cutting a loop region
 *  is an adaptation. */
export type MusicLicense = 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-3.0';

export interface MusicCredit {
  title: string;
  author: string;
  license: MusicLicense;
  /** The full credit line, shown verbatim. */
  line: string;
}

/** Exhaustive, like `MUSIC_CATALOGUE`: a track cannot ship without a credit decision. */
export const MUSIC_CREDITS: Record<MusicTrack, MusicCredit> = {
  // The author's own requested format, from his library's licensing page.
  menu: {
    title: 'Aurora',
    author: 'Scott Buckley',
    license: 'CC-BY-4.0',
    line: "'Aurora' by Scott Buckley - released under CC-BY 4.0. www.scottbuckley.com.au",
  },
  'dungeon.ember': {
    title: 'Lava Area Theme',
    author: 'Wolfgang_',
    license: 'CC-BY-4.0',
    line: "'Lava Area Theme' by Wolfgang_ - CC-BY 4.0 - opengameart.org/content/lava-area-theme",
  },
  // CC0 asks for no credit. It gets one anyway: a list of composers with one missing reads as
  // an omission, not as a licence decision.
  'dungeon.frost': {
    title: 'Beyond the Frozen Veil',
    author: 'Synth-thetic',
    license: 'CC0-1.0',
    line: "'Beyond the Frozen Veil' by Synth-thetic - CC0 - opengameart.org/content/beyond-the-frozen-veil",
  },
  boss: {
    title: 'Colossal Boss Battle Theme',
    author: 'Matthew Pablo',
    license: 'CC-BY-3.0',
    line: "'Colossal Boss Battle Theme' by Matthew Pablo - CC-BY 3.0 - opengameart.org/content/colossal-boss-battle-theme",
  },
};

/** The credit lines in track order, one per distinct line. Distinct because a track that
 *  borrows another's file (`TrackDef.borrowedFrom`) plays that file's music, not its own. */
export function musicCreditLines(): string[] {
  return [...new Set(ALL_TRACKS.map((t) => MUSIC_CREDITS[t].line))];
}
