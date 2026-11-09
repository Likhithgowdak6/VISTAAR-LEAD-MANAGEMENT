import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listConversations, listStages, listTags } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import ConversationFilters from '../components/inbox/ConversationFilters';
import PullToRefreshIndicator from '../components/PullToRefreshIndicator';
import LeadCard from '../components/leads/LeadCard';
import { mergeStages } from '../lib/stages';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import {
  type AuthValue,
  type Conversation,
  errorMessage,
  type StageOption,
  type Tag,
} from '../components/types';
import { type AiResponseStatus, type EnquiryClass } from '../types/analytics';

/**
 * Every lead this user may see, as a browsable list.
 *
 * HOW THIS DIFFERS FROM THE INBOX, which is the first thing to answer since both list the same
 * records. The inbox is a WORK QUEUE: it is sorted by what happened last, carries unread counts
 * and an AI switch per row, and exists to be worked top to bottom. This is a DIRECTORY: you
 * arrive knowing whose name you want, and the controls are therefore search and filters rather
 * than triage. Same `Conversation` records, same endpoint, same permissions - a different
 * question asked of them. There is no second source of truth for a lead.
 *
 * SEARCH RUNS IN THE DATABASE, which is the whole reason the backend grew a `search` parameter.
 * The inbox's box filters the fifty rows it happens to hold and admits as much on its own label
 * - "Search loaded leads" - so the fifty-first lead cannot be found by name. Here, typing a name
 * refetches from page one with `search`, so every lead the caller is allowed to see is
 * reachable. Debounced at 250ms, matching StarredMessagesSection, so a five-letter name is one
 * request rather than five.
 *
 * FILTERS ARE THE INBOX'S OWN COMPONENT, imported rather than reimplemented. They already run
 * server-side and already combine with each other; search is simply ANDed in alongside them, so
 * "Priya, among the enquiries" means both.
 */

/** Matches the inbox. One page is plenty to browse; search reaches past it. */
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  /** Opens the lead's profile. The shell owns which lead is open, as it does for the inbox. */
  onOpenLead: (conversationId: string) => void;
}

