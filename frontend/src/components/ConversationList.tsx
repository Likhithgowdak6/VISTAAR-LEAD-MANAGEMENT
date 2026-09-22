import { useCallback, useEffect, useState } from 'react';

import { listConversations, listStages, listTags, setAiAutomation } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { findStageByKey, mergeStages } from '../lib/stages';
import { useRealtime } from '../realtime/RealtimeProvider';
import AddLeadDialog from './AddLeadDialog';
import EmptyState from './EmptyState';
import InboxFilters from './InboxFilters';
import LeadScoreBadge from './LeadScoreBadge';
import RelativeTime from './RelativeTime';
import Spinner from './Spinner';
import StageBadge from './StageBadge';
import ToggleSwitch from './ToggleSwitch';
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
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const { subscribe } = useRealtime() as RealtimeValue;
  // Same gate as the route: adding a lead creates a contact and can send an unsolicited opening
  // message, so it belongs with the permissions that reach a customer, not with reading.
  const canAddLead = hasPermission(permissions, PERMISSIONS.MESSAGES_SEND);
  const [addingLead, setAddingLead] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [tags, setTags] = useState<Tag[]>([]);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [tagFilterIds, setTagFilterIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Conversation id -> the value the user just chose, held until the refetch confirms it.
  const [pending, setPending] = useState<Record<string, boolean>>({});

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

  /**
   * Optimistic, and deliberately so: the whole point is that switching the AI off feels immediate,
   * because the reason you are reaching for it is that you want it to stop NOW. The server is the
   * source of truth - a failure puts the switch back and says why.
   */
  const toggleAutomation = async (conversationId: string, next: boolean) => {
    setBusyId(conversationId);
    setPending((current) => ({ ...current, [conversationId]: next }));
    setError(null);

    try {
      await authedRequest((token) => setAiAutomation({ token, conversationId, enabled: next }));
      await load();
    } catch (toggleError: unknown) {
      setPending((current) => {
        const { [conversationId]: _discarded, ...rest } = current;
        return rest;
      });
      setError(errorMessage(toggleError, 'Could not change the AI for that lead.'));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * The optimistic value while a change is in flight, otherwise whatever the server last said.
   *
   * Falls back to ON, because that is the resting state: the AI works every lead until the owner
   * says otherwise. This only applies when the field is absent from the payload - an explicit
   * `false`, including the one an escalation writes, still reads as off.
   */
  const automationFor = (conversation: ConversationSummary): boolean =>
    pending[conversation.id] ?? conversation.aiAutomationEnabled ?? true;

  // Width is the shell's decision now - full bleed on a phone, a fixed rail from lg - so this no
  // longer pins itself to max-w-sm and eats half a laptop viewport.
  return (
    <aside className="flex h-full w-full flex-col border-r border-hairline bg-ink-2">
      <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
        {/* Stays "Conversations", not "Contact sheet": this app has Contacts as a separate thing,
            so the studio's own word for a page of frames would read as the wrong noun here. The
            contact-sheet idea lives in the film-edge markers on the rows instead. */}
        <h2 className="eyebrow">Conversations</h2>
        <div className="flex items-center gap-3">
          <output className="text-[0.6875rem] text-muted">{conversations.length}</output>
          {canAddLead ? (
            <button
              type="button"
              onClick={() => setAddingLead(true)}
              className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-key"
            >
              + Lead
            </button>
          ) : null}
          <button
            type="button"
            onClick={load}
            className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-key"
          >
            Refresh
          </button>
        </div>
      </header>

      {addingLead ? (
        <AddLeadDialog
          onClose={() => setAddingLead(false)}
          onCreated={(conversationId) => {
            setAddingLead(false);
            // Refetch before selecting: a lead added by hand is not in this list yet, and opening
            // a thread the list has never heard of leaves the row unhighlighted behind it.
            load();
            onSelect(conversationId);
          }}
        />
      ) : null}

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
              // The toggle is a sibling of the row button, never a child: a button inside a button
              // is invalid HTML, and assistive tech reports the inner control unreliably or not at
              // all. `group` moves up here so the sprocket still lights on row hover.
              <li key={conversation.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  aria-current={isSelected}
                  className={`relative flex w-full flex-col gap-1.5 border-b border-hairline/60 px-4 py-3 pl-5 pr-14 text-left transition-colors ${
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

                {/* The AI's off switch for this one lead, on the row rather than only inside the
                    thread: the moment you want it is when you have just read something the AI
                    said and want it to stop, and that is a moment for one click - not for opening
                    a panel and hunting for a setting. */}
                <span className="absolute bottom-3 right-4 flex items-center gap-1.5">
                  <span className="font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-muted">
                    AI
                  </span>
                  <ToggleSwitch
                    size="sm"
                    checked={automationFor(conversation)}
                    disabled={busyId === conversation.id}
                    label={
                      automationFor(conversation)
                        ? `Turn the AI off for ${conversation.displayName}`
                        : `Turn the AI on for ${conversation.displayName}`
                    }
                    onChange={(next) => toggleAutomation(conversation.id, next)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
};

export default ConversationList;
