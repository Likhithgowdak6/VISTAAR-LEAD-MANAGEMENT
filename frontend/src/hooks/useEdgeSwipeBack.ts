import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { hapticSelection } from '../lib/haptics';

interface UseEdgeSwipeBackOptions {
  onBack: () => void;
  enabled?: boolean;
  edgeThresholdPx?: number;
  triggerDistancePx?: number;
}

interface EdgeSwipeBackResult {
  swipeX: number;
  isSwiping: boolean;
  style: CSSProperties;
}

/**
 * Apple-inspired Edge Swipe Back gesture hook.
 * Detects touch swipes originating from the very left edge (<=35px) of the screen,
 * dragging the active view horizontally with tactile physics, then triggering onBack()
 * with spring animation when completed.
 */
export const useEdgeSwipeBack = ({
  onBack,
  enabled = true,
  edgeThresholdPx = 35,
  triggerDistancePx = 110,
}: UseEdgeSwipeBackOptions): EdgeSwipeBackResult => {
  const [swipeX, setSwipeX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const isCandidateRef = useRef(false);
  const triggeredRef = useRef(false);
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX <= edgeThresholdPx) {
        startXRef.current = touch.clientX;
        startYRef.current = touch.clientY;
        isCandidateRef.current = true;
        triggeredRef.current = false;
      } else {
        isCandidateRef.current = false;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isCandidateRef.current || startXRef.current === null || startYRef.current === null) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaY = Math.abs(touch.clientY - startYRef.current);

      // If vertical movement dominates, cancel the back-swipe
      if (deltaY > deltaX && deltaY > 15) {
        isCandidateRef.current = false;
        setIsSwiping(false);
        setSwipeX(0);
        return;
      }

      if (deltaX > 8) {
        setIsSwiping(true);
        const resistedX = Math.max(0, deltaX);
        setSwipeX(resistedX);

        if (resistedX >= triggerDistancePx && !triggeredRef.current) {
          triggeredRef.current = true;
          void hapticSelection();
        } else if (resistedX < triggerDistancePx) {
          triggeredRef.current = false;
        }

        if (e.cancelable) {
          e.preventDefault();
        }
      }
    };

    const handleTouchEnd = () => {
      if (isCandidateRef.current && isSwiping) {
        if (triggeredRef.current || swipeX >= triggerDistancePx) {
          setSwipeX(window.innerWidth);
          setTimeout(() => {
            onBackRef.current();
            setSwipeX(0);
            setIsSwiping(false);
          }, 180);
        } else {
          setSwipeX(0);
          setIsSwiping(false);
        }
      }
      isCandidateRef.current = false;
      startXRef.current = null;
      startYRef.current = null;
    };

    const handleTouchCancel = () => {
      isCandidateRef.current = false;
      setIsSwiping(false);
      setSwipeX(0);
      startXRef.current = null;
      startYRef.current = null;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [enabled, edgeThresholdPx, triggerDistancePx, isSwiping, swipeX]);

  const style: CSSProperties = {
    transform: swipeX > 0 ? `translateX(${swipeX}px)` : undefined,
    transition: isSwiping ? 'none' : 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)',
    boxShadow: isSwiping ? '-8px 0 24px rgba(0, 0, 0, 0.15)' : undefined,
    willChange: isSwiping ? 'transform' : undefined,
  };

  return { swipeX, isSwiping, style };
};

