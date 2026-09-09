import { formatClockTime } from '../lib/format';
import { type Message, type MessageType } from './types';

/**
 * Inbound media is deliberately never downloaded (see the backend's inbound ingestion), so there
 * is no thumbnail to show and nothing to play. Without a label a photo or a voice note renders as
 * an empty bubble and reads as "nothing happened", which is the one thing it must not read as.
 * The point of these is only that a human can see something was sent, and what kind of thing.
 *
 * WhatsApp inbound audio is a recorded voice note in all but a rare edge case (an attached music
 * file), and the push-to-talk flag is not persisted on the message row, so `audio` is labelled as
 * a voice note here - the wording that is right almost every time.
 */
const MEDIA_TYPE_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎤 Voice note',
  document: '📎 Document',
  sticker: '🌟 Sticker',
  contact: '👤 Contact',
  location: '📍 Location',
  unsupported: '📄 Attachment',
};

const OUTBOUND_STATUS_LABEL: Record<string, string> = {
  created: 'Pending',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed — will retry',
  failed_permanent: 'Failed',
};

type MessageBubbleProps = {
  message: Message;
};

const MessageBubble = ({ message }: MessageBubbleProps) => {
  const isOutbound = message.direction === 'out';
  const mediaLabel = message.type ? MEDIA_TYPE_LABEL[message.type] : undefined;
  const body = message.body ?? '';
  const fileName = message.media?.fileName ?? null;

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      {/*
       * The studio's side of the conversation sits in the key light and the lead's in the fill:
       * warm is us, cool is them. It is the same two-source scheme as the rest of the console, so
       * "who said this" is answerable from the colour temperature alone, without reading the
       * alignment or the timestamp.
       */}
      <div
        className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
          isOutbound
            ? 'border border-key/30 bg-key/10 text-bone glow-key-soft'
            : 'surface rounded-tl-sm text-bone'
        }`}
      >
        {mediaLabel ? (
          <p
            className={`font-mono text-[0.6875rem] uppercase tracking-[0.06em] ${
              isOutbound ? 'text-key-soft' : 'text-fill-soft'
            }`}
            data-testid="media-placeholder"
          >
            {mediaLabel}
            {fileName ? <span className="normal-case tracking-normal"> · {fileName}</span> : null}
          </p>
        ) : null}

        {/* A caption still shows under its label; a media message with no caption shows only the
            label, instead of the blank bubble this used to render. */}
        {body !== '' ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{body}</p>
        ) : null}
        <div className="mt-1 flex items-center justify-end gap-2 text-[0.625rem] text-muted">
          <time>{formatClockTime(message.sentAt)}</time>
          {isOutbound ? (
            <span className="font-mono uppercase tracking-[0.06em]">
              {OUTBOUND_STATUS_LABEL[message.status ?? ''] ?? message.status}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

type Props = {
  messages: Message[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
};

const MessageThread = ({ messages, hasMore, loadingOlder, onLoadOlder }: Props) => (
  <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-ink p-4">
    {hasMore ? (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
          className="rounded-full border border-hairline bg-panel px-3 py-1 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-bone-dim transition-colors hover:border-key/40 hover:text-key disabled:opacity-50"
        >
          {loadingOlder ? 'Loading…' : 'Load older'}
        </button>
      </div>
    ) : null}

    {messages.map((message) => (
      <MessageBubble key={message.id} message={message} />
    ))}
  </div>
);

export default MessageThread;
