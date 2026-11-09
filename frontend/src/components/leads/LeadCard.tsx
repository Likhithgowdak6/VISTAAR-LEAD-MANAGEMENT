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
        className="flex w-full flex-col gap-2 border-b border-slate-100 bg-white p-4 text-left transition-all duration-150 hover:bg-slate-50/80 active:bg-slate-100"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={conversation.displayName} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold text-slate-800">
                {conversation.displayName}
              </span>
              <RelativeTime
                value={conversation.lastMessageAt}
                className="shrink-0 text-[0.6875rem] font-medium text-slate-400"
              />
            </div>
            <p className="line-clamp-2 text-xs leading-relaxed text-slate-500 mt-0.5">
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
                className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.6875rem] font-medium text-slate-600"
              >
                {tag.name}
              </span>
            ) : null;
          })}

          {overflow > 0 ? (
            <span className="text-[0.6875rem] font-medium text-slate-400">+{overflow}</span>
          ) : null}
        </div>
      </button>
    </li>
  );
};

export default LeadCard;
