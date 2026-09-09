import { useCallback, useEffect, useState } from 'react';

import { listConversations, listStages, listTags } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { findStageByKey, mergeStages } from '../lib/stages';
import { useRealtime } from '../realtime/RealtimeProvider';
import EmptyState from './EmptyState';
import InboxFilters from './InboxFilters';
import LeadScoreBadge from './LeadScoreBadge';
import RelativeTime from './RelativeTime';
import Spinner from './Spinner';
import StageBadge from './StageBadge';
import {
  type AuthValue,
  type ConversationSummary,
  errorMessage,
  type RealtimeValue,
  type StageOption,
  type Tag,
} from './types';
import UnreadBadge from './UnreadBadge';

const POLL_INTERVAL_MS = 60000;

type Props = {
  selectedId?: string | null;
  onSelect: (conversationId: string) => void;
};

const ConversationList = ({ selectedId, onSelect }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const { subscribe } = useRealtime() as RealtimeValue;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [tags, setTags] = useState<Tag[]>([]);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [tagFilterIds, setTagFilterIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) =>
        listConversations({ token, limit: 50, stage: stageFilter, tagIds: tagFilterIds }),
      );
      setConversations(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load conversations.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, stageFilter, tagFilterIds]);

  useEffect(() => {
    // Fetch-on-mount + slow fallback poll: state updates happen after each request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    // Needed to resolve a custom stage's label/color for the badge below, and to populate the
    // filter pickers. The built-ins alone already render correctly, so failures are non-fatal.
    authedRequest((token) => listStages({ token }))
      .then((payload) => setStages(mergeStages(payload.data ?? [])))
      .catch(() => {});
    authedRequest((token) => listTags({ token }))
      .then((payload) => setTags(payload.data ?? []))
      .catch(() => {});
  }, [authedRequest]);

  // Realtime: refetch the inbox whenever any conversation changes.
  useEffect(() => subscribe(() => load()), [subscribe, load]);

  const hasFilters = Boolean(stageFilter) || tagFilterIds.length > 0;

  return (
    <aside className="flex h-full w-full max-w-sm flex-col border-r border-hairline bg-ink-2">
      <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
        {/* Stays "Conversations", not "Contact sheet": this app has Contacts as a separate thing,
            so the studio's own word for a page of frames would read as the wrong noun here. The
            contact-sheet idea lives in the film-edge markers on the rows instead. */}
        <h2 className="eyebrow">Conversations</h2>
        <div className="flex items-center gap-3">
          <output className="text-[0.6875rem] text-muted">{conversations.length}</output>
          <button
            type="button"
            onClick={load}
            className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-key"
          >
            Refresh
          </button>
        </div>
      </header>

      <InboxFilters
        stages={stages}
        tags={tags}
        stage={stageFilter}
        tagIds={tagFilterIds}
        onStageChange={setStageFilter}
        onTagsChange={setTagFilterIds}
      />

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading conversations…" />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {!loading && !error && conversations.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No matching conversations' : 'No conversations yet'}
            description={
              hasFilters
                ? 'No lead matches every filter. Try removing one.'
                : 'Inbound messages will appear here.'
            }
          />
        ) : null}

        <ul>
          {conversations.map((conversation) => {
            const isSelected = conversation.id === selectedId;

            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={isSelected}
                  className={`group relative flex w-full flex-col gap-1.5 border-b border-hairline/60 px-4 py-3 pl-5 text-left transition-colors ${
                    isSelected ? 'bg-panel' : 'hover:bg-panel/60'
                  }`}
                >
                  {/* The sprocket: a film-edge marker down the left of each frame, lit by the key
                      light on the frame you are looking at. It is the selected-state indicator and
                      the contact-sheet metaphor in the same two pixels. */}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-y-0 left-0 w-[3px] transition-all ${
                      isSelected
                        ? 'bg-key shadow-[0_0_12px_1px_rgb(255_158_74/70%)]'
                        : 'bg-transparent group-hover:bg-hairline'
                    }`}
                  />

                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={`truncate text-sm font-semibold ${
                        isSelected ? 'text-bone' : 'text-slate-700'
                      }`}
                    >
                      {conversation.displayName}
                    </span>
                    <RelativeTime
                      value={conversation.lastMessageAt}
                      className="shrink-0 text-[0.6875rem] text-muted"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[0.8125rem] leading-snug text-muted">
                      {conversation.lastMessagePreview ?? 'No messages yet'}
                    </span>
                    <UnreadBadge count={conversation.unreadCount} />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <StageBadge
                      stage={conversation.stage}
                      label={findStageByKey(stages, conversation.stage)?.label}
                      color={findStageByKey(stages, conversation.stage)?.color}
                    />
                    {/* How warm the lead is, so a HOT one is visible without opening it.
                        Renders nothing for a lead nobody has scored yet. */}
                    <LeadScoreBadge
                      band={conversation.leadScoreBand}
                      score={conversation.leadScore}
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
};

export default ConversationList;
