import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { TextInputOverlay } from '../ui/TextInputOverlay';
import * as partyApi from '../../net/party';
import type { PartyInfo } from '../../net/party';
import { getPlayerId } from '../../net/identity';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';
import { setPartyPresence } from '../../platform/partyPresence';
import { SQUAD_SIZE } from '../match/pvpConfig';

/** The party network calls this screen needs — injected (default: the real
 * `net/party.ts` functions) so tests can drive it with a fake, same DI convention as
 * `Matchmaker`/`PartyService`/`findMatch` elsewhere in this project. */
export interface PartyApi {
  createParty: typeof partyApi.createParty;
  joinParty: typeof partyApi.joinParty;
  leaveParty: typeof partyApi.leaveParty;
  startPartyMatching: typeof partyApi.startPartyMatching;
  getParty: typeof partyApi.getParty;
}

/**
 * PvP pre-formed squad lobby (design/05/15's squad follow-up — the never-built
 * "friends queue together" front door). Pure presentation + its own polling loop,
 * same shape as Forge.ts/Screens.ts: Game.ts owns what `onStartMatch` actually does
 * (hand off to the existing `connectOnlineSession` PvP path with this partyId).
 *
 * No account system backs "playerId" (none exists anywhere in this project, see
 * `net/identity.ts`'s own note) — it's a random id generated once and persisted
 * locally. A join "code" is a short human-typeable string, separate from the
 * internal `partyId`, entered via `TextInputOverlay` (Pixi has no native text input).
 */
