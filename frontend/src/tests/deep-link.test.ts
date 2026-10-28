/**
 * Opening a lead from a WhatsApp notification link.
 *
 * WHAT THE PARAMETER IS AND IS NOT. It names a record; it authorises nothing. An unauthenticated
 * visitor gets the sign-in screen, and every fetch afterwards is scoped server-side to the
 * caller's organisation exactly as it is for a thread clicked in the inbox - there is no new
 * endpoint and no new way in. These tests cover the reading and wiping of the parameter; the
 * authorisation itself is the conversation routes' existing, unchanged behaviour.
 *
 * THE WIPE IS NOT COSMETIC. Left in the address bar, a refresh drags the owner back to the
 * thread they had just navigated away from, and the URL carries a lead id into anything it is
 * pasted into.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearDeepLinkTarget, readDeepLinkTarget } from '../lib/deep-link';

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';

describe('reading the target', () => {
  it('reads a lead link', () => {
    expect(readDeepLinkTarget(`?conversation=${CONVERSATION_ID}`)).toEqual({
      conversationId: CONVERSATION_ID,
      reminderId: null,
    });
  });

  it('reads a reminder link, carrying both ids', () => {
    expect(readDeepLinkTarget(`?conversation=${CONVERSATION_ID}&reminder=${TASK_ID}`)).toEqual({
      conversationId: CONVERSATION_ID,
      reminderId: TASK_ID,
    });
  });

  it('is null for an ordinary page load', () => {
    expect(readDeepLinkTarget('')).toBeNull();
    expect(readDeepLinkTarget('?metaConnect=1&metaConnectResult=connected')).toBeNull();
  });

  it.each([
    ['empty', '?conversation='],
    ['too short', '?conversation=abc'],
    ['not hex', '?conversation=zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['a name', '?conversation=MD%20Afjal'],
    ['a phone number', '?conversation=%2B919876543210'],
    ['an injection attempt', '?conversation=../../admin'],
  ])('REFUSES A MALFORMED ID (%s)', (_label: string, search: string) => {
    // Passing one through would mean a failed fetch and an error screen, which reads as "the
    // CRM is broken" rather than "that link was not valid".
    expect(readDeepLinkTarget(search)).toBeNull();
  });

  it('ignores a malformed reminder id but still opens the lead', () => {
    expect(readDeepLinkTarget(`?conversation=${CONVERSATION_ID}&reminder=nonsense`)).toEqual({
      conversationId: CONVERSATION_ID,
      reminderId: null,
    });
  });

  it('coexists with the Meta callback parameters', () => {
    const target = readDeepLinkTarget(`?metaConnect=1&conversation=${CONVERSATION_ID}`);

    expect(target?.conversationId).toBe(CONVERSATION_ID);
  });
});

describe('wiping the address bar', () => {
  const replaceState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      location: { href: `https://vistaarcrm.duckdns.org/?conversation=${CONVERSATION_ID}` },
      history: { replaceState },
    });
  });

  it('removes both parameters', () => {
    clearDeepLinkTarget();

    expect(replaceState).toHaveBeenCalledTimes(1);
    const url = String(replaceState.mock.calls[0]![2]);
    expect(url).not.toContain('conversation=');
    expect(url).not.toContain('reminder=');
  });

  it('LEAVES OTHER PARAMETERS ALONE', () => {
    // The Meta callback owns its own three and clears them itself; stripping the whole query
    // here would swallow a result the wizard is waiting for.
    vi.stubGlobal('window', {
      location: {
        href: `https://vistaarcrm.duckdns.org/?metaConnect=1&conversation=${CONVERSATION_ID}`,
      },
      history: { replaceState },
    });

    clearDeepLinkTarget();

    expect(String(replaceState.mock.calls[0]![2])).toContain('metaConnect=1');
  });

  it('does nothing without a history API, rather than throwing', () => {
    vi.stubGlobal('window', { location: { href: 'https://x/' }, history: {} });

    expect(() => clearDeepLinkTarget()).not.toThrow();
  });
});
