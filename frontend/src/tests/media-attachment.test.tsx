/**
 * Showing an attachment in the thread, and degrading honestly when there is nothing to show.
 *
 * THE FALLBACK IS THE FEATURE. Bytes are missing more often than you would think: inbound
 * download is off by default, WhatsApp expires media on its own servers, a file can be too
 * large or refused by the format allowlist, and every message sent before this feature existed
 * has no bytes at all. In all of those cases the bubble must still say what was sent. A broken
 * image frame or a spinner that never resolves reads as a bug in the CRM rather than an absent
 * file.
 *
 * The fetch hook is mocked: what it does (auth header, blob URL, revoke) is its own business
 * and needs an auth provider; what this file cares about is which branch the bubble renders.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useAuthedMedia: vi.fn() }));

vi.mock('../hooks/useAuthedMedia', () => ({ useAuthedMedia: mocks.useAuthedMedia }));

import MediaAttachment from '../components/MediaAttachment';
import { type Message } from '../components/types';

const message = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'm1',
    direction: 'in',
    type: 'image',
    body: null,
    status: 'received',
    sentAt: '2026-10-20T09:30:00.000Z',
    media: {
      mimeType: 'image/jpeg',
      fileName: 'venue.jpg',
      sizeBytes: 81_234,
      storageStatus: 'stored',
      isVoiceNote: false,
    },
    ...overrides,
  }) as Message;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useAuthedMedia.mockReturnValue({ status: 'ready', url: 'blob:fake' });
});

describe('when the bytes are there', () => {
  it('shows a photo', () => {
    render(<MediaAttachment message={message()} />);

    const image = screen.getByRole('img', { name: 'venue.jpg' });
    expect(image).toHaveAttribute('src', 'blob:fake');
  });

  it('plays a voice note, and calls it one', () => {
    render(
      <MediaAttachment
        message={message({
          type: 'audio',
          media: {
            mimeType: 'audio/ogg',
            fileName: 'voice-note.ogg',
            sizeBytes: 8321,
            storageStatus: 'stored',
            isVoiceNote: true,
          },
        })}
      />,
    );

    expect(screen.getByText('🎤 Voice note')).toBeInTheDocument();
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:fake');
  });

  it('offers a video player', () => {
    render(
      <MediaAttachment
        message={message({
          type: 'video',
          media: {
            mimeType: 'video/mp4',
            fileName: 'walkthrough.mp4',
            sizeBytes: 4_000_000,
            storageStatus: 'stored',
            isVoiceNote: false,
          },
        })}
      />,
    );

    expect(document.querySelector('video')).toHaveAttribute('src', 'blob:fake');
  });
});

describe('documents', () => {
  const documentMessage = () =>
    message({
      type: 'document',
      media: {
        mimeType: 'application/pdf',
        fileName: 'competitor-quote.pdf',
        sizeBytes: 284_913,
        storageStatus: 'stored',
        isVoiceNote: false,
      },
    });

  it('does not download until asked', () => {
    // Scrolling a thread should not pull every PDF in it down someone's mobile data.
    render(<MediaAttachment message={documentMessage()} />);

    expect(mocks.useAuthedMedia).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /competitor-quote\.pdf/i })).toBeInTheDocument();
  });

  it('fetches once opened, and then offers to save', () => {
    render(<MediaAttachment message={documentMessage()} />);

    fireEvent.click(screen.getByRole('button', { name: /competitor-quote\.pdf/i }));

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'blob:fake');
    expect(link).toHaveAttribute('download', 'competitor-quote.pdf');
  });
});

describe('when the bytes are not there', () => {
  it('falls back to a label when nothing was stored', () => {
    // The common case today: inbound download is off by default, so every inbound photo is
    // metadata only.
    render(
      <MediaAttachment
        message={message({
          media: {
            mimeType: 'image/jpeg',
            fileName: null,
            sizeBytes: 54_000,
            storageStatus: 'not_applicable',
            isVoiceNote: false,
          },
        })}
      />,
    );

    expect(screen.getByTestId('media-placeholder')).toHaveTextContent('📷 Photo');
    expect(mocks.useAuthedMedia).not.toHaveBeenCalled();
  });

  it('says so when the download fails, instead of showing a broken frame', () => {
    mocks.useAuthedMedia.mockReturnValue({ status: 'error', message: 'gone' });

    render(<MediaAttachment message={message()} />);

    expect(screen.getByTestId('media-placeholder')).toHaveTextContent('unavailable');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the label while loading rather than an empty bubble', () => {
    mocks.useAuthedMedia.mockReturnValue({ status: 'loading' });

    render(<MediaAttachment message={message()} />);

    expect(screen.getByTestId('media-loading')).toHaveTextContent('📷 Photo');
  });

  it('labels a failed send without pretending it can be opened', () => {
    render(
      <MediaAttachment
        message={message({
          direction: 'out',
          media: {
            mimeType: 'image/jpeg',
            fileName: 'venue.jpg',
            sizeBytes: 81_234,
            storageStatus: 'failed',
            isVoiceNote: false,
          },
        })}
      />,
    );

    expect(screen.getByTestId('media-placeholder')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('the descriptor', () => {
  it('shows the file size, so a large download is not a surprise', () => {
    mocks.useAuthedMedia.mockReturnValue({ status: 'loading' });

    render(<MediaAttachment message={message()} />);

    // Rounded: the decimal stops being information above 10, so 81,234 bytes reads "81 KB".
    expect(screen.getByTestId('media-loading')).toHaveTextContent('81 KB');
  });

  it('keeps one decimal for a small file, where it still says something', () => {
    mocks.useAuthedMedia.mockReturnValue({ status: 'loading' });

    render(
      <MediaAttachment
        message={message({
          media: {
            mimeType: 'image/jpeg',
            fileName: 'thumb.jpg',
            sizeBytes: 2_400_000,
            storageStatus: 'stored',
            isVoiceNote: false,
          },
        })}
      />,
    );

    expect(screen.getByTestId('media-loading')).toHaveTextContent('2.4 MB');
  });

  it('does not repeat a generated filename for a voice note', () => {
    // "voice-note.ogg" is a name the server invented; showing it adds nothing.
    render(
      <MediaAttachment
        message={message({
          type: 'audio',
          media: {
            mimeType: 'audio/ogg',
            fileName: 'voice-note.ogg',
            sizeBytes: 8321,
            storageStatus: 'stored',
            isVoiceNote: true,
          },
        })}
      />,
    );

    expect(screen.queryByText(/voice-note\.ogg/)).not.toBeInTheDocument();
  });
});
