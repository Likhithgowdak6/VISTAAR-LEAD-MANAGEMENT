import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a scroll container's position across being hidden and shown again.
 *
 * WHY IT IS NEEDED. On a phone the inbox and the open thread are the same screen: the shell
 * hides the list with `display: none` rather than unmounting it, so filters and loaded rows
 * survive. Scroll position does not - a box with no layout has no scrollTop, and the browser
 * restores it as 0. Reading three screens down the inbox, opening a lead and coming back put
 * you at the top again, which on a long list is the difference between glancing at a thread
 * and losing your place.
 *
 * WHY VISIBILITY IS OBSERVED RATHER THAN PASSED IN. The same component is a permanent rail on
 * a desktop viewport, where it is never hidden and must never have its scroll touched. A prop
 * derived from "is a conversation open" would be true on a laptop too and would fight the
 * owner's own scrolling. A ResizeObserver reports what actually happened to the box: zero
 * height means the ancestor went `display: none`, whatever the breakpoint decided.
 */
export const useScrollMemory = (ref: RefObject<HTMLElement | null>): void => {
  const positionRef = useRef(0);
  const wasVisibleRef = useRef(true);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const remember = () => {
      // Only while on screen. A scroll event cannot fire on a hidden box, but guarding here
      // keeps a stray programmatic scroll from recording 0 over a good position.
      if (element.offsetParent !== null) {
        positionRef.current = element.scrollTop;
      }
    };

    element.addEventListener('scroll', remember, { passive: true });

    const observer = new ResizeObserver(() => {
      const isVisible = element.offsetHeight > 0;

      if (isVisible && !wasVisibleRef.current && positionRef.current > 0) {
        element.scrollTop = positionRef.current;
      }

      wasVisibleRef.current = isVisible;
    });

    observer.observe(element);
    wasVisibleRef.current = element.offsetHeight > 0;

    return () => {
      element.removeEventListener('scroll', remember);
      observer.disconnect();
    };
  }, [ref]);
};
