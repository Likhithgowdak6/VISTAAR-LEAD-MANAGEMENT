/**
 * The history bookkeeping behind the phone's back gesture.
 *
 * WHY THIS IS UNIT-TESTED RATHER THAN LEFT TO THE BROWSER CHECK. The failure mode is invisible
 * one step after it happens: a miscounted popstate does not break the gesture that caused it,
 * it breaks the NEXT one, by which point the person is two screens away and it reads as "back
 * is just unreliable". That is exactly the complaint this change set exists to fix, so the
 * counting is pinned down here.
 *
 * `window.history` is stubbed rather than driven through jsdom's own implementation: the thing
 * under test is how many popstate events we expect for a given call, and jsdom's fidelity on
 * `go(-n)` is not the contract real browsers follow. Dispatching the events by hand states the
 * real browser's behaviour explicitly, which is what the code has to survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  backStackDepth,
  pushBackLayer,
  removeBackLayer,
  resetMobileBackStack,
  startMobileBackStack,
} from '../lib/mobile-back-stack';

/** Lets the module's queued reconcile run. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/** One popstate, the way a browser delivers it after any traversal. */
const browserPopState = async (state: unknown = null) => {
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
  await settle();
};

let pushState: Mock<(state: unknown, title: string) => void>;
let go: Mock<(delta: number) => void>;

beforeEach(() => {
  resetMobileBackStack();
  pushState = vi.fn();
  go = vi.fn();

  vi.stubGlobal('history', {
    get state() {
      return null;
    },
    pushState,
    go,
    back: () => go(-1),
  });

  startMobileBackStack();
});

afterEach(() => {
  resetMobileBackStack();
  vi.unstubAllGlobals();
});

describe('one layer, one history entry', () => {
  it('takes an entry when a layer opens', async () => {
    pushBackLayer(vi.fn());
    await settle();

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(backStackDepth()).toBe(1);
  });

  it('closes the top layer when the person presses back', async () => {
    const onBack = vi.fn();
    pushBackLayer(onBack);
    await settle();

    await browserPopState();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(backStackDepth()).toBe(0);
    // The browser already dropped the entry; asking for it again would skip a second screen.
    expect(go).not.toHaveBeenCalled();
  });

  it('closes layers newest first', async () => {
    const order: string[] = [];
    pushBackLayer(() => order.push('outer'));
    await settle();
    pushBackLayer(() => order.push('inner'));
    await settle();

    await browserPopState();
    await browserPopState();

    expect(order).toEqual(['inner', 'outer']);
  });
});

describe('closing a layer from inside the app', () => {
  it('hands the entry back so the stack does not drift', async () => {
    const layer = pushBackLayer(vi.fn());
    await settle();

    removeBackLayer(layer);
    await settle();

    expect(go).toHaveBeenCalledWith(-1);
    expect(backStackDepth()).toBe(0);
  });

  it('does not close a second layer when that traversal lands', async () => {
    const outer = vi.fn();
    pushBackLayer(outer);
    await settle();
    const inner = pushBackLayer(vi.fn());
    await settle();

    removeBackLayer(inner);
    await settle();
    // The popstate the `go` above causes. It is ours, so nothing else may close.
    await browserPopState();

    expect(outer).not.toHaveBeenCalled();
    expect(backStackDepth()).toBe(1);
  });

  /**
   * THE BUG THIS FILE WAS WRITTEN FOR, found in the browser rather than by reading the code.
   *
   * `history.go(-2)` moves two entries and fires ONE popstate - it traverses to the destination
   * and notifies once. The first implementation expected one per entry and swallowed two, so
   * the surplus ate the person's NEXT real back gesture: close the lead panel with the in-app
   * arrow, reopen a thread, swipe back, and the thread stayed on screen while the history moved
   * underneath it.
   */
  it('expects ONE popstate from a multi-entry traversal, not one per entry', async () => {
    const outer = vi.fn();
    const outerLayer = pushBackLayer(outer);
    await settle();
    const innerLayer = pushBackLayer(vi.fn());
    await settle();

    // Both close in the same commit, the way tapping "← Inbox" from inside the lead panel
    // unmounts the thread and takes the panel with it.
    removeBackLayer(innerLayer);
    removeBackLayer(outerLayer);
    await settle();

    expect(go).toHaveBeenCalledWith(-2);

    // The single popstate that traversal produces.
    await browserPopState();

    // A genuine back gesture now has to be acted on, not swallowed by a leftover count.
    const reopened = vi.fn();
    pushBackLayer(reopened);
    await settle();
    await browserPopState();

    expect(reopened).toHaveBeenCalledTimes(1);
    expect(backStackDepth()).toBe(0);
  });
});

describe('a layer opening as another closes', () => {
  it('leaves history alone when the depth is unchanged', async () => {
    const first = pushBackLayer(vi.fn());
    await settle();
    pushState.mockClear();

    // The add-lead dialog dismissing itself and opening the new thread, in one commit.
    removeBackLayer(first);
    pushBackLayer(vi.fn());
    await settle();

    // Net depth is the same, so neither a push nor a traversal should have happened - the
    // entry is simply reused. Doing both would race, and the order they resolve in is not
    // something the app controls.
    expect(pushState).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(backStackDepth()).toBe(1);
  });
});

describe('a back press with nothing of ours open', () => {
  it('is left entirely alone', async () => {
    // In a tab this is the person leaving the app; in the Android shell the listener in
    // capacitor-back.ts has already chosen to exit. Either way this module must not interfere.
    await browserPopState();

    expect(go).not.toHaveBeenCalled();
    expect(backStackDepth()).toBe(0);
  });
});
