/**
 * Instagram webhook ingestion: routing, signatures and deduplication.
 *
 * THE FOUR FAILURES THAT MATTER, each of which is silent rather than loud:
 *
 *   1. **A DM reaching the wrong workspace.** A delivery names an Instagram account and nothing
 *      else. If two workspaces could claim one account, or an unclaimed account fell back to a
 *      default, a stranger's message would appear in somebody's CRM.
 *   2. **A redelivery becoming a second message.** Meta retries, and retries with different
 *      envelope timestamps for the same DM — so a body-hash check alone is not enough.
 *   3. **A forged delivery being believed.** The endpoint is public and writes to the inbox, and
 *      can trigger an automatic reply to a stranger.
 *   4. **An echo being answered.** Meta reflects our own sends back; filing one as inbound makes
 *      the automation answer itself.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseInstagramWebhookBody } from './instagram-webhook.service.js';
import { verifyInstagramWebhookSignature } from './instagram-webhook.signature.js';

const body = (overrides: Record<string, unknown> = {}) => ({
  object: 'instagram',
  entry: [
    {
      id: '17841400000000001',
      time: 1795000000,
      messaging: [
        {
          sender: { id: 'IGSID-CUSTOMER' },
          recipient: { id: '17841400000000001' },
          timestamp: 1795000000000,
          message: { mid: 'mid.ABC123', text: 'Do you shoot weddings?' },
        },
      ],
    },
  ],
  ...overrides,
});

const sign = (raw: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;

describe('signature verification', () => {
  const secret = 'an-instagram-app-secret';
  const config = { INSTAGRAM_APP_SECRET: secret, META_APP_SECRET: '' } as never;

  it('accepts a correctly signed body', () => {
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sign(raw, secret),
        config,
      }),
    ).toBe(true);
  });

  it('refuses a body signed with the wrong secret', () => {
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sign(raw, 'somebody-elses-secret'),
        config,
      }),
    ).toBe(false);
  });

  it('refuses a tampered body under a valid-looking signature', () => {
    // The attack this exists to stop: a real signature over a different message.
    const raw = JSON.stringify(body());
    const tampered = JSON.stringify(body({ entry: [] }));

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(tampered, 'utf8'),
        signatureHeader: sign(raw, secret),
        config,
      }),
    ).toBe(false);
  });

  it('FAILS CLOSED when no secret is configured', () => {
    /**
     * The only safe direction. An unconfigured secret accepting every delivery would let anyone
     * who learned the URL write to a customer's inbox and trigger an automatic reply.
     */
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sign(raw, ''),
        config: { INSTAGRAM_APP_SECRET: '', META_APP_SECRET: '' } as never,
      }),
    ).toBe(false);
  });

  it('falls back to META_APP_SECRET, so one Meta app needs no extra variable', () => {
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sign(raw, 'the-shared-meta-secret'),
        config: { INSTAGRAM_APP_SECRET: '', META_APP_SECRET: 'the-shared-meta-secret' } as never,
      }),
    ).toBe(true);
  });

  it('prefers the Instagram secret when both are set', () => {
    // An installation running Instagram through its own Meta app must remain expressible.
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sign(raw, 'instagram-only'),
        config: { INSTAGRAM_APP_SECRET: 'instagram-only', META_APP_SECRET: 'shared' } as never,
      }),
    ).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['a header without the prefix', 'abc123'],
    ['a header of the wrong length', 'sha256=deadbeef'],
  ])('refuses %s', (_label, header) => {
    const raw = JSON.stringify(body());

    expect(
      verifyInstagramWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: header,
        config,
      }),
    ).toBe(false);
  });

  it('refuses a delivery with no raw body captured', () => {
    // If the raw-body hook ever stops running, every digest would be computed over nothing.
    expect(
      verifyInstagramWebhookSignature({
        rawBody: undefined,
        signatureHeader: sign('{}', secret),
        config,
      }),
    ).toBe(false);
  });
});