export class PartyScreen {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.85, background: 'hub' });
  private title: Text;
  private codeText: Text;
  private membersText: Text;
  private statusText: Text;
  private createBtn: Button;
  private joinBtn: Button;
  private startBtn: Button;
  private leaveBtn: Button;
  private backBtn: Button;
  private inputOverlay = new TextInputOverlay();

  private readonly matchBaseUrl: string;
  private readonly playerId: string;
  private readonly api: PartyApi;
  private party: PartyInfo | null = null;
  private busy = false; // in-flight create/join/start/leave call guard — no double-fire
  private pollAccMs = 0;
  private static readonly POLL_INTERVAL_MS = 1000;
  // Guards a stale create/join/start/poll continuation from acting after the player has
  // already backed out (`hide()` bumps this) — same `attemptToken` convention
  // Matchmaking.ts already uses. Before this existed, a leader who tapped START then
  // immediately BACK (or was simply mid-poll) would still get yanked into
  // `onStartMatch` once the in-flight call resolved, even though they'd already left.
  private attemptToken = 0;

  onBack: (() => void) | null = null;
  /** Fired once — either the leader tapping START, or a non-leader member's poll
   * observing the leader already started. Game.ts hands off to the same online-PvP
   * connect path the `?pvp=1` URL flag uses, with this partyId attached. */
  onStartMatch: ((partyId: string) => void) | null = null;

  constructor(opts: { matchBaseUrl: string; playerId?: string; api?: PartyApi }) {
    this.matchBaseUrl = opts.matchBaseUrl;
    this.playerId = opts.playerId ?? getPlayerId();
    this.api = opts.api ?? partyApi;

    this.title = new Text({ text: t('party.title'), style: { fill: 0xf7fafc, fontSize: 32, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.codeText = new Text({ text: '', style: { fill: 0x90cdf4, fontSize: 22, fontFamily: 'monospace', letterSpacing: 4, padding: 16 } });
    this.codeText.anchor.set(0.5, 0);
    this.membersText = new Text({ text: '', style: { fill: 0xcbd5e0, fontSize: 16, fontFamily: 'monospace', align: 'center', lineHeight: 22, padding: 16 } });
    this.membersText.anchor.set(0.5, 0);
    this.statusText = new Text({ text: '', style: { fill: 0xf56565, fontSize: 13, fontFamily: 'monospace', padding: 12 } });
    this.statusText.anchor.set(0.5, 0);

    this.createBtn = new Button(t('party.create'), { w: 200, h: 44, fontSize: 15 });
    this.createBtn.onTap = () => void this.doCreate();
    this.createBtn.setIcon(getUiTexture('icon_party_create'));
    this.joinBtn = new Button(t('party.join'), { w: 200, h: 44, fontSize: 15 });
    this.joinBtn.onTap = () => this.openJoinInput();
    this.joinBtn.setIcon(getUiTexture('icon_party_join'));
    this.startBtn = new Button(t('party.startMatching'), { w: 200, h: 44, fontSize: 15, color: 0x2f855a });
    this.startBtn.onTap = () => void this.doStart();
    this.startBtn.setIcon(getUiTexture('icon_play'));
    this.leaveBtn = new Button(t('party.leave'), { w: 160, h: 36, fontSize: 13, color: 0x742a2a, sound: 'ui.back' });
    this.leaveBtn.onTap = () => void this.doLeave();
    this.leaveBtn.setIcon(getUiTexture('icon_party_leave'));
    this.backBtn = new Button(t('party.back'), { w: 120, h: 32, fontSize: 13, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(
      this.panel.view, this.title, this.codeText, this.membersText, this.statusText,
      this.createBtn.view, this.joinBtn.view, this.startBtn.view, this.leaveBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
    this.refreshButtons();
  }

  show(w: number, h: number): void {
    this.retext();
    this.layout(w, h);
    this.view.visible = true;
    this.refresh();
  }

  /** Re-apply every static label from the active locale — same convention as
   * MainMenu.ts's `retext()` (design/17-i18n.md). */
  private retext(): void {
    this.title.text = t('party.title');
    this.createBtn.setText(t('party.create'));
    this.joinBtn.setText(t('party.join'));
    this.startBtn.setText(t('party.startMatching'));
    this.leaveBtn.setText(t('party.leave'));
    this.backBtn.setText(t('party.back'));
  }

  hide(): void {
    this.view.visible = false;
    this.inputOverlay.close(); // never leave a DOM input dangling once navigated away
    this.attemptToken++; // any create/join/start/poll still in flight becomes stale
  }

  /** Call once per render frame while visible (mirrors Bar/ToastQueue's own `update(dt)`
   * convention) — polls party state at POLL_INTERVAL_MS so a non-leader member's screen
   * picks up new joiners and the leader starting matching without any action of its own. */
  update(dt: number): void {
    if (!this.view.visible || !this.party || this.busy) return;
    this.pollAccMs += dt;
    if (this.pollAccMs < PartyScreen.POLL_INTERVAL_MS) return;
    this.pollAccMs = 0;
    void this.pollOnce();
  }

  private layout(w: number, h: number): void {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 200);
    this.codeText.position.set(cx, cy - 140);
    this.membersText.position.set(cx, cy - 90);
    this.statusText.position.set(cx, cy + 60);
    this.createBtn.view.position.set(cx - 100, cy - 20);
    this.joinBtn.view.position.set(cx - 100, cy + 34);
    this.startBtn.view.position.set(cx - 100, cy - 20);
    this.leaveBtn.view.position.set(cx - 80, cy + 90);
    this.backBtn.view.position.set(cx - 60, cy + 150);
  }

  private async pollOnce(): Promise<void> {
    if (!this.party) return;
    const token = this.attemptToken;
    try {
      const info = await this.api.getParty(this.matchBaseUrl, this.party.partyId);
      if (token !== this.attemptToken) return; // hidden/backed out while this poll was in flight
      if (!info) {
        this.party = null;
        this.statusText.text = t('party.partyClosed');
        this.refresh();
        return;
      }
      const wasMatching = this.party.matching;
      this.party = info;
      this.refresh();
      if (info.matching && !wasMatching) this.onStartMatch?.(info.partyId);
    } catch {
      /* transient network hiccup — next poll retries, no need to surface every miss */
    }
  }

  private isLeader(): boolean {
    return this.party?.leaderId === this.playerId;
  }

  private async doCreate(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusText.text = '';
    const token = this.attemptToken;
    try {
      const party = await this.api.createParty(this.matchBaseUrl, this.playerId);
      if (token === this.attemptToken) this.party = party; // else: backed out — discard
    } catch {
      if (token === this.attemptToken) this.statusText.text = t('party.createFailed');
    } finally {
      // `busy` always clears regardless of staleness — it's this screen's OWN
      // re-entrancy guard (not tied to whether the player navigated away), and must
      // never get stuck permanently true or a later re-entry to this screen would be
      // unable to create/join/start ever again.
      this.busy = false;
      if (token === this.attemptToken) this.refresh();
    }
  }

  private openJoinInput(): void {
    this.inputOverlay.open({
      placeholder: t('party.codePlaceholder'),
      maxLength: 6,
      uppercase: true,
      onSubmit: (code) => void this.doJoin(code.trim()),
    });
  }

  /**
   * Join a code the player did not type — an accepted portal invite
   * (`platform/crazygames/portalBoot.ts`), arriving through `platform/onlineEntry.ts`.
   *
   * Deliberately the same `doJoin` a typed code runs through, rather than a second path:
   * the busy guard, the stale-attempt token, the error text and the presence publish are all
   * behaviour this must share, and the only difference is where the string came from.
   */
  joinWithCode(code: string): void {
    void this.doJoin(code.trim());
  }

  private async doJoin(code: string): Promise<void> {
    if (!code || this.busy) return;
    this.busy = true;
    this.statusText.text = '';
    const token = this.attemptToken;
    try {
      const party = await this.api.joinParty(this.matchBaseUrl, this.playerId, code);
      if (token === this.attemptToken) this.party = party;
    } catch {
      if (token === this.attemptToken) this.statusText.text = t('party.invalidCode');
    } finally {
      this.busy = false; // see doCreate's note — always clears, independent of staleness
      if (token === this.attemptToken) this.refresh();
    }
  }

  private async doStart(): Promise<void> {
    if (!this.party || this.busy || !this.isLeader()) return;
    this.busy = true;
    this.statusText.text = '';
    const token = this.attemptToken;
    try {
      const info = await this.api.startPartyMatching(this.matchBaseUrl, this.party.partyId, this.playerId);
      if (token !== this.attemptToken) return; // backed out before matching actually started
      this.party = info;
      this.onStartMatch?.(info.partyId);
    } catch {
      if (token === this.attemptToken) this.statusText.text = t('party.startFailed');
    } finally {
      this.busy = false;
      if (token === this.attemptToken) this.refresh();
    }
  }

  private async doLeave(): Promise<void> {
    if (!this.party) return;
    const partyId = this.party.partyId;
    this.party = null;
    this.refresh();
    try {
      await this.api.leaveParty(this.matchBaseUrl, partyId, this.playerId);
    } catch {
      /* best-effort — the party TTLs out server-side even if this call is lost */
    }
  }

  private refresh(): void {
    // Declare the squad for whatever the host wants told about it (design/20 — a portal
    // requires room information be passed through its SDK, and `platform/partyPresence.ts`
    // is the seam because `src/game/` may not import `platform/crazygames/`). Published
    // from HERE rather than from each of create/join/start/leave, because this is the one
    // place all four of them plus the poll converge — and `setPartyPresence` de-duplicates,
    // so the one-second poll does not become a one-second SDK call.
    setPartyPresence(
      this.party
        ? {
            partyId: this.party.partyId,
            code: this.party.code,
            // Not `!matching` alone: a FULL party is not joinable either, and the platform
            // draws a join affordance off this answer — so a join that would be refused
            // must not be advertised. `SQUAD_SIZE` and not a local constant: the server's
            // own `PartyService.MAX_PARTY_SIZE` is an alias of this same export
            // (`@dd/game/match/pvpConfig`), so the cap the join is refused by and the cap
            // drawn from here cannot drift.
            joinable: !this.party.matching && this.party.members.length < SQUAD_SIZE,
          }
        : null,
    );
    if (!this.party) {
      this.codeText.text = '';
      this.membersText.text = '';
    } else {
      this.codeText.text = t('party.codeLine', { code: this.party.code });
      this.membersText.text = this.party.members
        .map((m) => `${m === this.party!.leaderId ? '★' : ' '} ${m === this.playerId ? t('party.you') : m.slice(0, 8)}`)
        .join('\n');
    }
    this.refreshButtons();
  }

  private refreshButtons(): void {
    const inParty = this.party !== null;
    this.createBtn.view.visible = !inParty;
    this.joinBtn.view.visible = !inParty;
    this.leaveBtn.view.visible = inParty;
    this.startBtn.view.visible = inParty && this.isLeader();
  }
}
