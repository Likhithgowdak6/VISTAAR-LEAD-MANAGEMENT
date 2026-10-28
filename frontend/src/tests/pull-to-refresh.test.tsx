/**
 * Pull-to-refresh: the gesture maths, and the indicator that reports it.
 *
 * WHAT THESE ARE REALLY GUARDING. The risk in a pull-to-refresh is not that the refresh fails -
 * it is that the gesture fires when the user meant to scroll, or swipe back, or tap. Every
 * false positive refetches the list under someone's finger and moves the row they were aiming
 * at. So most of this file is about the cases that must NOT trigger.
 *
 * The hook's event plumbing is exercised by driving real touch events at a real scroll
 * container, because the parts most likely to break - the at-the-top check, the horizontal
 * rejection, the double-fire guard - live in the listeners rather than in the arithmetic.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PullToRefreshIndicator from '../components/PullToRefreshIndicator';
import {
  computePullDistance,
  PULL_TO_REFRESH_MAX_PX,
  PULL_TO_REFRESH_THRESHOLD_PX,
  shouldTriggerRefresh,
  usePullToRefresh,
} from '../hooks/usePullToRefresh';

describe('how far the spacer opens', () => {
  it('stays shut for an upward drag', () => {
    expect(computePullDistance(-40)).toBe(0);
    expect(computePullDistance(0)).toBe(0);
  });

  it('follows the finger at a resistance, so a short drag does not reach the threshold', () => {
    expect(computePullDistance(40)).toBe(20);
    expect(computePullDistance(100)).toBe(50);
  });

  it('CAPS, so a hard fling cannot open an arbitrarily large gap', () => {
    expect(computePullDistance(10_000)).toBe(PULL_TO_REFRESH_MAX_PX);
  });

  it('needs a deliberate pull to arm', () => {
    expect(shouldTriggerRefresh(PULL_TO_REFRESH_THRESHOLD_PX - 1)).toBe(false);
    expect(shouldTriggerRefresh(PULL_TO_REFRESH_THRESHOLD_PX)).toBe(true);
  });

  it('a 40px drag - a hesitant scroll - does NOT arm', () => {
    expect(shouldTriggerRefresh(computePullDistance(40))).toBe(false);
  });
});

/** A scrollable list whose scrollTop the test controls. */
const Harness = ({
  onRefresh,
  scrollTop = 0,
}: {
  onRefresh: () => Promise<unknown>;
  scrollTop?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({ scrollRef: ref, onRefresh });

  return (
    <div
      ref={(node) => {
        ref.current = node;

        if (node) {
          Object.defineProperty(node, 'scrollTop', { value: scrollTop, writable: true });
        }
      }}
      data-testid="scroller"
    >
      <PullToRefreshIndicator
        distance={pull.pullDistance}
        armed={pull.armed}
        refreshing={pull.refreshing}
      />
    </div>
  );
};

const touch = (clientY: number, clientX = 50) => ({ clientY, clientX });

const pullBy = (element: HTMLElement, deltaY: number, deltaX = 0) => {
  fireEvent.touchStart(element, { touches: [touch(100)] });
  fireEvent.touchMove(element, { touches: [touch(100 + deltaY, 50 + deltaX)] });
  fireEvent.touchEnd(element, { touches: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the gesture', () => {
  it('refreshes after a deliberate downward pull from the top', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), 200);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('DOES NOT REFRESH when the list is not scrolled to the top', async () => {
    // The commonest false positive: flicking up through a long list.
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} scrollTop={400} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), 200);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('IGNORES A DRAG THAT BEGAN MID-SCROLL, even once momentum reaches the top', async () => {
    /*
     * The case the touchstart guard exists for, and the one the other tests miss: the finger
     * lands while the list is still gliding, so this is a scroll the user is arresting - not a
     * pull. By the time they drag downward the list has reached the top, and without the
     * touchstart check the gesture would engage and refetch under their finger.
     */
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} scrollTop={400} />);
    const scroller = screen.getByTestId('scroller');

    await act(async () => {
      fireEvent.touchStart(scroller, { touches: [touch(100)] });
      // Momentum carries it to the top mid-gesture.
      (scroller as HTMLElement & { scrollTop: number }).scrollTop = 0;
      fireEvent.touchMove(scroller, { touches: [touch(300)] });
      fireEvent.touchEnd(scroller, { touches: [] });
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh on a short drag', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), 40);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not refresh on an upward drag', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), -200);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('IGNORES A HORIZONTAL SWIPE, which is how the user goes back', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), 200, 300);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('ignores a two-finger gesture, which is a pinch-zoom', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);
    const scroller = screen.getByTestId('scroller');

    await act(async () => {
      fireEvent.touchStart(scroller, { touches: [touch(100), touch(140)] });
      fireEvent.touchMove(scroller, { touches: [touch(300), touch(340)] });
      fireEvent.touchEnd(scroller, { touches: [] });
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('DOES NOT DOUBLE-FETCH when pulled again mid-refresh', async () => {
    let release: () => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness onRefresh={onRefresh} />);
    const scroller = screen.getByTestId('scroller');

    await act(async () => {
      pullBy(scroller, 200);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Impatient second pull while the first is still in flight.
    await act(async () => {
      pullBy(scroller, 200);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
  });

  it('STOPS THE INDICATOR WHEN THE REFRESH FAILS', async () => {
    // A spinner that never stops is worse than a failed refresh: it tells the user the app is
    // still working when it has given up.
    const onRefresh = vi.fn().mockRejectedValue(new Error('offline'));
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      pullBy(screen.getByTestId('scroller'), 200);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('pull-to-refresh-indicator')).toHaveStyle({ height: '0px' });
  });

  it('can refresh again after one finishes', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<Harness onRefresh={onRefresh} />);
    const scroller = screen.getByTestId('scroller');

    await act(async () => {
      pullBy(scroller, 200);
    });
    await act(async () => {
      pullBy(scroller, 200);
    });

    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('the indicator', () => {
  it('takes no space and announces nothing while idle', () => {
    render(<PullToRefreshIndicator distance={0} armed={false} refreshing={false} />);

    const node = screen.getByTestId('pull-to-refresh-indicator');
    expect(node).toHaveStyle({ height: '0px' });
    expect(node).toHaveAttribute('aria-hidden', 'true');
  });

  it('invites the pull, then says it will fire', () => {
    const { rerender } = render(
      <PullToRefreshIndicator distance={20} armed={false} refreshing={false} />,
    );
    expect(screen.getByText('Pull to refresh')).toBeInTheDocument();

    rerender(<PullToRefreshIndicator distance={80} armed refreshing={false} />);
    expect(screen.getByText('Release to refresh')).toBeInTheDocument();
  });

  it('reports the refresh as a live status', () => {
    render(<PullToRefreshIndicator distance={70} armed refreshing />);

    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
