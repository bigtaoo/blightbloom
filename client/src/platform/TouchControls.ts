import type { InputState, TouchVisual } from './types';

// Platform-agnostic virtual twin-stick controls.
//
// Pure geometry + state, fed normalized screen-space pointer events (CSS pixels) from
// whatever event source the platform has: DOM touch events (Web / Capacitor) or wx
// global touch events (WeChat). Both feed the same math here, so the on-screen controls
// behave identically everywhere.
//
//   left half  → movement joystick (dynamic origin at touch-down)
//   right half → hold-to-fire (design/10 v33: no more aim stick — the engine auto-faces,
//                see ApplyInputSystem; a melee swing is also the parry)
//   corner buttons → weapon 1 / weapon 2 / INTERACT (hold, revive channel only — the
//                extraction/descend gesture is PortalPrompt's own tappable buttons, not
//                this field; no jump/block — parry is the swing arc)
interface Stick {
  id: number;
  ox: number;
  oy: number;
  dx: number; // normalized offset from origin, magnitude clamped to 1
  dy: number;
}

interface Button {
  cx: number;
  cy: number;
  r: number;
}

export class TouchControls {
  onSwitchWeapon: ((slot: number) => void) | null = null;

  private w = 0;
  private h = 0;
  private stickRadius = 1;
  // design/10 open question ("control layout … left-handed mirror") — swaps which half
  // of the screen drives movement vs. fire, and moves the weapon buttons to the
  // opposite corner. Persisted in SettingsState.controlLayout, applied via setMirrored.
  private mirrored = false;

  private move: Stick | null = null;
  private fireTouchId: number | null = null;
  private interactTouchId: number | null = null;

  // Set on the first pointerDown ever and never cleared — this is "is this session a
  // touch session" (drives TouchVisual.active), distinct from hasActiveTouch() below,
  // which is momentary and drives which input source read() prefers right now.
  private everTouched = false;

  // ...and the other half of that answer, which `everTouched` alone got wrong.
  //
  // A first-touch trigger means a phone player opens the game and sees NO controls: no
  // joystick, no fire button, no weapon buttons — the overlay appears only once they have
  // already guessed where to press. That is fine on a desktop (the overlay must not appear
  // over a mouse session at all) and it is the whole control scheme on a touch device, so
  // one flag cannot serve both and the platform has to say which case this is.
  //
  // Set by the platform's input layer: `WebInput` from a coarse-pointer probe, `WeChatInput`
  // unconditionally (a mini-game has no other input). Deliberately not derived here — this
  // class takes normalized coordinates and owns no globals, which is what lets every test
  // in the suite drive it without a DOM.
  private assumeTouch = false;

  private weapon1Btn: Button = { cx: 0, cy: 0, r: 0 };
  private weapon2Btn: Button = { cx: 0, cy: 0, r: 0 };
  private fireBtn: Button = { cx: 0, cy: 0, r: 0 };
  private interactBtn: Button = { cx: 0, cy: 0, r: 0 };

  // Screen size in logical (CSS) pixels — the same units the pointer coords use.
  layout(width: number, height: number) {
    this.w = width;
    this.h = height;
    const unit = Math.min(width, height);
    this.stickRadius = unit * 0.18;

    const r = unit * 0.08;
    const m = r + unit * 0.04; // margin from the edge to a button centre
    const gap = r * 2.4;
    // Standard: buttons sit top-right (thumb-natural for a right-handed grip holding
    // the movement stick on the left). Mirrored: top-left instead. INTERACT is a third
    // button continuing the same row, one more `gap` out — held (like fire), not
    // tapped (like the weapon-swap pair), but it shares their corner cluster rather
    // than fighting the move/fire zones for space.
    if (this.mirrored) {
      this.weapon1Btn = { cx: m, cy: m, r };
      this.weapon2Btn = { cx: m + gap, cy: m, r };
      this.interactBtn = { cx: m + gap * 2, cy: m, r };
    } else {
      this.weapon1Btn = { cx: width - m, cy: m, r };
      this.weapon2Btn = { cx: width - m - gap, cy: m, r };
      this.interactBtn = { cx: width - m - gap * 2, cy: m, r };
    }
    // Fire button: centred in the fire-side half (mirrored: left, else right), same
    // radius as the move stick so it's an equally generous thumb target. Fixed position
    // (unlike the old dynamic-origin aim stick), so it stays put across presses instead
    // of appearing wherever the player last tapped.
    const fireCx = this.mirrored ? unit * 0.25 : width - unit * 0.25;
    this.fireBtn = { cx: fireCx, cy: height * 0.5, r: this.stickRadius };
  }

