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
  const isAi = isOutbound && !message.sentByUserId;
  // Anything that is not plain text has an attachment block, which shows the file itself when
  // the bytes were stored and falls back to a label when they were not. See MediaAttachment.
  const hasMedia = Boolean(message.type) && message.type !== 'text';
  const body = message.body ?? '';
  // Only text can be starred. A saved message is something to send again, and the composer
  // sends text - starring a photo would save an empty string that does nothing when reused.
  const canStar = Boolean(onToggleStar) && body.trim() !== '';

  const bubbleClasses = isOutbound
    ? isAi
      ? 'border border-blue-200/90 dark:border-blue-900/60 bg-gradient-to-br from-blue-50/90 via-indigo-50/50 to-white dark:from-slate-900 dark:via-blue-950/40 dark:to-slate-900 text-slate-800 dark:text-slate-100 shadow-sm rounded-2xl rounded-tr-xs'
      : 'bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-sm shadow-blue-500/20 rounded-2xl rounded-tr-xs'
    : 'border border-slate-200/90 dark:border-slate-800/90 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 shadow-sm rounded-2xl rounded-tl-xs';

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] px-3.5 py-2.5 text-sm transition-all duration-150 animate-slide-up ${bubbleClasses}`}>
        {isAi ? (
          <div className="mb-1 flex items-center gap-1.5 text-[0.625rem] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded bg-blue-600 dark:bg-blue-500 text-[8px] text-white">
              ★
            </span>
            <span>AI Auto-Reply</span>
          </div>
        ) : null}

        {hasMedia ? (
          <div className="mb-1.5">
            <MediaAttachment message={message} />
          </div>
        ) : null}

        {/* A caption still shows under its label; a media message with no caption shows only the
            label, instead of the blank bubble this used to render. */}
        {body !== '' ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{body}</p>
        ) : null}

        <div
          className={`mt-1 flex items-center justify-end gap-2 text-[0.6875rem] ${
            isOutbound && !isAi ? 'text-white/80' : 'text-slate-400 dark:text-slate-500'
          }`}
        >
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
                starred
                  ? isOutbound && !isAi
                    ? 'text-yellow-300'
                    : 'text-blue-600'
                  : isOutbound && !isAi
                  ? 'text-white/70 hover:text-white'
                  : 'text-slate-400 hover:text-blue-600'
              }`}
            >
              {starred ? '★' : '☆'}
            </button>
          ) : null}
          <time>{formatClockTime(message.sentAt)}</time>
          {isOutbound ? (
            <span className="font-mono text-[0.625rem] font-semibold uppercase tracking-wider">
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
  <div className="flex flex-1 flex-col gap-3 overflow-y-auto bg-slate-100/60 dark:bg-[#0b0f19] p-4 lg:p-6">
    {hasMore ? (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
          className="rounded-full border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300 shadow-xs transition hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
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
