/**
 * The hook that decides whether the phone chrome or the desktop masthead renders.
 *
 * WHY THIS IS A UNIT TEST AND NOT A BROWSER CHECK. The behaviour that matters is what happens
 * when the viewport CROSSES the breakpoint while the app is open - rotating a tablet between
 * 768 and 1024, or dragging a desktop window narrow. The preview harness used for the visual
 * pass cannot exercise it: it applies viewport and media emulation without dispatching any
 * MediaQueryList `change` event, which was confirmed on two independent media features
 * (`max-width` and `prefers-color-scheme` both changed value with zero events observed). Every
 * width was therefore verified on a fresh load there, and the crossing is pinned down here.
 *
 * The failure this guards against is specific and was observed: the shell renders the desktop
 * masthead while the layout has already switched to the phone one, because only the hook's
 * subscription can re-render AppShell - a state change further down the tree re-renders the
 * child, not the parent that owns the hook.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIsMobileViewport, MOBILE_BACK_QUERY } from '../hooks/useMobileBackLayer';

/** A controllable stand-in for one MediaQueryList, plus the window resize channel. */
const installMatchMedia = (initialMatches: boolean) => {
  const listeners = new Set<() => void>();
  const resizeListeners = new Set<() => void>();
  let matches = initialMatches;

  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      expect(query).toBe(MOBILE_BACK_QUERY);
      return {
        get matches() {
          return matches;
        },
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      };
    }),
  );

  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: never) => {
    if (type === 'resize') resizeListeners.add(fn as unknown as () => void);
    else realAdd(type as keyof WindowEventMap, fn);
  }) as typeof window.addEventListener);
  vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, fn: never) => {
    if (type === 'resize') resizeListeners.delete(fn as unknown as () => void);
    else realRemove(type as keyof WindowEventMap, fn);
  }) as typeof window.removeEventListener);

  return {
    /** Crosses the breakpoint and notifies the way a browser does. */
    cross: (next: boolean, via: 'change' | 'resize' = 'change') => {
      matches = next;
      act(() => {
        (via === 'change' ? listeners : resizeListeners).forEach((fn) => fn());
      });
    },
    listenerCount: () => listeners.size,
    resizeListenerCount: () => resizeListeners.size,
  };
};

const Probe = () => <span>{useIsMobileViewport() ? 'mobile' : 'desktop'}</span>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which chrome renders', () => {
  it('reads the viewport on first render', () => {
    installMatchMedia(true);
    render(<Probe />);

    expect(screen.getByText('mobile')).toBeInTheDocument();
  });

  it('switches to the phone chrome when the viewport narrows past the breakpoint', () => {
    const media = installMatchMedia(false);
    render(<Probe />);
    expect(screen.getByText('desktop')).toBeInTheDocument();

    media.cross(true);

    // THE REGRESSION. Without a working subscription the shell keeps the desktop masthead
    // while the layout underneath it has already become the phone one.
    expect(screen.getByText('mobile')).toBeInTheDocument();
  });

  it('switches back when it widens again', () => {
    const media = installMatchMedia(true);
    render(<Probe />);

    media.cross(false);

    expect(screen.getByText('desktop')).toBeInTheDocument();
  });

  it('also reacts to a plain resize, for WebViews that rotate without a media event', () => {
    const media = installMatchMedia(false);
    render(<Probe />);

    media.cross(true, 'resize');

    expect(screen.getByText('mobile')).toBeInTheDocument();
  });

  it('unsubscribes from both channels on unmount', () => {
    const media = installMatchMedia(true);
    const { unmount } = render(<Probe />);

    expect(media.listenerCount()).toBe(1);
    expect(media.resizeListenerCount()).toBe(1);

    unmount();

    // A leaked listener on a hook used by half a dozen components is a slow leak that only
    // shows up after an hour of navigating.
    expect(media.listenerCount()).toBe(0);
    expect(media.resizeListenerCount()).toBe(0);
  });

  it('reports desktop where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);

    // The safe default: every existing test and any non-browser render keeps the layout it
    // already had, rather than silently switching to phone chrome.
    expect(screen.getByText('desktop')).toBeInTheDocument();
  });
});