const LeadsPage = ({ onOpenLead }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [tags, setTags] = useState<Tag[]>([]);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [enquiryClass, setEnquiryClass] = useState<EnquiryClass | null>(null);
  const [aiStatus, setAiStatus] = useState<AiResponseStatus | null>(null);
  const [needsAttention, setNeedsAttention] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * Guards against a slow early response landing after a later one and replacing newer results
   * with older - which on a search box is the difference between showing what was typed and
   * showing what was typed three letters ago. Every load takes a ticket; only the newest writes.
   */
  const loadTicket = useRef(0);

  /**
   * The scroll container, so pull-to-refresh can watch it. Held here rather than inside the
   * list because the hook needs the element that actually scrolls, which is the wrapper below
   * and not the <ul>.
   */
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Resolves the pull gesture's promise once the refetch it triggered has actually landed.
   * Without it the spinner would retract the instant the gesture ended, while the list below
   * still showed the old rows - which reads as "refresh did nothing".
   */
  const refreshResolveRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [search]);

  /** The stage and tag vocabularies. Fetched ONCE, not per card - see LeadCard. */
  useEffect(() => {
    let active = true;

    Promise.all([
      authedRequest((token) => listStages({ token })).catch(() => null),
      authedRequest((token) => listTags({ token })).catch(() => null),
    ])
      .then(([stagePayload, tagPayload]) => {
        if (!active) {
          return;
        }

        setStages(mergeStages(stagePayload?.data ?? []));
        setTags(tagPayload?.data ?? []);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [authedRequest]);

  useEffect(() => {
    const ticket = loadTicket.current + 1;
    loadTicket.current = ticket;

    let active = true;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    authedRequest((token) =>
      listConversations({
        token,
        search: debouncedSearch || undefined,
        enquiryClass,
        aiStatus,
        needsAttention,
        limit: PAGE_SIZE,
        skip: 0,
      }),
    )
      .then((payload) => {
        if (!active || loadTicket.current !== ticket) {
          return;
        }

        setConversations(payload?.data ?? []);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active || loadTicket.current !== ticket) {
          return;
        }

        setError(errorMessage(loadError, 'Unable to load leads.'));
      })
      .finally(() => {
        if (active && loadTicket.current === ticket) {
          setLoading(false);
        }

        // Always settled, even for a superseded or failed load: a pull whose promise never
        // resolves leaves the spinner on screen forever.
        refreshResolveRef.current?.();
        refreshResolveRef.current = null;
      });

    return () => {
      active = false;
    };
  }, [authedRequest, debouncedSearch, enquiryClass, aiStatus, needsAttention, reloadKey]);

  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  const searching = debouncedSearch.length > 0;
  const filtering = Boolean(enquiryClass) || Boolean(aiStatus) || needsAttention;

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  /**
   * Pull down to refetch, the same gesture the inbox already has.
   *
   * Refetching through `reloadKey` rather than calling the loader directly keeps ONE path to the
   * server: the effect above owns the request, its ticket guard, and the loading flag, so a pull
   * that lands mid-request cannot race the response it is already waiting for.
   *
   * The promise has to resolve only once the new rows are in, or the spinner snaps away while
   * the screen still shows the old list - so this waits for `loading` to go false rather than
   * resolving immediately.
   */
  const pull = usePullToRefresh({
    scrollRef,
    onRefresh: useCallback(
      () =>
        new Promise<void>((resolve) => {
          setReloadKey((key) => key + 1);
          refreshResolveRef.current = resolve;
        }),
      [],
    ),
  });

  return (
    <div className="flex h-full flex-col bg-slate-50/50">
      <div className="shrink-0 border-b border-slate-200/80 bg-white px-5 pb-4 pt-5 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Leads</h1>
            <p className="text-xs text-slate-500 mt-0.5">Browse, search, and manage all prospective clients</p>
          </div>
          <span className="rounded-full bg-blue-50 px-2.5 py-1 font-mono text-xs font-bold text-blue-700">
            {conversations.length}
          </span>
        </div>

        <div className="mt-3.5 flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search leads by name..."
            aria-label="Search leads by name"
            className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/60 px-4 text-sm text-slate-900 placeholder:text-slate-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>

        <div className="mt-2.5">
          <ConversationFilters
            enquiryClass={enquiryClass}
            aiStatus={aiStatus}
            needsAttention={needsAttention}
            onEnquiryClassChange={setEnquiryClass}
            onAiStatusChange={setAiStatus}
            onNeedsAttentionChange={setNeedsAttention}
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        data-testid="leads-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <PullToRefreshIndicator
          distance={pull.pullDistance}
          armed={pull.armed}
          refreshing={pull.refreshing}
        />

        {loading ? <Spinner label="Loading leads…" /> : null}

        {error && !loading ? (
          <div className="p-4 text-center">
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-2 min-h-11 rounded-lg border border-hairline px-3 text-sm text-bone"
            >
              Try again
            </button>
          </div>
        ) : null}

        {/* THREE DIFFERENT EMPTIES, worded differently on purpose. "Nothing matched your search"
            and "you have no leads" lead to different next actions, and a filtered list that
            matched nothing is a third thing again - the fix there is removing a filter, not
            typing a different name. */}
        {!loading && !error && conversations.length === 0 ? (
          searching ? (
            <EmptyState
              title="No leads match that search"
              description={`No lead's name matches “${debouncedSearch}”.`}
            />
          ) : filtering ? (
            <EmptyState
              title="No leads match these filters"
              description="No lead matches every filter. Try removing one."
            />
          ) : (
            <EmptyState title="No leads yet" description="New enquiries will appear here." />
          )
        ) : null}

        {!loading && !error && conversations.length > 0 ? (
          <ul>
            {conversations.map((conversation) => (
              <LeadCard
                key={conversation.id}
                conversation={conversation}
                stages={stages}
                tagsById={tagsById}
                onOpen={onOpenLead}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
};

export default LeadsPage;
