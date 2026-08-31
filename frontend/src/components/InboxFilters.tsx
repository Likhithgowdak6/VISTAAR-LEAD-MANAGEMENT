import { type ChangeEvent } from 'react';

import { type StageOption, type Tag } from './types';

/**
 * Stage + tag filters for the inbox. Both narrow together (AND), and multiple tags must all be
 * present on a lead (match-ALL) — the same semantics the server applies.
 */
type Props = {
  stages: StageOption[];
  tags: Tag[];
  stage: string | null;
  tagIds: string[];
  onStageChange: (stage: string | null) => void;
  onTagsChange: (tagIds: string[]) => void;
};

const InboxFilters = ({ stages, tags, stage, tagIds, onStageChange, onTagsChange }: Props) => {
  const activeStages = stages.filter((entry) => entry.status !== 'archived');
  const activeTags = tags.filter((entry) => entry.status !== 'archived');
  const selectedTags = activeTags.filter((tag) => tagIds.includes(tag.id));
  const availableTags = activeTags.filter((tag) => !tagIds.includes(tag.id));
  const hasFilters = Boolean(stage) || tagIds.length > 0;

  const handleAddTag = (event: ChangeEvent<HTMLSelectElement>) => {
    const tagId = event.target.value;
    if (tagId) {
      onTagsChange([...tagIds, tagId]);
    }
  };

  return (
    <div className="space-y-2 border-b border-slate-200 px-4 py-2">
      <div className="flex items-center gap-2">
        <select
          aria-label="Filter by stage"
          value={stage ?? ''}
          onChange={(event) => onStageChange(event.target.value || null)}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
        >
          <option value="">All stages</option>
          {activeStages.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>

        {availableTags.length > 0 ? (
          <select
            aria-label="Filter by tag"
            value=""
            onChange={handleAddTag}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            <option value="">Add tag filter…</option>
            {availableTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {selectedTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
            >
              {tag.name}
              <button
                type="button"
                aria-label={`Remove ${tag.name} filter`}
                onClick={() => onTagsChange(tagIds.filter((id) => id !== tag.id))}
                className="text-slate-400 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
          {selectedTags.length > 1 ? (
            <span className="text-[11px] text-slate-400">matches all</span>
          ) : null}
        </div>
      ) : null}

      {hasFilters ? (
        <button
          type="button"
          onClick={() => {
            onStageChange(null);
            onTagsChange([]);
          }}
          className="text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
};

export default InboxFilters;