  /** Left-handed control-layout toggle (design/10, `Settings.ts`) — swaps which half of
   *  the screen drives movement vs. fire and re-anchors the weapon buttons to the
   *  opposite corner. Re-lays out immediately against the last known screen size (if
   *  any) rather than waiting for the next resize, so a mid-session toggle takes effect
   *  right away. A no-op if the value hasn't actually changed. */
  setMirrored(mirrored: boolean) {
    if (this.mirrored === mirrored) return;
    this.mirrored = mirrored;
    if (this.w > 0 && this.h > 0) this.layout(this.w, this.h);
  }

  /**
   * Declare that this session's primary input IS touch, so the controls are drawn before
   * the player has touched anything (see the `assumeTouch` field for why one flag could not
   * cover both hosts).
   *
   * Called once, at input attach. Never unset: a session that starts on a touchscreen keeps
   * its overlay even while a paired mouse is being used, which is the right way round — an
   * overlay nobody presses costs a few translucent circles, while a missing one costs the
   * player every control they have.
   */
  setAssumeTouch(assume: boolean) {
    this.assumeTouch = assume;
  }

  pointerDown(id: number, x: number, y: number) {
    this.everTouched = true;

    // Buttons take priority over the sticks.
    if (inCircle(x, y, this.weapon1Btn)) {
      this.onSwitchWeapon?.(1);
      return;
    }
    if (inCircle(x, y, this.weapon2Btn)) {
      this.onSwitchWeapon?.(2);
      return;
    }
    // INTERACT: held for as long as the touch stays down, same shape as the fire
    // zone below (not a one-shot latch like the weapon buttons above) — the revive
    // channel (ReviveSystem) reads it every tick it's held, exactly like the
    // keyboard's E/Space hold.
    if (inCircle(x, y, this.interactBtn)) {
      this.interactTouchId = id;
      return;
    }

    // Otherwise: left half drives movement, right half fires (hold anywhere in that
    // half — no precision tap needed) — swapped when `mirrored` (setMirrored/design/10's
    // left-handed layout option).
    const leftHalf = x < this.w * 0.5;
    if (leftHalf !== this.mirrored) this.move = { id, ox: x, oy: y, dx: 0, dy: 0 };
    else this.fireTouchId = id;
  }

  pointerMove(id: number, x: number, y: number) {
    if (this.move && id === this.move.id) this.updateStick(this.move, x, y);
  }

  pointerUp(id: number) {
    if (this.move && id === this.move.id) this.move = null;
    if (this.fireTouchId === id) this.fireTouchId = null;
    if (this.interactTouchId === id) this.interactTouchId = null;
  }

  // True while the player is touching any control — lets a platform that also has
  // mouse/keyboard (desktop Web) decide which source is currently driving.
  hasActiveTouch(): boolean {
    return this.move !== null || this.fireTouchId !== null || this.interactTouchId !== null;
  }

  // Render-facing snapshot for the on-screen overlay (TouchControlsView) — see
  // TouchVisual's doc comment (platform/types.ts). dx/dy are converted back from the
  // normalized [-1,1] `read()` uses into the raw pixel offset a render layer wants.
  getVisual(): TouchVisual {
    return {
      active: this.everTouched || this.assumeTouch,
      stickRadius: this.stickRadius,
      move: this.move
        ? { ox: this.move.ox, oy: this.move.oy, dx: this.move.dx * this.stickRadius, dy: this.move.dy * this.stickRadius }
        : null,
      fire: { ...this.fireBtn, pressed: this.fireTouchId !== null },
      weapon1: { ...this.weapon1Btn },
      weapon2: { ...this.weapon2Btn },
      interact: { ...this.interactBtn, pressed: this.interactTouchId !== null },
    };
  }

  private updateStick(s: Stick, x: number, y: number) {
    let dx = x - s.ox;
    let dy = y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len > this.stickRadius) {
      dx = (dx / len) * this.stickRadius;
      dy = (dy / len) * this.stickRadius;
    }
    s.dx = dx / this.stickRadius; // [-1, 1]
    s.dy = dy / this.stickRadius;
  }

  read(): InputState {
    const move = this.move ?? { dx: 0, dy: 0 };

    return {
      moveX: move.dx,
      moveY: move.dy,
      firing: this.fireTouchId !== null,
      // A real on-screen INTERACT hold, added this pass — previously hardcoded false
      // (a real, self-documented gap: touch/WeChat players could never revive a downed
      // teammate). Extraction/descend already went through PortalPrompt's own tappable
      // buttons instead of this field once that gesture was rewritten (design/10,
      // 2026-08-02), so this only ever gates the revive channel now — see
      // ReviveSystem's own doc comment.
      interacting: this.interactTouchId !== null,
    };
  }
}

function inCircle(x: number, y: number, b: Button): boolean {
  return Math.hypot(x - b.cx, y - b.cy) <= b.r;
}
