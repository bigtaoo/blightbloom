/**
 * The per-tick twin-stick input snapshot (design/08 "PlayerCommand") and the
 * InputSource seam (design/08 "InputSource, replay, headless").
 *
 * Stage B defined the frozen command shape — it is step()'s input contract — plus
 * a minimal non-stalling LocalInputSource so createGameEngine(config, input?) has
 * an honest default. Stage E formalized the seam: the input-edge quantization
 * lives in input.ts, LocalInputSource can serialize the frames it saw into a
 * Replay (replay.ts / ReplayInputSource), and golden-replay tests pin the
 * seed+config+input → identical终局 guarantee.
 */
import type { Brad } from '../math/trig';

/**
 * Button bitfield, edge-detected inside the engine (design/08). There is no BLOCK
 * or JUMP: parry is the melee swing arc (DeflectSystem), and jump was removed.
 */
export const Button = {
  FIRE: 1 << 0,
  SWAP_WEAPON: 1 << 1,
  INTERACT: 1 << 2,
  // One-shot portal-popup choices (design/10, ROADMAP 1.4 follow-up — replaces the
  // original hold-to-extract/tap-to-descend INTERACT gesture with an explicit two-
  // button choice). Same one-tick-pulse convention as SWAP_WEAPON: the render layer
  // latches the bit for exactly one command, never held across ticks.
  CONFIRM_EXTRACT: 1 << 3,
  CONFIRM_DESCEND: 1 << 4,
} as const;

export interface PlayerCommand {
  type: 'input';
  owner: number; // == index into state.players
  tick: number; // frame this input applies to (matches step's tick)
  moveBrad: Brad; // desired move direction
  moveMag: number; // 0..255 left-stick deflection, 0 = idle
  buttons: number; // Button bitfield
  // The PickupItem.id this tick's click asked to collect (design/03, ENGINE_VERSION
  // 32 — the ground-weapon panel's click-to-collect gesture). 0 = none. Not a
  // Button bit because it carries a value, not just an edge; CommandBuilder latches
  // it for exactly one tick, same one-shot convention as SWAP_WEAPON/CONFIRM_EXTRACT.
  pickupTargetId: number;
  // The floor-card slot this seat is voting for (design/05, ENGINE_VERSION 58): 1..3,
  // or 0 for "no change". Carries a VALUE, so it is a field and not a Button bit, same
  // reasoning as `pickupTargetId` above — but unlike that one it is not a one-shot
  // latch: `ApplyInputSystem` copies a non-zero vote onto the seat and leaves it there,
  // so a client only has to send the tap, and the sim holds the choice until the
  // checkpoint consumes it. 0 therefore means "I am not changing my vote this tick",
  // never "I withdraw it".
  cardVote: number;
  // The ShopOffer.id this tick's tap asked to buy (design/05 "Shops", 2026-09-14). 0 = none.
  // A one-shot latch like `pickupTargetId`, and a SEPARATE field from it rather than a shared
  // "what did I click" channel: offers and pickups are minted from different id spaces
  // (`GameState.nextShopId` vs `nextId`), so one field over both would make a tap on a
  // counter also collect whichever floor weapon happened to hold the same number.
  shopBuyId: number;
}

/**
 * design/08: submit / take(frame). `take` returns null only when a frame isn't
 * confirmed yet (net stall); a local/replay source never returns null. The
 * optional confirmedLead(frame) reports how many frames ahead of `frame` are
 * already confirmed (net pacing; unbounded for local/replay sources).
 */
export interface InputSource {
  submit(cmd: PlayerCommand): void;
  // `readonly` so a source may hand back an internal buffer without copying (design/06,
  // ROADMAP 3.1 NetInputSource caches per-frame command arrays). The engine only reads
  // the result (step()'s parameter is already `readonly`), so no consumer is affected.
  take(frame: number): readonly PlayerCommand[] | null;
  confirmedLead?(frame: number): number;
}

/**
 * Single-player / test input source. Never stalls: an unconfirmed frame returns
 * an empty array (idle-hold), not null (design/08 "LocalInputSource never stalls").
 * It also records every frame it saw, so a finished single-player match can be
 * serialized into a Replay for headless re-judge (see replay.ts).
 */
export class LocalInputSource implements InputSource {
  private readonly byFrame = new Map<number, PlayerCommand[]>();

  submit(cmd: PlayerCommand): void {
    const list = this.byFrame.get(cmd.tick);
    if (list) list.push(cmd);
    else this.byFrame.set(cmd.tick, [cmd]);
  }

  take(frame: number): PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }

  /**
   * Every submitted command, flattened in deterministic (tick, then submit) order.
   * Feeds toReplay() — the recorded stream a ReplayInputSource re-runs verbatim.
   */
  recorded(): PlayerCommand[] {
    const frames = [...this.byFrame.keys()].sort((a, b) => a - b);
    const out: PlayerCommand[] = [];
    for (const f of frames) out.push(...this.byFrame.get(f)!);
    return out;
  }
}