describe('parsing a delivery', () => {
  it('reads one message out of a well-formed body', () => {
    const [message] = parseInstagramWebhookBody(body());

    expect(message).toMatchObject({
      mid: 'mid.ABC123',
      senderId: 'IGSID-CUSTOMER',
      recipientId: '17841400000000001',
      text: 'Do you shoot weddings?',
      isEcho: false,
    });
  });

  it('marks our own reflected send as an echo', () => {
    // Filing this as inbound would make the automation answer itself.
    const [message] = parseInstagramWebhookBody(
      body({
        entry: [
          {
            id: '17841400000000001',
            messaging: [
              {
                sender: { id: '17841400000000001' },
                recipient: { id: 'IGSID-CUSTOMER' },
                timestamp: 1795000000000,
                message: { mid: 'mid.OUR-OWN', text: 'Thanks for getting in touch', is_echo: true },
              },
            ],
          },
        ],
      }),
    );

    expect(message.isEcho).toBe(true);
  });

  it('skips an event with no message id, because nothing could deduplicate it', () => {
    // A read receipt or a reaction has none.
    expect(
      parseInstagramWebhookBody(
        body({
          entry: [
            {
              id: '17841400000000001',
              messaging: [{ sender: { id: 'x' }, recipient: { id: 'y' }, read: { mid: 'z' } }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('falls back to the entry id when the event omits a recipient', () => {
    const [message] = parseInstagramWebhookBody(
      body({
        entry: [
          {
            id: '17841400000000001',
            messaging: [
              {
                sender: { id: 'IGSID-CUSTOMER' },
                timestamp: 1795000000000,
                message: { mid: 'mid.NO-RECIPIENT', text: 'hello' },
              },
            ],
          },
        ],
      }),
    );

    // The entry id IS the account the DM was sent to, which is what routing needs.
    expect(message.recipientId).toBe('17841400000000001');
  });

  it('keeps the other messages when one in the batch is malformed', () => {
    /**
     * This parses a payload that proved its signature but not its shape. Throwing on one odd
     * event would discard every other message Meta delivered in the same request.
     */
    const parsed = parseInstagramWebhookBody({
      entry: [
        {
          id: '17841400000000001',
          messaging: [
            { nonsense: true },
            { sender: {}, message: { mid: 'mid.NO-SENDER' } },
            {
              sender: { id: 'IGSID-CUSTOMER' },
              recipient: { id: '17841400000000001' },
              timestamp: 1795000000000,
              message: { mid: 'mid.GOOD', text: 'still here' },
            },
          ],
        },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0].mid).toBe('mid.GOOD');
  });

  it('reads messages from every entry in a batched delivery', () => {
    const parsed = parseInstagramWebhookBody({
      entry: [
        {
          id: 'ACCOUNT-A',
          messaging: [
            {
              sender: { id: 'IGSID-1' },
              recipient: { id: 'ACCOUNT-A' },
              message: { mid: 'mid.1', text: 'one' },
            },
          ],
        },
        {
          id: 'ACCOUNT-B',
          messaging: [
            {
              sender: { id: 'IGSID-2' },
              recipient: { id: 'ACCOUNT-B' },
              message: { mid: 'mid.2', text: 'two' },
            },
          ],
        },
      ],
    });

    // Two accounts in one delivery, which may belong to two different workspaces.
    expect(parsed.map((m) => m.recipientId)).toEqual(['ACCOUNT-A', 'ACCOUNT-B']);
  });

  it.each([null, undefined, {}, { entry: 'not-an-array' }, []])(
    'returns nothing for %s rather than throwing',
    (value) => {
      expect(parseInstagramWebhookBody(value)).toEqual([]);
    },
  );

  it('falls back to now when the timestamp is unusable', () => {
    const [message] = parseInstagramWebhookBody(
      body({
        entry: [
          {
            id: '17841400000000001',
            messaging: [
              {
                sender: { id: 'IGSID-CUSTOMER' },
                recipient: { id: '17841400000000001' },
                timestamp: 'nonsense',
                message: { mid: 'mid.BAD-TIME', text: 'hello' },
              },
            ],
          },
        ],
      }),
    );

    // A message with an unreadable timestamp is still a message; dropping it would be worse than
    // filing it a second late.
    expect(message.sentAt).toBeInstanceOf(Date);
    expect(Number.isNaN(message.sentAt.getTime())).toBe(false);
  });
});
