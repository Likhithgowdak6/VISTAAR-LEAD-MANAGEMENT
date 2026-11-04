import { useCallback, useEffect, useState } from 'react';

import { getConversation, listStages, listTags } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import Spinner from '../components/Spinner';
import StageBadge from '../components/StageBadge';
import CallAction from '../components/lead/CallAction';
import LeadFormSection from '../components/lead/LeadFormSection';
import MobileAppBar from '../components/mobile/MobileAppBar';
import { mergeStages, findStageByKey } from '../lib/stages';
import {
  type AuthValue,
  type Conversation,
  errorMessage,
  type StageOption,
  type Tag,
} from '../components/types';
import { type Contact } from '../types/models';

/**
 * One lead's profile: who they are, what they asked about, and the two things you do next.
 *
 * THE ENQUIRY SUMMARY IS NOT GENERATED HERE, and that is the important constraint. Everything
 * shown is already stored: `summary` is what the CRM has written down about the lead,
 * `lastMessagePreview` is the newest thing said, and LeadFormSection renders the answers the
 * lead typed into the Meta enquiry form - if there was one. No model is called to write prose
 * for this screen. When all of those are empty the screen SAYS SO rather than inventing a
 * plausible sentence, because a confident summary of a lead nobody has spoken to is worse than
 * an honest blank.
 *
 * TWO ACTIONS, NOT A TOOLBAR. Message hands back to the shell, which opens the inbox on this
 * exact conversation - the same call the inbox's own list makes, so the thread, its deep link
 * and its unread state all behave identically. Call is the existing CallAction, unchanged:
 * ACTION_DIAL into the system dialler, the call record, and the manual outcome prompt.
 */

interface Props {
  conversationId: string;
  /** Opens the inbox on THIS conversation. Owned by the shell, as every lead open is. */
  onMessage: (conversationId: string) => void;
  onBack: () => void;
}

const LeadDetailPage = ({ conversationId, onMessage, onBack }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, stagePayload, tagPayload] = await Promise.all([
        authedRequest((token) => getConversation({ token, conversationId })),
        authedRequest((token) => listStages({ token })).catch(() => null),
        authedRequest((token) => listTags({ token })).catch(() => null),
      ]);

      setConversation(detail?.data?.conversation ?? null);
      setContact(detail?.data?.contact ?? null);
      setStages(mergeStages(stagePayload?.data ?? []));
      setTags(tagPayload?.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load this lead.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const stage = conversation ? findStageByKey(stages, conversation.stage) : null;
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const enquiry = conversation?.summary ?? conversation?.lastMessagePreview ?? null;

  return (
    <div className="flex h-full flex-col">
      <MobileAppBar
        onBack={onBack}
        backLabel="Back to leads"
        title={conversation?.displayName ?? 'Lead'}
        asHeading
      />

      {/* `m-nav-clearance` because the bottom nav stays visible over this screen - unlike a
          message thread, which hides it so the composer owns the bottom edge. Without the
          padding the last section sits under the nav bar. */}
      <div className="m-nav-clearance min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <Spinner label="Loading lead…" /> : null}

        {error && !loading ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {!loading && !conversation && !error ? (
          <p className="text-sm text-muted">
            This lead is no longer here. It may have been deleted.
          </p>
        ) : null}

        {conversation ? (
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => onMessage(conversation.id)}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-hairline bg-panel px-3 text-sm font-medium text-bone hover:bg-panel/60"
              >
                <span aria-hidden="true">💬</span>
                Message
              </button>

              {/* The existing component, not a second call path. Renders nothing without
                  client_pii.reveal, which is the same permission that shows the number. */}
              <CallAction
                conversationId={conversation.id}
                contactId={contact?.id ?? null}
              />
            </section>

            <section>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Stage</p>
              <div className="mt-1">
                <StageBadge
                  stage={conversation.stage}
                  label={stage?.label}
                  color={stage?.color}
                />
              </div>
            </section>

            <section>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Tags</p>
              {conversation.tags.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {conversation.tags.map((tagId) => {
                    const tag = tagsById.get(tagId);

                    return tag ? (
                      <span
                        key={tagId}
                        className="rounded-full border border-hairline px-2 py-0.5 text-[0.6875rem] text-bone-dim"
                      >
                        {tag.name}
                      </span>
                    ) : null;
                  })}
                </div>
              ) : (
                <p className="mt-1 text-sm text-muted">No tags</p>
              )}
            </section>

            <section>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                Enquiry
              </p>
              {/* Stored text, verbatim. Never a generated sentence - see the note at the top. */}
              <p className="mt-1 whitespace-pre-wrap text-sm leading-snug text-bone-dim">
                {enquiry ?? 'No enquiry details available'}
              </p>
            </section>

            {/* Renders nothing unless this lead came in through a Meta form, in which case it
                shows the answers they actually typed. */}
            <LeadFormSection conversationId={conversation.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default LeadDetailPage;
