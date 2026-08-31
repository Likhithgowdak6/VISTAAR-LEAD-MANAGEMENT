import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  generateAiDraft,
  getConversation,
  getMessages,
  listSendableAccounts,
  listStages,
  recordAiDraftOutcome,
  sendMessage,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { findStageByKey, mergeStages } from '../lib/stages';
import { useRealtime } from '../realtime/RealtimeProvider';
import EmptyState from './EmptyState';
import LeadPanel from './lead/LeadPanel';
import MessageComposer from './MessageComposer';
import MessageThread from './MessageThread';
import Spinner from './Spinner';
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

type Props = {
  conversationId: string;
};

const ConversationView = ({ conversationId }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const { subscribe } = useRealtime() as RealtimeValue;
  const canSuggestReply = hasPermission(permissions, PERMISSIONS.AI_GENERATE);
  const canSendMessages = hasPermission(permissions, PERMISSIONS.MESSAGES_SEND);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [stageOverride, setStageOverride] = useState<string | null>(null);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [sendableAccounts, setSendableAccounts] = useState<SendableAccount[]>([]);

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
  }, [authedRequest, canSendMessages]);

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

  const handleSend = useCallback(
    async ({
      body,
      idempotencyKey,
      draftId,
      wasEdited,
      whatsappAccountId,
    }: {
      body: string;
      idempotencyKey: string;
      draftId: string | null;
      wasEdited: boolean;
      whatsappAccountId: string | null;
    }) => {
      const payload = await authedRequest((token) =>
        sendMessage({ token, conversationId, body, idempotencyKey, whatsappAccountId }),
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

      // Best-effort feedback metadata (ADR-005) — never blocks or fails the send itself.
      if (draftId) {
        authedRequest((token) =>
          recordAiDraftOutcome({
            token,
            conversationId,
            draftId,
            outcome: wasEdited ? 'approved_edited' : 'approved_unedited',
          }),
        ).catch(() => {});
      }
    },
    [authedRequest, conversationId, detail?.whatsappAccount?.id],
  );

  const handleSuggest = useCallback(async () => {
    const payload = await authedRequest((token) => generateAiDraft({ token, conversationId }));
    return {
      draftId: (payload?.data?.id as string | undefined) ?? null,
      draftText: (payload?.data?.draftText as string | undefined) ?? '',
    };
  }, [authedRequest, conversationId]);

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
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900">{conversation?.displayName}</h2>
            <p className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>{conversation?.leadId}</span>
              {whatsappAccount ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="truncate text-slate-500">via {whatsappAccount.name}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-3">
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
          />
        )}

        <MessageComposer
          onSend={handleSend}
          onSuggest={handleSuggest}
          canSuggest={canSuggestReply}
          sendableAccounts={sendableAccounts}
          currentAccountId={whatsappAccount?.id ?? null}
          currentAccountName={whatsappAccount?.name ?? null}
        />
      </section>

      {detailsOpen && conversation ? (
        <LeadPanel
          conversation={{
            ...conversation,
            stage: stageOverride ?? conversation.stage,
          }}
          contactId={contactId}
          onStageChange={setStageOverride}
        />
      ) : null}
    </div>
  );
};

export default ConversationView;
