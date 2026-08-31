import { useCallback, useEffect, useState } from 'react';

import { listTags } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import AddTagForm from '../components/tags/AddTagForm';
import TagRow from '../components/tags/TagRow';
import { type Tag } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

const TagsPage = () => {
  const { authedRequest, permissions } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_TAGS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listTags({ token }));
      setTags(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load tags.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const active = tags.filter((tag) => tag.status !== 'archived');
  const archived = tags.filter((tag) => tag.status === 'archived');

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Tags</h1>
        <p className="mt-1 text-sm text-slate-500">
          Labels you can attach to a lead — a lead can carry many at once. Unlike a stage, tags
          describe what is true about a lead (budget, unit type, language) rather than where it sits
          in the pipeline. Archiving keeps a tag on leads that already have it, but removes it from
          the picker.
        </p>
      </div>

      {canManage ? <AddTagForm onCreated={load} /> : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
          Active
        </div>
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading tags…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!loading && !error && active.length === 0 ? (
          <EmptyState
            title="No tags yet"
            description={
              canManage ? 'Add one above to start tagging leads.' : 'An admin can add tags.'
            }
          />
        ) : null}
        <ul>
          {active.map((tag) => (
            <TagRow key={tag.id} tag={tag} canManage={canManage} onChanged={load} />
          ))}
        </ul>
      </div>

      {archived.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
            Archived
          </div>
          <ul>
            {archived.map((tag) => (
              <TagRow key={tag.id} tag={tag} canManage={canManage} onChanged={load} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

export default TagsPage;
