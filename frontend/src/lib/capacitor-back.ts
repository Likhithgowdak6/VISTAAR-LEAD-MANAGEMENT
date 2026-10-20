import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

import { backStackDepth } from './mobile-back-stack';

/**
 * The Android hardware back button and the system back gesture.
 *
 * WHY THIS FILE HAS TO EXIST. In a browser, `history.pushState` is enough - the back gesture is
 * the browser's own and it walks the entries we pushed. Inside the Android shell it is not:
 * Capacitor 8's BridgeActivity has no back handling of any kind (the only `canGoBack` left in
 * the package is in a dead Cordova compatibility shim), so the key press reaches the default
 * Activity behaviour and finishes the app. Pushed history entries are never consulted and the
 * dashboard simply closes, which is the behaviour this whole change set is here to fix.
 *
 * Registering a `backButton` listener is what moves that decision into our code.
 *
 * DEPTH DECIDES, NOT `canGoBack`. The event carries Capacitor's own view of WebView history,
 * which also counts entries this app never pushed. Our layer count is the only thing that knows
 * whether there is an in-app screen to return to, so that is what is asked - and when there is
 * not, the app exits, which is what an Android user expects back at the root to do.
 */

let removeListener: (() => void) | null = null;

export const startCapacitorBackButton = (): void => {
  // A no-op in a browser: `isNativePlatform` is false there, and the History API already does
  // the right thing. Guarded rather than assumed so the dashboard and the APK run one codebase.
  if (removeListener || !Capacitor.isNativePlatform()) {
    return;
  }

  // Claimed synchronously so a second call during the same tick cannot register twice; the
  // real remover replaces it once the plugin resolves.
  removeListener = () => {};

  void App.addListener('backButton', () => {
    if (backStackDepth() > 0) {
      // Straight into the same path the browser's own back takes, so a gesture, a hardware key
      // and the in-app arrow all close exactly one layer and all close it the same way.
      window.history.back();
      return;
    }

    void App.exitApp();
  })
    .then((handle) => {
      removeListener = () => {
        void handle.remove();
      };
    })
    .catch(() => {
      // The plugin is not available in this build. Back reverts to Capacitor's default, which
      // is what it did before this file existed - no worse, and nothing to crash the app over.
      removeListener = null;
    });
};

/** Test seam, and a clean teardown if the app is ever unmounted. */
export const stopCapacitorBackButton = (): void => {
  removeListener?.();
  removeListener = null;
};
