import { formatClockTime } from '../lib/format';
import MediaAttachment from './MediaAttachment';
import { type Message } from './types';

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
  // Anything that is not plain text has an attachment block, which shows the file itself when
  // the bytes were stored and falls back to a label when they were not. See MediaAttachment.
  const hasMedia = Boolean(message.type) && message.type !== 'text';
  const body = message.body ?? '';

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
        {hasMedia ? (
          <div className="mb-1">
            <MediaAttachment message={message} />
          </div>
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
