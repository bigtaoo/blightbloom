import { Container, Text } from 'pixi.js';
import { type SeatNames } from '@dd/engine';
import { estimateMonoWidth } from './textWidth';
import { t } from '../../i18n';

/**
 * Who else is in this match, by name (design/20 — a game portal requires that the
 * platform's own usernames be shown in-game "so players can recognise their friends").
 *
 * One line, in the HUD's existing left-hand column, shown only during an online match in
 * which at least one seat has a name. Three decisions worth stating, because each closes an
 * obvious-looking alternative:
 *
 * - **A line, not nameplates over the actors.** A nameplate has to track a world position
 *   through the camera every frame and then fight the occlusion x-ray for legibility
 *   (`scene/occlusion.ts`), and at this game's zoom a four-seat PvP room would be four
 *   labels over four 20-pixel sprites. A roster answers "who am I playing with" once.
 * - **Unnamed seats are OMITTED, not filled in.** A guest and a bot have no name, and
 *   `P3`/`Player 3` would be a name this game invented and then showed to other people as
 *   if it were theirs.
 * - **It is not the ally row.** `AllyRow` (PlayerCard.ts) is only drawn for a LOCAL bot
 *   ally or the arena harness (`HudContext.showAlly` is `isCoop() || isArenaDemo()`, and
 *   an online co-op match sets neither), so a name put there would never be seen online —
 *   which is the only place a name exists.
 */
export class SeatRoster {
  readonly view = new Container();
  static readonly HEIGHT = 16;
  private static readonly FONT_SIZE = 11;
  private readonly line: Text;

  constructor() {
    this.line = new Text({
      text: '',
      style: {
        fill: 0xa0c4e8,
        fontSize: SeatRoster.FONT_SIZE,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        // `padding` guards the font-metrics clipping bug widgets.ts documents.
        padding: 6,
      },
    });
    this.view.addChild(this.line);
  }

  /**
   * `names` is the server's seat → name map (`MatchStart.names`). `localOwner` is this
   * client's own seat, marked so a player can find themselves in a list of strangers.
   *
   * Returns whether anything is drawn, so the caller's layout can skip the row entirely
   * rather than reserving space for an empty line.
   */
  set(names: SeatNames | undefined, localOwner: number): boolean {
    const parts: string[] = [];
    names?.forEach((name, owner) => {
      if (!name) return;
      parts.push(owner === localOwner ? `${t('hud.roster.you')} ${name}` : name);
    });
    this.line.text = parts.join('  ·  ');
    const any = parts.length > 0;
    this.view.visible = any;
    return any;
  }

  estimatedWidth(): number {
    return estimateMonoWidth(this.line.text, SeatRoster.FONT_SIZE);
  }

  /** Test seam — see StatChip's own. */
  get text(): string {
    return this.line.text;
  }
}
