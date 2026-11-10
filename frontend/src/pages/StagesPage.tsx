import { useCallback, useEffect, useState } from 'react';

import { listStages } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import AddStageForm from '../components/stages/AddStageForm';
import StageRow from '../components/stages/StageRow';
import { type Stage } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import { BUILTIN_STAGES } from '../lib/stages';

interface StagesPageProps {
  embedded?: boolean;
}

const StagesPage = ({ embedded = false }: StagesPageProps) => {
  const { authedRequest, permissions } = useAuth();
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.CRM_STAGE_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listStages({ token }));
      setStages(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load stages.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const content = (
    <div className="space-y-4">
      {!embedded ? (
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Lead stages</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            The 7 built-in stages (New, Contacted, Qualified, Proposal, Won, Lost, Closed) are
            permanent. Add custom stages here — once added, everyone can pick them on a lead.
          </p>
        </div>
      ) : null}

      {canManage ? <AddStageForm onCreated={load} /> : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="border-b border-slate-100 dark:border-slate-800 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
          Built-in (permanent)
        </div>
        <ul>
          {BUILTIN_STAGES.map((stage) => (
            <li
              key={stage.key}
              className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 px-4 py-3 text-slate-700 dark:text-slate-300"
            >
              {stage.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="border-b border-slate-100 dark:border-slate-800 px-4 py-2 text-xs font-semibold uppercase text-slate-400">
          Custom
        </div>
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading stages…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {!loading && stages.length === 0 ? (
          <EmptyState title="No custom stages yet" description="Add one above." />
        ) : null}
        <ul>
          {stages.map((stage) => (
            <StageRow key={stage.id} stage={stage} canManage={canManage} onChanged={load} />
          ))}
        </ul>
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      {content}
    </div>
  );
};

export default StagesPage;
