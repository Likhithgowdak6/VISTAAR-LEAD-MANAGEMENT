import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import { attachTag, detachTag, listTags } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import Spinner from '../Spinner';
import { type AuthValue, errorMessage, type Tag } from '../types';

type Props = {
  conversationId: string;
  tagIds?: string[];
  onTagsChange?: (tagIds: string[]) => void;
};

const TagsSection = ({ conversationId, tagIds, onTagsChange }: Props) => {
  const { authedRequest, permissions } = useAuth() as AuthValue;
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [attachedIds, setAttachedIds] = useState<string[]>(tagIds ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TAGS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listTags({ token }));
      setAllTags((payload?.data as Tag[] | undefined) ?? []);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load tags.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const tagById = new Map(allTags.map((tag) => [tag.id, tag]));
  const attachedTags = attachedIds.map((id) => tagById.get(id)).filter(Boolean) as Tag[];
  const availableTags = allTags.filter(
    (tag) => tag.status === 'active' && !attachedIds.includes(tag.id),
  );

  const applyResult = (result: { data?: { tags?: string[] } } | null | undefined) => {
    const nextIds = result?.data?.tags ?? [];
    setAttachedIds(nextIds);
    onTagsChange?.(nextIds);
  };

  const handleAttach = async (event: ChangeEvent<HTMLSelectElement>) => {
    const tagId = event.target.value;
    if (!tagId) {
      return;
    }
    setError(null);
    try {
      const payload = await authedRequest((token) => attachTag({ token, conversationId, tagId }));
      applyResult(payload as { data?: { tags?: string[] } });
    } catch (attachError: unknown) {
      setError(errorMessage(attachError, 'Unable to attach tag.'));
    }
  };

  const handleDetach = async (tagId: string) => {
    setError(null);
    try {
      const payload = await authedRequest((token) => detachTag({ token, conversationId, tagId }));
      applyResult(payload as { data?: { tags?: string[] } });
    } catch (detachError: unknown) {
      setError(errorMessage(detachError, 'Unable to remove tag.'));
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Tags</h3>

      {loading ? <Spinner label="Loading tags…" /> : null}

      <div className="flex flex-wrap gap-1.5">
        {attachedTags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
          >
            {tag.name}
            {canManage ? (
              <button
                type="button"
                aria-label={`Remove ${tag.name}`}
                onClick={() => handleDetach(tag.id)}
                className="text-slate-400 hover:text-red-500"
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        {attachedTags.length === 0 && !loading ? (
          <span className="text-xs text-slate-400">No tags</span>
        ) : null}
      </div>

      {canManage && availableTags.length > 0 ? (
        <select
          aria-label="Add tag"
          value=""
          onChange={handleAttach}
          className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
        >
          <option value="">Add a tag…</option>
          {availableTags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
};

export default TagsSection;
