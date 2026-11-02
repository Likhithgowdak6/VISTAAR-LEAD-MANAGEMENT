import RelativeTime from '../RelativeTime';
import StageBadge from '../StageBadge';
import { type Conversation, type StageOption, type Tag } from '../types';
import { findStageByKey } from '../../lib/stages';

/**
 * One lead, as a row in the Leads list.
 *
 * EVERYTHING HERE COMES OFF THE RECORD THE LIST ALREADY FETCHED. The conversations endpoint
 * returns `summary`, `lastMessagePreview`, `stage`, `tags` and `lastMessageAt` in the same
 * payload, so a page of fifty leads is one request - not one plus fifty. That is the whole
 * reason this takes a `Conversation` rather than an id.
 *
 * THE PREVIEW PREFERS THE SUMMARY over the last message, and the distinction matters. The
 * summary is what the lead is ABOUT; the last message is whatever happened to be said most
 * recently, which on a chased lead is often our own follow-up rather than anything about them.
 * Falling back to it is better than a blank line, but it is the second choice.
 *
 * TAGS ARE RESOLVED BY THE PARENT, which holds the one tag list it fetched once. Looking a name
 * up per card would be the N+1 this file exists to avoid.
 */

interface Props {
  conversation: Conversation;
  stages: readonly StageOption[];
  /** Tag id -> tag, built once by the parent. */
  tagsById: ReadonlyMap<string, Tag>;
  onOpen: (conversationId: string) => void;
}

/** Three is what fits on a phone without the row growing a second line of chips. */
const MAX_TAGS = 3;

const LeadCard = ({ conversation, stages, tagsById, onOpen }: Props) => {
  const preview = conversation.summary ?? conversation.lastMessagePreview;
  const stage = findStageByKey(stages, conversation.stage);
  // Defaulted rather than trusted. The type promises an array and the serializer always sends
  // one, but a card that throws takes the WHOLE LIST down with it - every other lead included -
  // and an older cached payload or a partial record is not worth that.
  const tagIds = conversation.tags ?? [];
  const shown = tagIds.slice(0, MAX_TAGS);
  const overflow = tagIds.length - shown.length;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(conversation.id)}
        className="flex w-full flex-col gap-1.5 border-b border-hairline/60 px-4 py-3 text-left transition-colors hover:bg-panel/60"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold text-bone">
            {conversation.displayName}
          </span>
          <RelativeTime
            value={conversation.lastMessageAt}
            className="shrink-0 text-[0.6875rem] text-muted"
          />
        </div>

        {/* Said plainly rather than left blank. A lead with nothing written down yet is an
            ordinary state - a form with no message, a number somebody added by hand. */}
        <span className="line-clamp-2 text-[0.8125rem] leading-snug text-muted">
          {preview ?? 'No enquiry details yet'}
        </span>

        <div className="flex flex-wrap items-center gap-1.5">
          <StageBadge stage={conversation.stage} label={stage?.label} color={stage?.color} />

          {shown.map((tagId) => {
            const tag = tagsById.get(tagId);

            // An id with no tag in hand renders NOTHING rather than the raw id. A hex string on
            // a lead card is noise, and it means the tag list is stale - not that this lead is
            // tagged "68f1a2b3".
            return tag ? (
              <span
                key={tagId}
                className="rounded-full border border-hairline px-2 py-0.5 text-[0.6875rem] text-bone-dim"
              >
                {tag.name}
              </span>
            ) : null;
          })}

          {overflow > 0 ? (
            <span className="text-[0.6875rem] text-muted">+{overflow}</span>
          ) : null}
        </div>
      </button>
    </li>
  );
};

export default LeadCard;
