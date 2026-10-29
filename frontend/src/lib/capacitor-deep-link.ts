import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

import { type DeepLinkTarget, readDeepLinkTargetFromUrl } from './deep-link';

/**
 * A tapped WhatsApp link, arriving as an Android intent instead of as a page load.
 *
 * WHY THE BROWSER PATH IS NOT ENOUGH. In a browser the link IS the navigation: Chrome opens
 * `https://vistaarcrm.duckdns.org/?conversation=...`, the app boots at that URL, and
 * `readDeepLinkTarget()` reads the query off `window.location` - see deep-link.ts. Inside the
 * APK none of that happens. The shell is served from `https://localhost` (capacitor.config.ts),
 * so the WebView is never navigated to the link's URL; Android hands the URL to the Activity as
 * an intent and the WebView carries on showing whatever it already had. Without this file the
 * App Link would open the app at the inbox and silently drop the lead it named.
 *
 * TWO ARRIVALS, BOTH NEEDED. `getLaunchUrl()` is the cold start - the app was not running and
 * the link is what started it. `appUrlOpen` is the warm one - the app was already in the
 * background, and `launchMode="singleTask"` in the manifest delivers the intent to the existing
 * Activity rather than making a second one. Handling only the first means a tapped link does
 * nothing whenever Vistaar happens to be open, which is most of the time.
 *
 * BUFFERED, BECAUSE NOBODY IS LISTENING YET. This starts before the first render (main.tsx),
 * the way the back-button listener does, because an intent is a property of the process rather
 * than of any component. AppShell - the thing that can actually open a lead - mounts later, and
 * only once there is a signed-in user. So a target that arrives early is held until something
 * subscribes, rather than dropped.
 */

let removeListener: (() => void) | null = null;
/** A target that arrived before anything subscribed. Replaced, not queued: the newest tap wins. */
let pending: DeepLinkTarget | null = null;
let subscriber: ((target: DeepLinkTarget) => void) | null = null;

const deliver = (target: DeepLinkTarget | null): void => {
  if (!target) {
    return;
  }

  if (subscriber) {
    subscriber(target);
    return;
  }

  pending = target;
};

export interface DeepLinkRuntime {
  isNative: () => boolean;
  /** The URL that launched the app, when it was launched by one. */
  getLaunchUrl: () => Promise<{ url?: string | null } | null | undefined>;
  /** Fires when a link is handed to an already-running app. Returns its own remover. */
  addUrlListener: (
    handler: (url: string) => void,
  ) => Promise<{ remove: () => void | Promise<void> }>;
}

const capacitorRuntime: DeepLinkRuntime = {
  isNative: () => Capacitor.isNativePlatform(),
  getLaunchUrl: () => App.getLaunchUrl(),
  addUrlListener: (handler) =>
    App.addListener('appUrlOpen', (event: { url: string }) => handler(event.url)),
};

export const startCapacitorDeepLinks = (runtime: DeepLinkRuntime = capacitorRuntime): void => {
  // A no-op in a browser, where the address bar already carries the parameters and
  // readDeepLinkTarget has them. Guarded rather than assumed so the dashboard and the APK run
  // one codebase - the same shape capacitor-back.ts uses.
  if (removeListener || !runtime.isNative()) {
    return;
  }

  // Claimed synchronously so a second call in the same tick cannot register twice; the real
  // remover replaces it once the plugin resolves.
  removeListener = () => {};

  void runtime
    .getLaunchUrl()
    .then((launch) => deliver(launch?.url ? readDeepLinkTargetFromUrl(launch.url) : null))
    .catch(() => {
      // No launch URL to read. An ordinary icon tap looks exactly like this, so it is not an
      // error - there is simply nowhere to jump to.
    });

  void runtime
    .addUrlListener((url) => deliver(readDeepLinkTargetFromUrl(url)))
    .then((handle) => {
      removeListener = () => {
        void handle.remove();
      };
    })
    .catch(() => {
      // The plugin is unavailable in this build. Links fall back to opening the app at the
      // inbox, which is what they did before this file existed.
      removeListener = null;
    });
};

/**
 * Subscribes to links, draining anything that arrived before now.
 *
 * Returns the unsubscribe, so a React effect can hand it straight back. One subscriber at a
 * time by design: there is exactly one shell that knows how to open a lead, and a second
 * listener would mean one tap opening two things.
 */
export const onDeepLinkOpened = (handler: (target: DeepLinkTarget) => void): (() => void) => {
  subscriber = handler;

  if (pending) {
    const target = pending;
    pending = null;
    handler(target);
  }

  return () => {
    if (subscriber === handler) {
      subscriber = null;
    }
  };
};

/** Test seam, and a clean teardown if the app is ever unmounted. */
export const stopCapacitorDeepLinks = (): void => {
  removeListener?.();
  removeListener = null;
  subscriber = null;
  pending = null;
};
