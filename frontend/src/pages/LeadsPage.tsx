import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listConversations, listStages, listTags } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import ConversationFilters from '../components/inbox/ConversationFilters';
import LeadCard from '../components/leads/LeadCard';
import { mergeStages } from '../lib/stages';
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
      });

    return () => {
      active = false;
    };
  }, [authedRequest, debouncedSearch, enquiryClass, aiStatus, needsAttention, reloadKey]);

  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  const searching = debouncedSearch.length > 0;
  const filtering = Boolean(enquiryClass) || Boolean(aiStatus) || needsAttention;

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-hairline px-4 pb-3 pt-4">
        <h1 className="font-display text-lg uppercase tracking-[0.14em] text-bone">Leads</h1>

        <div className="mt-3 flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search leads by name..."
            aria-label="Search leads by name"
            className="min-h-11 w-full rounded-lg border border-hairline bg-panel px-3 text-sm text-bone placeholder:text-muted"
          />
        </div>

        <div className="mt-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
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
