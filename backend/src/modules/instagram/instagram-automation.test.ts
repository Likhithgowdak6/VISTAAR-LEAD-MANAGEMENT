/**
 * Which automatic replies go out, and — far more importantly — which do not.
 *
 * AN AUTOMATIC REPLY IS A MESSAGE TO A STRANGER FROM A BUSINESS'S OWN ACCOUNT. The failures worth
 * testing are all of the form "it said something it should not have":
 *
 *   - to a workspace that never switched automation on
 *   - into a thread a human has taken over
 *   - twice, because Meta redelivered the webhook
 *   - with the HUMAN_AGENT tag, which would be a false declaration to Meta about who is replying
 */

import { describe, expect, it } from 'vitest';

import {
  chooseInstagramReply,
  matchKeywordReply,
} from './instagram-automation.service.js';

const account = (over: Record<string, unknown> = {}) =>
  ({
    welcomeReply: 'Thanks for getting in touch — what date are you looking at?',
    keywordReplies: [
      { keyword: 'price', reply: 'Packages start at ₹1,50,000. What date?' },
      { keyword: 'availab', reply: 'Tell me the date and I will check.' },
    ],
    ...over,
  }) as never;

describe('keyword matching', () => {
  it('matches a keyword anywhere in the message', () => {
    // "whats the price?" must hit a `price` rule. Requiring an exact match would make keyword
    // replies useless in practice.
    expect(
      matchKeywordReply('whats the price for a full day?', account().keywordReplies),
    ).toContain('Packages start at');
  });

  it('ignores case', () => {
    expect(matchKeywordReply('PRICE please', account().keywordReplies)).toContain('Packages');
  });

  it('matches a partial stem, so availability and available both land', () => {
    const rules = account().keywordReplies;

    expect(matchKeywordReply('are you available in March?', rules)).toContain('check');
    expect(matchKeywordReply('whats your availability?', rules)).toContain('check');
  });

  it('takes the FIRST match, so the settings order is the priority', () => {
    /**
     * First rather than longest or best, because the order in the list is something an admin can
     * see and reorder — "longest match wins" is a rule they cannot inspect or control.
     */
    const rules = [
      { keyword: 'price', reply: 'first rule' },
      { keyword: 'price for a wedding', reply: 'second rule' },
    ];

    expect(matchKeywordReply('price for a wedding please', rules)).toBe('first rule');
  });

  it('returns nothing when no keyword appears', () => {
    expect(matchKeywordReply('hello there', account().keywordReplies)).toBeNull();
  });

  it.each([null, undefined, ''])('returns nothing for %s message text', (text) => {
    // An image with no caption arrives with no text at all.
    expect(matchKeywordReply(text as never, account().keywordReplies)).toBeNull();
  });

  it('ignores a rule with a blank keyword rather than matching everything', () => {
    // An empty needle is a substring of every string. Without this guard, one blank row in the
    // settings list would answer every single message with that row's reply.
    expect(matchKeywordReply('anything at all', [{ keyword: '   ', reply: 'oops' }])).toBeNull();
  });

  it('ignores a rule with a blank reply rather than sending an empty message', () => {
    expect(matchKeywordReply('price?', [{ keyword: 'price', reply: '   ' }])).toBeNull();
  });

  it.each([null, undefined, 'not-an-array'])('survives %s rules', (rules) => {
    expect(matchKeywordReply('price?', rules as never)).toBeNull();
  });
});

describe('choosing a reply', () => {
  it('answers the question rather than sending the welcome', () => {
    /**
     * Somebody whose first message is "what do you charge?" wants the price. The welcome has no
     * second chance to be useful, and answering is strictly better than greeting.
     */
    const choice = chooseInstagramReply({
      account: account(),
      text: 'hi, what is the price for a full day?',
      isFirstMessage: true,
    });

    expect(choice).toMatchObject({ kind: 'keyword' });
  });

  it('falls back to the welcome when the question uses a word no rule covers', () => {
    /**
     * The honest limit of substring keyword matching: "what do you charge?" contains neither
     * `price` nor `availab`, so it gets the welcome rather than the price list. This is a real
     * limitation for an admin to work around by adding synonyms — not a bug to paper over with
     * fuzzy matching, which would start answering the wrong questions confidently.
     */
    const choice = chooseInstagramReply({
      account: account(),
      text: 'what do you charge?',
      isFirstMessage: true,
    });

    expect(choice).toMatchObject({ kind: 'welcome' });
  });

  it('sends the welcome on a first message with no keyword', () => {
    const choice = chooseInstagramReply({
      account: account(),
      text: 'hi',
      isFirstMessage: true,
    });

    expect(choice).toMatchObject({ kind: 'welcome' });
  });

  it('does NOT send the welcome on a later message', () => {
    // The most visible possible bug on this feature is greeting somebody twice.
    expect(
      chooseInstagramReply({ account: account(), text: 'hi again', isFirstMessage: false }),
    ).toBeNull();
  });

  it('still answers a keyword on a later message', () => {
    const choice = chooseInstagramReply({
      account: account(),
      text: 'and the price?',
      isFirstMessage: false,
    });

    expect(choice).toMatchObject({ kind: 'keyword' });
  });

  it('sends nothing when nothing is configured', () => {
    // The default state of a freshly connected account: no welcome, no keywords, no messages.
    expect(
      chooseInstagramReply({
        account: account({ welcomeReply: null, keywordReplies: [] }),
        text: 'hello',
        isFirstMessage: true,
      }),
    ).toBeNull();
  });

  it('treats a whitespace-only welcome as no welcome', () => {
    expect(
      chooseInstagramReply({
        account: account({ welcomeReply: '   ', keywordReplies: [] }),
        text: 'hello',
        isFirstMessage: true,
      }),
    ).toBeNull();
  });
});

