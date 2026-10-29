import { type ComponentProps, useCallback, useEffect, useMemo, useState } from 'react';

import {
  createStarredMessage,
  deleteStarredMessage,
  getConversation,
  getMessages,
  listSendableAccounts,
  listStages,
  listStarredMessages,
  listTemplates,
  sendMessage,
  uploadConversationMedia,
  type UploadedMedia,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useIsMobileViewport, useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { findStageByKey, mergeStages } from '../lib/stages';
import { useRealtime } from '../realtime/RealtimeProvider';
import { type MessageTemplate } from '../types';
import ConversationSummaryPanel from './ConversationSummaryPanel';
import EmptyState from './EmptyState';
import LeadPanel from './lead/LeadPanel';
import MessageTemplatesDialog from './MessageTemplatesDialog';
import MobileAppBar from './mobile/MobileAppBar';
import MessageComposer from './MessageComposer';
import MessageThread from './MessageThread';
import Spinner from './Spinner';
import StarredMessagesDialog from './StarredMessagesDialog';
import StageBadge from './StageBadge';
import {
  type AuthValue,
  type ConversationDetail,
  type Message,
  errorMessage,
  type RealtimeEvent,
  type RealtimeValue,
  type SendableAccount,
  type StageOption,
} from './types';

const PAGE_SIZE = 30;
const POLL_INTERVAL_MS = 60000;

// Newest-first, unique by id.
const mergeDesc = (existing: Message[], incoming: Message[]): Message[] => {
  const byId = new Map<string, Message>();
  [...existing, ...incoming].forEach((message) => byId.set(message.id, message));

  return [...byId.values()].sort((a, b) => {
    const timeDiff = new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime();
    return timeDiff !== 0 ? timeDiff : b.id.localeCompare(a.id);
  });
};

/**
 * True when the viewport is wide enough to show the thread and the lead panel side by side.
 * Read once, at mount, to pick the initial state of the details panel: on a phone the panel
 * would otherwise open over the messages you just tapped through to read.
 */
const isWideViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(min-width: 1280px)').matches;

type Props = {
  conversationId: string;
  /** Returns to the conversation list. Only rendered below lg, where the list is hidden. */
  onBack?: () => void;
  /**
   * The open thread was deleted. Has to be handled by the owner of `selectedId` rather than here:
   * there is no router, so nothing else would clear the selection and this view would sit on a
   * conversation the API now refuses to return, rendering its error branch.
   */
  onDeleted?: () => void;
  /**
   * Re-arms device alarms after a reminder is added or moved in the lead panel. Threaded from
   * AppShell because the alarm sync loop is a single hook instance that lives up there - calling
   * it again here would start a second loop.
   */
  onRemindersChanged?: () => void;
  /** Device-alarm health, forwarded to the lead panel's reminder section. */
  reminderAlarms?: ComponentProps<typeof LeadPanel>['reminderAlarms'];
  /**
   * Bumped when a reminder changed somewhere other than the lead panel - today, the reminder
   * dialog a notification link opens. Forwarded so the panel's list refetches instead of
   * sitting there still showing what was just completed.
   */
  remindersRefreshKey?: number;
};

const ConversationView = ({
  conversationId,
  onBack,
  onDeleted,
  onRemindersChanged,
  reminderAlarms,
  remindersRefreshKey,
}: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const { subscribe } = useRealtime() as RealtimeValue;
  // Same gate the lead panel used for the template writer before it moved here.
  const canUseTemplates = hasPermission(permissions, PERMISSIONS.AI_GENERATE);
  const canSendMessages = hasPermission(permissions, PERMISSIONS.MESSAGES_SEND);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(isWideViewport);
  const [stageOverride, setStageOverride] = useState<string | null>(null);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [sendableAccounts, setSendableAccounts] = useState<SendableAccount[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);

  const isMobile = useIsMobileViewport();
  /**
   * The template writer, opened from the composer.
   *
   * Owned here rather than inside MessageComposer because the dialog needs the conversation's
   * `aiCategory` and `aiFacts`, which this component already holds and the composer does not.
   */
  const [templatesOpen, setTemplatesOpen] = useState(false);

  /**
   * The user's own saved messages.
   *
   * `starredSources` is the set of MESSAGE ids that have a saved copy, which is what draws the
   * filled star on a bubble - not the ids of the saved records themselves. Kept here rather
   * than in MessageThread because the Starred panel can delete an entry, and the thread has to
   * notice.
   */
  const [starredOpen, setStarredOpen] = useState(false);
  const [starredSources, setStarredSources] = useState<ReadonlySet<string>>(new Set());
  const [starPendingId, setStarPendingId] = useState<string | null>(null);
  /**
   * The pending insert for the composer. The nonce is what makes picking the same saved
   * message twice in a row work - the text alone would compare equal and be ignored.
   */
  const [starredInsert, setStarredInsert] = useState<{ body: string; nonce: number } | null>(null);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);

  /**
   * The innermost mobile layer. Below xl the lead panel REPLACES the thread rather than sitting
   * beside it, so it is a screen you navigated into and back has to return to the messages -
   * not to the inbox, and certainly not out of the app, which is what it did before.
   */
  useMobileBackLayer({ active: detailsOpen, onBack: closeDetails });

  useEffect(() => {
    // Needed to resolve a custom stage's label/color for the header badge; built-ins already
    // render correctly on their own, so a failure here is silently non-fatal.
    authedRequest((token) => listStages({ token }))
      .then((payload) => setStages(mergeStages(payload.data ?? [])))
      .catch(() => {});
  }, [authedRequest]);

  useEffect(() => {
    // Which numbers this user can send from. A failure just leaves the picker hidden, so the
    // composer falls back to the thread's own number — the pre-existing behaviour.
    if (!canSendMessages) {
      return;
    }

    authedRequest((token) => listSendableAccounts({ token }))
      .then((payload) => setSendableAccounts(payload.data ?? []))
      .catch(() => {});

    // Saved quotes for the composer's picker. A failure just hides the picker - the composer
    // works exactly as it did before templates existed.
    authedRequest((token) => listTemplates({ token }))
      .then((payload) => setTemplates(payload.data ?? []))
      .catch(() => {});
  }, [authedRequest, canSendMessages]);

  /**
   * Which messages this user has already starred, so the bubbles can show it.
   *
   * Failing silently on purpose: an unreachable list means no stars are drawn, which is a
   * missing adornment rather than a broken thread.
   */
  const refreshStarred = useCallback(() => {
    if (!canSendMessages) {
      return;
    }

    authedRequest((token) => listStarredMessages({ token }))
      .then((payload) =>
        setStarredSources(
          new Set(
            (payload.data ?? [])
              .map((entry) => entry.sourceMessageId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        ),
      )
      .catch(() => {});
  }, [authedRequest, canSendMessages]);

  useEffect(() => {
    refreshStarred();
  }, [refreshStarred]);

  /**
   * Saves a message's text, or removes the save if it is already there.
   *
   * THE TITLE IS DERIVED, NOT ASKED FOR. Interrupting a star with a naming dialog would make a
   * one-tap action a three-step one; the user can rename it in the Starred panel, where they
   * are already editing. First line, trimmed to the field's limit.
   */
  const handleToggleStar = useCallback(
    async (message: Message) => {
      const body = (message.body ?? '').trim();

      if (body === '' || starPendingId) {
        return;
      }

      setStarPendingId(message.id);

      try {
        if (starredSources.has(message.id)) {
          // Find the saved record for this bubble. The thread knows the message id; only the
          // server knows which saved row points at it.
          const payload = await authedRequest((token) => listStarredMessages({ token }));
          const match = (payload.data ?? []).find(
            (entry) => entry.sourceMessageId === message.id,
          );

          if (match) {
            await authedRequest((token) =>
              deleteStarredMessage({ token, starredMessageId: match.id }),
            );
          }
        } else {
          const firstLine = body.split('\n')[0] ?? body;

          await authedRequest((token) =>
            createStarredMessage({
              token,
              title: firstLine.slice(0, 120),
              body,
              sourceMessageId: message.id,
              sourceConversationId: conversationId,
            }),
          );
        }

        refreshStarred();
      } catch {
        // Leave the star as it was. The next refresh reconciles with the server, so a failed
        // toggle cannot leave the icon lying about what is saved.
        refreshStarred();
      } finally {
        setStarPendingId(null);
      }
    },
    [authedRequest, conversationId, refreshStarred, starPendingId, starredSources],
  );

  const loadInitial = useCallback(async () => {
    try {
      const [conversationPayload, messagesPayload] = await Promise.all([
        authedRequest((token) => getConversation({ token, conversationId })),
        authedRequest((token) => getMessages({ token, conversationId, limit: PAGE_SIZE })),
      ]);

      const page = messagesPayload.data ?? [];
      setDetail(conversationPayload.data ?? null);
      setMessages(page);
      setHasMore(page.length === PAGE_SIZE);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load conversation.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  const pollLatest = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        getMessages({ token, conversationId, limit: PAGE_SIZE }),
      );
      setMessages((current) => mergeDesc(current, payload.data ?? []));
    } catch {
      // Polling failures are non-fatal; the next tick retries.
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after the awaited request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    const timer = setInterval(pollLatest, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollLatest]);

  // Realtime: refetch this thread when its own conversation changes.
  useEffect(
    () =>
      subscribe((event: RealtimeEvent) => {
        if (event?.conversationId === conversationId) {
          pollLatest();
        }
      }),
    [subscribe, conversationId, pollLatest],
  );

  const loadOlder = useCallback(async () => {
    const oldest = messages[messages.length - 1];
    if (!oldest) {
      return;
    }

    setLoadingOlder(true);

    try {
      const payload = await authedRequest((token) =>
        getMessages({
          token,
          conversationId,
          beforeSentAt: oldest.sentAt,
          beforeId: oldest.id,
          limit: PAGE_SIZE,
        }),
      );
      const page = payload.data ?? [];
      setMessages((current) => mergeDesc(current, page));
      setHasMore(page.length === PAGE_SIZE);
    } catch (olderError: unknown) {
      setError(errorMessage(olderError, 'Unable to load older messages.'));
    } finally {
      setLoadingOlder(false);
    }
  }, [authedRequest, conversationId, messages]);

  /**
   * Stores an attachment against this thread and returns the key the send will carry. Separate
   * from the send so a failed upload never leaves a queued message pointing at nothing.
   */
  const handleUploadMedia = useCallback(
    async ({ blob, fileName, kind }: { blob: Blob; fileName: string; kind: 'file' | 'voice' }) => {
      const payload = await authedRequest((token) =>
        uploadConversationMedia({ token, conversationId, file: blob, fileName, kind }),
      );

      if (!payload?.data) {
        throw new Error('The attachment could not be stored.');
      }

      return payload.data;
    },
    [authedRequest, conversationId],
  );

  const handleSend = useCallback(
    async ({
      body,
      idempotencyKey,
      whatsappAccountId,
      media,
    }: {
      body: string;
      idempotencyKey: string;
      whatsappAccountId: string | null;
      media?: UploadedMedia | null;
    }) => {
      const payload = await authedRequest((token) =>
        sendMessage({
          token,
          conversationId,
          body,
          idempotencyKey,
          whatsappAccountId,
          media,
        }),
      );

      if (payload?.data) {
        setMessages((current) => mergeDesc(current, [payload.data]));
      }

      // A send can re-home the thread onto another number; refetch so the header's "via …"
      // and the composer's selection reflect where the lead now lives.
      if (whatsappAccountId && whatsappAccountId !== detail?.whatsappAccount?.id) {
        authedRequest((token) => getConversation({ token, conversationId }))
          .then((conversationPayload) => setDetail(conversationPayload.data ?? null))
          .catch(() => {});
      }

      // The ADR-005 draft-outcome report went with "Suggest reply". It existed to say whether an
      // AI draft was sent as written or edited first, and nothing fills this box with an AI
      // draft any more - the template writer sends its own text through its own call, stamped
      // and keyed there. Reporting an outcome for a draft that was never generated would be a
      // fabricated signal, so the call is gone rather than left behind always-false.
    },
    [authedRequest, conversationId, detail?.whatsappAccount?.id],
  );

  // Oldest → newest for rendering.
  const orderedMessages = useMemo(() => [...messages].reverse(), [messages]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-100">
        <Spinner label="Loading conversation…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-100">
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      </div>
    );
  }

  const conversation = detail?.conversation;
  const effectiveStage = stageOverride ?? conversation?.stage;
  const contactId = detail?.contact?.id ?? null;
  const whatsappAccount = detail?.whatsappAccount ?? null;

  return (
    <div className="flex min-w-0 flex-1">
      {/* Below xl the thread and the lead panel take turns rather than splitting the width; the
          existing Details / Hide details button is the switch. From xl both are visible. */}
      <section className={`min-w-0 flex-1 flex-col xl:flex ${detailsOpen ? 'hidden' : 'flex'}`}>
        {/* THE ONE HEADER SHAPE, on a phone. The lead's name and who it came in on are the
            identity; the stage badge and the way into the details are the two actions worth a
            permanent target. Everything else about this lead is one tap away behind Details,
            which on a phone is a full screen rather than a side panel. */}
        {isMobile ? (
          <MobileAppBar
            asHeading
            onBack={onBack}
            backLabel="Back to inbox"
            title={conversation?.displayName ?? 'Conversation'}
            subtitle={
              whatsappAccount
                ? `${conversation?.leadId} · via ${whatsappAccount.name}`
                : conversation?.leadId
            }
            actions={
              <>
                <StageBadge
                  stage={effectiveStage}
                  label={findStageByKey(stages, effectiveStage)?.label}
                  color={findStageByKey(stages, effectiveStage)?.color}
                />
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  aria-label={`Lead details for ${conversation?.displayName ?? 'this lead'}`}
                  className="m-appbar-action"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5" fill="none">
                    <circle cx="10" cy="6.75" r="3" stroke="currentColor" strokeWidth="1.6" />
                    <path
                      d="M4 16.25c0-2.9 2.7-4.5 6-4.5s6 1.6 6 4.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </>
            }
          />
        ) : (
          <header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              {onBack ? (
                <button
                  type="button"
                  onClick={onBack}
                  className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 lg:hidden"
                >
                  ← Inbox
                </button>
              ) : null}
              <div className="min-w-0">
                <h2 className="truncate font-semibold text-slate-900">
                  {conversation?.displayName}
                </h2>
                <p className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="truncate">{conversation?.leadId}</span>
                  {whatsappAccount ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate text-slate-500">via {whatsappAccount.name}</span>
                    </>
                  ) : null}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <StageBadge
                stage={effectiveStage}
                label={findStageByKey(stages, effectiveStage)?.label}
                color={findStageByKey(stages, effectiveStage)?.color}
              />
              <button
                type="button"
                onClick={() => setDetailsOpen((open) => !open)}
                aria-pressed={detailsOpen}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {detailsOpen ? 'Hide details' : 'Details'}
              </button>
            </div>
          </header>
        )}

        <ConversationSummaryPanel key={conversationId} conversationId={conversationId} />

        {orderedMessages.length === 0 ? (
          <div className="flex-1 bg-slate-100">
            <EmptyState title="No messages yet" description="Send the first message below." />
          </div>
        ) : (
          <MessageThread
            messages={orderedMessages}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
            onToggleStar={canSendMessages ? (message) => void handleToggleStar(message) : undefined}
            starredMessageIds={starredSources}
            starPendingId={starPendingId}
          />
        )}

        <MessageComposer
          onSend={handleSend}
          onUploadMedia={handleUploadMedia}
          onOpenTemplates={() => setTemplatesOpen(true)}
          canUseTemplates={canUseTemplates}
          sendableAccounts={sendableAccounts}
          currentAccountId={whatsappAccount?.id ?? null}
          currentAccountName={whatsappAccount?.name ?? null}
          templates={templates}
          onOpenStarred={canSendMessages ? () => setStarredOpen(true) : undefined}
          starredInsert={starredInsert}
          onStarredInsertHandled={() => setStarredInsert(null)}
        />

        {/* Keyed on the thread, so switching leads remounts the writer and one lead's drafts
            cannot be left on screen looking ready to send to another. The `generatedFor` stamp
            inside MessageTemplatesSection refuses the send outright if they ever did. */}
        {templatesOpen && conversation ? (
          <MessageTemplatesDialog
            key={conversationId}
            conversationId={conversationId}
            aiCategory={conversation.aiCategory ?? null}
            aiFacts={conversation.aiFacts ?? null}
            onClose={() => setTemplatesOpen(false)}
          />
        ) : null}

        {/* Not keyed on the thread: saved messages are the user's own and belong to no lead. */}
        {starredOpen ? (
          <StarredMessagesDialog
            onUse={(body) => setStarredInsert({ body, nonce: Date.now() })}
            onChanged={refreshStarred}
            onClose={() => setStarredOpen(false)}
          />
        ) : null}
      </section>

      {detailsOpen && conversation ? (
        <LeadPanel
          onRemindersChanged={onRemindersChanged}
          remindersRefreshKey={remindersRefreshKey}
          reminderAlarms={reminderAlarms}
          conversation={{
            ...conversation,
            stage: stageOverride ?? conversation.stage,
          }}
          contactId={contactId}
          onStageChange={setStageOverride}
          onDeleted={onDeleted}
          // Below xl this panel is the whole screen and the thread's own "Hide details" button
          // is inside the hidden half, so without this there was no way back to the messages at
          // all. Above xl both panes are visible and the panel renders no header.
          onClose={closeDetails}
          leadName={conversation.displayName}
        />
      ) : null}
    </div>
  );
};

export default ConversationView;
