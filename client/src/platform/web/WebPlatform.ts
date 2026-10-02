import { Application } from 'pixi.js';
import type { AudioBus, InputSource, Platform } from '../types';
import { WebInput } from './WebInput';
import { WebAudio } from './WebAudio';
import { installFrameGate } from '../../game/frameGate';
import { activeDisplayHz } from '../../game/powerBudget';

// Web platform: browser canvas + keyboard/mouse. Mirrors the original main.ts boot.
export class WebPlatform implements Platform {
  async createApp(): Promise<Application> {
    const app = new Application();
    await app.init({
      background: '#0b0d12',
      resizeTo: window,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl', // WeChat has no WebGPU; use WebGL to match target-platform behavior
    });
    document.body.appendChild(app.canvas);
    installFrameGate(app.ticker, activeDisplayHz); // even frame pacing on any refresh rate
    return app;
  }

  createInput(_app: Application): InputSource {
    return new WebInput();
  }

  createAudio(): AudioBus {
    return new WebAudio();
  }
}
