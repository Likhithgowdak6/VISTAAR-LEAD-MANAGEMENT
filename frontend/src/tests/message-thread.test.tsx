import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import MessageThread from '../components/MessageThread';
import { type Message } from '../components/types';

/**
 * The thread's fallback when there are no bytes to show.
 *
 * Inbound media is only downloaded when an operator turns it on, and even then a file can be
 * expired, oversized or refused by the format allowlist. In all of those cases `storageStatus`
 * is something other than 'stored' and the bubble must still say that something was sent, and
 * what kind of thing - an empty bubble reads as though the lead said nothing. Everything here
 * uses a non-stored status on purpose; the stored path is covered in media-attachment.test.tsx.
 */
const message = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'm1',
    direction: 'in',
    type: 'text',
    body: null,
    media: {
      mimeType: null,
      fileName: null,
      sizeBytes: null,
      storageStatus: 'not_applicable',
      isVoiceNote: false,
    },
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

  it('labels a voice note as one when WhatsApp said it was push-to-talk', () => {
    renderThread([
      message({
        id: 'm2',
        type: 'audio',
        media: {
          mimeType: 'audio/ogg; codecs=opus',
          fileName: null,
          sizeBytes: 8321,
          storageStatus: 'not_applicable',
          isVoiceNote: true,
        },
      }),
    ]);

    expect(screen.getByText('🎤 Voice note')).toBeInTheDocument();
  });

  it('calls an attached audio file audio, not a voice note', () => {
    // This used to be a guess - every `audio` message was labelled a voice note because the
    // push-to-talk flag was not persisted. It is now, so the label follows the data: calling
    // somebody's attached music file a voice note is wrong, where "Audio" never is.
    renderThread([
      message({
        id: 'm2b',
        type: 'audio',
        media: {
          mimeType: 'audio/mpeg',
          fileName: 'reference-track.mp3',
          sizeBytes: 3_201_144,
          storageStatus: 'not_applicable',
          isVoiceNote: false,
        },
      }),
    ]);

    expect(screen.getByText('🎵 Audio')).toBeInTheDocument();
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
          isVoiceNote: false,
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
