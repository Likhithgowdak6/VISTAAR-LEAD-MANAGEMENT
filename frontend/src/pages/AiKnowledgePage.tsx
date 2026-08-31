import { useCallback, useEffect, useState } from 'react';

import { listAiKnowledge } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import AddKnowledgeForm from '../components/ai-knowledge/AddKnowledgeForm';
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
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">AI knowledge base</h1>
        <p className="mt-1 text-sm text-slate-500">
          Facts the AI reply assistant is grounded in — prices, policies, and things it must never
          promise. Every AI-drafted reply still requires a human to review and send it.
        </p>
      </div>

      {canManage ? <AddKnowledgeForm onCreated={load} /> : null}

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
          <EmptyState title="No facts yet" description="Add one above." />
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
