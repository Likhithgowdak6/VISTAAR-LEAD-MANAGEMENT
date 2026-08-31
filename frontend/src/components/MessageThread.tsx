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
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isOutbound ? 'bg-blue-600 text-white' : 'bg-white text-slate-900'
        }`}
      >
        {mediaLabel ? (
          <p
            className={`font-medium ${isOutbound ? 'text-blue-50' : 'text-slate-600'}`}
            data-testid="media-placeholder"
          >
            {mediaLabel}
            {fileName ? <span className="font-normal"> · {fileName}</span> : null}
          </p>
        ) : null}

        {/* A caption still shows under its label; a media message with no caption shows only the
            label, instead of the blank bubble this used to render. */}
        {body !== '' ? <p className="whitespace-pre-wrap break-words">{body}</p> : null}
        <div
          className={`mt-1 flex items-center justify-end gap-2 text-[11px] ${
            isOutbound ? 'text-blue-100' : 'text-slate-400'
          }`}
        >
          <span>{formatClockTime(message.sentAt)}</span>
          {isOutbound ? (
            <span>{OUTBOUND_STATUS_LABEL[message.status ?? ''] ?? message.status}</span>
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
  <div className="flex flex-1 flex-col gap-2 overflow-y-auto bg-slate-100 p-4">
    {hasMore ? (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
          className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          {loadingOlder ? 'Loading…' : 'Load older messages'}
        </button>
      </div>
    ) : null}

    {messages.map((message) => (
      <MessageBubble key={message.id} message={message} />
    ))}
  </div>
);

export default MessageThread;
