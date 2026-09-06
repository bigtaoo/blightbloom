import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite web build (webDir) in a native Android/iOS webview.
// The same PixiJS build that runs in the browser runs here; touch input already
// works via the shared TouchControls (see src/platform/TouchControls.ts).
//
// Native projects (android/, ios/) are generated on demand and git-ignored — run
// `npm run cap:add:android` / `cap:add:ios`, then open in Android Studio / Xcode.
const config: CapacitorConfig = {
  appId: 'de.elk.daydayup',
  appName: 'Blightbloom',
  webDir: 'dist',
};

export default config;
