import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MessageThread from '../components/MessageThread';
import { type Message } from '../components/types';

/**
 * Inbound media is never downloaded, so a photo or a voice note arrives with no thumbnail and
 * often no text at all. These cover the one thing the thread has to get right about that: a
 * human must be able to see that something was sent, and what kind of thing, instead of an
 * empty bubble that reads as though the lead said nothing.
 */
const message = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'm1',
    direction: 'in',
    type: 'text',
    body: null,
    media: { mimeType: null, fileName: null, sizeBytes: null, storageStatus: 'not_applicable' },
    status: 'received',
    sentAt: '2026-08-25T09:30:00.000Z',
    ...overrides,
  }) as Message;

const renderThread = (messages: Message[]) =>
  render(
    <MessageThread messages={messages} hasMore={false} loadingOlder={false} onLoadOlder={() => {}} />,
  );

describe('MessageThread — media placeholders', () => {
  it('labels a caption-less photo instead of rendering an empty bubble', () => {
    renderThread([message({ id: 'm1', type: 'image' })]);

    expect(screen.getByText('📷 Photo')).toBeInTheDocument();
  });

  it('labels a voice note', () => {
    renderThread([
      message({
        id: 'm2',
        type: 'audio',
        media: {
          mimeType: 'audio/ogg; codecs=opus',
          fileName: null,
          sizeBytes: 8321,
          storageStatus: 'not_applicable',
        },
      }),
    ]);

    expect(screen.getByText('🎤 Voice note')).toBeInTheDocument();
  });

  it('labels a document and shows its filename, which is often the whole point', () => {
    renderThread([
      message({
        id: 'm3',
        type: 'document',
        media: {
          mimeType: 'application/pdf',
          fileName: 'competitor-quote.pdf',
          sizeBytes: 284913,
          storageStatus: 'not_applicable',
        },
      }),
    ]);

    expect(screen.getByText('📎 Document')).toBeInTheDocument();
    expect(screen.getByText(/competitor-quote\.pdf/)).toBeInTheDocument();
  });

  it('shows the caption under the label when there is one', () => {
    renderThread([message({ id: 'm4', type: 'image', body: 'This is the venue' })]);

    expect(screen.getByText('📷 Photo')).toBeInTheDocument();
    expect(screen.getByText('This is the venue')).toBeInTheDocument();
  });

  it('leaves an ordinary text message exactly as it was — no label', () => {
    renderThread([message({ id: 'm5', type: 'text', body: 'Hi, do you shoot house-warmings?' })]);

    expect(screen.getByText('Hi, do you shoot house-warmings?')).toBeInTheDocument();
    expect(screen.queryByTestId('media-placeholder')).not.toBeInTheDocument();
  });
});
