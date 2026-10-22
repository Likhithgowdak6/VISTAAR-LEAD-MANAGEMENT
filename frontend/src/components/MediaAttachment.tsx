import { useState } from 'react';

import { useAuthedMedia } from '../hooks/useAuthedMedia';
import { formatFileSize } from '../lib/format';
import { type Message } from './types';

/**
 * The attachment inside a message bubble.
 *
 * WHAT IT DOES NOT DO: guess. If the row does not say `storageStatus: 'stored'` there are no
 * bytes to fetch - an older message from before attachments were downloaded, an inbound file
 * WhatsApp had already expired, a send that failed - and the bubble shows the same label it has
 * always shown rather than a spinner that never resolves or a broken image frame.
 *
 * IMAGES AND VIDEO LOAD ON SIGHT; a document does not. A thread is scrolled through quickly and
 * a photo that has to be clicked to appear is not a photo. A 2 MB PDF nobody opens is just 2 MB
 * of somebody's phone data, so documents fetch only when the owner asks.
 */
const MEDIA_TYPE_LABEL: Record<string, string> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎵 Audio',
  document: '📎 Document',
  sticker: '🌟 Sticker',
  contact: '👤 Contact',
  location: '📍 Location',
  unsupported: '📄 Attachment',
};

const describe = (message: Message) => {
  const media = message.media;
  const type = message.type ?? 'unsupported';
  const isVoiceNote = type === 'audio' && media?.isVoiceNote === true;
  const caption = media?.fileName ?? null;
  const size = typeof media?.sizeBytes === 'number' ? formatFileSize(media.sizeBytes) : null;

  return (
    <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em]">
      {isVoiceNote ? '🎤 Voice note' : (MEDIA_TYPE_LABEL[type] ?? '📄 Attachment')}
      {caption && !isVoiceNote ? (
        <span className="normal-case tracking-normal"> · {caption}</span>
      ) : null}
      {size ? <span className="normal-case tracking-normal"> · {size}</span> : null}
    </span>
  );
};

type Props = {
  message: Message;
};

/**
 * The half that actually fetches. Split out so that the label-only path above never mounts it -
 * it reaches for the auth context, and a bubble with nothing to download has no business
 * needing a session to render.
 */
const MediaBody = ({ message }: Props) => {
  const state = useAuthedMedia(message.id);
  const type = message.type ?? 'unsupported';
  const caption = message.media?.fileName ?? null;

  if (state.status === 'error') {
    return (
      <p data-testid="media-placeholder" className="text-fill-soft">
        {describe(message)}
        <span className="ml-1 normal-case tracking-normal text-muted">· unavailable</span>
      </p>
    );
  }

  if (state.status !== 'ready') {
    return (
      <p data-testid="media-loading" className="text-fill-soft">
        {describe(message)}
        <span className="ml-1 normal-case tracking-normal text-muted">· loading…</span>
      </p>
    );
  }

  if (type === 'image') {
    return (
      <a href={state.url} target="_blank" rel="noreferrer" className="block">
        <img
          src={state.url}
          alt={caption ?? 'Photo'}
          // Capped rather than natural size: a portrait photo at full height pushes the rest of
          // the thread off a phone screen entirely.
          className="max-h-72 w-auto max-w-full rounded-lg object-contain"
        />
      </a>
    );
  }

  if (type === 'video') {
    return (
      <video
        src={state.url}
        controls
        preload="metadata"
        className="max-h-72 w-full rounded-lg"
        aria-label={caption ?? 'Video'}
      />
    );
  }

  if (type === 'audio') {
    return (
      <div className="flex flex-col gap-1">
        {describe(message)}
        {/* The browser's own player: it already handles scrubbing, speed and the keyboard, and
            a hand-rolled one on top of the same <audio> element would do all of it worse. */}
        <audio src={state.url} controls preload="metadata" className="w-full max-w-[16rem]" />
      </div>
    );
  }

  return (
    <a
      href={state.url}
      download={caption ?? 'attachment'}
      className="flex min-h-11 items-center gap-2 rounded-lg border border-hairline px-2 py-1.5 text-fill-soft transition-colors hover:border-key/40 hover:text-key"
    >
      {describe(message)}
      <span className="ml-auto font-mono text-[0.625rem] uppercase tracking-[0.06em]">Save</span>
    </a>
  );
};

const MediaAttachment = ({ message }: Props) => {
  const type = message.type ?? 'unsupported';
  const stored = message.media?.storageStatus === 'stored';

  // Documents wait to be asked for; everything else is part of reading the thread.
  const [documentRequested, setDocumentRequested] = useState(false);
  const inlineByDefault = type === 'image' || type === 'video' || type === 'audio';

  if (!stored) {
    return (
      <p data-testid="media-placeholder" className="text-fill-soft">
        {describe(message)}
      </p>
    );
  }

  if (type === 'document' && !documentRequested) {
    return (
      <button
        type="button"
        onClick={() => setDocumentRequested(true)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-hairline px-2 py-1.5 text-left text-fill-soft transition-colors hover:border-key/40 hover:text-key"
      >
        {describe(message)}
        <span className="ml-auto font-mono text-[0.625rem] uppercase tracking-[0.06em]">Open</span>
      </button>
    );
  }

  if (!inlineByDefault && !documentRequested) {
    return (
      <p data-testid="media-placeholder" className="text-fill-soft">
        {describe(message)}
      </p>
    );
  }

  return <MediaBody message={message} />;
};

export default MediaAttachment;
