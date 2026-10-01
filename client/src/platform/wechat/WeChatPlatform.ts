import { Application, DOMAdapter } from 'pixi.js';
import type { AudioBus, InputSource, Platform } from '../types';
import { WeChatAdapter } from './WeChatAdapter';
import { WeChatInput } from './WeChatInput';
import { WeChatAudio } from './WeChatAudio';
import { installWeChatEventBridge, type WeChatEventBridge } from './weChatDomEvents';
import { installFrameGate } from '../../game/frameGate';
import { activeDisplayHz } from '../../game/powerBudget';

// WeChat mini-game platform.
//
// Design (see design/04-wechat.md):
//  - No weapp-adapter. We give Pixi our own DOMAdapter (WeChatAdapter) and init with
//    manageImports:false so Pixi's browser-environment probe can't overwrite it with
//    the BrowserAdapter (which calls document.createElement → would crash here).
//  - One main canvas from wx.createCanvas() (the FIRST call is the on-screen canvas;
//    later calls are offscreen sub-canvases). We create it before setting the adapter,
//    so the adapter's own lazy sub-canvas probes never become the main canvas.
//  - No WebGPU → force WebGL. No resizeTo/autoDensity → size explicitly, set resolution.
export class WeChatPlatform implements Platform {
  // Set by createApp() (before Application.init(), see weChatDomEvents.ts's doc
  // comment for why the timing matters), read by createInput() — WeChatInput drives
  // this per touch so Pixi's Button/Slider widgets (game/ui/widgets.ts) actually
  // receive taps on this platform instead of going silently dead.
  private eventBridge: WeChatEventBridge | null = null;

  async createApp(): Promise<Application> {
    // The first wx.createCanvas() is the main (on-screen) canvas.
    const wxCanvas = wx.createCanvas();

    const info = wx.getWindowInfo();
    const resolution = Math.min(info.pixelRatio || 1, 2);

    // Pixi's EventSystem attaches DOM listeners to the canvas during init. The wx canvas
    // has no DOM event API at all — installWeChatEventBridge gives it a real (if
    // minimal) one, driven per touch by WeChatInput, so Pixi's own interaction system
    // (Button/Slider) works here instead of the canvas silently swallowing every tap.
    this.eventBridge = installWeChatEventBridge(wxCanvas);
    const c = wxCanvas as unknown as {
      getBoundingClientRect?: () => { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number };
      style?: Record<string, unknown>;
    };
    c.getBoundingClientRect ??= () => ({
      x: 0, y: 0, left: 0, top: 0,
      width: info.windowWidth, height: info.windowHeight,
      right: info.windowWidth, bottom: info.windowHeight,
    });
    c.style ??= {};

    // Install our adapter before init; keep Pixi from swapping it back to the browser one.
    DOMAdapter.set(WeChatAdapter);

    const app = new Application();
    await app.init({
      canvas: wxCanvas as unknown as HTMLCanvasElement,
      width: info.windowWidth,
      height: info.windowHeight,
      background: '#0b0d12',
      antialias: true,
      resolution,
      autoDensity: false,
      preference: 'webgl',
      manageImports: false,
    });
    installFrameGate(app.ticker, activeDisplayHz); // even frame pacing on any refresh rate
    return app;
  }

  createInput(app: Application): InputSource {
    return new WeChatInput(app, this.eventBridge);
  }

  createAudio(): AudioBus {
    return new WeChatAudio();
  }
}
