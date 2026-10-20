import { useCallback, useEffect, useRef, useState } from 'react';

import { listConversations, listStages, listTags, setAiAutomation } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useIsMobileViewport } from '../hooks/useMobileBackLayer';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { findStageByKey, mergeStages } from '../lib/stages';
import { useRealtime } from '../realtime/RealtimeProvider';
import AddLeadDialog from './AddLeadDialog';
import EmptyState from './EmptyState';
import InboxFilters from './InboxFilters';
import MobileAppBar from './mobile/MobileAppBar';
import LeadScoreBadge from './LeadScoreBadge';
import LeadTemperatureBadge from './LeadTemperatureBadge';
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
  /**
   * On a phone this list is hidden rather than unmounted while a thread is open, so everything
   * above survives on its own - but `display: none` resets scrollTop. This puts the owner back
   * where they were reading instead of at the top of the inbox.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollMemory(scrollRef);

  const isMobile = useIsMobileViewport();
  /** Narrows the loaded page only - see the note beside the input on why there is no server query. */
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  const activeFilterCount = (stageFilter ? 1 : 0) + tagFilterIds.length;

  /**
   * The rows actually rendered.
   *
   * GATED ON `isMobile`, NOT JUST ON THE QUERY, and the difference is a bug that was shipped
   * once. The search input renders only on a phone, but this component is NOT remounted when
   * the viewport crosses the breakpoint - its key is the refresh counter - so `query` survives
   * into the desktop layout while the box that set it unmounts. Widening a browser window
   * after searching left the desktop inbox filtered to a handful of rows with no visible
   * search field and no way to clear it.
   *
   * Deriving it here rather than clearing `query` in an effect keeps the typed text for when
   * the viewport narrows again, and costs no extra render.
   *
   * Matches the name and the last-message preview, which together are what someone is
   * scanning for. Case-insensitive and trimmed, because nobody types a lead's name with the
   * capitalisation WhatsApp gave it.
   */
  const needle = isMobile ? query.trim().toLowerCase() : '';
  const visible =
    needle === ''
      ? conversations
      : conversations.filter((conversation) =>
          `${conversation.displayName ?? ''} ${conversation.lastMessagePreview ?? ''}`
            .toLowerCase()
            .includes(needle),
        );

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
      {isMobile ? (
        <>
          <MobileAppBar
            asHeading
            title="Inbox"
            subtitle={`${visible.length} of ${conversations.length} leads`}
            actions={
              <>
                {canAddLead ? (
                  <button
                    type="button"
                    onClick={() => setAddingLead(true)}
                    aria-label="Add a lead"
                    className="m-appbar-action"
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5" fill="none">
                      <path
                        d="M10 4.5v11M4.5 10h11"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={load}
                  aria-label="Refresh the list"
                  className="m-appbar-action"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5" fill="none">
                    <path
                      d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5V7h-3.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </>
            }
          />

          {/* SEARCH FILTERS WHAT IS ALREADY LOADED, and says so. The conversations endpoint
              takes stage and tags but no query, and inventing a server parameter would be an
              API change. Narrowing the page in the hand is still the thing you want nine times
              out of ten - finding the lead you were just reading - so it is offered, labelled
              honestly, and the count above shows how much of the list it is matching. */}
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
            <div className="relative min-w-0 flex-1">
              <svg
                viewBox="0 0 20 20"
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                fill="none"
              >
                <circle cx="9" cy="9" r="5.25" stroke="currentColor" strokeWidth="1.6" />
                <path
                  d="m13 13 3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search loaded leads…"
                aria-label="Search the leads already loaded"
                className="h-10 w-full rounded-lg border border-hairline bg-panel pl-8 pr-3 text-sm text-bone placeholder:text-muted focus:border-key/50 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className={`flex h-10 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
                hasFilters ? 'border-key/50 text-key' : 'border-hairline text-bone-dim'
              }`}
            >
              Filters
              {activeFilterCount > 0 ? (
                <span className="rounded-full bg-key px-1.5 font-mono text-[0.625rem] text-ink">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>
        </>
      ) : (
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
      )}

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

      {/* On a phone the two selects are folded away behind the Filters button: they are set
          once and then take a permanent row away from the leads. On desktop they stay visible,
          exactly as before. */}
      {!isMobile || filtersOpen ? (
        <InboxFilters
          stages={stages}
          tags={tags}
          stage={stageFilter}
          tagIds={tagFilterIds}
          onStageChange={setStageFilter}
          onTagsChange={setTagFilterIds}
        />
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
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

        {/* A search that matches nothing is a DIFFERENT state from an empty inbox, and saying
            so is the difference between "try another word" and "nothing has come in". */}
        {!loading && !error && conversations.length > 0 && visible.length === 0 ? (
          <EmptyState
            title="No leads match that search"
            description={`Nothing in the ${conversations.length} loaded leads matches “${query.trim()}”. Older leads are not searched.`}
          />
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
          {visible.map((conversation) => {
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
                    {/* How warm the lead is: have they written, and how recently. This used to
                        be the SCORE band, whose 20-49 tier is also called "cold" - so an
                        imported lead that had never been contacted arrived labelled Cold, and
                        a lead who messaged a minute ago with no details yet showed nothing at
                        all. Neither was about temperature. */}
                    <LeadTemperatureBadge temperature={conversation.leadTemperature} />
                    {/* Intent still earns a pill, but only when it is high enough to be worth
                        interrupting for - which is what "visible without opening it" was for.
                        The full score and its six signals live in the lead panel. */}
                    {conversation.leadScoreBand === 'hot' ||
                    conversation.leadScoreBand === 'warm' ? (
                      <LeadScoreBadge
                        band={conversation.leadScoreBand}
                        score={conversation.leadScore}
                      />
                    ) : null}
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
