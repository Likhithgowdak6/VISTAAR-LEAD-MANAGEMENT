import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull down at the top of a list to refetch it.
 *
 * WHY THIS IS JAVASCRIPT AND NOT ANDROID'S SwipeRefreshLayout. The entire UI is a React app
 * inside one Capacitor WebView. A native refresh layout wraps the WebView, so it would know a
 * drag happened but nothing about which screen is showing or what to refetch - the gesture
 * would animate and the data would not change. Attaching here means the pull calls the screen's
 * own loader, which is the thing that actually makes it a refresh rather than an animation.
 *
 * WHAT STOPS IT FIRING BY ACCIDENT, which is most of the work:
 *
 *   1. The container must already be scrolled to the top when the finger lands. Mid-list drags
 *      are ordinary scrolling and never considered.
 *   2. The drag must be downward and mostly VERTICAL. A horizontal swipe - the gesture that
 *      goes back, or scrolls a filter row - is rejected on its first move and stays rejected
 *      for the rest of that touch.
 *   3. It must pass THRESHOLD_PX. Below that the spacer springs back and nothing is fetched.
 *   4. A refresh already in flight blocks another, so an impatient second pull cannot double
 *      the API calls.
 *
 * TOUCH EVENTS ONLY, so this is inert with a mouse and costs the desktop build nothing - there
 * is no platform check because the absence of touch is the check.
 *
 * NON-PASSIVE touchmove, deliberately. Suppressing the browser's own overscroll while the
 * spacer opens needs preventDefault, and a passive listener cannot call it. The listener is
 * attached by hand rather than through React's onTouchMove for exactly this reason.
 */

/** How far the finger must travel before the gesture counts as a refresh. */
const THRESHOLD_PX = 70;
/** The spacer stops growing here, however hard the pull. */
const MAX_PULL_PX = 110;
/**
 * Fraction of finger movement the spacer follows. Less than 1 so the pull feels weighted and,
 * more usefully, so a short accidental drag does not reach the threshold.
 */
const RESISTANCE = 0.5;
/** Past this much sideways movement the gesture is a horizontal swipe, not a pull. */
const HORIZONTAL_TOLERANCE_PX = 12;

export interface UsePullToRefreshOptions {
  /** The element that actually scrolls - not its parent. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /**
   * Refetches the screen. Awaited, so the indicator stops when the data really has landed.
   *
   * May reject; the indicator is cleared in a `finally` either way. Callers that already
   * surface their own error state (the inbox does) need do nothing extra.
   */
  onRefresh: () => Promise<unknown>;
  /** Off while a dialog is open, or on a screen with nothing to refetch. */
  enabled?: boolean;
}

export interface PullToRefreshState {
  /** Current spacer height in pixels. Drives the indicator. */
  pullDistance: number;
  /** True once past the threshold, so the label can change before the finger lifts. */
  armed: boolean;
  /** True while onRefresh is in flight. */
  refreshing: boolean;
}

export const PULL_TO_REFRESH_THRESHOLD_PX = THRESHOLD_PX;
export const PULL_TO_REFRESH_MAX_PX = MAX_PULL_PX;

/**
 * The pure part of the gesture: how far the spacer opens for a given finger travel.
 *
 * Separated from the event plumbing so the resistance curve and the cap can be tested without
 * synthesising touches.
 */
export const computePullDistance = (deltaY: number): number => {
  if (deltaY <= 0) {
    return 0;
  }

  return Math.min(deltaY * RESISTANCE, MAX_PULL_PX);
};

/** Whether a finished drag should trigger a refetch. */
export const shouldTriggerRefresh = (pullDistance: number): boolean =>
  pullDistance >= THRESHOLD_PX;

