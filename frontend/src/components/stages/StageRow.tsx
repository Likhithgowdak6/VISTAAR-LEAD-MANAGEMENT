import { useState } from 'react';

import { archiveStage, deleteStage } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, type CustomStage, errorMessage } from '../types';

type Props = {
  stage: CustomStage;
  canManage: boolean;
  onChanged?: () => void;
};

const StageRow = ({ stage, canManage, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isArchived = stage.status === 'archived';

  const handleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest((token) => archiveStage({ token, stageId: stage.id }));
      onChanged?.();
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError, 'Unable to archive stage.'));
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest((token) => deleteStage({ token, stageId: stage.id }));
      onChanged?.();
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError, 'Unable to delete stage.'));
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
        {/* An uncoloured stage falls back to the muted token, not a light slate: on this
            background a pale dot reads as the brightest thing in the row. */}
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-slate-200"
          style={{ backgroundColor: stage.color ?? 'var(--color-muted)' }}
          aria-hidden="true"
        />
        <span className="truncate font-semibold text-slate-900">{stage.label}</span>
        {isArchived ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            Archived
          </span>
        ) : null}
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {!isArchived ? (
            <button
              type="button"
              onClick={handleArchive}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Archive
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
};

export default StageRow;
