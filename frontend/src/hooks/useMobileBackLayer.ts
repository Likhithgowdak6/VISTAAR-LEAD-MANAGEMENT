import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  pushBackLayer,
  removeBackLayer,
  startMobileBackStack,
  type BackLayer,
} from '../lib/mobile-back-stack';

/**
 * Below this the inbox is a drill-down and a back gesture has somewhere in-app to go. At and
 * above it the list is a permanent rail, every section is one click away in the masthead, and
 * the owner is happy with how that behaves - so nothing is pushed and browser history on a
 * desktop viewport is exactly what it was before any of this existed.
 *
 * 1024px is `lg`, the same breakpoint the shell already uses to switch the inbox between a
 * drill-down and two panes. Deriving it from the layout rather than inventing a second number
 * means the two cannot drift apart.
 */
export const MOBILE_BACK_QUERY = '(max-width: 1023.98px)';

/**
 * TWO SOURCES, DELIBERATELY. The media query's own `change` event is the precise one - it fires
 * only when the breakpoint is actually crossed. `resize` is the belt: some embedded WebViews
 * resize the viewport on rotation without re-evaluating MediaQueryList listeners promptly, and
 * the cost of an extra listener that usually agrees with the first is a single cheap
 * `matches` read. `useSyncExternalStore` de-duplicates: if the snapshot has not changed, a
 * notification causes no re-render.
 */
const subscribeToViewport = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  const query = window.matchMedia(MOBILE_BACK_QUERY);
  query.addEventListener('change', onChange);
  window.addEventListener('resize', onChange);

  return () => {
    query.removeEventListener('change', onChange);
    window.removeEventListener('resize', onChange);
  };
};

const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(MOBILE_BACK_QUERY).matches;

/**
 * Subscribed rather than read once: rotating a phone, or dragging a desktop window narrow,
 * has to change the answer. A layer registered on a phone then widened past `lg` unregisters
 * itself, which hands its history entry back and leaves desktop history clean.
 */
export const useIsMobileViewport = (): boolean =>
  useSyncExternalStore(
    subscribeToViewport,
    isMobileViewport,
    () => false, // Server/snapshot default: desktop, i.e. change nothing.
  );

export interface MobileBackLayerOptions {
  /** True while the layer is on screen and the back gesture should close it. */
  active: boolean;
  /** Closes this layer. Must leave the parent view intact - it is about to be shown again. */
  onBack: () => void;
}

/**
 * Pairs one dismissible mobile layer with one history entry.
 *
 * Give it `active` and a way to close, and the phone's back gesture, the Android back button
 * and the browser's own back button all close that layer and nothing else. Layers nest: the
 * most recently opened is always the first to close, because that is the order the history
 * entries are in.
 *
 * `onBack` is held in a ref so a caller can pass an inline arrow without re-registering - and
 * re-registering would mean dropping and re-taking a history entry on every render, which the
 * person would feel as back doing nothing.
 */
export const useMobileBackLayer = ({ active, onBack }: MobileBackLayerOptions): void => {
  const isMobile = useIsMobileViewport();
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!active || !isMobile) {
      return;
    }

    startMobileBackStack();

    let layer: BackLayer | null = pushBackLayer(() => onBackRef.current());

    return () => {
      removeBackLayer(layer);
      layer = null;
    };
  }, [active, isMobile]);
};
