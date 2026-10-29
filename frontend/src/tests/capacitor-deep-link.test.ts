/**
 * A WhatsApp link tapped on Android, arriving as an intent instead of as a page load.
 *
 * THE TWO ARRIVALS ARE THE WHOLE POINT. `getLaunchUrl` is the cold start - the link started the
 * app. `appUrlOpen` is the warm one - the app was already in the background. Handling only the
 * first means a tapped link does nothing whenever Vistaar happens to already be open, which is
 * most of the time; handling only the second means it does nothing when it is not.
 *
 * AND SO IS THE BUFFER. This starts before the first render, but the thing that can open a lead
 * is AppShell, which mounts later and only once somebody is signed in. A target that arrives
 * before that has to be held, not dropped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DeepLinkRuntime,
  onDeepLinkOpened,
  startCapacitorDeepLinks,
  stopCapacitorDeepLinks,
} from '../lib/capacitor-deep-link';

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';
const ORIGIN = 'https://vistaarcrm.duckdns.org';

/** A fake Capacitor. `fire` is the handler the plugin would have called. */
const nativeRuntime = (launchUrl: string | null = null) => {
  let fire: ((url: string) => void) | null = null;
  const remove = vi.fn();

  const runtime: DeepLinkRuntime = {
    isNative: () => true,
    getLaunchUrl: () => Promise.resolve(launchUrl ? { url: launchUrl } : null),
    addUrlListener: (handler) => {
      fire = handler;
      return Promise.resolve({ remove });
    },
  };

  return { runtime, remove, open: (url: string) => fire?.(url) };
};

afterEach(() => {
  stopCapacitorDeepLinks();
  vi.clearAllMocks();
});

describe('a cold start from a link', () => {
  it('delivers the lead and the reminder the link named', async () => {
    const { runtime } = nativeRuntime(`${ORIGIN}/?conversation=${CONVERSATION_ID}&reminder=${TASK_ID}`);
    const onTarget = vi.fn();

    startCapacitorDeepLinks(runtime);
    onDeepLinkOpened(onTarget);
    await vi.waitFor(() => expect(onTarget).toHaveBeenCalled());

    expect(onTarget).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      reminderId: TASK_ID,
    });
  });

  it('BUFFERS A LINK THAT ARRIVES BEFORE ANYTHING SUBSCRIBES', async () => {
    // The real order on a cold start: the launch URL resolves while the app is still on the
    // splash screen or the sign-in form, and AppShell does not exist yet. Dropping it here is
    // the bug this buffer exists to prevent.
    const { runtime } = nativeRuntime(`${ORIGIN}/?conversation=${CONVERSATION_ID}`);

    startCapacitorDeepLinks(runtime);
    await Promise.resolve();
    await Promise.resolve();

    const onTarget = vi.fn();
    onDeepLinkOpened(onTarget);

    expect(onTarget).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      reminderId: null,
    });
  });

  it('delivers a buffered link ONCE, not on every subscribe', async () => {
    const { runtime } = nativeRuntime(`${ORIGIN}/?conversation=${CONVERSATION_ID}`);

    startCapacitorDeepLinks(runtime);
    await Promise.resolve();
    await Promise.resolve();

    const first = vi.fn();
    const unsubscribe = onDeepLinkOpened(first);
    unsubscribe();

    const second = vi.fn();
    onDeepLinkOpened(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('stays quiet for an ordinary icon tap', async () => {
    const { runtime } = nativeRuntime(null);
    const onTarget = vi.fn();

    startCapacitorDeepLinks(runtime);
    onDeepLinkOpened(onTarget);
    await Promise.resolve();
    await Promise.resolve();

    expect(onTarget).not.toHaveBeenCalled();
  });
});

describe('a link tapped while the app is already running', () => {
  it('delivers it to the live subscriber', async () => {
    const { runtime, open } = nativeRuntime(null);
    const onTarget = vi.fn();

    startCapacitorDeepLinks(runtime);
    onDeepLinkOpened(onTarget);
    await Promise.resolve();

    open(`${ORIGIN}/?conversation=${CONVERSATION_ID}&reminder=${TASK_ID}`);

    expect(onTarget).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      reminderId: TASK_ID,
    });
  });

  it('ignores a URL that names nothing we can open', async () => {
    const { runtime, open } = nativeRuntime(null);
    const onTarget = vi.fn();

    startCapacitorDeepLinks(runtime);
    onDeepLinkOpened(onTarget);
    await Promise.resolve();
    await Promise.resolve();

    open(`${ORIGIN}/`);
    open(`${ORIGIN}/?conversation=../../admin`);
    open('not a url');

    expect(onTarget).not.toHaveBeenCalled();
  });
});

describe('the browser', () => {
  it('REGISTERS NOTHING. The address bar already carries the parameters', () => {
    // readDeepLinkTarget reads them off `window.location` on the web - see deep-link.ts. A
    // listener here would be a second, competing way in.
    const { runtime } = nativeRuntime(`${ORIGIN}/?conversation=${CONVERSATION_ID}`);
    const getLaunchUrl = vi.spyOn(runtime, 'getLaunchUrl');
    const addUrlListener = vi.spyOn(runtime, 'addUrlListener');

    startCapacitorDeepLinks({ ...runtime, isNative: () => false });

    expect(getLaunchUrl).not.toHaveBeenCalled();
    expect(addUrlListener).not.toHaveBeenCalled();
  });
});

describe('starting twice', () => {
  it('registers one listener, not two', async () => {
    // One tap must open one lead. A second registration would deliver every link twice.
    const { runtime } = nativeRuntime(null);
    const addUrlListener = vi.spyOn(runtime, 'addUrlListener');

    startCapacitorDeepLinks(runtime);
    startCapacitorDeepLinks(runtime);
    await Promise.resolve();

    expect(addUrlListener).toHaveBeenCalledTimes(1);
  });
});