describe('what the client refuses to send', () => {
  it('refuses a reply over Instagram\'s 1,000-character limit', async () => {
    /**
     * Enforced here rather than at the form, because a reply assembled from a template can exceed
     * it without anybody typing it — and Meta's refusal does not say which message was too long.
     */
    const { instagramTextTooLong, INSTAGRAM_TEXT_MAX_BYTES } = await import(
      './instagram.client.js'
    );

    expect(instagramTextTooLong('a'.repeat(INSTAGRAM_TEXT_MAX_BYTES))).toBe(false);
    expect(instagramTextTooLong('a'.repeat(INSTAGRAM_TEXT_MAX_BYTES + 1))).toBe(true);
  });

  it('measures the limit in bytes, not characters', async () => {
    // An emoji is four bytes. Counting characters would let a message through that Meta refuses.
    const { instagramTextTooLong } = await import('./instagram.client.js');

    expect(instagramTextTooLong('😀'.repeat(251))).toBe(true);
  });

  it('tags a send as HUMAN_AGENT only when asked', async () => {
    /**
     * The tag declares to Meta that a person is replying. Using it for a bot is a false statement
     * about who is on the other end, with the account's messaging access as the penalty — so
     * automation never sets it and this asserts the wiring, not just the intent.
     */
    const { sendInstagramText } = await import('./instagram.client.js');

    const calls: { body: unknown }[] = [];

    const fetchImpl = (async (_url: string, init: { body: string }) => {
      calls.push({ body: JSON.parse(init.body) });

      return {
        ok: true,
        status: 200,
        json: async () => ({ recipient_id: 'r', message_id: 'm' }),
      };
    }) as unknown as typeof fetch;

    await sendInstagramText({
      pageId: 'PAGE',
      pageAccessToken: 'token',
      recipientId: 'IGSID',
      text: 'automatic reply',
      humanAgent: false,
      fetchImpl,
    });

    await sendInstagramText({
      pageId: 'PAGE',
      pageAccessToken: 'token',
      recipientId: 'IGSID',
      text: 'a person replying',
      humanAgent: true,
      fetchImpl,
    });

    expect(calls[0].body).not.toHaveProperty('tag');
    expect(calls[1].body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  });

  it('sends the token in a header, never the URL', async () => {
    // A URL is recorded by proxies, load balancers and error trackers.
    const { sendInstagramText } = await import('./instagram.client.js');

    let seenUrl = '';
    let seenAuth = '';

    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenAuth = init.headers.authorization;

      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    await sendInstagramText({
      pageId: 'PAGE',
      pageAccessToken: 'super-secret-token',
      recipientId: 'IGSID',
      text: 'hello',
      fetchImpl,
    });

    expect(seenUrl).not.toContain('super-secret-token');
    expect(seenAuth).toBe('Bearer super-secret-token');
  });
});

describe('classifying a failed send', () => {
  const failWith = async (code: number, status = 400) => {
    const { sendInstagramText, InstagramSendError } = await import('./instagram.client.js');

    const fetchImpl = (async () => ({
      ok: false,
      status,
      json: async () => ({ error: { code, message: 'Meta said no' } }),
    })) as unknown as typeof fetch;

    try {
      await sendInstagramText({
        pageId: 'PAGE',
        pageAccessToken: 'token',
        recipientId: 'IGSID',
        text: 'hello',
        fetchImpl,
      });
    } catch (error) {
      return error as InstanceType<typeof InstagramSendError>;
    }

    throw new Error('expected a send error');
  };

  it('treats a revoked token as needing attention, not a retry', async () => {
    // It will fail identically every minute forever; retrying burns a send budget while the owner
    // is never told to reconnect.
    const error = await failWith(190);

    expect(error.code).toBe('INSTAGRAM_TOKEN_EXPIRED');
    expect(error.failureKind).toBe('needs_attention');
  });

  it('treats a permission refusal as needing attention, and names the settings toggle', async () => {
    const error = await failWith(10);

    expect(error.code).toBe('INSTAGRAM_PERMISSION_DENIED');
    // The single most-missed step in the whole setup.
    expect(error.message).toContain('Allow Access to Messages');
  });

  it('treats an unreachable recipient as needing attention and says why', async () => {
    const error = await failWith(551);

    expect(error.code).toBe('INSTAGRAM_RECIPIENT_UNAVAILABLE');
    expect(error.message).toContain('24-hour');
  });

  it('treats rate limiting as transient', async () => {
    const error = await failWith(4, 429);

    expect(error.failureKind).toBe('transient');
  });

  it('treats a 5xx as transient', async () => {
    const error = await failWith(0, 503);

    expect(error.failureKind).toBe('transient');
  });

  it("keeps Meta's own words, because the code is what gets searched for", async () => {
    const error = await failWith(190);

    expect(error.message).toContain('Meta said no');
  });
});
