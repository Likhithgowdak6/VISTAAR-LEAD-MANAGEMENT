import { useState } from 'react';

import { archiveTag } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage, type Tag } from '../types';

type Props = {
  tag: Tag;
  canManage: boolean;
  onChanged?: () => void;
};

const TagRow = ({ tag, canManage, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isArchived = tag.status === 'archived';

  const handleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest((token) => archiveTag({ token, tagId: tag.id }));
      onChanged?.();
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError, 'Unable to archive tag.'));
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-slate-200"
          style={{ backgroundColor: tag.color ?? '#cbd5e1' }}
          aria-hidden="true"
        />
        <span className="truncate font-semibold text-slate-900">{tag.name}</span>
        <span className="truncate text-xs text-slate-400">{tag.slug}</span>
        {isArchived ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            Archived
          </span>
        ) : null}
        {error ? <span className="text-xs text-red-600">{error}</span> : null}
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

export default TagRow;
