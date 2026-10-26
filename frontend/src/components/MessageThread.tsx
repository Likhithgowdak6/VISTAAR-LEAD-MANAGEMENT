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
  /**
   * Saves this message's text for reuse, or removes it if already saved.
   *
   * Absent means the feature is off for this view - the button is not rendered at all rather
   * than rendered disabled, because a star nobody can press is just clutter on a phone.
   */
  onToggleStar?: (message: Message) => void;
  /** Whether this user has already starred this message. Drives the filled/hollow star. */
  starred?: boolean;
  /** True while the save or delete is in flight, so the button cannot be double-fired. */
  starBusy?: boolean;
};

const MessageBubble = ({ message, onToggleStar, starred = false, starBusy = false }: MessageBubbleProps) => {
  const isOutbound = message.direction === 'out';
  // Anything that is not plain text has an attachment block, which shows the file itself when
  // the bytes were stored and falls back to a label when they were not. See MediaAttachment.
  const hasMedia = Boolean(message.type) && message.type !== 'text';
  const body = message.body ?? '';
  // Only text can be starred. A saved message is something to send again, and the composer
  // sends text - starring a photo would save an empty string that does nothing when reused.
  const canStar = Boolean(onToggleStar) && body.trim() !== '';

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
          {/* First in the row and small: a reading aid, not a call to action. The accessible
              name says which way the press goes, because the glyph alone does not. */}
          {canStar ? (
            <button
              type="button"
              onClick={() => onToggleStar?.(message)}
              disabled={starBusy}
              aria-pressed={starred}
              aria-label={starred ? 'Remove from starred messages' : 'Save to starred messages'}
              title={starred ? 'Remove from starred messages' : 'Save to starred messages'}
              className={`mr-auto rounded px-1 text-xs leading-none transition-colors disabled:opacity-50 ${
                starred ? 'text-key' : 'text-muted hover:text-key'
              }`}
            >
              {starred ? '★' : '☆'}
            </button>
          ) : null}
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
  onToggleStar?: (message: Message) => void;
  /**
   * Ids of messages this user has starred. A Set rather than a list: this is consulted once per
   * bubble on every render of a thread that can run to hundreds.
   */
  starredMessageIds?: ReadonlySet<string>;
  /** The one message whose star is mid-flight, if any. */
  starPendingId?: string | null;
};

const MessageThread = ({
  messages,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onToggleStar,
  starredMessageIds,
  starPendingId = null,
}: Props) => (
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
      <MessageBubble
        key={message.id}
        message={message}
        onToggleStar={onToggleStar}
        starred={starredMessageIds?.has(message.id) ?? false}
        starBusy={starPendingId === message.id}
      />
    ))}
  </div>
);

export default MessageThread;
