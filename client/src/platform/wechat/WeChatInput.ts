import type { Application } from 'pixi.js';
import type { InputSource, InputState, TouchVisual } from '../types';
import { TouchControls } from '../TouchControls';
import type { WeChatEventBridge } from './weChatDomEvents';

// WeChat touch input: feeds wx global touch events into the shared TouchControls.
// All the stick/button behaviour lives in TouchControls so it matches the Web build.
export class WeChatInput implements InputSource {
  private app: Application;
  private controls = new TouchControls();
  // Feeds Pixi's own interaction system (Button/Slider, game/ui/widgets.ts) — see
  // weChatDomEvents.ts's doc comment for why the canvas can't do this on its own here.
  // Optional/nullable so the existing `new WeChatInput(app)` test construction (no
  // bridge) stays valid: every dispatch call below is a no-op without one.
  private bridge: WeChatEventBridge | null;
  // Which single active touch is currently driving the synthetic Pixi mouse pointer —
  // the FIRST touch to start while none already is. Additional simultaneous touches
  // (e.g. the move stick held while aiming/firing) still reach TouchControls exactly as
  // before; only one of them ever also reaches Pixi's Button/Slider hit-testing, which
  // is all a menu/HUD screen ever needs.
  private mouseTouchId: number | null = null;

  get onSwitchWeapon() {
    return this.controls.onSwitchWeapon;
  }
  set onSwitchWeapon(cb: ((slot: number) => void) | null) {
    this.controls.onSwitchWeapon = cb;
  }

  constructor(app: Application, bridge: WeChatEventBridge | null = null) {
    this.app = app;
    this.bridge = bridge;
  }

  attach() {
    // app.screen is logical (CSS) pixels — the same units wx touch coords use.
    this.controls.layout(this.app.screen.width, this.app.screen.height);
    // Unconditional here: a mini-game has no other pointer, so the controls are the whole
    // control scheme and must be on screen before the first touch rather than after it
    // (TouchControls' `assumeTouch` field explains what the first-touch trigger cost).
    this.controls.setAssumeTouch(true);

    wx.onTouchStart((e) => {
      for (const t of e.changedTouches) {
        this.controls.pointerDown(t.identifier, t.clientX, t.clientY);
        if (this.mouseTouchId === null) {
          this.mouseTouchId = t.identifier;
          this.bridge?.dispatch('mousedown', t.clientX, t.clientY);
        }
      }
    });
    wx.onTouchMove((e) => {
      for (const t of e.changedTouches) {
        this.controls.pointerMove(t.identifier, t.clientX, t.clientY);
        if (t.identifier === this.mouseTouchId) this.bridge?.dispatch('mousemove', t.clientX, t.clientY);
      }
    });
    const end = (e: WxTouchEvent) => {
      for (const t of e.changedTouches) {
        this.controls.pointerUp(t.identifier);
        if (t.identifier === this.mouseTouchId) {
          this.bridge?.dispatch('mouseup', t.clientX, t.clientY);
          this.mouseTouchId = null;
        }
      }
    };
    wx.onTouchEnd(end);
    wx.onTouchCancel(end);
  }

  read(): InputState {
    return this.controls.read();
  }

  getTouchVisual(): TouchVisual {
    return this.controls.getVisual();
  }

  setControlMirror(mirrored: boolean): void {
    this.controls.setMirrored(mirrored);
  }
}
