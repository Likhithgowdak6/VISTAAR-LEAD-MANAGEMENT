import { useState } from 'react';

import { archiveAiKnowledge } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AiKnowledge, type AuthValue, errorMessage } from '../types';

type Props = {
  knowledge: AiKnowledge;
  canManage: boolean;
  onChanged?: () => void;
};

const KnowledgeRow = ({ knowledge, canManage, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isArchived = knowledge.status === 'archived';

  const handleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest((token) => archiveAiKnowledge({ token, knowledgeId: knowledge.id }));
      onChanged?.();
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError, 'Unable to archive.'));
      setBusy(false);
    }
  };

  return (
    <li className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-slate-900">{knowledge.label}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize text-slate-500">
            {knowledge.category}
          </span>
          {isArchived ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
              Archived
            </span>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">
          {knowledge.content}
        </p>
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
      </div>

      {canManage && !isArchived ? (
        <button
          type="button"
          onClick={handleArchive}
          disabled={busy}
          className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Archive
        </button>
      ) : null}
    </li>
  );
};

export default KnowledgeRow;
