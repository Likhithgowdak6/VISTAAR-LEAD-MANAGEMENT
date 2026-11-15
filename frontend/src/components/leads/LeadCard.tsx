import RelativeTime from '../RelativeTime';
import StageBadge from '../StageBadge';
import { type Conversation, type StageOption, type Tag } from '../types';
import { findStageByKey } from '../../lib/stages';
import { Avatar } from '../ui/Motion';

/**
 * One lead, as a row in the Leads list.
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
  const tagIds = conversation.tags ?? [];
  const shown = tagIds.slice(0, MAX_TAGS);
  const overflow = tagIds.length - shown.length;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(conversation.id)}
        className="lead-list-row flex w-full flex-col gap-2 border-b border-slate-100 p-4 text-left transition-colors duration-150"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={conversation.displayName} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="lead-list-title truncate text-sm font-semibold">
                {conversation.displayName}
              </span>
              <RelativeTime
                value={conversation.lastMessageAt}
                className="lead-list-meta shrink-0 text-xs font-medium"
              />
            </div>
            <p className="lead-list-preview line-clamp-2 text-sm leading-relaxed mt-0.5">
              {preview ?? 'No enquiry details yet'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pl-11">
          <StageBadge stage={conversation.stage} label={stage?.label} color={stage?.color} />

          {shown.map((tagId) => {
            const tag = tagsById.get(tagId);
            return tag ? (
              <span
                key={tagId}
                className="chip"
              >
                {tag.name}
              </span>
            ) : null;
          })}

          {overflow > 0 ? (
            <span className="lead-list-meta text-xs font-medium">+{overflow}</span>
          ) : null}
        </div>
      </button>
    </li>
  );
};

export default LeadCard;