export const usePullToRefresh = ({
  scrollRef,
  onRefresh,
  enabled = true,
}: UsePullToRefreshOptions): PullToRefreshState => {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  /** Where the finger landed, or null when this touch is not a candidate. */
  const startYRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  /** Set once a touch has been ruled out, so later moves in the same drag stay ruled out. */
  const rejectedRef = useRef(false);
  /** Mirrors `refreshing` for the event handlers, which close over a stale state value. */
  const refreshingRef = useRef(false);
  /** Latest callback, so re-renders do not require re-attaching listeners. */
  const onRefreshRef = useRef(onRefresh);
  /**
   * `pullDistance` mirrored for touchend, and WRITTEN SYNCHRONOUSLY alongside every setState
   * below rather than from an effect.
   *
   * Two reasons, and the second is the one that bites. The listeners are attached once, so a
   * state value captured in that closure would be the value at attach time - always zero.
   * And syncing through an effect means the ref only catches up after React has re-rendered:
   * a touchend arriving in the same tick as the last touchmove would read the PREVIOUS
   * distance, so a fast flick - exactly how an impatient person pulls - would silently fail
   * to refresh.
   */
  const pullDistanceRef = useRef(0);

  /** Keeps the ref and the state in step; everything below uses this, never setPullDistance. */
  const applyPullDistance = useCallback((distance: number) => {
    pullDistanceRef.current = distance;
    setPullDistance(distance);
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const reset = useCallback(() => {
    startYRef.current = null;
    rejectedRef.current = false;
    applyPullDistance(0);
  }, [applyPullDistance]);

  useEffect(() => {
    const element = scrollRef.current;

    if (!element || !enabled) {
      return;
    }

    const handleTouchStart = (event: TouchEvent) => {
      // A refresh in flight, or a multi-finger gesture (pinch-zoom), is never a pull.
      if (refreshingRef.current || event.touches.length !== 1) {
        startYRef.current = null;
        rejectedRef.current = true;

        return;
      }

      // THE GUARD THAT MATTERS: only a container already at the top can be pulled. Without
      // this, flicking upward mid-list would open the spacer as the list reached the top.
      if (element.scrollTop > 0) {
        startYRef.current = null;
        rejectedRef.current = true;

        return;
      }

      const touch = event.touches[0];

      if (!touch) {
        return;
      }

      startYRef.current = touch.clientY;
      startXRef.current = touch.clientX;
      rejectedRef.current = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const startY = startYRef.current;

      if (startY === null || rejectedRef.current || refreshingRef.current) {
        return;
      }

      const touch = event.touches[0];

      if (!touch) {
        return;
      }

      const deltaY = touch.clientY - startY;
      const deltaX = Math.abs(touch.clientX - startXRef.current);

      // Sideways: a back-swipe or a horizontally scrolling row. Give up on this touch rather
      // than fighting it.
      if (deltaX > HORIZONTAL_TOLERANCE_PX && deltaX > Math.abs(deltaY)) {
        rejectedRef.current = true;
        applyPullDistance(0);

        return;
      }

      // Upward, or the user scrolled away from the top mid-drag: ordinary scrolling.
      if (deltaY <= 0 || element.scrollTop > 0) {
        applyPullDistance(0);

        return;
      }

      const distance = computePullDistance(deltaY);

      // Only once the pull is real. Calling this for every downward touch at the top would
      // suppress legitimate scrolling on a list shorter than its container.
      if (distance > 0 && event.cancelable) {
        event.preventDefault();
      }

      applyPullDistance(distance);
    };

    const handleTouchEnd = () => {
      const distance = pullDistanceRef.current;

      startYRef.current = null;
      rejectedRef.current = false;

      if (!shouldTriggerRefresh(distance) || refreshingRef.current) {
        applyPullDistance(0);

        return;
      }

      refreshingRef.current = true;
      setRefreshing(true);
      // Held open at the threshold while the request runs, so the spinner has somewhere to be.
      applyPullDistance(THRESHOLD_PX);

      void Promise.resolve()
        .then(() => onRefreshRef.current())
        .catch(() => {
          // Swallowed on purpose. The screen owns its own error display; what must not happen
          // is the indicator spinning forever because a fetch rejected.
        })
        .finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          applyPullDistance(0);
        });
    };

    const handleTouchCancel = () => {
      if (!refreshingRef.current) {
        reset();
      }
    };

    // passive: false on move only - see the header. The others never call preventDefault.
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });
    element.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [scrollRef, enabled, reset, applyPullDistance]);

  return {
    pullDistance,
    armed: pullDistance >= THRESHOLD_PX,
    refreshing,
  };
};
