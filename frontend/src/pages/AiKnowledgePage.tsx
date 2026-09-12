import { useCallback, useEffect, useState } from 'react';

import { listAiKnowledge } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import KnowledgeDialog from '../components/ai-knowledge/KnowledgeDialog';
import KnowledgeRow from '../components/ai-knowledge/KnowledgeRow';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import { type AiKnowledge } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

const AiKnowledgePage = () => {
  const { authedRequest, permissions } = useAuth();
  const [knowledge, setKnowledge] = useState<AiKnowledge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const canManage = hasPermission(permissions, PERMISSIONS.AI_KNOWLEDGE_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listAiKnowledge({ token }));
      setKnowledge(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error ? loadError.message : 'Unable to load knowledge entries.',
      );
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">AI knowledge base</h1>
          <p className="mt-1 text-sm text-slate-500">
            What the agent knows and how it must behave — prices, policies, and things it must
            never promise. It reads all of this before every reply.
          </p>
        </div>

        {canManage ? (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="btn-key shrink-0 rounded-lg px-4 py-2 text-sm"
          >
            Tell the AI what to do
          </button>
        ) : null}
      </div>

      {dialogOpen ? (
        <KnowledgeDialog onClose={() => setDialogOpen(false)} onSaved={load} />
      ) : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading knowledge…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!loading && knowledge.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description="Until you add something, the agent runs on its seven built-in safety rules alone."
          />
        ) : null}
        <ul>
          {knowledge.map((item) => (
            <KnowledgeRow key={item.id} knowledge={item} canManage={canManage} onChanged={load} />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default AiKnowledgePage;
